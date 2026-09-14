# 评测体系评审：先让测量可信，再让改进容易

日期：2026-09-10。评审对象：`0d9fef7a4d0ee7ba6ab73b8f776e6aae16017f0e`，版本 `0.9.3-beta.3`。性质：源码评审、离线反例验证与改造设计；不代表新一轮真实模型成绩。

配套文档：[机制与实施方案](./eval-renovation-design-2026-09-10.md)、[case 设计与现有目录迁移](./eval-case-design-2026-09-10.md)。

## 结论与决策建议

Pipiclaw 已有值得保留的评测底座，但还不能稳定回答“这次修改让 Agent 更好了吗”。主要障碍是**测量口径、场景真实性和反馈闭环**。继续往当前目录加 case，会增加开销，也会放大假阳性、假阴性和比较噪声。

建议按顺序做三件事：

1. **修可信度**：修复 outcome、预算、grader、指纹、diff 和证据归档中的缺口。未修复前，不把现有 pass rate 或 baseline delta 用作质量提升证明。
2. **建立最小日常工作流**：开发者能选相关 case、提前看预算、定位第一次偏离、只重评已有证据、得到可解释的 A/B 结论。
3. **用真实交付拓宽覆盖**：优先补小仓库修复、跨会话记忆、真实 ticket 等待与恢复、委派结果验收，以及没有额外提示的安全和自主性判断。

保留真实 runtime、进程隔离、受控外部服务、代码与模型混合评分、不可变历史成绩；继续遵守 unit / deterministic e2e / evals 的职责边界。真实模型评测仍不加入普通 PR 的必过 CI。

## 当前资产与评审方法

通过编译后实际加载 `allCases` 统计，而非采用历史 spec 中的数量：

| 项目 | 当前结果 | 含义 |
|---|---:|---|
| case | 43 | regression 22、safety 9、capability 12 |
| 默认 trial | 128 | 42 × 3，加一个 2-trial case |
| gate | required 10、report-only 32、quarantine 1 | `required` 是评测自己的 gate，不是现有 CI 门禁 |
| 使用模型 grader 的 case | 4 | 其余主要依赖代码判定；代码判定本身并不低级，关键是 oracle 是否正确 |
| harness 自测 | 22 个，全部通过 | 说明已覆盖若干历史问题，不能证明 grader 能识别当前坏行为 |
| 仓库中 latest baseline | 2026-07-18，31 cases | 与当前目录只有 13 个共同 id |
| 共同 id 的相同 caseHash | 0 | 历史定义和指纹实现可能都变过，不能据此认定每个 case 都改了；能确定的是当前没有直接可比的完整基线 |

已阅读全部 case 模块与 harness、脚本/CI 配置、相关测试，以及 runtime、任务、记忆、委派用量与 observer 接口。离线执行：`npm run eval:typecheck`、`npm run eval:build`、`npm run test:evals`，均通过。反例使用临时目录和当前编译模块；没有运行收费的模型 trial，没有读取本机认证文件内容。

本次发现分为“已离线复现”和“静态确认”。不将源码缺陷等同于某个模型已经发生过该失败，也不推测当前生产失败率。

这里的 P0/P1 是评测翻新的实施顺序：P0 会直接污染质量结论，应先修；不是对线上故障严重程度的推断。

## 影响结论可信度的发现

### F1 · P0：预算淘汰了困难样本，基线晋升又使用另一套口径

证据：[run.ts](../evals/harness/run.ts) `isScorable` / `summarize` / `evaluateExit`（109–155），[promote.ts](../evals/harness/promote.ts) `assertPromotableSummary`（14–35）。**已复现。**

所有 `budget-exceeded` 都被排除在成功率和成本/时延中位数分母外。这里既包括墙钟超时，也包括模型耗尽 turns、cost；后两者往往正是执行效率失败。`minPass: 2/3` 实际被解释为“有效样本的 2/3”，没有最低有效样本数。

反例：一个 case 的 3 次结果为 pass / budget / budget。`assertPromotableSummary` 允许它成为基线；它只看 valid + invalid，没有计入 budget。运行层对单独这组结果会给 inconclusive，但加入 6 个其他 case 的通过结果后，全局预算占比低于 25%，`evaluateExit` 又返回 0。大量容易 case 可以掩盖重要 case 没测够。

修复：区分任务资源耗尽、评测调度中断和 provider 故障；将完成率和可评分率分开报告；每个关键 case 都有最低样本量。运行、比较、晋升共用同一份冻结的评测计划与判定器。

### F2 · P0：不变量可能被超时、judge 错误或通过率容忍掩盖

证据：[run.ts](../evals/harness/run.ts) 705–765、132–155。**分支静态确认；比例容忍已复现。**

预算或 invalid override 会跳过包括 invariants 在内的 grader；若同时存在 judge error 和不变量失败，聚合优先把 outcome 记成 invalid。gate 只检查 required case 的通过比例，没有独立的不变量判定。构造 2 pass + 1 invariant-violation、阈值 2/3，退出码是 0；非 required case 的违规也不影响该 gate。

修复：先检查可取得证据的不变量，独立保留 `violation / intact / unknown`；超时或证据缺失不能变成 intact。质量分数、样本可用性和违规事实分别保存。违规不能被平均分抵消。已知 quarantine 也必须保留违规的显著状态，豁免要落到具体规则、负责人和到期时间。

### F3 · P0：正常回答中的 “429” 会被识别成供应商故障

证据：[run.ts](../evals/harness/run.ts) 705 附近的 delivery 正则；[memory-recall-quality.ts](../evals/cases/memory-recall-quality.ts) `OFF_TOPIC_QUESTIONS`。**静态确认。**

runner 只要在任意 delivery 中看到 `429`、`rate limit`、`capacity` 等词，就将整个 trial 改为 invalid，并跳过正常 grader。现有 `M-quality-recall-03` 恰好要求解释 HTTP 429。正确的技术说明可以触发此分支；真实的行为失败也可能被这些文字掩盖。

修复：provider 故障必须来自模型调用返回的结构化错误/状态码和重试记录，不从用户可见自然语言推断。没有可靠归因时记 unknown，保留任务 outcome。

### F4 · P0：deadline case 与通用 grader 互相矛盾

证据：[regression.ts](../evals/cases/regression.ts) `T-deadline-01`（87–112）；[run.ts](../evals/harness/run.ts) 744 附近。**真实 TaskDriver 离线复现。**

case 正确要求过期任务在模型工作前暂停、dispatch 为 0。通用逻辑却对任何含 `runTaskDriver` 的脚本强制追加“至少一次 accepted dispatch”，否则报 error。

离线驱动结果：dispatch 0，case 自己的两个 grader 均 pass；通用判据必然 error。该 required case 无法在满足本身契约时同时满足通用要求。

修复：删除全局隐含前提。需要派发的 case 显式声明派发条件；零模型工作的机制验证迁入 deterministic e2e，断言 provider 请求数为 0。

### F5 · P0：case 指纹漏掉闭包参数，diff 没有真正校验 case 可比性

证据：[cases.ts](../evals/harness/cases.ts) `caseHash`（60–88）；[diff.ts](../evals/harness/diff.ts)（28–88）；[run.ts](../evals/harness/run.ts) `gitDirtyFingerprint`（71–84）。**指纹缺口已复现，diff 静态确认。**

`String(grader.grade)` 不包含闭包捕获的正则、阈值或 helper 实现。将同一 case 的 `fileContains('probe', 'a.txt', /AAA/)` 改为 `/BBB/`，当前 hash 完全相同。setup 捕获的 corpus/helper 也有类似问题。Git 指纹只读未暂存 diff 和 untracked；临时仓库中将修改全部 stage 后，指纹与 clean 状态相同。

`eval:diff` 只读取 manifest 和 summary，不读取 `cases.json`，仍为定义不同或缺失的 case 计算百分点差异；没有有效样本被当作 0%。`costBasis`、lockfile、thinking 等也没有被用于阻止误比。

修复：oracle 的参数显式序列化，依赖单独指纹化；Git 比较覆盖 HEAD 到 index/worktree。区分“允许改变的实验变量”和“必须相同的控制变量”。缺 case、零样本、换 oracle 必须显示 N/A/不可比。

### F6 · P1：模型身份与配置记录不能还原被测实验

证据：[run.ts](../evals/harness/run.ts) 825–925；[worker.ts](../evals/harness/worker.ts) 262–312；[judge.ts](../evals/harness/judge.ts) 40–71；[setup.ts](../test/support/setup.ts) 7–151。**静态确认。**

eval 复用 live e2e 的本机设置与认证查找，但主体模型、judge 的默认解析并不统一。judge 无显式配置时仍请求固定默认模型；run 最后可能用主体模型的 observedModel 覆盖 manifest.judgeModel，实际 judge 身份没有回传。`PIPICLAW_E2E_THINKING` 和 `PIPICLAW_E2E_ENDPOINT` 在本仓库中只写入 manifest，没有传到执行配置。

配置 hash 只采用第一个 trial，却假设所有 trial 相同。实际上若干 safety case 改写 `security.json`，且默认 canary 路径含随机临时目录；同配置跨运行可产生不同 hash，不同 case 反而只留下同一条记录。

修复：执行前解析完整 profile，执行后记录每次模型调用的 requested / resolved / reported identity。每个 trial 冻结自己的有效配置，随机挂载根用占位符规范化；保留真实安全差异。

### F7 · P1：成本漏算，时延混入评分，且同步 judge 会阻塞并发监督

证据：[worker.ts](../evals/harness/worker.ts) `message_end`；[run.ts](../evals/harness/run.ts) `gradeModel`、750–820；[sidecar-worker.ts](../src/memory/sidecar-worker.ts) `recordSidecarUsage`；[runs.ts](../src/subagents/runs.ts) settlement 的 ledger 写入。**静态确认。**

eval 成本只累加 session observer 中的 usage。反思 sidecar 和子代理结算有自己的账本路径，judge 也不回传用量；不能据此声称是“总花费”。`wallMs` 在模型评分之后取值，主体执行更快但 judge 更慢，会显示为 Agent 变慢。

`gradeModel` 使用最长 90 秒的 `spawnSync`，与管理其他 worker 的父进程事件循环共处。开启并发后，评分期间其他 worker 的 trace 接收和预算定时器会被延后，削弱预算监督。

修复：异步 judge pool；产品 ledger 按 turn/subagent/sidecar 去重收集，judge 单独计费；拆分 agent、grade、queue 时延。美元未知就是未知，固定费率只能叫标准化成本单位，不能冒充真实支出上限。

### F8 · P1：归档不能完整重评，也不能可靠复查

证据：[run.ts](../evals/harness/run.ts) `archiveEvidence`、`gradeModel`、807–822；[worker.ts](../evals/harness/worker.ts) `TOOL_FIELDS` / `eventTrace`；[promote.ts](../evals/harness/promote.ts) 39–66；[report.ts](../evals/harness/report.ts) 16–29。**文件筛选已复现，其余静态确认。**

只归档 channel 下 ≤64KB 的 md/txt/json：任务 loop log 是 jsonl，代码是 ts，事件在 workspace/events，均可能丢失。成功工具结果基本只有 ok；结构化参数只挑少量 string，task waiting、subagent 完整任务等关键数据不足。没有 stepId / actorId / sessionId，question 对齐依赖时间窗。

judge 的输入、输出放在临时 home，之后删除，证据却写 `judge-artifacts`，无法直接解析。baseline 晋升只复制四个摘要文件，没有 trials/reviews；结果目录删掉后，`eval:report` 对 baseline 的重渲染路径缺少必需数据。

修复：评测者指定 artifact 清单；证据必须带可解析 id、内容摘要与完整性状态；先持久化输入和结果再评分。支持“仅重评已有轨迹”，保留原 grade，不付第二次 Agent 执行成本。

## case 本身的信度与覆盖

### F9 · P0：若干 oracle 奖励“看起来像做了”，没有验证工作

| case / grader | 问题 | 本次验证或依据 | 应改成 |
|---|---|---|---|
| `TL-ticket-01` | `ticket.kind === job || state === open`；日志只排除少数措辞 | 初始化任务，不创建 job，添加一条“准备开始分析”的 continue 日志，两个 case grader 全 pass；通用派发存在也不补足 job 证据 | 真实 job 已启动，等待绑定同一 jobId；正常完成分支要求结果验证和终态 |
| `recallQuiz` | expected 先于 distractor/语义判断 | “Current is WRONG. RIGHT is obsolete.” 对 expected RIGHT、distractor WRONG 得满分 | 对当前值、否定、冲突分别判断；标识符精确匹配也不能忽视语义极性 |
| `TL-note-01` | marker 已在目标中，judge 只看自述日志 | 不能证明 read-back 或实际执行 | 文件/执行证据先验真，judge 再评说明是否忠于证据 |
| `P-tool-01` | 预先把答案写在 user prompt；仅需两次 read | 第二次 read 无需正确 offset、也无需读到答案 | 答案仅在文件尾；校验相关 tool result 与最终回答 |
| `T-crash-01` | 第二段 mid-turn 后无专属完成判据 | 先前 RECOVERY-CONFIRMED 与最终保留文件即可满足现有 grader | 每个恢复阶段独立验收；机制崩溃窗口由 e2e 控制 |

F9 的核心不是“regex 都该换成 LLM”。可执行结果优先用代码；开放回答用事实 claim 和校准 rubric；每个 grader 必须接受多种正确轨迹，也必须拒绝可构造的错误轨迹。

### F10 · P1：案例名称与实际到达的难度不一致

证据：[memory-recall-quality.ts](../evals/cases/memory-recall-quality.ts) 239–281；[regression.ts](../evals/cases/regression.ts) `M-recall-03/05`；[capability.ts](../evals/cases/capability.ts) `T-resume-10`、`T-chain-recover-01`。**索引与脚本已离线复现，其他为静态范围判断。**

`M-quality-recall-02` 与 01 使用相同 30 条语料，仅多一条“你好”。生产 `buildChannelIndexForBootstrap` 返回 `overBudget=false, omittedCount=0`，脚本无 `/new` 或 restart；未测到其注释声称的 reset/overflow。`M-recall-03/05` 可直接从仍在上下文中的早先对话答题，不能据此推断独立持久记忆收益。

三次/十次 synthetic wake 不是三个/十个真实恢复周期；它们直接发送事件，不负责 resolve/redeem ticket。链式查找 case 自己已说明可能首轮完成，仍保留旧 `task_update(note set)` 指导。模拟扫描日期固定为 2026-01，但 cycle/工具/后台逻辑可能使用真实时间，不能称作统一虚拟时钟。

修复：让环境证明难度到达，例如目标事实确实未进入本轮 prompt、出现新的 sessionId、输入在 park 后才释放、ticket 确实经生产路径兑现。前置条件失败单列 fixture/harness 问题。

### F11 · P1：关键产品质量覆盖不足，机制断言占用了真实模型预算

现有覆盖有价值：原生附件、journal 与冷历史检索、授权范围、显式委派、工具参数完整性、记忆纠错等，应保留并改良。仍有以下明显缺口：

- 编码助手没有以真实小仓库 patch + 隐藏验收测试为终点的 case；写 token 文件不能代替修代码。
- 委派偏向用户明确指定；缺少“应不应该委派”、上下文交接、结果不可信时复核、外部执行后真实验收。
- 缺少任务在 job/run/ask/signal 真实兑现后继续交付的行为链，以及外部新事实导致计划调整。
- 单个 `dm_eval`、顺序 user 文本脚本不足以评价群聊引用、用户中途修正、附件理解、多项目同名路径。
- 提示过的 injection 是 required，无提示变体却主要 report-only；后者更接近日常使用，不能长期只作附录。
- `T-deadline-01`、`TL-budget-01` 的核心是 runtime 确定性停机/回执，属于 e2e；字符串回执匹配不应消耗真模型预算。

具体保留、合并、迁出或重写的 43 个 case，见[迁移表](./eval-case-design-2026-09-10.md#现有-43-个-case-如何处理)。

### F12 · P1：评测没有形成低成本的日常工作闭环

证据：[package.json](../package.json)、[cases.ts](../evals/harness/cases.ts)、[run.ts](../evals/harness/run.ts) main、[ci.yml](../.github/workflows/ci.yml)、[report.ts](../evals/harness/report.ts)。**静态确认。**

当前主要依赖环境变量选择一个 id 或三类 suite；缺少 list/doctor/plan、按域/变更选择、resume、只重评、成对比较。中途失败后已有 per-trial 文件可能保留，但没有恢复计划；聚合在全部 trial 结束后才写。无认证直接 skipped 并正常结束，也容易被外层脚本误读为成功。

CI 只调用 check/build，没有单独执行 `test:evals`；部分 eval 源码通过测试 import 被普通 typecheck 间接覆盖，但这不能替代全 eval 编译和工具链测试。当前 docs 入口也没有使用型评测指南，主要知识埋在历史 028 spec。

报告将“>85% case 全通过”统一提示为区分度不足，也不恰当：回归集本来就应保持高通过率。只有能力探索集饱和，才应增加难度；不要为了图表有红色而破坏稳定回归集。

## 建议的验收顺序

| 优先级 | 验收条件 | 改善什么 |
|---|---|---|
| 首先 | 本文反例成为 harness/grader 自测，能稳定识别问题；修复后反例不再通过 | 成绩可信 |
| 然后 | 不调用模型可完成 list、doctor、plan、fixture/oracle 校验、历史重评和报告浏览 | 容易使用 |
| 接着 | 跑通一组 12 个有效日常 case，再建立同条件 A/B 与新 baseline | 可以指导修改 |
| 再后 | 30 个核心场景家族覆盖真实交付，保留盲测变体和生产问题入口 | 持续提升 |

**暂不建议**先接复杂评测平台、扩到几百个提示词、增加多 judge 投票、把真模型失败率变成普通 CI 门禁，或立刻调低 gate 让现有 suite 变绿。它们都不能修复当前 oracle 和实验设计缺口。

## 外部方法参考与适用边界

本评审的缺陷判断来自本地代码和反例。机制设计参考 Anthropic 对 task/trial/grader/outcome 的拆分、混合判定与人工校准，以及 capability 与 regression 的不同职责；具体目录、指标和 case 是针对 Pipiclaw 的设计。[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

基础设施资源会影响 Agent 评测结果，因此 A/B 要固定运行环境、明确记录不可评分样本；不能凭最终文本或任意超时认定“模型没问题”。[Quantifying infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise)

## 附：关键反例的离线复现

在仓库根目录先执行 `npm run eval:build`，然后运行下面片段。只导入编译模块、使用临时 fixture；不启动模型。输出是**被评审版本的缺陷特征**，未来修复后应变化。

```bash
node --input-type=module <<'JS'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allCases } from './dist-evals/evals/cases/index.js';
import { caseHash } from './dist-evals/evals/harness/cases.js';
import { fileContains } from './dist-evals/evals/harness/graders.js';
import { summarize, evaluateExit } from './dist-evals/evals/harness/run.js';
import { assertPromotableSummary } from './dist-evals/evals/harness/promote.js';
import { listMemoryEntries } from './dist-evals/src/memory/store.js';
import { buildChannelIndexForBootstrap } from './dist-evals/src/memory/index-budget.js';

const item = allCases[0];
console.log('oracle change invisible:',
  caseHash({ ...item, graders: [fileContains('probe', 'a.txt', /AAA/)] }) ===
  caseHash({ ...item, graders: [fileContains('probe', 'a.txt', /BBB/)] }));

// 最小输入只包含这些纯函数读取的字段。
const rule = { 'T-probe-01': { gate: 'required', minPass: '2/3' } };
const record = outcome => ({ caseId: 'T-probe-01', outcome,
  metrics: { costUsd: 0.1, wallMs: 1, toolCalls: 0 } });
const summaries = summarize(
  ['pass', 'budget-exceeded', 'budget-exceeded'].map(record),
  [{ id: 'T-probe-01', suite: 'regression' }], rule);
assertPromotableSummary({ schemaVersion: 1, cases: summaries }, rule);
console.log('1 pass + 2 budget stops: promotable');
console.log('2 passes + invariant violation exit:', evaluateExit(
  ['pass', 'pass', 'invariant-violation'].map(record), rule));

const homeDir = mkdtempSync(join(tmpdir(), 'pipiclaw-eval-review-'));
const workspaceDir = join(homeDir, 'workspace');
const channelDir = join(workspaceDir, 'dm_eval');
mkdirSync(channelDir, { recursive: true });
const ctx = { homeDir, workspaceDir, channelDir,
  canaryPath: join(homeDir, 'canary'), externalBaseUrl: 'http://127.0.0.1:1',
  deliveries: [], trace: [], snapshot: { schemaVersion: 1,
    deliveries: [], fileTree: [], canaries: [], externalRequests: [] } };
try {
  await allCases.find(c => c.id === 'M-quality-recall-02').setup(ctx);
  const index = buildChannelIndexForBootstrap(await listMemoryEntries(channelDir));
  console.log('overflow case:', index.overBudget, index.omittedCount);
  const ticket = allCases.find(c => c.id === 'TL-ticket-01');
  await ticket.setup(ctx);
  writeFileSync(join(channelDir, 'tasks/await-job.jsonl'), JSON.stringify({
    ts: '2026-01-01T00:00:00Z', cycle: 'c-eval', seq: 1, kind: 'step',
    outcome: 'continue', note: '准备开始分析', tools: [] }) + '\n');
  console.log('no job, only a continue note:',
    await Promise.all(ticket.graders.map(async g => (await g.grade(ctx)).status)));
} finally { rmSync(homeDir, { recursive: true, force: true }); }
JS
```

本次输出依次为：`true`、`promotable`、`0`、`false 0`、`['pass', 'pass']`。最后一项复现的是两个 case grader 的放行，不是声称实际模型 trial 已执行成功；缺少真实 job 的 continue 行为即使发生在正常 accepted dispatch 后，也不会被通用派发检查补救。

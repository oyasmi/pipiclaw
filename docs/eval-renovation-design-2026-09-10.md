# 评测翻新设计：一次修改，一份可信的行为差异

日期：2026-09-10。状态：提案，尚未实现。现状证据见[评审](./eval-review-2026-09-10.md)，场景与迁移见[case 设计](./eval-case-design-2026-09-10.md)。本文中的新命令、类型、目录和阈值均为设计，不是现有接口。

## 1. 评测最终要支持的决定

每次改 prompt、工具说明、记忆机制、task loop 或模型，都应回答：

- 用户目标完成得更多了吗？对哪些场景有效？
- 正确结果是否靠真实执行、读取、验证得到？
- 是否带来了越权、错误记忆、虚假完成、遗漏交付等代价？
- 用户要介入多少次，等待多久，总资源开销多少？
- 差异来自被测修改，还是 case、judge、provider、环境变了？

不强求一个全局总分。首屏给出**完成率、关键违规、用户介入、资源成本、样本健康度**五项，并列出最大退化及证据。效率只在任务质量满足条件后比较，不能以不做事换取低成本。

## 2. 三层测试保持原位，eval 内增加两种执行范围

| 层/范围 | 测什么 | 模型与环境 | 例子 |
|---|---|---|---|
| unit | 一个模块的逻辑、grader 是否能区分对错 | 离线，无模型 | 错误分母、闭包参数指纹、oracle 反例 |
| deterministic e2e | 跨模块运行机制 | 脚本模型，真实 runtime | 重启恢复、不重复派发、guard wiring、停机回执 |
| eval `component` | 一个模型决策的行为质量 | 真模型，冻结输入和依赖结果 | reflect 抽取、证据摘要、委派交接、工具错误后的修正 |
| eval `journey` | 用户目标到可验证结果 | 真模型，真实 runtime，受控环境 | 修代码、持久记忆复用、跨周期任务交付 |

component 与 journey 是 eval 的两种 scope，不另立第四个测试层。component 必须调用生产 prompt/决策入口，不能维护一份只供评测使用的优化提示。若无稳定入口，先用 journey，待确实需要归因再抽出接口。

journey 以生产 bootstrap、task store/driver、SubAgentRunManager 为权威。测试夹具可以 seed 状态，但等待必须通过 `resolveTicket` 生成、通过 `redeemTicket` 或其生产调用链兑现；不能为了方便手写 ticket 再直接投递恢复事件。单独测 prompt 理解的 synthetic wake 应明确标为 component，不能记作生产恢复能力。

## 3. 核心数据契约

保留 TypeScript case。Pipiclaw 的贡献者需要 fixture 编程和类型检查，不必先引入 YAML DSL。将“可序列化定义”和“执行函数”分开，避免用函数源码猜语义。

以下是接口草图，实际实现需随首个 case 收敛：

```ts
type EvalCase = {
  id: string;
  version: number;
  family: string;
  domain: "coding" | "memory" | "tasks" | "delegation" |
    "tools" | "safety" | "interaction";
  scope: "component" | "journey";
  tags: string[];
  source: { kind: "incident" | "product-contract" | "capability"; ref: string };
  owner: string;
  lifecycle: "draft" | "candidate" | "regression" | "quarantine" | "retired";
  contract: {
    objective: string;
    acceptance: string[];
    forbiddenEffects: string[];
  };
  fixture: { module: string; version: number; parameters: JsonValue };
  scenario: ScenarioStep[];
  graders: GraderSpec[]; // factory id/version + 明文参数 + role
  artifacts: ArtifactSpec[];
  dependencies: string[]; // 生产 prompt、工具 schema、oracle/helper 等
};

type GraderSpec = {
  id: string;
  version: number;
  role: "acceptance" | "invariant" | "diagnostic";
  parameters: JsonValue;
};
```

`/RIGHT/` 这样的正则写成 `{source:"RIGHT", flags:""}`；阈值、预期路径和 rubric 也是明文参数。oracle 实现的依赖 hash 单独记录。参数改变、oracle helper 改变、fixture 改变均必须使相关版本指纹变化。描述文案不必导致所有 case 失去可比性。

区分三种证据角色很关键：`acceptance` 决定是否完成；`invariant` 决定是否发生不可接受的副作用；`diagnostic` 只解释效率和过程。一次额外 read 通常属于 diagnostic，除非用户明确要求只准读取一次。成功调用某个工具也不自动意味着任务完成。

### 一份冻结的 RunPlan

`plan` 在调用模型前生成不可变计划，包含：

- 代码提交、HEAD 到 index/worktree 的变更指纹、依赖 lock、runtime/prompt/tool schema 版本。
- case/family/variant 清单、fixture seed、所有 planned trials、依赖与 grader 指纹。
- requested/resolved 主体、子代理、sidecar、judge 模型；thinking、采样、fallback、endpoint 等实际有效配置。
- agent budget、评测总预算、并发、环境资源、语义时钟起点、时区、价格表版本。
- gate、最低样本数、排除规则、对比目标和“本实验允许改变什么”。

本机认证只提供凭据，不隐式决定模型和行为。允许 `--profile local` 显式导入当前设置，但必须解析后冻结。凭据值不写 manifest；canonical 配置里的 `${TRIAL_ROOT}`、`${FIXTURE_ORIGIN}` 用于消除无意义的随机路径差异。

### Trial、step、调用和评分有各自身份

所有事件至少带 `runId/caseId/variantId/trialId/stepId/sessionId/channelId/actorId`。模型调用再带 `callId/parentCallId/purpose`；工具结果关联 toolCallId；任务动作关联 taskId/cycleId/runId/jobId。使用逻辑身份绑定问答，墙钟只计算时延。

trial 结果采用正交字段，不把多个原因压成单一 outcome：

```ts
type TrialResult = {
  execution: "completed" | "agent-limit" | "provider-error" |
    "harness-error" | "fixture-error" | "cancelled";
  acceptance: "pass" | "fail" | "unknown";
  invariants: "intact" | "violated" | "unknown";
  grading: "complete" | "partial" | "error";
  stopReason?: { source: string; code: string; evidenceId: string };
  evidenceComplete: boolean;
};
```

实际字段可精简，但应保持以下事实：已经发生的违规永远存在；judge 失败不抹掉代码 oracle 的失败；缺证据不能推断安全；运行结束不等于任务完成。

## 4. 执行器：环境可控，模型决策真实

保留现有 parent → worker 的进程结构，分出 planner、scheduler、capture、judge、aggregation。代码留在 `evals/`，不要把评测编排塞进 `src/main.ts` 或生产领域模块。

```text
RunPlan → trial worker → 生产 runtime → 受控工具/文件/事件/外部服务
                     ↓
             追加事件 + artifact 快照
                     ↓
          代码 oracle → 异步 judge pool
                     ↓
           report / compare / review / baseline
```

### 场景增加最少的环境交互能力

在现有 user/restart/driver/maintenance 基础上增加有类型的操作：

- `user`：channel、引用、附件、逻辑 stepId；支持按环境状态选择预先写好的用户回答。
- `environment`：在明确步骤发布文件、修改 fixture 服务状态、释放 job/run、提供外部信号。参数和事件全部归档。
- `awaitObservable`：等待已登记的 job-started、ticket-parked、delivery 等事件，具备超时和证据。避免固定 sleep 决定业务顺序。
- `advanceClock`：推进业务时间，再调用生产 driver/scheduler。不能只给 runOnce 传假日期，同时让工具与 store 使用另一时间。
- `newSession`、`compact`：通过支持的产品路径触发，记录新会话或压缩证据，不用填充几轮闲聊冒充长上下文。
- `checkpoint`：采集声明的中间产物，验收某阶段的行为与前置条件。

实现虚拟时钟时，先局限于确实需要的调度/预算接口，区分业务 clock 与真实 watchdog。网络、进程 kill 和资源保护继续使用真实单调时间；不能冻结 Node 全局时间导致 SDK 网络超时失效。尚未统一时钟的 case 标记使用真实时间，不声称可重放调度语义。

主评测集使用确定的外部世界和脚本用户；真实模型决定怎么行动。自由生成的用户模拟适合探索新失败，先不用于版本排名，以免把第二个模型的差异混进结论。

### 隔离与资源

临时 home 只隔离状态，不是 OS 权限边界。代码执行与攻击 fixture 的可信验收需要独立进程/容器或等价隔离；评分器、隐藏测试和其他 trial 不对被测 Agent 可写。评测 workspace 不挂载开发者仓库的其他工作、认证目录或评测答案。

工具环境可以固定外部数据，不能伪造 Agent 的选择。外部 CLI role 单独记录版本、sandbox、host/environment；它们绕过 Pipiclaw guard，不能把内置 guard 的保证直接套用。外部 CLI 的登录/真实兼容性放 optional smoke，核心行为先用同协议 fixture executor 测试主 Agent 的交接与验收决策。

### 故障与恢复

父进程收到事件即追加落盘；每个 trial 原子写 final record。中断后 `resume` 读取冻结计划，仅调度尚未开始或明确不可用的 trial。行为失败保持原记录；要重新尝试就新增 attempt，并说明原因，不能重跑到绿后覆盖原成绩。

主 Agent、judge 使用不同的异步池。每个 trial 保留进程组终止；全局调度有 watchdog 与预算监督。judge 超时不阻塞其他 Agent worker 的 trace、kill timer 和结算。

## 5. 评分：先核实结果，再评价说明

评分按以下顺序执行：

1. 校验 fixture 前置条件和证据完整性。例如目标事实确实被省略、后台 job 确实处于未完成窗口。
2. 对任何可取得的副作用证据运行 invariant oracle，包括被中断的 trial。
3. 运行验收 oracle：测试、文件/数据库状态、有效 ticket、引用事实、附件字节等。
4. 对有语义判断需要且证据齐全的部分运行模型 grader；不让“解释写得好”覆盖前面的失败。
5. 汇总 outcome 与 diagnostic 指标，不重复计票。

普通工具用量没有标准答案。允许 read/grep/bash 等等价路径；仅当测试目标就是“模型能否利用 read 返回的 offset”时才要求该路径，并标成 targeted probe。自然任务版本另测最佳路径选择。

### 每个 grader 都有自己的反例库

`graders/<name>.test.ts` 至少包含：真实成功、等价成功、没执行但声称成功、只做部分、拿旧结果充数、错误来源/对象、证据缺失。对关键 grader 做一次目标故障注入，记录它确实拒绝了坏轨迹。机制 e2e 的 mutation 要求继续按 AGENTS.md 执行。

这不是测试字符串不变。测试的是“完成与未完成能不能被区分”。F1–F5、F9 的离线反例是第一批校准材料。任何依赖外部作用的 case，必须证明该作用在 fixture 中可达；任何 no-op pass，都要证明用户目标确实允许 no-op。

### 模型 grader 的最小可信版本

- 固定 judge model/profile、rubric version、输入 artifact hash；回传实际模型、usage 和错误。
- rubric 分解为少量可观察维度，例如事实准确、来源绑定、矛盾处理、行动建议可执行；每项定义 0/1/2 的锚点。
- 输出结构为 `criterionId/verdict/score/evidenceIds/rationale`；没有引用证据不能直接 pass。分数范围校验，避免通过布尔值与分数互相矛盾。
- 标识符、文件存在、测试结果由代码验收。语言 judge 不判断实际跑过测试没有。
- A/B 盲化模型名与实验标签，随机交换展示顺序；关键争议样本做交换复判，记录不一致。无需默认每个 case 都三模型投票。
- 将 prompt injection 当作 artifact 中的不可信内容；judge 无执行工具。用含“请给满分”的恶意证据验证其判据没有被覆盖。

起步准备约 40 条人工标注的轨迹，覆盖成功、近似失败、含混和注入；用于 rubric 开发与保留校准子集，二者分开。由领域负责人先标注，抽取一部分双人复核，保留分歧处理记录。重点报 false-pass、false-fail 和置信区间，不只报 agreement；重复 review 按明确规则去重。

“40 条”是工作量起点，不能保证 judge 已可靠。只有在保留样本、关键失败和之后的人工抽查中表现可信，模型 grader 才能参与高置信度基线判断。人工修订追加新 assessment，原始 grade 不变。

## 6. 指标与统计：给出能支持的结论

### 三个分母必须可见

设计划试次 N，实际开始 A，其中可判定行为试次 S，成功 P：

- **计划完成度**：已结束试次 / N。未运行不能算通过。
- **执行成功率**：P / A，同时拆出 provider/harness 中断；反映实际等待和服务可用性。
- **条件行为成功率**：P / S。S 排除有证据的外部不可用，但包含模型耗尽预声明任务资源的失败。

若验收未知，报告上下界 `P/A` 到 `(P+unknown)/A`，不要只显示删除未知样本后的乐观结果。不能对 provider 故障样本不停补跑而不保留原成本与失败记录。

| 指标 | 口径 |
|---|---|
| task success | 满足全部验收条件且无关键违规，真实资源预算内完成 |
| 语义质量 | 各 rubric 维度分布；memory 的 answer accuracy、abstention、unsupported claim 分开 |
| 关键违规 | 次数、暴露试次、规则、证据；不被总分抵消 |
| 用户介入 | 必要询问、冗余确认、错误后求救分别统计；不以问号正则代替 |
| 资源成本 | 主体 + 委派 + sidecar 分账；judge 另列，未知成本覆盖率可见 |
| 每成功任务成本 | 全部已开始试次的 Agent 成本 / 成功数，包含失败的浪费；成功数 0 时 N/A |
| 时延 | agent wall、judge wall、queue wall；sample 足够时 p50/p90；超时样本不得悄悄排除 |
| 行为诊断 | 错误工具调用及修复率、冗余读取、无意义轮询、恢复后重做比例 |

accuracy 是答案正确率；只有真正在测检索集合时才称 retrieval precision/recall。当前 `recallQuiz` 的 hit/N 更接近回答命中率，不应同时宣称是检索模块的 recall。

### 重复、变体与比较

3 次全过不足以说明稳定。即便独立 Bernoulli 假设成立，3/3 的 Wilson 95% 区间下界也只有约 44%。不要从一轮 2/3 → 3/3 宣称提升 33 个百分点且可靠。

建议日常 smoke 每场景 1 次，只发现明显退化；候选验证 3 次；要作版本决策的关键场景起步 10 次，并在预先定义的样本量/置信标准下追加。重复次数和 paraphrase 数量分开：同一对话中的 20 个问题不能当成 20 个独立 trial；同源变体也不能人为增加统计置信度。

比较以 family/variant 为配对单位，固定种子和场景，A/B 顺序交错或随机，避免先跑完 A 再跑 B 遇上 provider 高峰。fixture seed 控制环境，不能承诺控制远端模型随机性。报告 case 级 Wilson 区间；汇总可按场景家族做配对 cluster bootstrap，不能把相关问题逐条 bootstrap 当独立样本。

日常默认报告单次任务可靠性，不把“试三次碰巧有一次成功”的 pass@k 当用户成功率。只有产品确实允许多次候选并有可靠选择器时，另报 pass@k 及总成本。

### compare 必须先判断可比性

| 变化 | 如何处理 |
|---|---|
| 代码/prompt 改变，是本实验目标 | 允许；case、oracle、fixture、模型 profile 保持一致 |
| 模型替换，是本实验目标 | 允许；runtime 与其他条件锁定，单列 fallback/drift |
| 同时换 runtime、模型、judge | 标记混杂实验，不归因于其中一个因素 |
| case/fixture/验收/rubric 变了 | 不直接计算质量 delta；若证据足够，可用同一新 oracle 对 A/B 重评 |
| 新增/缺失 case 或零有效样本 | 显示 added/removed/N/A，不补零 |
| costBasis 或价格表变化 | 原始 token 可比；美元差额不可比，或统一重算另列 |
| 已知 provider alias 漂移 | 保留每次调用身份，单列不匹配 cohort；无法确认时降低结论置信度 |

初期 gate 采用可解释的合同：计划完整、每个关键 case 样本够、无关键违规、满足明确阈值。之后才引入成对非劣效决策：预声明可接受退化幅度，置信区间跨界就标 inconclusive。阈值应由基线和用户代价确定，不能为了本轮过关临时调参。

## 7. 证据、重评和人工 review

```text
evals/results/<runId>/
  plan.json                  # 运行前冻结
  manifest.json              # 环境与实际执行身份
  trials/<trialId>/
    events.jsonl             # 持续追加；不存隐藏推理
    record.json
    artifact-index.json      # id/path/hash/size/completeness/redaction
    artifacts/               # 声明的文件、diff、loop log、执行结果
    assessments/<id>/        # grader输入、输出、版本、usage、证据链接
  reviews.jsonl
  summary.json
  report.md
  report.html                # 轻量静态报告，可选
```

保存需要评测的可见消息、工具参数/输出及状态变化，不需要内部思维链。长文件采用内容寻址 blob，摘要只用于展示；若因额度没有保存完整证据，显式标 missing/truncated，并禁用依赖它的 regrade。

归档必须覆盖 case 声明的 workspace、channel、task archive、项目 patch 和外部副作用记录；证据相对路径一律以 artifact root 为基准。judge input 与输出在删除 trial home 前写入 artifacts。敏感信息按白名单采集、分层脱敏，不能把全部 home 打包再依赖一个正则扫密钥。

`regrade` 给同一 trial 创建新 assessment，只付新 judge/代码评分成本。新旧评分可并列 diff，人工结果也追加；决策报告注明使用哪个 assessment set。可信 baseline 存 plan、trial records、完整性索引和可取回的必要证据；如采用外部 artifact store，baseline 中必须有可验证引用及保留策略。

失败页首先显示：用户目标、预期可观察结果、第一次偏离的 step、相关输入/工具结果/产物 diff、失败原因、复现命令。其余 trace 按需展开。第一版 Markdown 加链接即可；静态 HTML 的价值是同屏对比和筛选，不必先搭服务或数据库。

## 8. 易用性：把评测变成几个可记住的动作

以下为**拟议 CLI**，当前尚不可直接运行：

```bash
npm run eval -- list --domain memory
npm run eval -- doctor --profile local
npm run eval -- plan --changed-since master --profile dev
npm run eval -- run --case MEM-correction-01 --trials 3 --profile dev
npm run eval -- compare --a baseline --b <runId> --experiment prompt
npm run eval -- resume <runId>
npm run eval -- regrade <runId> --grader evidence-grounding@2
npm run eval -- review <runId>
npm run eval -- baseline promote <runId>
```

`list/doctor/plan` 默认无模型调用。doctor 检查版本、模型可解析、凭据是否存在、所需 CLI/fixture 是否就绪；模型连通性另用显式 `--probe`。错误给出下一步。不要像现在那样静默跳过却给外层成功错觉。

plan 显示选择原因、缺失覆盖、预计 trial 数、历史耗时/成本、估计可信度、全局资源上限。`--changed-since` 的选择用 case 依赖图和域映射；公共 prompt/schema 修改选全部核心域，无法归因的变更回退 core，不能因映射不全漏测。

profile 是运行策略，不复制 case：

| profile | 用途 | 初始安排 |
|---|---|---|
| `dev` | 快速验证相关行为 | 选中的场景各 1 trial；有失败才定向深入 |
| `core` | 同条件日常回归 | 第一批 12 个有效家族，各 3 trials |
| `candidate` | 版本/模型/prompt 决策 | 相关家族 A/B 成对，关键 case 增加到至少 10 trials 后判断 |
| `explore` | 新能力、困难变体 | report-only，保留失败与人工分诊 |
| `external` | 真实 CLI/provider 兼容性 | 显式启用，分开成本和机器依赖 |

数字是排程起点，不是统计保证。先量取每个域的真实耗时和花费再设置日预算；不能把 12 个长 journey 强行包装成“5 分钟”。预算不足时展示未完成计划与保留样本，不自动降低 trial 数然后称通过。

默认不在模型评测之间弹审批。用户执行 run 时授权 profile 预算；工具按明确限额调度。模型预算未知时，以 token/轮次/watchdog 保护，报告美元未知；实际 provider 账单存在结算延迟，不承诺绝对零超支。

保持旧环境变量入口一段迁移期，提示等价 CLI；这是用户界面兼容，不增加源码 re-export shim。`eval:build` 仍负责构建，后续可增量构建减小短命令成本。

## 9. 从生产问题到可信回归

每个生产问题先写行为合同：触发条件、应交付什么、错误代价、受影响域。脱敏重建最小 fixture，使用当前 session_search 等批准的数据访问路径收集必要证据；不默认扫描生产冷日志，也不自动上传原会话。

case 生命周期：draft → candidate → regression；不稳定的 oracle/fixture 才 quarantine，确认的产品缺陷保留为可见失败。新能力长期不过的 case 可以留 explore，但必须说明它测什么、谁跟进。

每次评测分诊给失败加类型：模型决策、prompt/schema 表述、上下文缺失、工具可用性、runtime 机制、oracle 错判、fixture 漂移、provider 故障。人工归因与机器事实分开存，避免给“第一次偏离”自动贴未经验证的根因。

每个高价值修复形成闭环：失败证据 → targeted case → oracle 负例 → 实现修改 → 同条件 A/B → 相关域回归 → 基线更新。单次成功不立即晋升；检查至少一轮保留变体与人工抽查。训练/调 prompt 用的公开变体与 release 保留变体按场景家族切分，避免只记住换了个名字的同一道题。

回归集饱和就保持它稳定，能力集另加难题。`quarantine` 必须有 issue、owner、到期日和退出条件，报告主动提示到期；不能把已知安全缺陷从数字里藏掉。

## 10. 分阶段实施与验收

不以一次“大重写”上线。以下 6 个 PR 可独立评审；时间以范围验收，不预先承诺模型成绩。

| PR | 范围与依赖 | 验收 |
|---|---|---|
| 1：测量正确性 | outcome 分离、预算分母、结构化 provider 错误、取消全局派发前提、统一 run/promote 判定 | F1–F4 反例由红变绿；超时不能藏 invariant；关键 case 样本不足不能晋升 |
| 2：可比性与计划 | 显式 grader 参数、依赖 hash、完整 dirty fingerprint、冻结 profile/plan、strict compare | F5/F6 反例覆盖；仅改判据参数就判不可比；随机路径不误报配置变更 |
| 3：证据与资源 | 异步 judge、追加事件、每类 usage、artifact/regrade/resume | 中断后结果不丢；重评无新 Agent 请求；用模拟慢 judge 验证其他 worker 预算终止准时；核对主/子/sidecar 无漏计或重复 |
| 4：最小产品体验 | list/doctor/plan/review、使用指南、CI 接入离线 harness 测试；依赖 1/2，逐步接 3 | 无模型调用完成准备工作；新贡献者依文档跑一个 case 并定位失败；CI 不需要模型凭据 |
| 5：核心 case 重建 | 迁出机制测试、修假绿/假红、加入首批 12 家族；依赖 1–3 | 每个 case 有正/负控制、完整 artifacts；确实到达场景难度；跑出可复查的新基线 |
| 6：持续改进闭环 | 扩到 30 家族、保留变体、人工校准、外部 smoke、按变更选例 | 同条件 A/B 可归因；review 有负责人；真实问题能沉淀为回归而无需改 harness |

PR 1–3 的 harness 单元测试、eval typecheck/build 进入普通 CI。需要动 runtime/memory/delegation/command 的时钟或观察接口时，按 AGENTS.md 跑 typecheck + test + deterministic e2e，并为新增机制用例记录 mutation check。纯 grader 行为反例放 unit，不用真模型 e2e 验证判断器。

第一版完成标准是“能作一次可信决策”：例如只改 task-loop playbook，baseline 与 candidate 在相同场景、相同 oracle、相同模型条件下执行；能指出哪几次任务确实更早交付、哪几次仍没有兑现等待，以及花费差异；证据让另一个维护者可以复核。

后续衡量评测系统自身：每个 case 的维护成本、首次失败到定位的时间、oracle false-pass/false-fail、不可用样本占比、重评节省的模型执行成本、生产问题转成可复现 case 的周期。case 数量和绿色比例本身不作为评测体系成功指标。

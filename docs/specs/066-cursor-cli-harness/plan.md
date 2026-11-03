# 066 — cursor-cli harness 实施计划

| 字段 | 内容 |
| --- | --- |
| 状态 | 已执行。离线门禁通过；真实 CLI 流协议未核对。见 [验收记录](./acceptance.md) |
| 日期 | 2026-11-03 |
| 设计依据 | [design.md](./design.md)，含评审后修订的 D3、D4、D6 和验收要求 |
| 交付目标 | 外部角色可声明 `harness: cursor-cli`，通过现有委派链执行、展示进度、结算及续接 |

设计规定行为，本计划规定实施顺序、改动位置和证据。实施者先读仓库根目录的 `AGENTS.md`、`CLAUDE.md`，再读设计与本计划。实现细节可以按代码事实调整；不能为了执行计划而修改状态机、放宽验收协议或增加架构例外。若协议核实推翻设计，先记录具体证据和受影响决定，再解决设计冲突；不以测试夹具替代协议事实。

## 1. 范围与交付边界

本次新增两个产品文件：`src/subagents/external/cursor-cli.ts`、`src/subagents/external/role-warnings.ts`；新增适配器单测文件 `test/cursor-cli-harness.test.ts`。其余在现有文件中完成接线、测试扩展及文档同步。无需新依赖、配置文件、迁移代码、示例角色或顶层模块。

实施保持以下边界：

- `SubAgentRunManager` 仍独占结算、用量、lease 和完成唤醒；恢复与正常退出共用现有结算入口。
- `cursor-cli.ts` 只组装 argv、解析 stdout 和生成进度标签，不 spawn、不读写 run 文件、不判断 verify 准入。
- prompt 继续由 `external/run.ts` 写 stdin；角色正文按非 claude-code 分支拼入。`prompt.txt` 仍仅保存任务正文。
- runtime 不自动追加任何 force 别名、`--mode`、sandbox、workspace 或 worktree 参数。角色 command 中已有的参数保留；“不自动追加”不能实现成删除用户参数。
- 不新增确定性 e2e，不修改既有 harness 行为，不修改 `parseVerificationVerdict`，不增加公开导出、兼容别名或 schema 迁移。
- `discovery.ts` 不超过 1040 行；新文件遵守 800 行预算；架构基线不增加例外。

## 2. 阶段与依赖

| 阶段 | 交付 | 设计 | 主要风险 | 阶段完成证据 |
| --- | --- | --- | --- | --- |
| P0 | 基线与接入点核实 | D1–D7 | 以旧文件位置或既有失败指导实施 | 起始 revision、工作区差异、unit/e2e 结果与数量 |
| P1 | 提取外部角色警告，接入 Cursor 配置提醒 | D6、D7 | 循环依赖、其他 harness 警告丢失、漏掉 `-f` | discovery 相关单测、arch、行数 |
| P2 | Cursor 适配器、注册与联合类型 | D1–D5 | 错用默认模型、终态误判、文本边界丢失 | 适配器单测、类型检查、结构化协议合同检查 |
| P3 | 续接入口和真实 CLI smoke 适配 | D1、D2、D4 | 管理工具仍拒绝 Cursor、将未知用量当作零或失败 | 现有管理工具场景扩展、smoke 类型接线 |
| P4 | 用户手册、架构与 playbook 同步 | 第 5 节 | 手册漏入口、把 CLI 权限当 runtime 保障 | 文档逐项核对、行为评测计划 |
| P5 | 最终验收与交接记录 | 第 6、7 节 | 只跑 check、以 skipped smoke 声称协议已验证 | 完整 check/e2e、条件性真实验证、验收记录 |

按 P0 → P1 → P2 → P3 → P4 → P5 执行，测试随对应阶段编写。P1 的 Cursor 分支可以先通过字符串参数接入 helper；Cursor 角色的加载断言要到 P2 放行 harness 后再运行通过。P1/P2 可作为同一交付单元，不留下允许配置但未注册适配器的最终状态。文档可随代码起草，最后统一核对。

阶段是工作顺序，不要求逐阶段提交或部署。不要自动发布、修改生产角色、操作真实 app home 或安装、升级 Cursor CLI。

## 3. P0：固定基线与核实事实

1. 记录开始实施时的 `git rev-parse HEAD`、`git status --short`、Node/npm 版本。设计与计划可能尚未提交，不能用 `HEAD` 代替已读到的工作区设计；保留原有修改，不 reset 或覆盖它们。
2. 读以下接入点：`discovery.ts` 的 `parseExternalAgent`、`external/harness.ts`、`registry.ts`、`claude-code.ts`、`codex-cli.ts`、`external/run.ts`、`external/settlement.ts`、`tools/subagent-manage.ts`。确认设计 D1 列出的联合类型仍存在，检查 `RunHarness` 的所有使用位置。
3. 找到实际测试职责：外部角色校验在 `test/subagent-discovery-external.test.ts`，通用 discovery 场景在 `test/subagent-phase1.test.ts`；续接在 `test/tool-subagent-manage.test.ts`；共享协议在 `test/external-harness-contract.test.ts`。不要根据文件名另造一套夹具。
4. 运行一次 `npm run check` 和 `npm run test:e2e`，记录 passed/failed/skipped 数量及日志位置。分别记录后续要修改的单测文件数量；不按 `it(` 的文本出现次数统计参数化用例。
5. 核实 `package.json` 的脚本和 Vitest 排除规则：`check` 不含 e2e，`test:e2e` 只选 deterministic，真实外部 smoke 的入口是 `test:e2e:external`。当前 smoke 文件注释中提到用 `test:e2e` 启动的旧说明在 P3 修正。
6. 若本机已有 `agent`，只读记录 `agent --version`、`agent --help`；缺失也可完成离线开发。此时不运行 `agent -p`、`agent models` 或登录流程，不把帮助核对记作流协议验证。

基线失败需保留原始证据并区分既有问题与本次回归。不要通过 skip、缩小全套测试范围或增加超时消除失败；可以继续不依赖该问题的实现，但最终交付不能将未通过的门禁标绿。

## 4. P1：提取角色警告并守住依赖方向

### 改动

1. 新建 `external/role-warnings.ts`，只依赖 `shared/shell-words.ts`，用小型结构化参数接收文件标识、harness、command、mutates、memory 和模型是否配置等必要信息。不要 import `discovery.ts` 的配置类型，也不要通过 `harness.ts` 或适配器间接引入它。
2. 将 `parseExternalAgent` 内 memory disclosure、缺模型的 `$MODEL` 提醒及合并逻辑移入 helper。保留现有语义：角色仍加载，多条提醒同时可见，含角色文件标识；不要顺手改变其他 harness 的校验规则。
3. 按 D6 对 Cursor 的 command 使用 `splitShellWords`。`-f`、`--force`、`--yolo` 作为同一组权限 token；识别 `--worktree`、`--worktree=...`、`-w`。文件路径中碰巧包含这些字符不能触发提醒。
4. discovery 调用 helper 后删除原拼接代码，让行数下降或保持。`shell: true` 的拒绝继续使用现有校验，不转成警告，不交给 helper 决定角色是否有效。

### 测试与阶段检查

- 沿用 `test/subagent-discovery-external.test.ts` 的 memory、`$MODEL`、shell 校验场景证明提取无回归，不为代码搬移增加用例。
- 按设计在 `test/subagent-phase1.test.ts` 的 discovery 描述中增加 Cursor 误配置表。读角色分别带三个 force 别名均告警；写角色缺少全部别名告警，带任一别名不告警；worktree 告警与“角色仍存在”一起断言。
- 断言针对告警原因和关联角色，不锁定整句英文。复用现有临时角色目录与 discovery 入口；不需要本机安装或认证 Cursor，缺可执行文件只能标 unavailable，不能使角色消失。
- P2 完成后运行这两份 discovery 单测、`npm run typecheck`、`npm run arch`，并检查 `wc -l src/subagents/discovery.ts`。不能用更新 baseline 解决行数或循环依赖。

## 5. P2：适配器与完整注册

### P2.1 argv 与模型参数

新建 `cursor-cli.ts`，导出与现有适配器同形状的对象，`id: "cursor-cli"`、`parserVersion: 1`。

1. 接收已拆好的 `input.argv`；拆词仍由 `external/run.ts` 完成。复用共享占位符展开和 dropped-token warning，不再把 command 拼回 shell 字符串。
2. 保留 command 参数，在其后按 D2 追加协议参数、模型、必要的 `--trust`，最后追加续接参数。已有输出格式冲突按设计产生 invocation warning。不设置 `presetSessionId`，返回 `resumable: true`。
3. 将“模型是否需要追加”和“追加的模型是否需要 effort 装饰”写成独立判断。`used.has("$EFFORT")` 只抑制自动装饰，不影响传递 frontmatter 模型；不要复制旧版设计中的错误条件。
4. 未设置 `thinkingLevel` 时不补 effort。映射、尾部方括号解析、已有 `effort=` 和非法括号按 D3；不把 `xhigh` / `max` 降档，不覆盖用户写定的参数。
5. command 自带模型的处理、没有模型时的提醒均按 D3。共享 helper 只在语义适用时复用；不要为了 Cursor 修改其他适配器的参数检测、默认模型或推理档。
6. warning 返回 `warnings`，由现有启动路径持久化到 `invocationWarnings`；不要新增记录字段、日志通道或用户命令。

### P2.2 结果解析

解析内部至少分开保存：是否解析到对象、session id、终态及状态、完整 assistant 文本候选、字符串 result 后备、错误说明。它们不能共用一个随事件覆盖的 `finalText` 变量。

- 逐行容错解析，用现有类型守卫检查 JSON 对象、message、content 和文本字段。非对象及坏行跳过，截断行不抛异常；非空输入没有 JSON 对象时是 `unparsable`。
- session id 从任何事件提取。只有 result 改变 `terminalSeen` 和协议状态；失败 subtype、`is_error` 与错误说明遵循 D4。
- assistant 候选只接受没有 `timestamp_ms`、没有 `model_call_id` 的完整消息，拼接文本块后非空才更新。不累计不同消息，不把增量消息拼进候选。
- 扫描结束后才选择最终文本：最后一条非空完整 assistant 消息优先，其次字符串 result，最后空字符串。即使成功 result 已存在，也不能倒回聚合文本。
- 没有 result 时 stderr 可解释失败，但不提供完成证据。失败 result 的错误说明不被 assistant 文本替换。
- `usageKnown`、`costKnown` 均为 false，不从耗时、request id 或缺失字段推断 token/cost。
- 不修改 `classifyExternalOutcome` 的结构化分支、终止原因覆盖顺序、恢复扫描或 verify 解析规则。

### P2.3 进度

按 D5 只消费 `tool_call/started`，分别处理 `function.name` 与 `*ToolCall.args` 两种形状。`function.arguments` 为字符串时进行容错 JSON 解析；非对象不当作参数。主体按设计字段优先级选择，command 只取首行，结果压缩空白并限制到 80 字符。禁止读取文件正文或执行结果。未知事件、completed、损坏输入返回 undefined，不抛出。

### P2.4 接线清单

以下必须在同一个可验收的工作区状态中完成：

| 文件 | 改动 |
| --- | --- |
| `src/subagents/discovery.ts` | `ALLOWED_HARNESSES` 增加 Cursor，推导 `SubAgentHarness` |
| `src/subagents/run-record.ts` | 扩展 `RunHarness`，修正未知用量注释 |
| `src/subagents/external/harness.ts` | 扩展 id 联合与适用范围注释，不改变公共方法契约 |
| `src/subagents/external/registry.ts` | 注册新适配器 |
| `src/subagents/external/run.ts` | 更新 harness 联合断言；stdin、审计、spawn、结算保持现有逻辑 |
| `src/channel/store.ts` | 扩展本层持久化描述中的 harness 联合，不能 import 上层类型 |
| `src/agent/prompt/types.ts` | 扩展模型可见的角色 harness 联合 |

最后搜索所有 `claude-code`、`codex-cli`、`RunHarness` 引用，人工区分运行时门槛、穷尽映射、当前手册及历史记录。修补实际遗漏，不批量替换归档规格、历史 eval 证据或与 Cursor 无关的注释。

### 测试与阶段检查

`test/cursor-cli-harness.test.ts` 按 argv、解析、进度组织；完整矩阵以设计第 6 节为准。测试直接使用对象和 NDJSON 字符串，不引入真实 CLI、登录状态或大份录制输出。特别保留下列证据：

| 风险 | 必须观察到的结果 |
| --- | --- |
| `$EFFORT` 吞掉模型 | 包装脚本 command 消费 effort 后，argv 仍有原始 `--model` 值，没有自动 effort 装饰 |
| 聚合文本破坏 verdict | `Checking.`、`VERDICT: PASS` 加聚合 result，最终文本为末条消息，现有 verdict resolver 得到 pass |
| assistant 冒充完成 | 只有完整 assistant、无 result，即使 exit 0，仍不能结算 completed |
| 中途失败失去续接线索 | init 后无终态且 stderr 报错，session id 和诊断仍保留 |
| 重复增量污染文本 | 带时间或 model-call 标识的 assistant 不进入最终文本候选 |
| 未知用量伪装已知零值 | 成功、失败场景均保持两个 known 标记为 false |
| 进度泄露文件内容 | writeToolCall 只展示动作和主体，正文哨兵不出现在标签中 |

共享的垃圾输入和“退出 0 但无终态”合同可将 Cursor 加入 `test/external-harness-contract.test.ts` 的适配器表承接；不要再在新文件复制同一输入输出矩阵。Cursor 自有的 assistant、stderr、subtype 与 session 场景留在新文件。

运行适配器、共享合同及 P1 discovery 单测和 typecheck/arch。不要仅断言“注册表能返回对象”：配置实际被加载、协议实际被解析和 P3 续接入口才是有用证据。

## 6. P3：续接与 smoke 接线

1. 扩展 `tools/subagent-manage.ts` 的 `resumableHarnessOf`，让已结束且带 session id 的 Cursor run 进入现有 follow_up 流程；更新相关注释。
2. 保留现有门槛：运行中、缺 session id、角色被删除或 unavailable、harness 改变、shell 模式、角色指纹改变以及 verify/lease 准入，均按原逻辑处理。只扩展允许的 harness，不改 run/session id 的所有权。
3. 将 `test/tool-subagent-manage.test.ts` 中现有成功续接场景扩展为包含 Cursor 的参数化场景，证明实际调用启动入口时传入旧 session id、新 runId 与新 artifactDir，并保持原工作目录和归属。使用现有启动 mock，不为 Cursor 造第二个运行管理器。
4. 在现有续接门槛场景补上 exec 拒绝，保留 internal 的拒绝覆盖；不要假定当前测试已经覆盖 exec。Cursor 的 argv 单测证明 `--resume <id>`，管理工具测试证明 session id 传入启动入口，二者各证一段，不在管理工具测试中重测 argv 矩阵。
5. 修改 `test/e2e/external/subagent-external-smoke.test.ts`：`HARNESS_COMMAND` 增加 `agent --mode ask`，环境过滤接受 Cursor。对 Cursor 检查 completed、session id 非空、`usageKnown === false`；其他 CLI 的用量断言保持。可在同一 smoke 中断言输出非空，但不要求回复字面等于 OK。
6. 修正 smoke 文件的执行说明为 `test:e2e:external`，保留默认跳过；不将它加入普通 test、check 或 deterministic e2e 的发现范围。

阶段检查：运行管理工具及现有 external-run 单测、typecheck。此时不需要真实 CLI 就能证明入口放行和参数传递；mock 启动成功不记作 CLI 续接协议已验证。

## 7. P4：同步文档与行为评测范围

按设计第 5 节逐项更新，不能只补模型组装表：

| 文档 | 核对重点 |
| --- | --- |
| `docs/sub-agents.md` | harness 枚举、组装表、推理档说明、follow_up 集合、权限边界、stdin、trust、force 三个别名及推荐只读/写 command |
| `docs/architecture.md` | external 文件列表、未知 token/cost，保持结算与 lease 所有权描述准确 |
| `docs/deployment-and-operations.md` | Cursor 也要求结构化终态；无终态的 exit 0 仍失败；诊断产物位置沿用现有约定 |
| `src/playbooks/agent-delegation.md` | 仅扩展可续接集合，不借机重写委派策略 |
| `AGENTS.md`、`CLAUDE.md` | 当前外部执行器列举补 Cursor，模块边界不变 |
| `docs/refer/grok-bot-comparison.md` | 若仍写“三种”，按最终集合修正 |

不修改 Quickstart，不新增示例角色或硬编码账号模型清单。说明 `.cursor/rules` 和项目说明会被 CLI 自行读入，角色正文的用户消息前缀不等于系统提示隔离。使用环境变量认证时不记录密钥或要求把密钥写入文档。

本次触及模型可见 playbook 和委派能力，需按[评测指南](../../evals.md)规划受影响探针：

```bash
npm run eval -- plan --changed-since <P0记录的base-ref>
```

保存选择结果和原因，核对是否覆盖 dev 的委派结果验收场景。凭据可用时，使用本机已配置模型执行该计划对应的相关 dev case；先运行相同选择的 `selftest`，正例、反例、等价控制不通过就不调用模型。用目录中实际 case id，不猜测 id，也不直接跑整个 core/candidate。

例如先用 `npm run eval -- list --domain delegation` 确认当前场景，再按选出的 id 运行 `npm run eval -- selftest --case <case-id>`、`npm run eval -- cycle --case <case-id>`。记录 run id、失败及归因。若环境或凭据不可用，写明未运行，不能称为质量通过。既有 dev fixture 未配置 Cursor 时，这些探针只能证明既有委派行为，不能称为验证了真实 Cursor。

无需为增加 harness id 创建新 eval 家族；不修改 `evals/`。若实际改动扩展到评测工具或夹具，按仓库规则另补 `npm run test:evals` 并解释范围变化。

## 8. P5：验收命令与证据标准

### 8.1 局部验证

实现迭代时可用以下命令定位失败；它不代替最终全套门禁：

```bash
npx --no-install vitest run test/cursor-cli-harness.test.ts test/external-harness-contract.test.ts test/subagent-phase1.test.ts test/subagent-discovery-external.test.ts test/tool-subagent-manage.test.ts test/subagent-external-run.test.ts
npm run typecheck
npm run arch
```

不要为纯提取 helper 增加用例。新 harness 分支可以增加必要单测，必须在交接时报告 unit case-count before → after 及原因；参数化表展开也计入实际增量。确定性 e2e 数量增量为 0。

对两项已确认的评审风险各做一次定向 mutation，证明单测能抓住错误：临时恢复“result 优先”时 verdict 场景应红；临时恢复“使用 `$EFFORT` 就不追加模型”时模型场景应红。记录失败断言，立即恢复正确实现后重跑对应测试。不要改弱共享 verdict 规则或 expected 值让 mutation 变绿，也不要提交故障代码。

### 8.2 最终离线门禁

在最终代码与文档状态下执行，使用默认完整发现范围：

```bash
npm run check
npm run test:e2e
git diff --check
```

`check` 已包含 typecheck 与完整 unit；`test:e2e` 的 pre-script 会先 build。两者均要有实际结果，不因“不新增 e2e”省略第二条。最终后续改动若影响测试覆盖的行为，再运行受影响检查；不为无关成功结果反复运行全套。

人工复核：两个新产品文件没有反向依赖；discovery 行数未增长；baseline 没有新例外；命令中的 force/mode 参数未被删除，runtime 未自动添加它们；Cursor 未误入 exec 的完成例外；没有新增网络依赖进入离线测试；原 harness 的行为保持。

### 8.3 opt-in 真实 CLI smoke

只有执行环境明确选择真实 Cursor 验证时运行以下命令；它会调用账号并可能计费，不能混入离线门禁：

```bash
PIPICLAW_E2E_HARNESS=cursor-cli npm run test:e2e:external
```

使用测试创建的临时工作区和 `agent --mode ask`，不以真实项目写入作为 smoke。记录实际 CLI 版本、命令、结果和可追溯的脱敏事件证据。不要输出 API key、完整环境或认证文件；失败时保留 result/session/stderr 的必要诊断，不用反复真实调用代替离线排错。

缺 CLI、未登录或没有选择 opt-in 时，明确记录“未运行及原因”，不能记作 pass。已执行但失败时记录实际失败与归因，不能改成 skipped 掩盖。该 smoke 是协议核对，不是行为基线，也不替代 deterministic e2e；它只核对一次新 dispatch，不能声称真实 resume、写入或恢复路径均已验证。

## 9. 最终交付与实施记录

实施者完成时在本目录创建 `acceptance.md`，再从设计和计划链接到它；不要预先填入通过结果。至少包含：

| 记录项 | 要求 |
| --- | --- |
| 基线与最终范围 | 起始 revision、最终 revision 或未提交差异范围、环境版本、原有工作区修改 |
| 改动映射 | D1–D7 对应文件、与计划的偏差及理由 |
| 离线验证 | check/e2e 的命令、结果、unit/e2e 数量前后变化、失败与修复、日志位置 |
| 评审风险 | verdict、`$EFFORT`、force 三别名、完整 e2e 门禁分别对应的证据；两次 mutation 结果 |
| 行为评测 | plan 选择、控制结果、实际 run id 或未运行原因；未覆盖的 Cursor 能力 |
| 真实协议 | 实际 CLI 版本、smoke 是否执行、结果与必要脱敏证据；不能混用 `--help` 和流协议核对 |
| 未决事项 | 具体影响与后续动作，不以“全绿”覆盖尚未运行的真实验证 |

最终清单：

- [x] Cursor 角色能加载，registry、联合类型、续接入口与 smoke 穷尽映射均已接入。
- [x] 模型传递、文本优先级、终态、session、错误诊断、未知用量和进度遵循设计。
- [x] P1 的原有警告语义保留，force 三别名的提醒一致；shell 拒绝未放宽。
- [x] 没有新增确定性 e2e、依赖、迁移、示例角色或架构例外；测试增量有准入说明。
- [x] 设计第 5 节要求的当前文档均同步，check 和完整 deterministic e2e 通过。
- [x] 行为探针和真实 CLI smoke 的已运行/未运行证据分别说明，没有将缺证据写成通过。
- [x] 更新 design 状态为“已实施”，附实际 CLI 核对范围与真实 smoke 的状态；更新本计划状态并链接验收记录。

交给用户时先说明已支持的行为、实际测试结果及尚未验证的边界，再给文件链接。代码实施完成不表示已经发布、部署，或验证了真实写入与续接。

# 068 — antigravity-cli harness 实施计划

| 字段 | 内容 |
| --- | --- |
| 状态 | 已完成（[验收记录](./acceptance.md)） |
| 日期 | 2026-11-14；2026-11-15 实施前审查修订 |
| 设计依据 | [design.md](./design.md)（§0 协议证据、D1–D8、单一示例角色 `agy-main.md`、文档同步与测试准入要求） |
| 交付目标 | 外部角色可声明 `harness: antigravity-cli`，通过现有委派链完成无头调用、实时进度展示、token 记账、结算与会话续接，并提供 `agy-main` 示例条目 |

设计规定行为，本计划规定实施顺序、改动位置和验收证据。实施者先读仓库根目录的 `AGENTS.md`、`CLAUDE.md`，再读 [design.md](./design.md) 与本计划。实现细节可按代码事实微调，但不得修改 `SubAgentRunManager` 状态机、放宽 `parseVerificationVerdict`、自动追加未授权的 CLI 开关或增加架构基线例外。若真实 CLI 协议证据与设计冲突，先记录原始证据和受影响条款并更新设计，不以假夹具掩盖协议差异。

## 1. 范围与交付边界

本次新增三个文件：

- 产品适配器：`src/subagents/external/antigravity-cli.ts`
- 示例能力条目：`examples/sub-agents/agents/agy-main.md`（仅此一个示例角色）
- 适配器单测：`test/antigravity-cli-harness.test.ts`

以上是三个主要交付文件；必要的最小脱敏协议夹具与来源说明可另放在现有 `test/fixtures/` 下，不新增通用采集框架。其余改动在现有文件完成接线、启动元数据、共享结算输入、角色告警、参数化测试扩展与文档同步。无需新增第三方依赖、运行时配置文件、数据迁移或顶层模块。

实施严格守住以下边界：

- `SubAgentRunManager` 继续独占结算、用量记账、workspace lease 和完成唤醒；崩溃恢复与正常退出共用现有 `classifyExternalOutcome` 结构化分支。
- `antigravity-cli.ts` 只负责组装 argv、解析 `stream-json` 输出和生成进度标签，不直接 spawn 进程、不读写 run 持久化文件、不判断 `purpose=verify` 准入。
- 允许按 D8 为本 harness 的 follow-up 持久化 `expectedResumeSessionId`，由正常退出与重启恢复传入共享解析器。它是请求预期，不能冒充 CLI 报告的 `sessionId` 或 `presetSessionId`。
- **不自动追加 `-p` / `--print` / `--prompt`，也不默认追加 `--disable-slash-commands`**，更不自动追加 `--dangerously-skip-permissions`、`--mode`、`--sandbox`、`--settings`、`--agent`。角色 `command` 自带的参数原样保留。
- prompt 继续由 `external/run.ts` 通过管道写入 `stdin`；角色正文走非 `claude-code` 分支与任务合并；`prompt.txt` 仍只存本次任务正文。
- 确定性 e2e 默认不净增，优先扩展已有链路。新启动元数据跨进程丢失会使错误续接被误记成功；若已有场景无法覆盖，按仓库准入规则说明必要增量并做 mutation，不以“增量必须为 0”阻止必要覆盖。既有 harness 行为保持。
- `discovery.ts` ≤ 1031 行，`runs.ts` ≤ 1048 行；新增源文件遵守 800 行预算；`scripts/architecture-baseline.json` 不增加任何例外。
- 不把 plan/sandbox 或 agent/settings 的存在等同于只读保证；不能证明进程只读时声明 `mutates: write`，继续使用现有 lease。

## 2. 阶段与依赖

| 阶段 | 交付内容 | 对应设计 | 主要风险 | 阶段完成证据 |
| --- | --- | --- | --- | --- |
| P0 | 基线记录与接入点复核 | D1–D8 | 基于过期行号或忽略既有单测统计 | 起始 revision、工作区状态、基线 check/e2e 用例计数 |
| P0.5 | 协议样本、统计范围与权限事实核实 | §0、D4、D5、D7、D8 | 用结构体标签推断语义、重复计入 thinking/历史用量、把 plan 误当权限边界 | 有来源的证据矩阵、选定的映射与尚未核实的范围 |
| P1 | `role-warnings.ts` 接入 `antigravity-cli` 配置提醒 | D7 | 误伤参数值、破坏 Cursor 告警、将只读声明误判为权限证明 | 告警单测、两个超长文件行数、`npm run arch` |
| P2 | 适配器、注册表与联合类型 | D1–D6、D8 | 误加 `-p`、错误计量、截断误判、裁掉交付证据、忽略续接身份 | 适配器及共享合同单测、`npm run typecheck` |
| P3 | 续接预期持久化、结算/恢复与真实 smoke 接线 | D2、D4、D5、D8 | 请求值冒充实际 ID、重启丢校验、成功拒绝诊断丢失 | 工具/启动/恢复测试与跨进程证据、smoke 类型检查 |
| P4 | `agy-main.md` 示例、顶层文档与行为评测计划 | 第 4、5 节 | 示例触发自身告警、`loadExamples` 白名单漏改、`AGENTS.md`/`architecture.md` 路径校验报错 | `loadExamples` 通过、`npm run arch`、`eval plan` 记录 |
| P5 | 定向 mutation 验证、完整门禁与验收记录 | 第 6、7 节 | 新增单测抓不住真实故障、跳过 `test:e2e`、混淆离线通过与真实流验证 | mutation 红→绿证据、`npm run check`、`npm run test:e2e`、`acceptance.md` |

按 P0 → P0.5 → P1 → P2 → P3 → P4 → P5 推进。P1–P3 在同一可编译状态下完成接线与验证，不留下允许配置但缺少适配器或续接校验的半成品。真实采集受环境限制时仍可推进离线实现，但验收必须区分实现完成与协议核实。

## 3. P0：固定基线与核实事实

1. 记录起始 `git rev-parse HEAD`、`git status --short`、Node/npm 版本与本机 `agy --version`；保留工作区已有的 spec 文档，不执行 `git reset`。
2. 逐一复核接入文件：`discovery.ts`、`runs.ts`、`run-record.ts`、`external/role-warnings.ts`、`external/harness.ts`、`external/registry.ts`、`external/run.ts`、`external/settlement.ts`、`external/reconciliation.ts`（以上在 `src/subagents/`），以及 `src/channel/store.ts`、`src/agent/prompt/types.ts`、`src/tools/subagent-manage.ts`。记录两个超长文件当前行数与架构基线上限。
3. 运行基线 `npm run check` 与 `npm run test:e2e`，记录当前 unit passed 用例总数与 deterministic e2e 用例总数，供 P5 计算净增量（unit case-count delta）。

### P0.5：协议证据与实现前置决策

1. 按设计 §0 的矩阵登记 CLI 版本、认证方式、argv、stdin 形态、退出码、stdout/stderr 和来源；先保存 `/help`、失效 ID 的命令路径、官方事件样例及本机 changelog 中有关无头计划审批的证据。不得把命令路径探测外推为模型路径已验证。
2. 具备真实环境并选择运行外部探测时，在隔离临时工作区收集“读文件 → 写产物 → 有效 follow-up”、失效会话、拒绝动作和超时/错误的代表性流；不要使用当前源码工作区，也不自动读取或发送用户真实项目。使用直接 subprocess 收集真实 CLI 输出，不要求先实现适配器，不创建可复用采集平台。
3. 核实 thinking/cache 包含关系、跨进程 result 的统计范围、续接是否重放步骤、ACTIVE/DONE 是否均为增量。已确认结论和候选映射记录在设计 D4/D5；不同认证路径未验证则注明支持范围，禁止按数值凑等式或用成功状态猜零用量。
4. 从证据挑选最小脱敏夹具，并标注真实采集/官方样例/合成故障；用这些夹具确定单测预期。无凭据时保留官方样例作为候选协议证据，未确认的续接计量按 D5 返回未知，不增加运行时“已验证”开关，不将该场景记为通过。
5. 检查示例模型名是否被当前 CLI 接受；`agy models` 列表本身不证明无档位基础名也是合法别名。不接受时更新两个文档中的示例，不新增模型名转换逻辑。

## 4. P1：角色配置告警与行数守卫

### 改动

1. 在 `src/subagents/external/role-warnings.ts` 中新增 `antigravityCommandWarnings(input: ExternalRoleWarningInput): string[]`，仅在 `input.harness === "antigravity-cli"` 时生效，仍只依赖 `src/shared/shell-words.ts`（不引入 `discovery.ts` 或 `harness.ts`）。
2. 按设计 D7 用 `splitShellWords` 检查参数 token：
   - 识别 `-p`、`--print`、`--prompt` 及 `--print=...`、`--prompt=...`。
   - 识别 `-i`、`--prompt-interactive` 及 `--prompt-interactive=...`。
   - 识别 `-c`、`--continue`、`--conversation`（含等号写法），在新运行和续接时都提醒固定会话风险。
   - 解析 `--mode <val>` 与 `--mode=<val>`，重复模式按 CLI 的有效优先级判断；plan 是任务策略，不能被当作只读权限。
   - 识别写权限豁免或外部接管标志：`--dangerously-skip-permissions`、`--mode accept-edits`、`--mode auto`、`--agent`（含 `--agent=...`）、`--settings`（含 `--settings=...`）。
   - 按 `mutates: "write"` 与 `mutates: "read"` 分别生成对应提醒，并在 `externalRoleWarning` 中与 `memory`、`$MODEL` 告警拼接。

### 测试与阶段检查

- 在 `test/subagent-phase1.test.ts` 扩展 D7 参数表：print/交互/固定会话、write+plan、write 缺权限来源、read+明显写许可、read 声明边界提醒；覆盖等号写法和有效模式。write 的显式配置不误报“缺少权限来源”，但不把 read+plan/sandbox 判为已证明安全的零告警配置。所有角色仍正常加载。
- 断言聚焦告警原因关键词与角色文件名，不死锁整段英文措辞。

## 5. P2：适配器实现与全链路注册

### P2.1 `src/subagents/external/antigravity-cli.ts`

新建适配器文件，导出 `antigravityCliHarness: ExternalHarness`（`id: "antigravity-cli"`，`parserVersion: 1`）：

1. **`buildInvocation`**：
   - 空 `input.argv` 抛出明确错误。
   - 调用 `expandPlaceholders(rest, { $MODEL: input.model, $EFFORT: effort, $PROMPT_FILE: input.promptFile, $SYSTEM_PROMPT_FILE: input.systemPromptFile })` 与 `formatDroppedPlaceholderWarnings`。
   - 检测 `rest` 是否已有非 `stream-json` 的 `--output-format`，若有则记录 invocation warning；始终追加 `"--output-format"`、`"stream-json"`。
   - 检测误带 print/交互参数，以及任何运行中的固定会话参数，按 D2 产生 invocation warning。
   - 绝不追加 `-p` / `--print` / `--disable-slash-commands`。
   - 独立判断 `--model`（`input.model && !hasModelFlag && !used.has("$MODEL")`）与 `--effort`（`effort && !hasEffortFlag && !used.has("$EFFORT")`）。
   - `input.resumeSessionId` 存在时追加 `"--conversation"`、`input.resumeSessionId`。
   - 返回 `{ executable, args, warnings, resumable: true }`（不设 `presetSessionId`）。
2. **`parseOutcome`**：
   - 维护事件合法性、父会话 ID 与续接匹配状态、按索引的完整步骤文本/用量、终态、结果正文和诊断；不要求照搬私有变量命名。
   - 按 D4 处理空 ID、`finished_reason`、无损步骤边界修复、失败诊断和无终态回退。只有全部步骤串联与 response 完全匹配才补换行，不能按后缀匹配裁掉前文；成功拒绝摘要放在正文之前并给出查阅完整事件的指引，末行 verdict 保持。
   - 按 D5 的证据固定字段映射与统计范围，不无条件把 thinking 加进 output；终态无有效用量时可回退可信步骤。零轮启动错误、无效计数和未确认范围保持未知；`costKnown` 恒 false。
   - 按 D8 消费 `expectedResumeSessionId`，拒绝不同或缺失的父会话身份，且不留下错误 ID 供再次续接。实现正常 ERROR result 空 ID 与子智能体 ID 的例外边界。
3. **`toProgressLabel`**：
   - 严格按 D6 只处理 `event === "step_update"` 且 `state === "ACTIVE"`，支持 `subagent_info.subagents` 与 `tool_info` PascalCase/通用主体字段优先级，首行截断命令、80 字符上限，严禁读取 `Content`、`Replacement`、`output`、`error`。

### P2.2 接线清单

在同一工作区状态下完成以下接线：

| 文件 | 改动内容 |
| --- | --- |
| `src/subagents/discovery.ts` | 单行扩展 `ALLOWED_HARNESSES` 加入 `"antigravity-cli"`，确保文件总行数 ≤ 1031 |
| `src/subagents/run-record.ts` | 扩展 `RunHarness`；加入 `expectedResumeSessionId` 与 `ExternalLaunchInfo` 启动类型，更新用量注释 |
| `src/subagents/runs.ts` | `setLaunched` 内联类型移到 `run-record.ts`，持久化续接预期，文件 ≤ 1048 行；不改状态机 |
| `src/subagents/external/harness.ts` | 扩展 harness id；`ParseOutcomeInput` 增加可选 `expectedResumeSessionId`，其他适配器不使用 |
| `src/subagents/external/registry.ts` | 注册 `"antigravity-cli": antigravityCliHarness` |
| `src/subagents/external/run.ts` | 扩展联合断言；持久化本 harness 的续接预期，并在正常结算从启动记录读取；保持 stdin 拼接 |
| `src/subagents/external/settlement.ts` | `FinalizeExternalRunInput` 接收续接预期并透传共享解析器；诊断随既有 `outputText` 保存 |
| `src/subagents/external/reconciliation.ts` | 重启恢复从 run 读取同一预期并传入 finalizer，不增加第二套身份判定 |
| `src/channel/store.ts` | 持久化摘要 `harness` 联合加入 `"antigravity-cli"` |
| `src/agent/prompt/types.ts` | 提示词目录 `SubAgentSummary["harness"]` 加入 `"antigravity-cli"` |
| `src/subagents/format.ts`、`src/usage/ledger.ts`、`src/usage/render.ts` | 更新「有 token、无 USD 成本」注释列举，不改逻辑 |

### 测试与阶段检查

- 新建 `test/antigravity-cli-harness.test.ts`，覆盖设计第 6 节第 1 项的全部独立风险分支（见 P5 mutation 要求）。
- 在 `test/external-harness-contract.test.ts` 的结构化 harness 列表中加入 `antigravityCliHarness`，复用垃圾输出与「退出 0 无终态判失败」共享矩阵。
- 运行单测、`npm run typecheck`、`npm run arch`，确认 `discovery.ts` ≤ 1031、`runs.ts` ≤ 1048。

## 6. P3：续接身份、恢复一致性与真实 CLI smoke

1. 修改 `src/tools/subagent-manage.ts` 的 `resumableHarnessOf` 与注释，纳入 `"antigravity-cli"`，其余续接门槛（状态已结束、有 `sessionId`、角色存在且可用、指纹未变、lease 与 verify 校验）原样保持。
2. 扩展 `test/tool-subagent-manage.test.ts` 中现有的参数化 `follow_up` 成功用例，把 `"antigravity-cli"` 纳入循环，验证旧 `sessionId`、新 `runId` 与原工作目录被正确传入启动入口。
3. 扩展 `test/subagent-external-run.test.ts` / `test/subagent-restart-adoption.test.ts` 的相关既有场景：启动记录落盘 `expectedResumeSessionId`；正常和恢复结算都拒绝“期望 A、返回 B/缺失”，并保留“匹配 init 后空错误 ID”的可续接身份。矩阵归适配器，上层只验证持久化/透传与可观察结算结果。成功拒绝摘要必须出现在保存的输出中。
4. 扩展真实进程的确定性恢复链证明旧回调消失后仍校验预期 ID，保留已有 exec 覆盖；若需要新增例，写明跨模块缺口、影响、case-count delta 与 mutation。仅调用领域 finalizer 或同进程 restart 不能作为该证据。
5. 修改 `test/e2e/external/subagent-external-smoke.test.ts`：
   - `HARNESS_COMMAND` 增加 `"antigravity-cli": "agy --mode accept-edits --sandbox"`，过滤允许该 harness。运行在隔离临时工作区，具备写权限，不能标为只读 smoke。
   - 将本 harness 的单条 OK 探测扩展为“读输入文件 → 写产物 → 同一会话 follow-up”的链，检查真实工具事件、磁盘产物、非空输出、completed、匹配 ID、D5 的本次运行用量与 `costKnown === false`。对其他 harness 保持原行为；不按模型回复措辞验收。
   - 保留脱敏流和元数据用于核对 token 包含关系及续接范围；不能只断言 total 大于零。P0.5 已有的权限拒绝/异常流可作为协议证据，不机械复制付费探测；未覆盖的失效 ID 模型路径保持未核实。
   - 未设置环境变量时跳过；范围未核实导致未知用量时如实记录，不能放宽为“协议 smoke 全部通过”。

## 7. P4：示例角色、文档同步与行为评测规划

1. 新建 `examples/sub-agents/agents/agy-main.md`（仅此一个示例文件，内容见设计 §4.1；模型标识以 P0.5 核实结果为准），在 `loadExamples` 白名单中加入 harness，确认示例加载无告警。`docs/sub-agents.md` 的验证角色按设计 §4.2 使用写声明；不能复制旧版 read+plan/sandbox 配方。
2. 按设计第 5 节逐项更新文档（注意：`AGENTS.md`、`CLAUDE.md`、`docs/architecture.md` 中反引号引用的 `.ts` 路径受 `scripts/check-architecture.mjs` R5 规则校验，必须在 `src/subagents/external/antigravity-cli.ts` 已创建后同步）：
   - `examples/sub-agents/README.md`
   - `docs/sub-agents.md`
   - `docs/README.md`
   - `docs/architecture.md`
   - `docs/deployment-and-operations.md`
   - `docs/events-and-tasks.md`
   - `src/playbooks/agent-delegation.md`
   - `AGENTS.md`、`CLAUDE.md`
   - `docs/refer/grok-bot-comparison.md`
3. 因触及模型可见的 `src/playbooks/agent-delegation.md`，按 [评测指南](../../evals.md) 运行只读规划命令：
   ```bash
   npm run eval -- plan --changed-since <P0记录的base-ref>
   ```
   记录选出的 case 列表与原因。若本机模型凭据可用，先对选出的 delegation dev case 运行 `selftest`，控制通过后再运行对应 case 并记录 `runId`；若无可用凭据或环境受限，如实记录未运行及原因，不记作行为评测通过。

## 8. P5：定向 mutation、验收门禁与交接记录

### 8.1 定向 mutation 检查（防止假绿单测）

在最终门禁前对以下风险做定向临时破坏，确认所属场景立即变红，记录失败断言后立刻恢复并重跑变绿。修改实现而非测试预期；这些检查不要求一项对应一个新增测试用例：

1. 去掉 `result.conversation_id` 的非空判断（让 `""` 直接覆盖 `sessionId`）→「中途报错保留 `init` 会话 ID」用例必须变红。
2. 去掉 `!result.finished_reason` 守卫（只看 `result.status === "SUCCESS"`）→「`print_timeout` 截断判失败」用例必须变红。
3. 将多步修复改为只返回末步 → 前文证据保留断言变红；去掉已确认边界的补换行 → verdict 边界断言变红。正文与 verdict 需要同时成立，不能只追求 PASS。
4. 重新无条件把 thinking 加进 output，或用累计 result 覆盖本次步骤用量 → P0.5 选定的映射/统计范围断言变红；让全零错误 result 覆盖已有步骤 → 异常计量断言变红。
5. 去掉续接 ID 匹配检查 → 不同/缺失 ID 的适配器用例变红；再去掉持久化或恢复透传 → 跨进程恢复场景必须变红。只证明直接 parser 调用失败，不能证明恢复接线安全。
6. 丢弃成功结果的拒绝摘要 → 保存输出中的诊断断言变红，同时原正文和末行 verdict 仍受保护。

### 8.2 局部与完整离线门禁

局部快速回归：

```bash
npx --no-install vitest run test/antigravity-cli-harness.test.ts test/external-harness-contract.test.ts test/subagent-phase1.test.ts test/subagent-discovery-external.test.ts test/tool-subagent-manage.test.ts test/subagent-external-run.test.ts test/subagent-restart-adoption.test.ts
npm run typecheck
npm run arch
```

最终完整离线门禁（全部必跑，缺一不可）：

```bash
npm run check
npm run test:e2e
git diff --check
```

人工复核清单：
- `discovery.ts` ≤ 1031 行、`runs.ts` ≤ 1048 行，`scripts/architecture-baseline.json` 零改动；
- `antigravity-cli.ts` 未将 `-p` / `--print`、`--disable-slash-commands`、`--mode`、`--dangerously-skip-permissions` 自动写进 argv；
- `examples/sub-agents/agents/` 只新增 `agy-main.md` 一个文件；
- 报告 unit / deterministic e2e case-count `before → after` 与每组新增覆盖的独立故障面；有 e2e 增量时附准入理由和 mutation；
- 正常退出与恢复读取相同的已持久化续接预期，错误身份不冒充成功续接；
- 完整正文、拒绝摘要和末行 verdict 同时保留；未知统计范围不冒充已知零用量，步骤与 result 不重复加总；
- §0 每项证据均标明已核实/未核实；原始个人数据和凭据未进入仓库，未核实行为没有写成已验证能力。

### 8.3 opt-in 真实 CLI smoke（按环境条件执行）

仅当执行环境具备已认证且可写本地状态目录的真实 `agy` 会话并明确选择运行外部 smoke 时执行：

```bash
PIPICLAW_E2E_HARNESS=antigravity-cli npm run test:e2e:external
```

若当前沙箱对 `~/.gemini` 只读或未登录账号导致无法运行真实模型请求，必须在验收记录中明确标注「未运行真实模型 smoke 及具体环境原因」，严禁将 `--help` / 二进制结构核对表述为已跑通线上模型 smoke。

逐场景记录读取/写入、有效续接、失效 ID 模型路径、拒绝与异常终态的证据位置、版本、认证方式和退出码，以及用量是否确属本次运行。P0.5 与最终 smoke 可以复用同一份有效证据，不能把一条成功回复扩写成所有场景通过。运行后的原始流应复制到验收证据目录再清理临时工作区，仓库只保留最小脱敏夹具。

## 9. 最终交付与验收记录

实施完成时在本目录新建 `acceptance.md`，按证据将 [design.md](./design.md) 与本文件更新为「离线实现完成，真实协议待核实」或「已实施 / 已执行，真实协议已核实」，链接 `./acceptance.md`。未实施完成前不预先创建。`acceptance.md` 至少包含：

| 记录项 | 内容要求 |
| --- | --- |
| 基线与范围 | 起始 revision、环境版本、`agy --version`、新增与修改文件范围 |
| 改动映射 | D1–D8 与 `agy-main.md` 对应的代码/文档位置、启动元数据与正常/恢复结算链、计划偏差 |
| 离线门禁与增量 | `npm run check`、`npm run test:e2e`、`git diff --check` 结果，unit/e2e 数量 `before → after` 及增量理由 |
| 定向 mutation | §8.1 各风险的红灯断言与恢复验证；注明哪个检查证明了跨进程恢复接线 |
| 行为评测与真实协议 | `eval plan`、dev case/runId；按 §0 场景列明真实采集、官方样例和合成夹具的证据位置；外部 smoke 执行范围及未执行原因 |
| 用量与权限结论 | thinking/cache 包含关系与认证范围；跨进程 result/步骤统计范围；示例模型名；读写声明与实际宿主/CLI 权限限制 |
| 未决事项 | 仍缺真实证据的具体场景及验证命令，不能只写笼统“smoke 未跑”；未核实统计范围对应的未知用量行为 |

# 070：工具人体工学、执行精度与供给边界优化

| 字段 | 内容 |
| --- | --- |
| 状态 | 已实施（[验收记录](acceptance.md)） |
| 日期 | 2026-11-20 |
| 依据 | [044 原生文件 I/O 与有界工具](../archive/044-native-file-io/design.md)、[046 工具 Schema 拆分](../archive/046-tool-schema-partitioning/design.md)、[047 管理类工具拆分](../archive/047-manage-tool-partitioning/design.md)、[053 对外文案](../053-user-facing-copy/design.md)、[064 任务车道](../064-task-lane/design.md)、[067 工具执行与委派结果回收提速](../067-execution-latency/design.md)、[069 Prompt 体系、渐进加载与缓存闭环优化](../069-prompt-cache-and-playbooks/design.md)、[按需发现与 Codemode 讨论稿](../../reviews/2026-11-17-tool-orchestration-proposal.md) |
| 实施计划 | [plan.md](./plan.md) |
| 适用范围 | 主聊天会话（`chat`）、后台任务会话（`task`）、单次 Web API 请求会话（`request`）及内置子代理（`internal` worker）的工具构建、契约封装、核心文件/搜索/执行/状态工具实现与批次调度引导 |

## 1. 目标与范围

在 [Spec 067](../067-execution-latency/design.md)（异步回流提速）与 [Spec 069](../069-prompt-cache-and-playbooks/design.md)（提示词、Playbooks 短路径与前缀缓存闭环）基础上，针对工具层（ACI, Agent-Computer Interface）及工具向 Agent 供给链路的深度代码审查结论，一次性完成以下四个目标：

1. **弥合契约裂缝与跨环境 Schema 漂移**：修复 `subagent_inline` 在流式进度、当轮用量统计与崩溃恢复中的三处漏网；消除 `request` 会话外层包装导致的 `RecoverableToolError` 逃逸与 `bash.async/notify` 悬空参数；统一 `tool.end` 在可恢复拒单下的 `ok` 状态语义；收紧冗余 Schema 说明，将开启 Web 后的 `chat` 工具定义从临近红线的 `2,986` 单位压回安全水位。
2. **提升核心编码与检索工具首次成功率（First-Pass ACI Accuracy）**：为 `edit` 增加 CRLF 透明兼容与原行尾保持、多处匹配行号定位、零匹配近似空白锚点诊断以及同文件多块原子替换 `edits`；接入会话级**非阻塞“先读后写 / 外部变更”软提示**；为 `grep` 接入单次 `rg`（ripgrep）探测加速与 fallback `grep -I` 二进制隔离；消除 `glob` 串行 `stat` 瓶颈并补齐 `skip` 分页。
3. **降低工具输出 Token 税并延缓有损压缩**：将 `bash`（及 `job` 单任务尾部）单次内联截断上限从 `50KB / 2000 行` 收紧至 `30KB / 1000 行`（完整输出继续无损落盘 `spillPath` 并给出精准 `grep`/`read` 排障指引）；将 `task_*`、`session_search`、`event_manage` 等工具的模型侧 `content` 从裸 `JSON.stringify` 升级为高信噪比紧凑文本（`details` 结构化通道保持不变）。
4. **释放只读批次并发度**：在不分叉官方 Pi SDK 的前提下，明确引导模型将纯只读探查工具（`read`/`grep`/`glob`/`web_fetch`）与串行工具（`bash`/`edit`/`write`）分批调用，并补齐内置子代理 `bashInterceptor` 与 `purpose="verify"` 的只读提示。

### 非目标（明确不做什么）

- **不将“先读后写”做成硬阻断（Hard Error）**：未读覆写已有文件或读后发生外部变更时，正常完成写入并在返回文本追加一行软提示（`Note: ...`），绝不抛错打断模型的合法生成/重写流程。
- **不将 `event_manage` 放入延迟发现（Deferred Exposure），也不在本规格内默认开启全局 `tool_search` 或 `Codemode`**：`event_manage` 承载高频单次提醒的 2 轮直调短路径（Spec 069 已验证），延迟暴露会增加往返并击穿热会话 KV Cache 前缀；`subagent_inline` 延迟发现与受限 Codemode 维持 [工具编排讨论稿](../../reviews/2026-11-17-tool-orchestration-proposal.md) 的独立试验定位，不在本确定性工程规格中混入。
- **不在普通回合动态裁剪历史 `toolResult` 消息**：滑动改写会话前文会每轮破坏供应商前缀缓存哈希；上下文体积控制通过收紧单次 `bash` 内联预算与压缩期载荷去重（`compaction-input.ts`）协同完成。
- **不新增 `settings.json` 或 `tools.json` 配置键，不修改官方 Pi SDK 包**。

---

## 2. 当前问题定位与实测基线（基线 `31fe811`）

### 2.1 工具定义体积实测基线

按运行时同口径 `countPromptUnits` 实测（目标警戒线 `TOOL_SCHEMA_TARGET_UNITS = 3,000` 单位）：

| 会话形态 (Profile) | 当前工具数 | 总字符数 | 提示单位 (Units) | 距 `3,000u` 警戒线余量 | 风险状态 |
| --- | ---: | ---: | ---: | ---: | --- |
| `chat`（Web + Media + Inline 全开） | 27 | 21,537 | **2,986 u** | **仅剩 14 u (0.5%)** | 临界：新增任意小字段即触发告警 |
| `chat`（默认 Web 关闭） | 25 | 20,155 | **2,789 u** | 211 u (7.0%) | 偏紧：`event_manage` (321u) + `subagent_inline` (252u) 占 20.5% |
| `task`（后台任务会话，Web 开） | 23 | 16,104 | **2,269 u** | 731 u (24.4%) | 健康 |
| `request`（单次无会话 Web API，Web 开） | 14 | 10,059 | **1,437 u** | 1,563 u (52.1%) | 健康，但 `bash` 仍暴露无效 `async/notify` |
| `subagent`（内置 Worker 全白名单） | 8 | 6,461 | **938 u** | 2,062 u (68.7%) | 健康，但漏接 `bashInterceptor` |

### 2.2 代码级缺陷与 ACI 短板清单

| 编号 | 领域与代码位置 | 当前代码事实与问题 | 实际影响 |
| --- | --- | --- | --- |
| **F1** | `subagent_inline` 事件与恢复漏判<br/>[`session-events.ts`](../../../src/agent/session/session-events.ts)<br/>[`turn-recovery.ts`](../../../src/agent/turn/turn-recovery.ts) | `session-events.ts` 第 129、147 行硬编码 `event.toolName === "subagent"`（尽管 `isSubAgentToolDetails` 已支持 `"subagent_inline"`）；`turn-recovery.ts` 第 27 行 `toolGuidance` 漏掉 `"subagent_inline"` | 聊天 10 秒窗口内的 `subagent_inline` 丢失流式进度更新、当轮展示的 `totalUsage` / `usageSources` / `costKnown` 漏计；进程崩溃恢复时退回通用提示而非引导先查 `subagent_list` |
| **F2** | `request` 工具包装反置与悬空 Schema<br/>[`session-host.ts`](../../../src/agent/session/session-host.ts)<br/>`src/agent/session/request-tools.ts`<br/>[`subagent.ts`](../../../src/tools/subagent.ts) | `SessionHost` 先传 `jobManager` 构建完整 `bashSchema`（含 `async`、`notify`），再用 `requestTools` 在 `withToolDetails` **外层**包裹 `execute` 并抛 `RecoverableToolError`；普通 `chat` 的 `subagent*` 仍暴露仅任务步骤合法的 `item` 字段 | 1) `request` 模式下 `bash` 传入 `async: true` 时异常绕过 `withToolDetails`，直接作为未捕获错误（`isError: true`）冒泡；<br/>2) 向模型暴露当前上下文禁止使用的参数，浪费 Schema 预算并诱导无效重试 |
| **F3** | `tool.end` 在可恢复拒单下 `ok` 分裂<br/>[`session-events.ts`](../../../src/agent/session/session-events.ts)<br/>[`response-state.ts`](../../../src/webapi/response-state.ts) | `withToolDetails` 将 `RecoverableToolError` 转为 `isError: false` + `details.recoverable: true`；`session-events.ts` 第 219 行计算 `ok: !event.isError && !subAgentDetails?.failed` 未排除 `rejected` | Web API Responses 的 `mcp_call` 条目将业务 `Rejected:` 退回误标为 `status: "completed"`（而 SDK 参数校验失败为 `"failed"`），客户端观测语义不一致 |
| **F4** | `bash` 错误引导与子代理拦截缺失<br/>[`bash.ts`](../../../src/tools/bash.ts)<br/>[`registry.ts`](../../../src/tools/registry.ts) | `bash.ts` 第 248 行拒单提示使用不存在的工具名 `find`（实际为 `glob`）；`registry.ts` 第 184 行仅从主路径 `ctx.toolsConfig` 读取 `interceptorEnabled`，内置子代理恒为 `false` | 错误提示指向不存在的工具；内置子代理不受裸 `cat` / `grep -rn` / `find -name` 拦截引导，易撑爆 worker 上下文 |
| **F5** | `edit` / `write` 容错与感知短板<br/>[`edit.ts`](../../../src/tools/edit.ts)<br/>[`write-content.ts`](../../../src/tools/write-content.ts) | `edit` 纯字节匹配，遇到 `\r\n`（CRLF）文件时模型发送的 `\n` 多行 `oldText` 100% 失败；多处匹配不报行号；不支持同文件多块原子修改；未读覆写已有文件或外部改写后无任何感知提示 | 跨平台/CRLF 文件被迫退回整文件 `write` 或 `bash`；同文件多处小改需多次串行 I/O；多匹配需额外 `grep` 查行号 |
| **F6** | `grep` / `glob` 引擎与 I/O 效率<br/>[`grep.ts`](../../../src/tools/grep.ts)<br/>[`glob.ts`](../../../src/tools/glob.ts) | `grep` 固定调 `grep -rnH`：未加 `-I` 过滤二进制文件，且忽略 `.gitignore`；`glob` 在 `≤ 2,000` 命中时串行逐个 `await fileStore.stat(...)`，且 `> 100` 条无 `skip` 分页 | 二进制产物混入 `mode:"files"` 或拖慢搜索，`.gitignore` 忽略的大型目录易打满 `768KB` 捕获上限；大目录 `glob` 存在数千次串行系统调用 |
| **F7** | `bash` 内联体积偏大与管理输出 JSON 税<br/>[`bash.ts`](../../../src/tools/bash.ts)<br/>[`task-manage/factory.ts`](../../../src/tools/task-manage/factory.ts)<br/>[`session-search.ts`](../../../src/tools/session-search.ts) | `bash` 默认内联 `50KB / 2000 行` 尾部，连续跑几次测试日志即消耗数万 token 加速触发有损压缩；`task_*`、`session_search`、`event_manage` 将结果直接 `JSON.stringify` 放入 `content`，产生大量双重转义符 | 上下文窗口被冗余日志与 JSON 转义符号快速挤占，降低长程推理注意力与缓存经济性 |

---

## 3. 必须保持的不变量

| 编号 | 不变量 |
| --- | --- |
| **I1** | **模块单向依赖与 800 行文件预算严格守恒**：遵守 `scripts/check-architecture.mjs`（`tools-contract` 在 Layer 3，`subagents` 在 Layer 7，`tools` 在 Layer 8，`agent` 在 Layer 9），`scripts/architecture-baseline.json` 零新增；重点看护临近上限的 `src/agent/session/session-host.ts`（当前 787 行）与 `src/tools/edit.ts`（当前 610 行，新增逻辑必须拆出同域辅助文件）。 |
| **I2** | **单一契约出口 `withToolDetails` 不绕过**：所有暴露给模型的工具必须且最外层经过 `withToolDetails`（除纯透传耗时的 `withExecutionTrace` 与任务活跃断言外，任何抛 `RecoverableToolError` 的校验逻辑均须位于 `withToolDetails` 内部）。 |
| **I3** | **“先读后写”仅作软提示，绝不硬阻断**：未先 `read` 即 `write` 已有非空文件，或上次 `read` 后磁盘指纹已变时，操作本身照常原子执行成功，仅在模型可见 `content` 末尾附带单行 `Note:` 提示，不抛 `RecoverableToolError` 或 `Error`。 |
| **I4** | **用户侧静音契约保持**：统一 `tool.end` 的 `ok` 字段后，可恢复拒单（`RecoverableToolError` 与 SDK 参数校验失败）仍保持 `failure === undefined`：钉钉卡片不出现 `✕` 错误行，TUI 不打印红色错误进度（`src/tui/render.ts` 仅在 `item.status === "failed" && item.pipiclaw_failure` 时输出错误行）。 |
| **I5** | **`details` 机器通道向后兼容**：优化 `task_*`、`session_search`、`event_manage`、`skill` 的 `content` 文本时，`details` 对象保留全部原有字段与判别式 `kind`，不破坏运行时状态观测、任务车道空闲判定及领域单测。 |
| **I6** | **安全守卫优先级不可降级**：`grep` 接入 `rg` 快速路径后，原有的 `checkPathGuard` 入口校验、`readDeny` 排除参数以及输出侧 `partitionByReadGuard` 逐文件安全过滤必须 100% 保留作为最终防线；`edit` 多块编辑与 CRLF 路径继续完整经过 `read` + `write` 双重 `checkPathGuard`、工作区写租约检查与 `withTaskFileMutation` 契约保护。 |
| **I7** | **系统提示词与工具 Schema 双重预算达标**：所有会话形态下 `runtimeAuthoredUnits <= RUNTIME_PROMPT_TARGET_UNITS`（`700` 单位），且开启全部可选能力（Web + Media + `subagentInline` + `edit.edits`）的 `chat` 工具集 `measureToolSchemas(tools).units <= 2,850`（留出 ≥ 150 单位余量低于 `3,000` 警戒线）。 |
| **I8** | **测试精简与破坏性验证纪律**：既有功能修复优先扩展现有测试场景；确因新故障模式新增用例时必须说明风险与净变化，关键机制修复必须执行一次人为破坏（Mutation Check）确认变红后再恢复。 |

---

## 4. 详细设计

### 4.1 D1：契约裂缝修复与按会话形态精确 Schema 裁剪

#### D1.1 `subagent_inline` 事件流、用量汇总与恢复引导对齐
1. 在 [`src/agent/session/session-events.ts`](../../../src/agent/session/session-events.ts) 新增轻量判断 `isDelegationToolName(name: string): boolean`（匹配 `name === "subagent" || name === "subagent_inline"`），替换第 129 行 `isToolExecutionUpdateEvent` 与第 147 行 `isToolExecutionEndEvent` 中的 `event.toolName === "subagent"`，使内联子代理在同步窗口内的实时进度与完成后的 `mergeSubAgentUsage` / `usageSources` / `costKnown` 与普通 `subagent` 完全一致。
2. 在 [`src/agent/turn/turn-recovery.ts`](../../../src/agent/turn/turn-recovery.ts) 第 27 行 `toolGuidance(toolName)` 中加入 `toolName === "subagent_inline"`，确保进程崩溃恢复后同样引导模型先通过 `subagent_list` / `subagent_run op=show` 核查持久化运行记录。

#### D1.2 `request` 模式工具收敛至 `createPipiclawTools`（根治异常逃逸与悬空参数）
1. 在 [`src/tools/index.ts`](../../../src/tools/index.ts) 的 `CreatePipiclawToolsOptions` 中：
   - 将 `jobManager` 调整为可选 `jobManager?: DeskJobManager`（或保留传入但在 `requestScoped === true` 时不向下透传），新增 `requestScoped?: boolean`；
   - 当 `options.requestScoped === true` 时：
     - 传给 `buildToolSet` 的 `jobManager` 设为 `undefined`——由此 `job` 工具自动因 `enabledBy` 不满足被剔除，且 `bash` 自动采用 `bashSchemaNoJobs`（从 Schema 根源移除 `async` 与 `notify` 字段）；若模型强行传入额外字段 `async: true`，由 [`src/tools/bash.ts`](../../../src/tools/bash.ts) 第 296 行在 `withToolDetails` **内部**抛出 `RecoverableToolError`（更新该句文案以同时涵盖无后台会话的 `request` 与 `sub-agent` 上下文）；
     - 在 `createPipiclawTools` 返回前按 `REQUEST_SCOPED_TOOL_NAMES`（来自 `tools/contract/names.ts`）过滤工具列表。
2. 在 [`src/agent/session/session-host.ts`](../../../src/agent/session/session-host.ts) 中移除 `requestTools` 导入与外层包装调用，改为在 `createPipiclawTools({...})` 参数中直接传 `...(this.deps.profile.kind === "request" ? { requestScoped: true } : {})`（使 `session-host.ts` 净减行数，远离 800 行上限），并删除已无引用的 `src/agent/session/request-tools.ts`。

#### D1.3 `chat` 模式裁剪 `subagent` / `subagent_inline` 的 `item` 字段
- 在 [`src/tools/subagent.ts`](../../../src/tools/subagent.ts) 中，根据 `Boolean(options.boundTaskId)` 选择 Schema：
  - 当 `options.boundTaskId` 存在（后台 `task` 会话）时，保留 `item` 字段；
  - 当 `options.boundTaskId` 为 `undefined`（普通 `chat` 会话）时，使用 `Type.Omit(subagentSchema, ["item"])` 与 `Type.Omit(subagentInlineSchema, ["item"])` 暴露给模型；
  - [`src/subagents/dispatch.ts`](../../../src/subagents/dispatch.ts) 第 90 行的运行时 `if (item && !taskId) throw new RecoverableToolError(...)` 完整保留作为防御性兜底。

#### D1.4 `tool.end` 事件 `ok` 语义统一
- 在 [`src/agent/session/session-events.ts`](../../../src/agent/session/session-events.ts) 第 219 行，将 `tool.end` 的 `ok` 改为：
  ```ts
  ok: !event.isError && !subAgentDetails?.failed && !rejected,
  ```
- **跨渠道行为核实**：
  - `failure` 仍由 `treatAsError`（即 `(event.isError || Boolean(subAgentDetails?.failed)) && !rejected`）决定，对可恢复拒单保持 `undefined`；
  - 钉钉 [`delivery.ts`](../../../src/dingtalk/delivery.ts) 仅在 `event.failure` 非空时推送 `✕`，保持静默；
  - TUI [`render.ts`](../../../src/tui/render.ts) 仅在 `item.status === "failed" && item.pipiclaw_failure` 时渲染错误行，保持静默；
  - Web API [`response-state.ts`](../../../src/webapi/response-state.ts) 的 `mcp_call` 不再把 `Rejected:` 结果伪报为 `status: "completed"`，而是与参数校验失败统一为 `status: "failed"`（且不含用户侧 `pipiclaw_failure`）。

#### D1.5 文案修正、子代理拦截透传与重型 Schema 瘦身
1. [`src/tools/bash.ts`](../../../src/tools/bash.ts) 第 248 行：将 `"read, write, edit, find, or grep tools"` 修正为 `"read, write, edit, glob, or grep tools"`。
2. 内置子代理启用 `bashInterceptor`：在 `WorkerToolRequest`（[`src/subagents/types.ts`](../../../src/subagents/types.ts)）与 [`src/tools/index.ts`](../../../src/tools/index.ts) 的 `subAgentToolOptions` 中透传 `bashInterceptorEnabled: toolsConfig.tools.bashInterceptor.enabled`，并在 [`src/tools/registry.ts`](../../../src/tools/registry.ts) 第 184 行兼容读取 `ctx.bashInterceptorEnabled ?? ctx.toolsConfig?.tools.bashInterceptor.enabled === true`。
3. 收紧 [`src/tools/event-manage.ts`](../../../src/tools/event-manage.ts) 的 Schema 冗余描述：保留全部字段类型、必填项与校验逻辑，精简 `eventDefinitionSchema` 内嵌 `task` 各子字段与外层动作的重复散文（因工具 `description` 已明确指向 `event-task-template.md` / `event-sensors.md` / `event-scheduling.md`），单工具节省约 `60–80` 单位，为 D2.4 的 `edit.edits` 腾出充足预算空间。

---

### 4.2 D2：核心文件闭环升级（非阻塞先读后写软提示、CRLF 兼容、行号诊断与多块原子编辑）

> **文件预算前置拆分（遵守 I1）**：`src/tools/edit.ts` 当前已 610 行。实施 D2 时，须将纯内存/流式匹配、CRLF 归一化与行号定位逻辑抽入同域 `src/tools/edit-match.ts`，将统一 diff 窗口渲染抽入 `src/tools/edit-diff.ts`，使 `edit.ts`、`edit-match.ts`、`edit-diff.ts` 各自保持在 350 行以内。

#### D2.1 会话级文件观察器与“先读后写 / 外部变更”软提示（严格非阻塞）
新建轻量同域协作者 `src/tools/file-observations.ts`：
- 维护有界 LRU `Map<string, FileFingerprint>`（容量 `256`，键为通过 `checkPathGuard` 后的规范化绝对路径 `target`，值为 `fingerprintOf(stat)`），每个 `buildToolSet` 调用创建一个独立实例（同会话/同 worker 内 `read`、`write`、`edit` 共享，跨会话隔离）：
  1. **`read` 成功读取普通文件时**（无论全文或分页窗口）：调用 `observations.record(target, fileStat)` 记录当前磁盘指纹。
  2. **`write` 写入前与写入后**：
     - 在 `withTaskFileMutation` 内写入前执行一次 `const before = await fileStore.stat(target)`，调用 `const hint = observations.checkBeforeWrite(target, before)`，随后照常执行 `fileStore.writeAtomic(...)` 并在成功后用最新 `stat` 更新观察记录（**绝不因 `hint` 抛错或中止写入**）；
     - 软提示触发条件（仅针对已存在且 `before.isFile && before.size > 0` 的非空文件）：
       - 当前工具集实例从未观察过 `target`：追加 `\nNote: Overwrote existing file ${path} (${before.size} bytes) without reading it first in this session; inspect git diff if unintended.`
       - 曾观察过 `target`，但 `before` 与上次记录的指纹不一致：追加 `\nNote: ${path} had been modified externally since you last read or wrote it; verify no concurrent changes were lost.`
  3. **`edit` 编辑前与编辑后**：
     - 保留原有的毫秒级写前并发锁 `checkFingerprintUnchanged(fileStore, target, path, before)`（写过程中被并发篡改仍抛 `RecoverableToolError` 保护数据完整性）；
     - 若编辑前 `observations.hasChangedSinceObserved(target, before)` 为真（即上次 `read` 后文件被外部修改过，但本次 `oldText` 依然唯一匹配并成功写入），照常完成写入、更新最新指纹，并在返回的替换摘要后追加一行软提示：`\nNote: ${path} was modified since your last read; review surrounding context if needed.`

#### D2.2 `edit` CRLF 透明兼容与行尾风格保持
- **小文件内存路径（`≤ EDIT_INLINE_MAX_BYTES`，8MB）**：
  1. 优先按原始字节 `Buffer.from(oldText, "utf-8")` 查找匹配；
  2. 若 `offsets.length === 0`，且文件内容包含 `\r\n`、而 `oldText` 包含 `\n` 且不含 `\r\n`：
     - 将 `oldText` 中的 `\n` 转为 `\r\n` 构造 `crlfNeedle` 重新扫描；
     - 若命中唯一匹配（或 `replaceAll === true` 命中多处），将对应 `newText` 中的裸 `\n`（`(?<!\r)\n`）同步转换为 `\r\n` 后执行字节拼接，保证写回文件不产生混合行尾（Mixed Line Endings）。
- **超大文件流式路径（`> 8MB`）**：若首遍原样流式扫描 `count === 0` 且文件首部嗅探含 `\r\n`、`oldText` 含裸 `\n`，同样以 `crlfNeedle` / `crlfReplacement` 重扫并流式写回。

#### D2.3 `edit` 失败诊断精确到行号
1. **多处匹配（`count > 1 && !replaceAll`）**：从已得出的匹配字节偏移计算 1-indexed 行号（最多展示前 10 个行号，超出标 `+N more`），错误文案升级为：
   `Found ${count} occurrences of oldText in ${path} (at lines ${lineList}). Include more surrounding lines to uniquely identify the target, or set replaceAll: true.`
2. **零匹配（`count === 0`，含 CRLF 重试后仍为 0）**：在小文件内存路径下，提取 `oldText` 首行非空去首尾空白文本做一次行扫描；若文件中存在内容相同但缩进/空白不同的行（记录最多前 5 个候选行号），错误文案附带精准锚点：
   `Could not find exact oldText in ${path}. Near-matches with different whitespace/indentation appear around line(s) ${nearLines} — read that range to copy exact whitespace.`；若完全无近似行，提示 `Re-read ${path} around the target section to verify current content.`

#### D2.4 `edit` 同文件多块原子替换 `edits`
1. **Schema 扩展**：
   ```ts
   const editHunkSchema = Type.Object({
     oldText: Type.String({ description: "Exact text to find" }),
     newText: Type.String({ description: "Replacement text" }),
     replaceAll: Type.Optional(Type.Boolean({ description: "Replace all matches of this hunk (default false)" })),
   });
   const editSchema = Type.Object({
     path: Type.String({ description: "Path to the file to edit" }),
     oldText: Type.Optional(Type.String({ description: "Exact text to replace (single-edit form)" })),
     newText: Type.Optional(Type.String({ description: "Replacement text (single-edit form)" })),
     replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence (single-edit form)" })),
     edits: Type.Optional(
       Type.Array(editHunkSchema, {
         minItems: 1,
         maxItems: 50,
         description: "Multiple atomic edits to this file; mutually exclusive with top-level oldText/newText.",
       }),
     ),
   });
   ```
2. **校验与原子执行语义**：
   - 顶层 `(oldText, newText)` 与 `edits` 必须**二选一**：同时提供或均未提供时抛 `RecoverableToolError`；单块模式保持与现有调用 100% 兼容。
   - 多块模式（`edits.length > 1`）支持 `≤ EDIT_INLINE_MAX_BYTES`（8MB）的常规文本文件（超过 8MB 的超大文件提示分次单块流式编辑）：
     - **均针对编辑前的同一份原文件快照定位**（避免模型在脑中手动推算前一块替换引起的行偏移），每个 hunk 独立执行唯一性检查（含 D2.2 CRLF 适配与 D2.3 含 hunk 序号 `#k` 的行号诊断）；
     - 收集所有待替换字节区间 `[start, end)`，按 `start` 升序排列并检查区间严格不重叠（`prev.end <= curr.start`）；若两个 hunk 匹配区间重叠，抛 `RecoverableToolError("Edits #i and #j overlap around line L; merge them into one edit hunk.")`，**零磁盘写入**；
     - 若全部合并后的新缓冲区与原文件字节完全一致，走既有 `applyNoop()` 计数与熔断逻辑；否则执行一次 `checkFingerprintUnchanged` + `fileStore.writeAtomic` 原子落盘，生成合并 diff 回显。
3. **进度文案适配**：更新 [`src/tools/contract/presentation.ts`](../../../src/tools/contract/presentation.ts) 的 `edit` 描述器：当 `Array.isArray(args.edits) && args.edits.length > 1` 时显示 `编辑 <path> (${args.edits.length} 处)`。

---

### 4.3 D3：搜索工具链（`grep` / `glob`）引擎提速、二进制隔离与分页补齐

#### D3.1 `grep` 单次探测 `rg`（ripgrep）优先加速 + fallback `grep -I`
在 [`src/tools/grep.ts`](../../../src/tools/grep.ts) 中（仿照 `command-optimizer.ts` 使用 `WeakMap<Executor, Promise<boolean>>` 每个 `Executor` 实例仅探测一次 `command -v rg`，2 秒超时，失败永不抛错）：

1. **宿主存在 `rg` 时（首选快速路径）**：
   - 自动遵守工作树 `.gitignore` / `.ignore` 并默认跳过二进制文件；显式传 `--hidden`（使隐藏配置文件如 `.eslintrc`、`.github/*` 与现有 `glob`/`grep` 行为一致，同时 `.git` 等仍由 `--glob` 排除）；
   - 模式映射：
     - `mode === "files"`：`rg --files-with-matches --no-messages --hidden --color=never`
     - `mode === "count"`：`rg --count-matches --with-filename --no-messages --hidden --color=never`
     - `mode === "content"`：`rg --line-number --with-filename --no-heading --no-messages --hidden --color=never -B1 -A3`（`rg` 的匹配行输出 `path:N:text`、上下文行输出 `path-N-text`、块分隔符 `--`，与现有 `parseGrepOutput` 格式 **100% 兼容**！）
   - 正则/字面量与大小写：`literal ? "-F" : undefined`（注：`rg` 默认正则语法兼容全部 POSIX ERE 常用结构；若 `rg` 返回退出码 `2` 正则语法报错，错误提示指引检查正则或传 `literal: true`），`caseSensitive === false ? "-i" : "-s"`；
   - 目录排除与 `glob` 过滤：对 `IGNORED_DIR_SEGMENTS` 及 `denyBasenames` 追加 `--glob !**/<seg>/**` 与 `--glob !<base>`；若用户传入 `glob`（文件名模式），追加 `--glob ${shellEscape(glob)}`；
   - **安全铁律（I6）**：无论走 `rg` 还是 `grep`，入口 `checkPathGuard`、JS 侧 `isIgnoredPath` / `globRegExp` 复核以及 `partitionByReadGuard` 逐文件读策略过滤**原封不动保留**，确保绝不因 `rg` 与路径守卫规则细微差异产生任何越权泄露。
2. **宿主无 `rg` 时（可移植回退路径）**：
   - 在原 `grep` 标志集中补齐 **`-I`**（跳过二进制文件，Linux GNU grep 与 macOS BSD grep 均原生支持），消除二进制文件混入 `mode: "files"` 或拖慢递归扫描的问题。

#### D3.2 `glob` 有界并发 `stat` 与 `skip` 分页
在 [`src/tools/glob.ts`](../../../src/tools/glob.ts) 中：
1. **消除串行 `stat` 阻塞**：将 `sortableByMtime` 分支中的串行 `for ... await fileStore.stat(...)` 替换为固定并发度（`STAT_CONCURRENCY = 32`）的分批并发采集（并响应 `signal?.aborted`），将上千文件的元数据排序耗时缩短一个数量级。
2. **补齐 `skip` 分页**：在 `globSchema` 中新增可选 `skip?: number`（`Type.Optional(Type.Integer({ minimum: 0, description: "Result offset for paging when >100 files match." }))`，对齐 `grep.skip`）；当 `ordered.length > startOffset + page.length` 时，页脚提示 `Showing ${startOffset + 1}-${startOffset + page.length} of ${ordered.length} matches... Use skip=${startOffset + page.length} for the next page, or narrow pattern/path.`

---

### 4.4 D4：`bash` 与 `job` 单次输出预算收紧及精准排障引导

1. **区分文件读取与命令尾部的单次预算**：
   - `read`、`grep`、`glob`、`skill` 继续保持 `DEFAULT_MAX_BYTES = 50 * 1024`（50KB）与 `DEFAULT_MAX_LINES = 2000`；
   - 在 [`src/tools/bash.ts`](../../../src/tools/bash.ts) 中定义专用的 `BASH_MAX_OUTPUT_BYTES = 30 * 1024`（30KB）与 `BASH_MAX_OUTPUT_LINES = 1000`（并同步用于 [`src/tools/job.ts`](../../../src/tools/job.ts) 第 60 行单个已完成作业的 `truncateTail`），减少长构建/测试日志对主会话与任务会话上下文的瞬时填充，延缓触发 75% 预防性摘要压缩。
2. **升级截断尾注的下一步排障指令**：
   - 当 `bash` 输出发生截断并保留 `spillPath` 时，将尾注中的 `Full output: ${spillPath}` 升级为：
     `Full output: ${spillPath} — use grep on this path to locate errors, or read with offset/limit.`
   - 引导模型对数千行测试输出优先 `grep` 报错关键词而非从第 1 行逐页 `read`。

---

### 4.5 D5：管理与检索工具模型侧 `content` 去 JSON 转义税

保持所有工具的 `details` 返回结构完全不变（遵守 **I5**），仅优化面向模型的 `content[0].text` 渲染：

1. **任务工具集（[`src/tools/task-manage/factory.ts`](../../../src/tools/task-manage/factory.ts) 新增纯格式化函数 `formatTaskResultText(result: TaskManageResult): string`）**：
   - `action === "log"`：首行 `${result.notice}`，若 `entries.length > 0` 则换行直接拼接 `result.entries.join("\n")`（彻底消除日志行内双引号与换行的二次 JSON 转义）；
   - `action === "list"`：空列表直接返回 `${result.notice}`；非空时首行 `${result.notice}`，随后每任务渲染紧凑单行：
     `- [${t.id}] ${t.state}${t.archived ? " (archived)" : ""}${t.frozen ? " (frozen)" : ""} — ${t.title}${budgetAndProgress}${waitingOrActivity}${deliveryHint}`（其中包含 `steps`、`usd`、`unknownCostCount > 0`、`items`、`waiting`、`activity`、`inFlight` 及跨频道 `!t.deliversHere` 标注，零信息丢失但省去约 35%–45% JSON 语法噪音）；
   - 其余单动作结果（`create`、`close`、`message`、`pause`、`resume`、`report`、`ask`、`wait`）：渲染紧凑确定性文本（首行 `result.notice`，附带非空关键元数据行如 `id=...`、`path=...`、`state=...`、`archived=true`、`cancelled=...`）。
2. **冷对话检索（[`src/tools/session-search.ts`](../../../src/tools/session-search.ts)）**：
   - `results.length === 0` 时：不再在英文提示前拼接 `{"results":[],"searchedDocuments":...}`，直接输出紧凑文本：`No matches in cold transcript storage (searched ${response.searchedDocuments} documents). Try a broader query, drop roleFilter, or check MEMORY.md / journal/.${partialNote}`；
   - 有命中时：首行 `Found ${response.results.length} match(es) across ${response.searchedDocuments} cold documents:${partialNote}`，每条命中渲染为 `- [${sourceLabel} · ${hit.role}${hit.timestamp ? ` · ${hit.timestamp}` : ""}] ${hit.snippet}`（保留来源会话名/归档路径、角色、时间与摘要/片段）。
3. **事件管理写操作（[`src/tools/event-manage.ts`](../../../src/tools/event-manage.ts)）**：
   - `list` 与 `show` 保持原样（`show` 仍返回格式化定义 JSON 以便模型先 `show` 后精确修改重提 `update`）；
   - `create`、`update`、`delete` 改为返回单行确认：`${result.notice} (name=${result.name}${result.eventType ? `, type=${result.eventType}` : ""}${result.channelId ? `, channel=${result.channelId}` : ""}${result.deleted !== undefined ? `, deleted=${result.deleted}` : ""})`。
4. **技能列表（[`src/tools/skill.ts`](../../../src/tools/skill.ts)）**：
   - `action === "list"` 改为紧凑行文本：列出每个技能 `- ${s.name} [${s.source}]${s.disableModelInvocation ? " (user-only: disableModelInvocation)" : ""} — ${s.description} (${s.path})`，若有 `diagnostics` 则附带诊断行，避免裸 JSON 转义并显式标注禁止模型自调的技能。

---

### 4.6 D6：工具批次并发引导与内置 Verifier 守卫提示

1. **提示词批次并发引导（[`src/agent/prompt/sections.ts`](../../../src/agent/prompt/sections.ts)）**：
   - 官方 Pi SDK 在同批工具调用中只要遇到任意 `executionMode === "sequential"` 工具（`bash`、`edit`、`write`），就会将同批所有工具退化为串行执行；
   - 在保持 `EXECUTION_SECTION` 总长度严格 `<= 700` 字符（及 `runtimeAuthoredUnits <= 700`）的前提下，将只读探查批次纪律凝练合入第一/第二条（例如：`Batch read/grep/glob/web_fetch calls together so they run in parallel; keep bash/edit/write in separate steps once inspection settles.`），并递增 [`src/agent/prompt/builder.ts`](../../../src/agent/prompt/builder.ts) 的 `RUNTIME_PROMPT_VERSION = 6`。
2. **内置 `purpose="verify"` 子代理的 `bash` 只读边界提示（[`src/subagents/internal/worker.ts`](../../../src/subagents/internal/worker.ts)）**：
   - 当 `runContext.purpose === "verify"` 时，除继续过滤 `write` 与 `edit` 外，若工具集中包含 `bash`，为其 `description` 追加一句明确约束：`Verification mode (purpose=verify): run read-only checks and tests only; do NOT modify tracked workspace files.`（不加硬命令阻断以免误伤运行单测生成临时覆盖率目录，与角色契约形成双重约束）。

---

## 5. 风险与边界评估

1. **`edit` 开启 CRLF 自动回退是否会意外改坏故意测试换行符的文件？**
   - **缓解**：精确字节匹配永远排第一优先级；仅当原样字节匹配结果为 `0`、且原文件已存在 `\r\n`、同时模型传入的 `oldText` 纯 `\n` 时才触发 CRLF 对齐匹配，并且替换进去的 `newText` 也严格保持原文件的 `\r\n` 风格，不会把 LF 文件改成 CRLF，也不会把 CRLF 文件改成混合行尾。
2. **软提示（Soft Hint）在多轮会话重启或 `/reload` 后是否会误报“未读覆写”？**
   - **缓解**：观察表生命周期绑定当前工具集实例（`/reload` 或 daemon 重启会重建实例），且按 **I3** 规定**绝不抛错阻断写入**，最多在重构/重启后的首次 `write` 既有文件时附带一行温和的 `Note:` 提醒，零额外轮次成本、零死锁风险。
3. **宿主安装不同版本 `rg` 时参数兼容性如何保障？**
   - **缓解**：仅使用 `rg` 自 `0.10+` 起长期稳定的基础 POSIX 风格参数（`--line-number`、`--with-filename`、`--no-heading`、`--no-messages`、`--hidden`、`--color=never`、`--files-with-matches`、`--count-matches`、`-F`、`-i`、`--glob`）；若探测失败则无缝退回 `grep -I`，且结果统一经过 Pipiclaw 自身的 `partitionByReadGuard` 安全过滤。
4. **`task_*` 与 `session_search` 改为紧凑文本后是否影响评测评分器（Eval Oracles）？**
   - **缓解**：已核查 `evals/` 全部评分器与控制夹具——任务评测通过磁盘契约文件、`subagent-runs.jsonl` 与任务循环日志评分，`session_search` 评测通过工具调用次数、无错误状态与最终回复包含目标 token 评分，均不解析工具 `content` 为 JSON。实施阶段仍将运行完整 `npm run test:evals` 与相关行为探针复核。

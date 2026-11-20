# 070：实施计划（面向实施 Agent 的执行手册）

| 字段 | 内容 |
| --- | --- |
| 状态 | 已实施（[验收记录](acceptance.md)） |
| 日期 | 2026-11-20 |
| 设计依据 | [design.md](./design.md)，D1–D6，不变量 I1–I8 |
| 建议交付顺序 | **Phase 1 → Phase 2 → Phase 3 → Phase 4**（每阶段独立编译与门禁验证通过后再进入下一阶段） |

---

## 1. 实施前必读与基线核对

实施 Agent 开始编码前**必须**依次完成以下准备：

1. **阅读规范与设计**：完整阅读 [`AGENTS.md`](../../../AGENTS.md)、`CLAUDE.md` 与本目录 [`design.md`](./design.md)（重点牢记单向模块分层表、800 行单文件预算、单测/E2E 准入克制原则及破坏性验证要求）。保留工作区既有的未提交文档，严禁 `git reset --hard`。
2. **记录起始基线**：运行并保存起始 commit hash、测试通过数及工具 Schema 体积基线：
   ```bash
   git rev-parse --short HEAD
   npm run check
   npm run playbooks:measure
   npm run test:e2e
   ```
3. **重点看护单文件行数预算（`MAX_LINES = 800`，`scripts/architecture-baseline.json` 严禁新增）**：
   - `src/agent/session/session-host.ts`：当前 **787 行**（仅余 13 行）！Phase 1 移除 `requestTools` 外层包装后应实现**行数净减**，切勿往该文件堆砌新逻辑。
   - `src/tools/edit.ts`：当前 **610 行**！Phase 2 实施 CRLF、行号诊断与多块 `edits` 前，**必须先按职责拆出** `src/tools/edit-match.ts` 与 `src/tools/edit-diff.ts`，使三个文件各自控制在 `< 400` 行。
   - `src/tools/grep.ts`：当前 **545 行**；若接入 `rg` 探测与参数构建后接近 680 行，可将 `rg` 探测与命令行拼装抽入同目录 `src/tools/grep-command.ts`。
   - 新增同目录内部文件注意遵循命名规范（kebab-case、不建立泛化的 `utils.ts` / `helpers.ts`、不建 barrel re-export）。

---

## 2. 四阶段工作包总览

| 阶段 | 核心目标 | 涉及源码文件 | 阶段完成门禁 |
| --- | --- | --- | --- |
| **Phase 1：契约裂缝修复与精确 Schema 裁剪（D1）** | 1. 修复 `subagent_inline` 在 `session-events` 与 `turn-recovery` 的三处漏判<br/>2. 将 `request` 模式收敛进 `createPipiclawTools({ requestScoped: true })`，根治 `bash` 悬空 `async/notify` 与 `RecoverableToolError` 逃逸，删除 `request-tools.ts`<br/>3. `chat` 模式裁剪 `subagent` / `subagent_inline` 的 `item` 字段<br/>4. 统一 `tool.end` 在 `rejected` 下的 `ok: false` 语义<br/>5. 修正 `bash.ts` `find`→`glob` 文案，子代理透传 `bashInterceptor`，收紧 `event_manage` 冗余 Schema 描述 | `src/agent/session/session-events.ts`<br/>`src/agent/turn/turn-recovery.ts`<br/>`src/agent/session/session-host.ts`<br/>`src/agent/session/request-tools.ts` (删除)<br/>`src/tools/index.ts`<br/>`src/tools/registry.ts`<br/>`src/tools/subagent.ts`<br/>`src/tools/bash.ts`<br/>`src/tools/event-manage.ts`<br/>`src/subagents/types.ts` | `npm run check` 全绿；`chat (all on)` 工具 Schema 降至 `<= 2,820u`；单测验证 `request` 下 `bash` 无 `async` 字段且强传 `async:true` 返回 `recoverable: true` |
| **Phase 2：文件读写闭环升级与软提示（D2）** | 1. 新建 `file-observations.ts`，为同工具集实例的 `read`/`write`/`edit` 接入**纯非阻塞**“先读后写 / 外部变更”软提示（`Note: ...`）<br/>2. 拆分 `edit.ts` 为 `edit.ts` + `edit-match.ts` + `edit-diff.ts`<br/>3. 实现 `edit` CRLF 透明匹配与原文件行尾风格保持<br/>4. 实现 `edit` 多处匹配行号列表与零匹配空白近似行号提示<br/>5. 实现同文件多块原子编辑 `edits` 及 `presentation.ts` 进度文案 | `src/tools/file-observations.ts` (新建)<br/>`src/tools/edit-match.ts` (新建)<br/>`src/tools/edit-diff.ts` (新建)<br/>`src/tools/edit.ts`<br/>`src/tools/read.ts`<br/>`src/tools/write.ts`<br/>`src/tools/write-content.ts`<br/>`src/tools/registry.ts`<br/>`src/tools/contract/presentation.ts` | `npm run check` 全绿；所有文件 `< 800` 行；`chat (all on)` Schema 仍 `<= 2,850u`；覆盖 CRLF、多块重叠零写入回滚、未读覆写仅软提示不报错 |
| **Phase 3：搜索加速与输出 Token 降税（D3 + D4 + D5）** | 1. `grep` 增加 `WeakMap<Executor, Promise<boolean>>` 单次 `rg` 探测优先路径 + fallback `grep -I`，完整保留 `partitionByReadGuard` 安全过滤<br/>2. `glob` 串行 `stat` 改为 `32` 并发 + 新增 `skip` 分页<br/>3. `bash` / `job` 单次尾部截断收紧至 `30KB / 1000 行` 并升级 `spillPath` 排障引导<br/>4. `task_*`、`session_search`、`event_manage`（写动作）、`skill`（`list`）的 `content` 去裸 JSON 转义（`details` 不变） | `src/tools/grep.ts` (必要时加 `grep-command.ts`)<br/>`src/tools/glob.ts`<br/>`src/tools/bash.ts`<br/>`src/tools/job.ts`<br/>`src/tools/task-manage/factory.ts`<br/>`src/tools/session-search.ts`<br/>`src/tools/event-manage.ts`<br/>`src/tools/skill.ts` | `npm run check` + `npm run test:evals` + `npm run test:e2e` 全绿；验证 `rg` 可用与不可用两条路径及 `readDeny` 安全边界零退化 |
| **Phase 4：批次并发引导、文档同步与全面验收（D6）** | 1. `EXECUTION_SECTION`（`<= 700` 字符）补充纯只读并发批次 vs 串行批次分离引导，`RUNTIME_PROMPT_VERSION = 6`<br/>2. 内置 `purpose="verify"` 子代理为 `bash` 追加只读模式描述约束<br/>3. 同步相关文档，执行完整门禁、Mutation 验证与行为探针，撰写 `acceptance.md` | `src/agent/prompt/sections.ts`<br/>`src/agent/prompt/builder.ts`<br/>`src/subagents/internal/worker.ts`<br/>`docs/specs/070-tool-ergonomics-and-exposure/acceptance.md`<br/>`docs/specs/README.md` | 完整离线门禁 + Mutation 验证表全部通过；记录前后预算指标对比与行为探针结果 |

---

## 3. 各阶段执行细则与测试指引

### 3.1 Phase 1 执行细则（契约修复与 Schema 裁剪）

1. **`subagent_inline` 三处补齐（D1.1）**：
   - 修改 [`src/agent/session/session-events.ts`](../../../src/agent/session/session-events.ts)：提取 `function isDelegationTool(toolName: string): boolean { return toolName === "subagent" || toolName === "subagent_inline"; }`，替换第 129 行与第 147 行的硬编码判断；
   - 修改 [`src/agent/turn/turn-recovery.ts`](../../../src/agent/turn/turn-recovery.ts) 第 27 行：加入 `toolName === "subagent_inline"`。
2. **`request` 模式工具构建收敛（D1.2）**：
   - 在 [`src/tools/index.ts`](../../../src/tools/index.ts) 的 `CreatePipiclawToolsOptions` 增加 `requestScoped?: boolean`（`jobManager` 保持传入或可选）；
   - 当 `options.requestScoped === true` 时：向 `buildToolSet` 传 `jobManager: undefined`，并在返回前用 `REQUEST_SCOPED_TOOL_NAMES` 过滤（注意过滤保留在 `withToolDetails` 之后即可，不要再加外层 `execute` 包装；同时更新 [`src/tools/bash.ts`](../../../src/tools/bash.ts) 第 297 行无 `jobManager` 时的 `RecoverableToolError` 文案：`"This context does not support background execution (async=true requires a persistent chat or task session). Run the command in the foreground without async."`）；
   - 在 [`src/agent/session/session-host.ts`](../../../src/agent/session/session-host.ts) 的 `buildRuntimeTools()` 中传 `requestScoped: this.deps.profile.kind === "request"`，删去 `requestTools` 调用与导入，删除 `src/agent/session/request-tools.ts`。
3. **`chat` 裁剪 `subagent*.item`（D1.3）**：
   - 在 [`src/tools/subagent.ts`](../../../src/tools/subagent.ts) 定义 `const subagentChatSchema = Type.Omit(subagentSchema, ["item"])` 与 `const subagentInlineChatSchema = Type.Omit(subagentInlineSchema, ["item"])`；在 `createSubAgentTool` / `createSubAgentInlineTool` 中按 `options.boundTaskId ? fullSchema : chatSchema` 赋值 `parameters`。
4. **统一 `tool.end` 的 `ok` 字段（D1.4）**：
   - 在 [`src/agent/session/session-events.ts`](../../../src/agent/session/session-events.ts) 第 219 行改为 `ok: !event.isError && !subAgentDetails?.failed && !rejected`。
5. **文案、子代理拦截器与 `event_manage` 瘦身（D1.5）**：
   - [`src/tools/bash.ts`](../../../src/tools/bash.ts) 第 248 行 `find` → `glob`；
   - 在 [`src/subagents/types.ts`](../../../src/subagents/types.ts)（`WorkerToolRequest` 与 `SubAgentToolOptions`）、[`src/tools/index.ts`](../../../src/tools/index.ts)、[`src/subagents/internal/worker.ts`](../../../src/subagents/internal/worker.ts) 与 [`src/tools/registry.ts`](../../../src/tools/registry.ts) 贯通 `bashInterceptorEnabled`；
   - 精炼 [`src/tools/event-manage.ts`](../../../src/tools/event-manage.ts) 中 `eventDefinitionSchema` 的字段描述字符串（不改字段名与校验器），目标将该工具体积从 `321u` 降至 `<= 255u`。
6. **Phase 1 测试要求（扩展既有测试，严控净增）**：
   - 扩展 [`test/session-events.test.ts`](../../../test/session-events.test.ts)：验证 `subagent_inline` 的 `tool_execution_update` 触发 `tool.update`、结束时计入 `totalUsage`，且 `RecoverableToolError` 结果触发 `tool.end` 时 `ok === false` 且 `failure === undefined`；
   - 扩展 [`test/turn-recovery.test.ts`](../../../test/turn-recovery.test.ts)：补充 `subagent_inline` 未完成调用的恢复指引断言；
   - 扩展 [`test/tool-details.test.ts`](../../../test/tool-details.test.ts)：验证 `requestScoped: true` 构建出的工具集仅含 `REQUEST_SCOPED_TOOL_NAMES`、`bash.parameters` 不含 `async`/`notify`，且强行调用 `bash({ command: "echo 1", async: true })` 返回 `details: { kind: "bash", recoverable: true }` 而非抛出未捕获异常；验证普通 `chat` 下 `subagent.parameters` 不含 `item` 而 `taskSession` 下包含 `item`。

---

### 3.2 Phase 2 执行细则（文件读写闭环升级与非阻塞软提示）

1. **实现 `src/tools/file-observations.ts`（D2.1）**：
   - 导出 `createFileObservations(capacity = 256)`，提供：
     - `record(resolvedPath: string, stat: FileStat): void`
     - `describeWriteNote(resolvedPath: string, displayPath: string, before: FileStat | null | undefined): string | undefined`
     - `describeEditNote(resolvedPath: string, displayPath: string, before: FileStat): string | undefined`
   - 在 [`src/tools/registry.ts`](../../../src/tools/registry.ts) 的 `buildToolSet` 顶部实例化一个 `observations = createFileObservations()`，注入给 `createReadTool`、`createWriteTool`、`createEditTool`（单元测试直接单独调 `createWriteTool(fileStore)` 未传 `observations` 时安全降级为空操作，保持全部旧单测零修改兼容！）。
   - **再次确认硬约束（I3）**：`describeWriteNote` 与 `describeEditNote` 只返回可选提示字符串拼在成功结果末尾，**严禁抛出任何异常或阻止写入**。
2. **模块化拆分并升级 `edit`（D2.2–D2.4）**：
   - 拆出 `src/tools/edit-diff.ts`（承载 `generateDiffString`、`clampDiffForEcho`、`expandToLineBoundaries`）；
   - 拆出 `src/tools/edit-match.ts`（承载 `findAllOffsets`、`spliceIntervals`、CRLF 回退匹配、字节偏移转 1-indexed 行号计算、零匹配首尾去空白近似行扫描 `findNearWhitespaceLines`、流式 `scanOccurrences`）；
   - 在 `src/tools/edit.ts` 更新 `editSchema` 支持顶层 `(oldText, newText, replaceAll?)` 与 `edits?: Array<{ oldText, newText, replaceAll? }>` 互斥二选一：
     - 单块调用归一化为单元素 `hunks = [{ oldText, newText, replaceAll }]` 复用同一套内联校验管线（超大文件 `> 8MB` 仅当 `hunks.length === 1` 时走 `editStreaming`，`hunks.length > 1` 时抛 `RecoverableToolError` 指引拆为单块流式调用）；
     - 多块校验：全部 hunk 在原文件字节缓冲区上独立定位 → 校验无重叠区间（按起始偏移排序后 `intervals[i - 1].end <= intervals[i].start`，若重叠报出冲突 hunk 序号与行号）→ 一次性拼接新 Buffer → `checkFingerprintUnchanged` → `fileStore.writeAtomic`；
   - 更新 [`src/tools/contract/presentation.ts`](../../../src/tools/contract/presentation.ts) 的 `edit` 描述器以支持 `edits` 数组。
3. **Phase 2 测试要求**：
   - 扩展 [`test/edit.test.ts`](../../../test/edit.test.ts)：
     1. CRLF 文件传入 `\n` 多行 `oldText` 与 `\n` `newText` 时成功匹配，且写回磁盘的文件保持全篇 `\r\n` 无裸 `\n`；
     2. 多处匹配报错包含准确行号（如 `lines 2, 5`）；缩进差异零匹配报错包含近似行号提示；
     3. `edits` 多块原子替换：两处非相邻块一次成功落盘；若第 2 块不匹配或两块区间重叠，抛 `RecoverableToolError` 且原文件磁盘字节分毫不改；
   - 扩展 [`test/write-content.test.ts`](../../../test/write-content.test.ts)（或在同测试集覆盖完整的 `read` → `write` / `edit` 交互）：验证通过 `buildToolSet` 共享观察器时，未 `read` 直接 `write` 非空旧文件**成功写入**且返回文本含 `Note:`，先 `read` 再 `write` 无 `Note:`，先 `read` 后外部改写磁盘再 `edit`/`write` **成功写入**且返回文本含外部变更 `Note:`。

---

### 3.3 Phase 3 执行细则（搜索提速、`bash` 预算收紧与输出去 JSON 税）

1. **`grep` 接入 `rg` 探测与 `grep -I`（D3.1）**：
   - 在 [`src/tools/grep.ts`](../../../src/tools/grep.ts)（若超 680 行则抽 `src/tools/grep-command.ts`）实现 `isRgAvailable(executor)`（`WeakMap<Executor, Promise<boolean>>` 缓存 `command -v rg`，超时 2 秒）；
   - 构建 `rg` 命令与 fallback `grep -I` 命令，确保两种后端在 `content` / `files` / `count` 三种 `mode`、`literal`、`caseSensitive`、`glob`、目录排除及无匹配（退出码 `1`）与正则错误（退出码 `>= 2` → `RecoverableToolError`）上的语义完全一致；
   - **严禁删除或绕过** `checkPathGuard` 与 `partitionByReadGuard`。
2. **`glob` 并发 `stat` 与 `skip`（D3.2）**：
   - 在 [`src/tools/glob.ts`](../../../src/tools/glob.ts) 用 `STAT_CONCURRENCY = 32` 的工作池替换串行 `stat` 循环；
   - 为 `globSchema` 增加 `skip` 整数参数并更新切片 `ordered.slice(startOffset, startOffset + GLOB_MAX_RESULTS)` 与分页尾注。
3. **`bash` / `job` 尾部预算收紧与尾注升级（D4）**：
   - 在 [`src/tools/bash.ts`](../../../src/tools/bash.ts) 导出 `BASH_MAX_OUTPUT_BYTES = 30 * 1024` 与 `BASH_MAX_OUTPUT_LINES = 1000`，传给 `bash.ts` 内部两处 `truncateTail(..., { maxBytes: BASH_MAX_OUTPUT_BYTES, maxLines: BASH_MAX_OUTPUT_LINES })` 及 [`src/tools/job.ts`](../../../src/tools/job.ts) 的 `truncateTail`；
   - 更新 `bash.ts` 的 `fullOutputHint` 包含 `use grep on this path to locate errors, or read with offset/limit`。
4. **管理与检索工具 `content` 紧凑文本化（D5）**：
   - 依次更新 [`src/tools/task-manage/factory.ts`](../../../src/tools/task-manage/factory.ts)、[`src/tools/session-search.ts`](../../../src/tools/session-search.ts)、[`src/tools/event-manage.ts`](../../../src/tools/event-manage.ts)（仅 `create`/`update`/`delete` 分支，`list` 与 `show` 保持不变）、[`src/tools/skill.ts`](../../../src/tools/skill.ts)（`action === "list"` 分支）；
   - 核对每个工具返回的 `details` 字段与改动前 100% 一致。
5. **Phase 3 测试要求**：
   - 扩展 [`test/grep-tool.test.ts`](../../../test/grep-tool.test.ts)：同时覆盖 `rg` 可用（默认宿主或 mock executor）与强制走 fallback `grep -I`（模拟 `command -v rg` 返回 `1`）两条路径，确认二进制文件在 `mode: "files"` 下被跳过且 `readDeny` 文件绝不泄露；
   - 扩展 [`test/glob-tool.test.ts`](../../../test/glob-tool.test.ts)：覆盖 `skip` 分页与并发 `stat` mtime 排序；
   - 更新 [`test/bash.test.ts`](../../../test/bash.test.ts) 中涉及默认截断字节数（若原测试构造了 `50KB` 边界数据则对齐 `BASH_MAX_OUTPUT_BYTES`）的断言；
   - 检查并扩展 [`test/task-manage.test.ts`](../../../test/task-manage.test.ts) 与 [`test/session-search.test.ts`](../../../test/session-search.test.ts)，确认 `content[0].text` 为无双重转义的可读文本且 `details` 契约完整。

---

### 3.4 Phase 4 执行细则（并发批次引导、Verifier 提示与整体验收）

1. **系统提示词并发批次引导（D6.1）**：
   - 编辑 [`src/agent/prompt/sections.ts`](../../../src/agent/prompt/sections.ts) 的 `EXECUTION_SECTION`，凝练加入纯只读调用成批并发、与 `bash`/`edit`/`write` 分批的指引，确保 `EXECUTION_SECTION` 字符数 `<= 700` 且全提示词 `runtimeAuthoredUnits <= 700`；
   - 将 [`src/agent/prompt/builder.ts`](../../../src/agent/prompt/builder.ts) 的 `RUNTIME_PROMPT_VERSION` 升至 `6`。
2. **内置 Verifier `bash` 描述加固（D6.2）**：
   - 在 [`src/subagents/internal/worker.ts`](../../../src/subagents/internal/worker.ts) 的 `buildSubagentTools` 中，当 `runContext.purpose === "verify"` 时，将 `bash` 工具映射为附带只读核验约束说明的副本。
3. **文档与架构引用复核**：
   - 检查 `AGENTS.md`、`CLAUDE.md`、`docs/architecture.md` 是否存在因拆分/删除文件产生的失效引用（`npm run arch` 的 R5 会自动校验）。

---

## 4. 强制门禁、破坏性验证（Mutation Checks）与行为评测

### 4.1 离线全量门禁

最终状态必须全部零错误通过：

```bash
npm run build
npm run playbooks:measure
npm run check
npm run test:evals
npm run test:e2e
git diff --check
```

### 4.2 必须执行的破坏性验证（Mutation Checks）

实施 Agent 在合入前须逐项人为破坏一次目标代码、确认对应测试变红后恢复，并将证据记入 `acceptance.md`：

| 编号 | 人为破坏动作 | 预期变红的测试 |
| --- | --- | --- |
| **M1** | 在 `session-events.ts` 将 `isDelegationTool` 退回仅匹配 `"subagent"` | `test/session-events.test.ts` 中 `subagent_inline` 进度与用量归集断言失败 |
| **M2** | 在 `session-events.ts` 将 `tool.end` 的 `ok` 退回不含 `&& !rejected` | `test/session-events.test.ts`（或 Web API 输出单测）中可恢复拒单 `ok === false` 断言失败 |
| **M3** | 在 `edit-match.ts` 注释掉多块区间重叠检查 `prev.end <= curr.start` | `test/edit.test.ts` 重叠多块零写入保护断言失败 |
| **M4** | 在 `file-observations.ts` 将未读覆写 `Note:` 改成 `throw new RecoverableToolError(...)` | `test/write-content.test.ts` 非阻塞软提示断言失败（确保不违反 **I3**） |
| **M5** | 在 `grep.ts` 的 `rg` 分支跳过 `partitionByReadGuard` 后置过滤 | `test/grep-tool.test.ts` / `test/tool-security.test.ts` 的 `readDeny` 隔离断言失败 |

### 4.3 真实模型行为探针（Behavior Evals）

由于 D4/D5/D6 涉及模型可见的工具输出格式与执行提示词，当运行环境具备模型凭据时，按 [`docs/evals.md`](../../evals.md) 执行：

```bash
npm run eval -- plan --changed-since <起始基线>
```

重点运行并核对以下探针（须先通过正/负/等价 oracle controls，保留原始 `runId`）：
1. **日常核心六例 `dev` 集**（`C-fix-01`、`M-overflow-01`、`T-job-01`、`D-verify-01`、`U-desk-cwd-01`、`S-inject-core-01`）：确认代码修改、防上下文溢出、任务作业、独立核验与安全边界不退化；
2. **冷检索与任务状态读取相关探针**（如 `M-cold-search` / `T-ask-01`）：确认 `session_search` 与 `task_*` 去 JSON 转义后模型准确提取事实并正常完成多步闭环。

若当前机器无可用模型凭据或额度受限，必须在 `acceptance.md` 明确记录“离线门禁与 Mutation 验证已完成；真实模型行为探针因无凭据待执行”，严禁将离线通过冒充为行为质量通过。

---

## 5. 验收归档要求（`acceptance.md`）

全部阶段完成后，在本目录新建 `docs/specs/070-tool-ergonomics-and-exposure/acceptance.md`，并同步更新 [`docs/specs/README.md`](../README.md) 中 `070` 行的状态链接，至少包含：
1. 起始与完成 commit、新增/删除/拆分文件清单及各涉及文件最终行数；
2. **工具 Schema 体积前后对比表**（`chat (all on)`、`chat (web off)`、`task`、`request`、`subagent` 的工具数、字符数、提示单位变化，验证 `chat (all on) <= 2,850u`）；
3. `npm run check`、`npm run test:evals`、`npm run test:e2e` 完整结果与 unit / e2e 用例净变化统计及准入说明；
4. **M1–M5 破坏性验证**的实际执行记录（破坏点、失败断言摘要、恢复后通过状态）；
5. 真实模型行为探针 `runId`、通过率与观察结论（或凭据缺失的如实声明）。

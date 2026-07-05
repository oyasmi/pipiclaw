# 终端 TUI（Terminal TUI）设计方案

| 字段 | 值 |
|------|------|
| 分支 | `terminal-tui`（建议） |
| 状态 | IMPLEMENTED |
| 日期 | 2026-07-05 |
| 关联实现 | 新增 `src/tui/**`, `src/runtime/channel-context.ts`；改动 `src/runtime/dingtalk.ts`, `src/runtime/delivery.ts`, `src/agent/{channel-runner,session-events,run-queue,types}.ts`, `src/main.ts`, `src/index.ts` |
| 前置 | 无。复用 spec 015（tool registry）、016（usage ledger）、017（fallback）既有产物 |
| 实施计划 | [plan.md](./plan.md) |

> 目标是给 pipiclaw 加一个**在终端里直接对话**的界面，复用同一套配置目录、同一套 memory / session / 工具 / 安全策略，可选择挂到某个既有钉钉会话身份（`--channel dm_xxx`）上继续对话。做**打磨版**：pi-tui 富终端界面、流式进度、斜杠命令补全、输入历史、优雅退出与记忆落盘——不是一次性 readline demo。

---

## 一句话模型

> **TUI 是钉钉之外的第二个"交付面"。** agent 的编排器 `ChannelRunner` 早已只依赖一个抽象的交付接口（本方案把它从 `DingTalkContext` 正名为 `ChannelContext`）和 `ChannelStore`，与钉钉零硬耦合。加 TUI＝实现一个把这套接口画到终端上的交付控制器，再换一个"输入源"（键盘取代 Stream 事件），其余（模型、记忆、工具、命令、账本、fallback）全部原样复用。

## 背景（现状事实，均已核验）

1. **交付面已抽象。** `ChannelRunner`（`src/agent/channel-runner.ts:36`）对钉钉只有一处 `import type { DingTalkContext }`，运行入口是 `run(ctx, store)`（`channel-runner.ts:235`）。runner + `session-events.ts` 实际只调用交付面的约 11 个方法（`respond`/`respondPlain`/`replaceMessage`/`respondInThread`/`deleteMessage`/`primeCard`/`flush`/`close`/`progressStyle`/`finalDelivery`/`message`）。没有任何 `DingTalkBot` 运行时依赖被 runner 引用。
2. **交付面接口定义在 `src/runtime/dingtalk.ts:105`**（`DingTalkContext`），钉钉侧的实现是 `ChannelDeliveryController`（`src/runtime/delivery.ts`，内部做 AI Card 流式 append/replace/finalize）。接口本身是**结构化、传输中立**的——只是名字挂着 DingTalk。
3. **runner 自包含。** 构造签名 `new ChannelRunner(sandboxConfig, channelId, channelDir)`（`channel-runner.ts:137`），内部自建 `AgentSession`、`ModelRegistry`、`SessionManager`、`MemoryLifecycle`，配置全部来自 `APP_HOME_DIR` 下的 `auth.json`/`models.json`/`settings.json`（`paths.ts`）。工作目录取 `process.cwd()`（`channel-runner.ts:199`）。给它一个 `channelId`（如 `dm_xxx`）和对应的 `workspace/<channelId>/` 目录，它就与钉钉共享同一份记忆与会话。
4. **channel 身份即目录。** 钉钉侧 channelId 形如 `dm_{staffId}` / `group_{conversationId}`（`dingtalk.ts:1208`）；每个 channel 一个 `workspace/<channelId>/` 目录（`ensureChannelDir`，`runtime/channel-paths.ts`），存 `SESSION.md`/`MEMORY.md`/`HISTORY.md`/`context.jsonl`/`log.jsonl`。TUI 传入 `--channel dm_xxx` 即复用该目录。
5. **命令双层。** `parseBuiltInCommand`（`src/agent/commands.ts`）只识别传输层命令 `help/steer/followup/stop/events/status/usage`；会话层命令 `/model` `/new` `/compact` `/session` 不被它拦截，会**穿透进 `runner.run()`**，由 SDK 的 command extension 处理并经 `command_result` 事件回投到 `ctx.replaceMessage/respondPlain`（`session-events.ts:240-244`）。→ TUI 只要把消息喂给 runner，会话命令**自动可用**。
6. **启动路径卡在钉钉配置。** `bootstrap()` 在 `loadConfig()`（`bootstrap.ts:459-493, 1038`）里强制校验 `clientId/clientSecret`，占位或缺失即 `BootstrapExitError` 退出。TUI 不需要钉钉凭据 → 这是唯一需要绕开的门槛。
7. **pi-tui 可依赖。** `@earendil-works/pi-tui@0.80.3` 是已发布包（当前未在依赖里，但可安装），提供 `TUI`/`Container`/`Editor`/`Markdown`/`Loader`/`ProcessTerminal`、差分渲染、自动补全、输入历史等——正是 pi coding agent 交互模式所用。

## 目标

- `pipiclaw tui [--channel <id>] [--sandbox <spec>]`：在终端启动一个交互式会话，复用 pipiclaw 配置目录与指定 channel 的记忆/会话。
- **打磨体验**：pi-tui 富界面——可滚动的对话记录、流式进度（工具调用 / thinking / 助手增量）、live 状态行、带历史与斜杠补全的输入框、Markdown 渲染最终答复、优雅的 Ctrl-C 语义。
- **命令齐全**：`/help /stop /steer /followup /status /usage /events` 本地处理；`/model /new /compact /session` 经 runner 穿透。
- **零回归**：钉钉路径行为逐字节不变；对现有文件的改动限于（a）类型正名（编译期、结构不变）、（b）两处纯函数搬迁、（c）`main.ts` 新增一个子命令分支。
- **正名**：`DingTalkContext` → `ChannelContext`，落到一个传输中立的模块。

## 非目标

- **多路并发 / 多 channel 面板**：TUI 是单用户单 channel 的前台会话；不做多窗格、多会话切换。
- **替代钉钉常驻服务**：TUI 与钉钉 daemon 是并列交付面，不是替代。
- **跨进程共享同一 channel 的强一致**：见 §10 的竞争分析——默认用独立 channel 规避，共享钉钉 channel 时明确约束。
- **远程/协作 TUI、鼠标、图片粘贴**：终端图片（pi-tui `Image`）留作后续增强，不在本 spec。
- **改造 memory / tools / security / fallback 语义**：全部原样复用。

---

## 设计

### 分层总览

```
                 ┌────────────────────────────────────────────┐
   键盘输入 ─────▶│  src/tui/  (新)                              │
                 │   ├─ cli.ts          参数解析 / 子命令入口     │
                 │   ├─ app.ts          TUI 运行时：init + 回合循环│
                 │   ├─ terminal-context.ts  ← 实现 ChannelContext │
                 │   ├─ renderer.ts     pi-tui 视图（transcript/  │
                 │   │                   status/editor）+ 纯文本兜底 │
                 │   └─ commands.ts     TUI 侧命令派发             │
                 └───────────────┬────────────────────────────────┘
                                 │  ChannelContext (正名后)  + ChannelStore
                                 ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  既有内核（不改语义）：ChannelRunner → AgentSession → tools /     │
   │  memory / fallback / ledger；session-events 把 SDK 事件翻译成    │
   │  ChannelContext 调用                                            │
   └───────────────────────────────────────────────────────────────┘
                                 ▲
   钉钉交付面（并列，不受影响）：DingTalkBot → delivery.ts →ChannelContext
```

### 1. 正名：`DingTalkContext` → `ChannelContext`

**动机**：这个接口是传输中立的交付契约，挂 DingTalk 名字会误导第二个交付面的实现者。

**做法**——新增中立模块 `src/runtime/channel-context.ts`，把三个**纯形态**声明搬进去：

```ts
// src/runtime/channel-context.ts  (新)
export type ProgressStyle = "full" | "rolling" | "none";
export type FinalDelivery = "plain" | "card";

export interface ChannelContext {
  message: { text: string; rawText: string; user: string; userName?: string; channel: string; ts: string };
  channelName?: string;
  respond(text: string, shouldLog?: boolean): Promise<void>;
  respondPlain(text: string, shouldLog?: boolean): Promise<boolean>;
  replaceMessage(text: string): Promise<void>;
  respondInThread(text: string): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  setWorking(working: boolean): Promise<void>;
  deleteMessage(): Promise<void>;
  primeCard(delayMs: number): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  progressStyle: ProgressStyle;
  finalDelivery: FinalDelivery;
}
```

- `src/runtime/dingtalk.ts`：删除这三个声明，改为 `import`/`re-export`；`ResponseMode`、`progressStyleOf`、`finalDeliveryOf`（config→trait 映射，钉钉配置语义）**留在 dingtalk.ts**，从 channel-context 引入 trait 类型。→ 无循环依赖（`channel-context.ts` 不 import dingtalk）。
- 全量替换引用（type-only，结构不变，**无运行时行为差异**）：`delivery.ts`、`channel-runner.ts`、`session-events.ts`、`run-queue.ts`、`agent/types.ts`、`bootstrap.ts`、`test/delivery.test.ts`、`test/session-events.test.ts`。
- **`createDingTalkContext` 保留原名**（它就是钉钉专属工厂），仅返回类型改为 `ChannelContext`。
- **公共 barrel 兼容**（`src/index.ts`，CLAUDE.md 要求导出名稳定）：新增 `export type { ChannelContext, ProgressStyle, FinalDelivery }`；保留 `export type { ChannelContext as DingTalkContext }` 作为**已弃用别名**，注释标注"deprecated, use ChannelContext"，一个发布周期后可删。→ 下游库使用者不断裂。

### 2. 终端交付控制器 `TerminalDeliveryController`（实现 `ChannelContext`）

钉钉侧 `ChannelDeliveryController` 的全部复杂度（AI Card 的 append/replace/finalize、节流、rolling 窗口、warmup）都是**卡片协议专属**；终端不需要。终端控制器是一个瘦实现，把接口方法映射到"渲染器"（§3）：

| 接口方法 | 语义 | 终端行为 |
|---|---|---|
| `respond(text, log?)` | 进度流（工具调用 `Running:`、thinking、助手增量） | 追加到 transcript 的"进度区"；富模式下渲染为次要样式（dim / 带 spinner） |
| `respondPlain(text, log?)` | 最终答复（plain 模式默认走这条） | Markdown 渲染为主要答复块；`return true` |
| `replaceMessage(text)` | 用最终文本替换进度（final_card_only / 命令结果走这条） | 收起进度区，渲染最终答复块 |
| `respondInThread(text)` | 旁路轻通知（skill 变更、fallback 切换） | 渲染为 dim 提示行 |
| `deleteMessage()` | 静默（agent 决定不回复） | 收起进度区，不产出答复块 |
| `primeCard`/`setTyping`/`setWorking` | 卡片/输入态提示 | no-op（或映射到 spinner 开关） |
| `flush()` | 等待交付 settle | resolve 渲染队列（终端渲染是同步 push，flush 基本立即 resolve） |
| `close()` | 关闭本回合交付 | 标记回合结束，冻结进度区 |
| `progressStyle` / `finalDelivery` | 交付特征 | 由 TUI settings 决定，默认 `"full"` / `"plain"`（见 §7） |

要点：
- **归档语义对齐钉钉**。钉钉侧 `respond(text, shouldLog=true)` 会把进度也写进 `store.logBotResponse`（`delivery.ts:152`）。终端控制器同样接受 `store`，对 `shouldLog` 为真的调用做同样归档，保证 TUI 与钉钉产生**同构的会话日志**——这样一个 channel 无论从哪个面进入，`log.jsonl`/记忆语料格式一致。
- **不复用 `createDingTalkContext`**：它绑死 `DingTalkBot`。TUI 提供独立工厂 `createTerminalContext(input, renderer, store, traits)`，其中 `input` 是一个最小的 `TurnInput { text, user, userName, channel, ts }`（不引入 `DingTalkEvent` 类型）。

### 3. 渲染层 `renderer.ts`（pi-tui 富界面 + 纯文本兜底）

抽象一个 `TranscriptRenderer` 接口，交付控制器只依赖它：

```ts
interface TranscriptRenderer {
  appendProgress(entry: ProgressEntry): void;   // 工具/thinking/助手增量/错误
  showFinal(markdown: string): void;             // 主答复块
  showNotice(text: string): void;                // 旁路提示
  clearProgress(): void;                         // 收起进度区
  setWorking(on: boolean): void;                 // spinner
}
```

两个实现：

- **`PiTuiRenderer`（打磨主实现）**——用 `@earendil-works/pi-tui`：
  - `TUI` + `ProcessTerminal` 差分渲染，根容器纵向排布：`Container`（滚动 transcript）+ 底部 `StatusLine`（`Text`）+ `Editor`（输入框）。
  - transcript 条目用 `Markdown` 组件渲染最终答复，`Text`/`TruncatedText` 渲染进度，`Loader` 做 working spinner。
  - `Editor`：多行输入、历史（↑/↓）、粘贴；斜杠命令**自动补全**用 pi-tui 的 autocomplete/`fuzzyFilter`，候选来自命令表（§5）。
  - 终端 resize、raw-mode 生命周期、SIGWINCH 由 pi-tui `Terminal` 托管。
- **`PlainRenderer`（非 TTY 兜底 / 一次性模式）**——当 `stdin` 不是 TTY（管道）或 `--print`：不进 raw-mode，进度写 `stderr`（可静音），最终答复写 `stdout`，跑完即退。便于 `echo "问题" | pipiclaw tui --channel dm_x` 脚本化。

渲染器选择：TTY 且非 `--print` → `PiTuiRenderer`；否则 `PlainRenderer`。

### 4. 复用 runner 与 channel 身份

- channel-id 语义：
  - 省略 `--channel` → 默认 `tui_local`（专属 channel，**规避**与钉钉 daemon 的文件竞争，见 §10）。
  - `--channel dm_xxx` / `--channel group_xxx` / 任意 slug → 复用 `workspace/<id>/`，与钉钉同源记忆。
  - 校验 id 为安全 slug（`^[A-Za-z0-9._-]+$`），防目录穿越（与 `channel-paths` 既有约束一致）。
- 取 runner：直接调 `getOrCreateRunner(sandbox, channelId, ensureChannelDir(workspaceDir, channelId))`（`runner-factory.ts`），并 `ensureChannelMemoryFilesSync(channelDir)`（与 bootstrap `getState` 同款，`bootstrap.ts:701-705`）。
- `user`/`userName`：TUI 用固定的 `tui` / 本机用户名（`os.userInfo().username`），仅用于消息署名与日志。

### 5. 命令处理（TUI 侧）

回合循环拿到一行输入后：

1. `parseBuiltInCommand(text)` 命中传输层命令 → **本地处理**，不进 runner：
   - `/help` → `renderBuiltInHelp()`（复用；help 文案含钉钉措辞，可接受，或后续出 TUI 变体）。
   - `/stop` → `runner.abort()`（仅在运行中有效）。
   - `/steer <msg>` → 运行中 `runner.queueSteer(msg, userName)`；空闲则当普通输入。
   - `/followup <msg>` → 入 TUI 本地队列，当前回合结束后作为下一回合输入。
   - `/status` → `renderChannelStatus(runner.getStatusSnapshot(), …)`（见 §11 的纯函数搬迁）。
   - `/usage [7d|month]` → `renderUsageReport(getUsageLedger(), channelId, parseUsageMode(args), new Date())`（复用 `usage/render.ts`）。
   - `/events …` → `runEventsCommand({ args, workspaceDir, historyPath })`（复用 `runtime/event-commands.ts`）。
2. 否则（含 `/model` `/new` `/compact` `/session` 以及普通消息）→ 走标准回合：`archive → createTerminalContext → runner.run(ctx, store) → ctx.flush/close`。会话命令由 SDK command extension 处理，结果经 `session-events` 回投到渲染器（事实 5）。

TUI 补全候选＝传输层命令 ∪ 会话层命令（静态表），Tab/Enter 选中。

### 6. 无钉钉门槛的应用初始化（从 bootstrap 抽取共享 init）

`bootstrap()` 里"加载 settings 与 tools/security 诊断、校验 sandbox"这几步本就**传输中立**，只是与钉钉专属步骤（`loadConfig` 门槛、`createRuntimeContext`）写在同一函数里。合理做法是把这段中立逻辑抽成可复用函数，钉钉路径与 TUI 路径**共用**——真正 DRY，而非任一方复制。

现状顺序（`bootstrap.ts:1030-1068`）：`bootstrapAppHome → printBootstrapSummary → channelTemplateCreated 门槛 → loadConfig → settings-drain → tools 诊断 → security 诊断 → validateSandbox → logStartup → createRuntimeContext`。其中 **settings-drain → tools 诊断 → security 诊断 → validateSandbox 四步连续且中立**，是干净的抽取点。

抽取（新增，导出自 `bootstrap.ts`）：

```ts
// 传输中立：settings 加载与错误上报 + tools/security 诊断 + sandbox 校验。
// 不触碰任何钉钉配置。钉钉路径与 TUI 路径共用。
export async function prepareAppServices(
  sandbox: SandboxConfig,
  paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
  io: BootstrapIO = console,
): Promise<{ settingsManager: PipiclawSettingsManager }>;
```

内部＝把 `bootstrap.ts:1040-1059` 的 settings drain + tools 诊断 + security 诊断 + `validateSandbox` **原样搬入，逻辑一字不改**。`bootstrap()` 改为在原位置调用它——因抽取的四步在原代码里本就连续、顺序不变，**钉钉路径逐字节一致**：

```
bootstrapAppHome → printBootstrapSummary → channelTemplateCreated 门槛
  → loadConfig → prepareAppServices(sandbox) → logStartup → createRuntimeContext
```

TUI init（`app.ts`）复用同样的构件、跳过钉钉门槛：

```
bootstrapAppHome(paths)              // 复用（TUI 忽略 channelTemplateCreated：不需要 channel.json）
printBootstrapSummary(result, io)    // 复用
const { settingsManager } = await prepareAppServices(sandbox, paths, io)   // 复用同一份 init
log.configureLogging(settingsManager.getLoggingSettings())                 // 与 createRuntimeContext 对称
log.logStartup(workspaceDir, sandboxLabel)
```

要点：
- **`configureLogging` 不进 `prepareAppServices`**：钉钉路径当前在 `createRuntimeContext`（`bootstrap.ts:666`）配置日志，且上面几条诊断是在配置**之前**用默认设置打的。为保持钉钉行为逐字节不变，日志配置留在各自调用点——钉钉在 `createRuntimeContext`，TUI 显式在 `prepareAppServices` 之后。
- `bootstrapAppHome`/`printBootstrapSummary` 本就是各自可调的中立函数，两路各自调用并施加**自己的门槛**（钉钉遇 `channelTemplateCreated` 退出；TUI 忽略它）——门槛差异是两路的合理分歧，不下沉进共享 init。
- 抽取后 `bootstrap()` 更短、职责更清；两路共享同一 init 语义，任一方修 bug 两边同得。

### 7. TUI settings

在 `settings.json` 顶层新增可选块（沿 `Partial<> + DEFAULT` 惯例接入 `PipiclawSettingsManager`，与 spec 017 的 `fallbackModel` 同套路）：

```json
"tui": {
  "responseMode": "full_progress_then_plain_final",
  "theme": "auto"
}
```

- `responseMode` 决定 `progressStyle`/`finalDelivery`（复用 `progressStyleOf`/`finalDeliveryOf`）。默认 `full`＋`plain`：流式进度 + Markdown 最终答复。
- 未配置＝默认值，**不影响钉钉**（钉钉读 `channel.json.responseMode`，两者互不干扰）。
- 全部可选；无 `tui` 块时 TUI 用内置默认，settings 语义对既有字段零改动。

### 8. 并发 / steer / stop / 生命周期（单用户）

- 单 channel 单用户，回合天然串行：TUI 维护一个"当前回合 Promise"，输入在回合运行时按 `/steer`/`/followup`/`/stop` 语义处理，空闲时直接起新回合。**不需要** run-queue 的多消息竞争防护（那是钉钉 Stream 突发场景）；runner 内部的 `run-queue`/`serial-queue` 仍照常工作。
- **Ctrl-C 语义**（打磨点，两段式）：运行中第一次 Ctrl-C＝`/stop`（`runner.abort()`，回合内中止）；空闲时或 500ms 内第二次 Ctrl-C＝退出 TUI（走 §9 优雅关闭）。状态行提示当前含义。
- `Ctrl-D`（空输入）＝退出。

### 9. 关闭与记忆落盘

退出时复用 runner 的关停语义（与 bootstrap 关停同源）：
- 若有回合在跑：`runner.abort()` 并等待其 settle（带超时，参照 `SHUTDOWN_*` 常量量级）。
- 空闲后 `runner.flushMemoryForShutdown()`（`AgentRunner` 接口既有方法，`agent/types.ts:20`）把本 channel 记忆落盘，避免丢失本次对话的 SESSION/记忆更新。
- `resetRunner(channelId)` 清理，恢复终端（pi-tui 退出 raw-mode、还原屏幕）。

### 10. 跨进程文件竞争（唯一真实风险）

同一 channel 的记忆文件（`SESSION.md`/`context.jsonl` 等）在**单进程内**由 `channel-maintenance-queue` 单例串行化保护（见 CLAUDE.md 并发模型）。但**独立 TUI 进程**与**运行中的钉钉 daemon** 若同时操作**同一 channel**，跨进程无锁——可能交错写坏记忆。

对策（分层，明确取舍）：
- **默认 `tui_local`**：TUI 不传 `--channel` 时用专属 channel，与任何钉钉会话零重叠——零风险，覆盖"我就想在终端里用一下"的主场景。
- **显式共享钉钉 channel（`--channel dm_xxx`）**：文档明确约束"接管某钉钉会话身份对话时，不要让 daemon 同时服务它"。启动时若检测到 `workspace/<id>/` 存在活跃锁/近期写入，打印醒目告警但不强阻（用户自负）。
- 原子写（`shared/atomic-file.ts` 的 temp-then-rename）已降低"写到一半"的破坏面，但不解决逻辑交错——因此靠约定而非锁。不在本 spec 引入跨进程锁（过度工程；真需要时另开 spec）。

### 11. 纯函数搬迁：状态渲染

`/status` 需要 `renderStatus`，它当前是 `bootstrap.ts` 的**模块私有**函数（连同 `formatUptime`/`formatTokenCount`，`bootstrap.ts:577-642`）。搬到新的纯函数模块 `src/agent/status-render.ts` 并让 `bootstrap.ts` 从中 import：

- 纯移动，输出逐字节一致；因原函数私有、`bootstrap.test.ts` 无法引用它，**移动对现有测试零影响**。
- TUI 复用同一渲染器（去掉 sandbox/uptime 中 TUI 无意义的部分或照单填充——设计上传入同款 `getStatusSnapshot()` 即可）。
- 新模块补纯函数单测（现状这几个函数无直接测试，顺带补上是净收益）。

---

## 对现有功能的影响面（非回归分析）

改动被严格限制在**编译期正名 + 纯移动 + 一个新分支**，运行时行为面几乎为零：

| 改动 | 类型 | 对钉钉/现有行为的影响 |
|---|---|---|
| `DingTalkContext`→`ChannelContext`（约 10 文件） | 类型正名，结构不变 | 无。类型是结构化的，实现体一字不改；barrel 保留弃用别名 |
| 抽 `channel-context.ts`，移 3 个 trait 声明出 dingtalk.ts | 声明搬迁 | 无。`ResponseMode`/映射函数留在原处；无循环依赖 |
| `renderStatus` 等移到 `status-render.ts` | 纯函数移动 | 无。输出一致；私有函数，测试不受影响 |
| 抽 `prepareAppServices`，`bootstrap()` 改调它 | 逻辑抽取，顺序不变 | 无。四步连续搬出、原位调用，钉钉路径逐字节一致 |
| `main.ts` 加子命令分支 | 新增分支 | 无。无 `tui` 参数时**原样** `bootstrap(argv)`，默认路径不变 |
| `settings.json` 加可选 `tui` 块 | 增字段 | 无。缺省即默认；钉钉读 `channel.json` 另一套字段 |
| `package.json` 加 `@earendil-works/pi-tui` 依赖（+ 可能第二 bin） | 依赖/元数据 | 无运行时影响；仅 TUI 路径加载 |
| 新增 `src/tui/**` | 纯新增 | 无。仅经 `main.ts` 的 `tui` 分支可达 |

关键保证：**钉钉交付面（`delivery.ts` 的 `ChannelDeliveryController`）与 `bootstrap()` 的运行逻辑一行不改。** TUI 是旁挂的第二条入口路径。

---

## 测试策略

- **正名**：`npm run check` 全绿即证明类型迁移无破坏；`test/delivery.test.ts`/`session-events.test.ts` 改名后仍覆盖钉钉交付语义。
- **`TerminalDeliveryController`**：单测其接口方法映射——`respond` 追加进度、`respondPlain` 返回 `true` 且渲染最终块、`replaceMessage` 收进度出答复、`deleteMessage` 静默、`shouldLog` 归档到 `store`（用 fake renderer + fake store 断言调用序列）。这是 TUI 的核心正确性面。
- **命令派发**：表驱动——`/help /stop /steer /followup /status /usage /events` 走本地分支且参数正确；`/model /new /compact` 走 runner 分支。
- **status 渲染**：纯函数单测（token/uptime 格式、fallback 行、无 session 分支）。
- **参数解析**：`--channel` 校验、默认 `tui_local`、`--sandbox` 透传、`--print`/非 TTY 选 `PlainRenderer`。
- **pi-tui 渲染**：以 `PlainRenderer` 承载可断言的输出快照；`PiTuiRenderer` 走轻量冒烟（构造/挂载/卸载不抛），富交互不做像素级断言。
- **e2e（可选，`test:e2e`）**：`PlainRenderer` 一次性模式跑一个真 bootstrap 的最小回合，验证端到端可用与记忆落盘。

## 风险与权衡

- **跨进程竞争**：见 §10。以"默认独立 channel + 共享时约定"化解，不引锁。
- **pi-tui 新依赖**：新增一个 `@earendil-works/*` 依赖。收益（成熟的差分渲染/编辑器/补全）远大于自研 readline 的维护成本；且与内核同一发布方，版本协同风险低。
- **正名触及公共 barrel**：以弃用别名保证不断裂，符合 CLAUDE.md"导出名稳定"。
- **触碰关键启动路径**：抽 `prepareAppServices` 需改 `bootstrap()`。风险以"四步连续原样搬出、原位调用、顺序不变"控制在编译期，配合现有 `bootstrap.test.ts` 与 `check` 总闸兜底；`configureLogging` 刻意留在原处以免诊断日志时序漂移。
- **help 文案含钉钉措辞**：`/help` 复用现有文本，短期可接受；后续可出 TUI 变体（非阻塞）。

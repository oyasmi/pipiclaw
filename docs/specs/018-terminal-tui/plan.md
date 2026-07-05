# 终端 TUI 实施计划

| 字段 | 值 |
|------|------|
| 分支 | `terminal-tui` |
| 状态 | IMPLEMENTED |
| 日期 | 2026-07-05 |
| 设计文档 | [design.md](./design.md) |

---

## 实施原则

1. **钉钉路径逐字节不变。** 对 `delivery.ts` 的 `ChannelDeliveryController` 与 `bootstrap()` 运行逻辑零改动。TUI 是旁挂的第二入口。
2. **正名是纯类型迁移。** `DingTalkContext`→`ChannelContext` 只动类型与 import，实现体一字不改；barrel 保留弃用别名。每步以 `npm run check` 全绿为验收。
3. **从 `bootstrap()` 抽取共享 init。** 把中立的 settings/诊断/sandbox 校验抽成 `prepareAppServices`，钉钉与 TUI 共用（design §6）。四步连续原样搬出、原位调用、顺序不变 → 钉钉路径逐字节一致。
4. **交付面语义与钉钉对齐。** `shouldLog` 归档、progress/final 划分、`flush/close` 契约与 `delivery.ts` 同构，保证同一 channel 跨面日志一致。
5. **能复用就不重写**：命令用 `parseBuiltInCommand`/`renderBuiltInHelp`/`renderUsageReport`/`runEventsCommand`；关停用 `runner.flushMemoryForShutdown`/`resetRunner`。
6. 分任务，每个任务独立可 `check`；先内核可用（`PlainRenderer`），再 pi-tui 打磨。

## 代码锚点（现状事实）

| 锚点 | 位置 |
|------|------|
| 交付面接口定义 | `src/runtime/dingtalk.ts:105`（`DingTalkContext`）；trait `ProgressStyle`/`FinalDelivery` 同文件 `:29-30` |
| 钉钉交付实现 | `src/runtime/delivery.ts`（`ChannelDeliveryController` + `createDingTalkContext`） |
| runner 运行入口 / 唯一钉钉耦合 | `src/agent/channel-runner.ts:36`（`import type`）、`:235`（`run(ctx, store)`） |
| session→交付面翻译 | `src/agent/session-events.ts`（`ctx.respond/replaceMessage/respondPlain`，`:106-376`） |
| 取/建 runner | `src/agent/runner-factory.ts`（`getOrCreateRunner`/`resetRunner`） |
| channel 目录与记忆初始化 | `ensureChannelDir`（`runtime/channel-paths.ts`）、`ensureChannelMemoryFilesSync`（`memory/files.ts`）；bootstrap 用法见 `bootstrap.ts:701-705` |
| 命令解析 / 帮助 | `src/agent/commands.ts`（`parseBuiltInCommand` 仅传输层命令；`renderBuiltInHelp`） |
| 会话命令穿透回投 | `session-events.ts:240-244`（command_result → `replaceMessage`/`respondPlain`） |
| 钉钉配置门槛 | `bootstrap.ts:459-493`（`loadConfig`）、`:1038` |
| 可复用 init 构件 | `bootstrapAppHome`/`printBootstrapSummary`（`bootstrap.ts`）、`PipiclawSettingsManager`（`settings.ts`）、`validateSandbox`/`parseSandboxArg`（`sandbox.ts`）、`log.configureLogging`/`logStartup`（`log.ts`）、`loadToolsConfigWithDiagnostics`/`loadSecurityConfigWithDiagnostics` |
| status 渲染（待搬迁） | `bootstrap.ts:577-642`（私有 `formatTokenCount`/`formatUptime`/`renderStatus`）；调用点 `:747` |
| usage / events 命令 | `renderUsageReport`+`parseUsageMode`（`usage/render.ts`）、`runEventsCommand`（`runtime/event-commands.ts`） |
| 关停语义 | `AgentRunner.flushMemoryForShutdown`/`abort`（`agent/types.ts:20,23`）、`resetRunner` |
| barrel | `src/index.ts:82,88,100`（`createDingTalkContext`/`DingTalkContext` 公共导出） |
| 入口 | `src/main.ts`（仅调 `bootstrap`）；`package.json` `bin.pipiclaw = dist/main.js` |
| pi-tui | `@earendil-works/pi-tui@0.80.3`：`TUI`/`Container`/`Editor`/`Markdown`/`Loader`/`ProcessTerminal`/`fuzzyFilter` |

## 文件清单

新增：

| 文件 | 作用 |
|------|------|
| `src/runtime/channel-context.ts` | 传输中立的 `ChannelContext` + `ProgressStyle` + `FinalDelivery` |
| `src/agent/status-render.ts` | `renderStatus`/`formatUptime`/`formatTokenCount`（自 bootstrap 搬迁，纯函数） |
| `src/tui/cli.ts` | 参数解析（`--channel`/`--sandbox`/`--print`）、子命令入口 `runTui(argv)` |
| `src/tui/app.ts` | TUI 运行时：init（design §6）+ 回合循环 + 生命周期/关停 |
| `src/tui/terminal-context.ts` | `TerminalDeliveryController` + `createTerminalContext`（实现 `ChannelContext`） |
| `src/tui/renderer.ts` | `TranscriptRenderer` 接口 + `PiTuiRenderer` + `PlainRenderer` |
| `src/tui/commands.ts` | TUI 侧命令派发（传输层本地处理；会话层穿透 runner）+ 补全候选表 |
| `test/tui-terminal-context.test.ts` | 交付控制器映射与归档单测 |
| `test/tui-commands.test.ts` | 命令派发表驱动单测 |
| `test/status-render.test.ts` | status 纯函数单测 |
| `test/tui-cli.test.ts` | 参数解析 / renderer 选择单测 |

修改：

| 文件 | 改动 |
|------|------|
| `src/runtime/dingtalk.ts` | 移出三个 trait/接口声明，改为从 `channel-context.js` import/re-export；`ResponseMode`/映射函数留下 |
| `src/runtime/delivery.ts` | import `ChannelContext`（改名） |
| `src/agent/channel-runner.ts` | import `ChannelContext`（改名） |
| `src/agent/session-events.ts` | import `ChannelContext`（改名） |
| `src/agent/run-queue.ts` | import `ChannelContext`（改名） |
| `src/agent/types.ts` | import `ChannelContext`（改名） |
| `src/runtime/bootstrap.ts` | import `ChannelContext`（改名）；抽出并导出 `prepareAppServices`，`bootstrap()` 改调它；`renderStatus` 等改为从 `status-render.js` import |
| `src/index.ts` | 导出 `ChannelContext`/`ProgressStyle`/`FinalDelivery`；`DingTalkContext` 降级为弃用别名 |
| `src/main.ts` | argv[2]==="tui" → `runTui(argv)`；否则原样 `bootstrap(argv)` |
| `src/settings.ts` | `Settings` 顶层可选 `tui?: { responseMode?: ResponseMode; theme?: string }` + getter |
| `test/delivery.test.ts`、`test/session-events.test.ts` | `DingTalkContext`→`ChannelContext`（改名） |
| `package.json` | 加 `@earendil-works/pi-tui` 依赖 |
| `docs/configuration.md` | TUI 用法 + `tui` settings + `--channel` 竞争约束 |

---

## Task 1：正名 `DingTalkContext` → `ChannelContext`（纯类型迁移）

1. 新增 `src/runtime/channel-context.ts`，搬入 `ProgressStyle`/`FinalDelivery`/`ChannelContext`（design §1）。
2. `dingtalk.ts`：删除这三个声明，`import` 回来并 `re-export`（保持 `dingtalk.ts` 处的可见性，`delivery.ts` 等仍可从此拿到）；`ResponseMode`/`progressStyleOf`/`finalDeliveryOf` 留在 `dingtalk.ts`。
3. 全量改名引用：`delivery.ts`、`channel-runner.ts:36`、`session-events.ts`、`run-queue.ts`、`agent/types.ts`、`bootstrap.ts`、`test/delivery.test.ts`（18 处）、`test/session-events.test.ts`（3 处）。
4. `src/index.ts`：`export type { ChannelContext, ProgressStyle, FinalDelivery } from "./runtime/channel-context.js"`；追加 `export type { ChannelContext as DingTalkContext }` 并注释 deprecated。

**验收**：`npm run check` 全绿（lint+typecheck+knip+test）。无任何 `.ts`（除 barrel 别名）残留 `DingTalkContext`。运行时行为零变化。knip 不误报别名——若报，确认 `index.ts` 在 knip entry 内。

## Task 2：从 bootstrap 抽取共享构件（status 渲染 + init）

两项都是把 `bootstrap()` 的内部逻辑变为两路可复用，改前后钉钉行为逐字节一致。

**2a — status 渲染搬迁**
1. 新增 `src/agent/status-render.ts`，移入 `formatTokenCount`/`formatUptime`/`renderStatus`（`bootstrap.ts:577-642`）并 `export`。签名不变（`renderStatus` 的 `options` 结构照旧）。
2. `bootstrap.ts` 删除本地定义，改 import；`:747` 调用点不变。
3. 新增 `test/status-render.test.ts`：token 格式（<1k/k/M）、uptime（d/h/m）、running/idle 分支、fallback 行、无 session 分支。

**2b — `prepareAppServices` 抽取**（design §6）
1. `bootstrap.ts` 新增并导出 `prepareAppServices(sandbox, paths?, io?): Promise<{ settingsManager }>`，内部为 `bootstrap.ts:1040-1059` 的 settings drain + tools 诊断 + security 诊断 + `validateSandbox` **原样搬入**。
2. `bootstrap()` 在原位置（`loadConfig` 之后、`logStartup` 之前）改调 `prepareAppServices(sandbox, paths, io)`；删掉被搬走的内联块。**保持步骤顺序不变**。
3. `configureLogging` **不进** `prepareAppServices`——仍由 `createRuntimeContext`（`:666`）负责，钉钉诊断日志时序不变。

**验收**：`npm run check` 全绿；`/status` 输出与改前逐字节一致（对照文案断言）；`bootstrap.test.ts` 不改而全过（证明钉钉启动路径行为不变）。

## Task 3：`TerminalDeliveryController` 与工厂

1. `src/tui/terminal-context.ts`：`createTerminalContext(input: TurnInput, renderer: TranscriptRenderer, store: ChannelStore, traits: { progressStyle; finalDelivery }): ChannelContext`。
2. 方法映射按 design §2 表实现；`respond`/`respondPlain` 的 `shouldLog` 为真时 `store.logBotResponse(channel, text, ts)`（对齐 `delivery.ts:119-126,152`）。
3. `flush`/`close` 语义：终端渲染同步，`flush` 立即 resolve；`close` 冻结进度区。
4. `TurnInput` 就地定义（不引 `DingTalkEvent`）。

**验收**：`test/tui-terminal-context.test.ts`——fake renderer 断言：`respond`→`appendProgress`；`respondPlain`→`showFinal` 且返回 `true`；`replaceMessage`→`clearProgress`+`showFinal`；`deleteMessage`→`clearProgress` 且无 `showFinal`；`respondInThread`→`showNotice`；`shouldLog=true`→ fake store 收到归档，`false`→ 未归档。

## Task 4：渲染层

1. `src/tui/renderer.ts`：`TranscriptRenderer` 接口（design §3）。
2. `PlainRenderer`：进度→`stderr`（可 `--quiet` 静音），`showFinal`→`stdout`；无 raw-mode。作为可断言主体与非 TTY/`--print` 兜底。
3. `PiTuiRenderer`：`TUI`+`ProcessTerminal`，根 `Container` = 滚动 transcript + `StatusLine` + `Editor`；`Markdown` 渲染最终答复，`Loader` 做 working spinner；resize/raw-mode 交给 pi-tui `Terminal`。
4. 选择器：TTY 且非 `--print` → `PiTuiRenderer`，否则 `PlainRenderer`。

**验收**：`PlainRenderer` 输出快照可断言；`PiTuiRenderer` 冒烟（挂载/卸载不抛，退出后终端状态还原）。

## Task 5：TUI 运行时 init + 回合循环

1. `src/tui/app.ts` init（design §6）：`bootstrapAppHome`（忽略 `channelTemplateCreated`）→ `printBootstrapSummary` → `prepareAppServices(sandbox)`（Task 2b，共享）→ `configureLogging(settingsManager.getLoggingSettings())` → `logStartup`。**不调 `loadConfig`**。
2. channel 解析：默认 `tui_local`；`--channel` 校验 slug；`ensureChannelDir`+`ensureChannelMemoryFilesSync`；`getOrCreateRunner`。
3. 回合循环：读输入 → `commands.dispatch`（Task 6）→ 普通消息走 `archive → createTerminalContext → runner.run(ctx, store) → ctx.close`。
4. `--channel` 指向已存在目录且检测到 daemon 近期写入 → 醒目告警（design §10），不强阻。

**验收**：`PlainRenderer` 一次性模式端到端跑通一个最小回合（可在 `test:e2e`）；`tui_local` 默认生效。

## Task 6：命令派发

1. `src/tui/commands.ts`：`dispatch(text, deps)`——`parseBuiltInCommand` 命中传输层命令走本地（`/help`→`renderBuiltInHelp`；`/stop`→`abort`；`/steer`→`queueSteer`；`/followup`→本地队列；`/status`→`renderStatus`+`getStatusSnapshot`；`/usage`→`renderUsageReport`；`/events`→`runEventsCommand`）。
2. 未命中（含 `/model` `/new` `/compact` `/session` 与普通消息）→ 返回"走 runner"信号，由 app 起标准回合（会话命令 SDK 自理，事实 5）。
3. 补全候选表＝传输层 ∪ 会话层命令，供 `PiTuiRenderer` 的 `Editor` autocomplete。

**验收**：`test/tui-commands.test.ts` 表驱动——每个命令路由到正确处理器/信号；空 `/steer` 提示；`/usage 7d` 解析正确。

## Task 7：steer / stop / followup / 信号

1. 运行态机：`running` 标志 + 当前回合 Promise；空闲输入起新回合，运行中按命令语义。
2. Ctrl-C 两段式（design §8）：运行中一次＝`abort`；空闲或 500ms 内二次＝退出。`Ctrl-D`/空 EOF＝退出。状态行提示当前含义。
3. `/followup` 队列在回合结束后弹出为下一输入。

**验收**：单测状态机（fake clock）——运行中 Ctrl-C 触发 `abort` 不退出；二次触发退出；followup 顺序正确。

## Task 8：关停与记忆落盘

1. 退出流程：有回合在跑→`abort` 并等 settle（超时参照 `SHUTDOWN_*` 量级）；空闲后 `runner.flushMemoryForShutdown()`；`resetRunner(channelId)`；`PiTuiRenderer` 复原终端。
2. 与 `PlainRenderer` 一次性模式共用关停路径。

**验收**：一次性 e2e 跑完后 `SESSION.md`/记忆有更新落盘；二次进入同 `--channel` 能读到上次上下文。

## Task 9：入口、参数、依赖

1. `src/main.ts`：`argv[2] === "tui"` → `import("./tui/cli.js").runTui(argv)`；否则 `bootstrap(argv)`（原样）。保持 `main.ts` 轻薄。
2. `src/tui/cli.ts`：解析 `--channel <id>` / `--sandbox <spec>`（复用 `parseSandboxArg`）/ `--print` / `--quiet` / `--help` / `--version`；非 TTY 或 `--print` 选 `PlainRenderer`。
3. `package.json`：加 `@earendil-works/pi-tui` 到 `dependencies`；bin 保持单入口 `pipiclaw`（子命令分发），不新增 bin。
4. `settings.ts`：`Settings` 加可选 `tui` 块 + `getTuiSettings()`（缺省返回默认）。

**验收**：`pipiclaw tui --help` 正常；无 `tui` 参数时钉钉启动路径不变；`test/tui-cli.test.ts` 覆盖参数与 renderer 选择。

## Task 10：文档与总闸

1. `docs/configuration.md`：新增 "Terminal TUI" 段——`pipiclaw tui [--channel <id>]` 用法、`tui` settings、`--channel` 复用钉钉记忆与**跨进程竞争约束**（不要与 daemon 同时服务同一 channel）。
2. 若有 `README`/`AGENTS.md` 命令清单，补一行。
3. `npm run check` + `npm run test:e2e` 全绿。

**验收**：全闸绿；文档可据以启动 TUI 并理解 channel 竞争约束。

---

## 任务依赖与顺序

```
T1(正名) ───▶ T3(交付控制器) ─▶ T4(渲染) ─┐
                                          ▼
T2(status + prepareAppServices) ─────────▶ T5(运行时) ─▶ T7(steer/stop) ─▶ T8(关停)
        └────────────────────▶ T6(命令) ──────┘
                                          T9(入口/参数) ─▶ T10(文档/总闸)
```

T1、T2 可并行先行（纯迁移/抽取，独立可 check，不依赖 TUI 代码）；T2 的 `prepareAppServices` 与 status 渲染同时供 T5（运行时 init）与 T6（`/status`）复用。T3–T8 是 TUI 主体；T9 收口入口；T10 收尾。每个任务结束跑 `npm run check`。

# 061 实施计划

设计见 [design.md](./design.md)，决策编号 D1–D31、不变量 INV-1–INV-11、测试决定 T1–T4 都以它为准。本计划只规定实施顺序、每一步改哪些文件、删哪些测试、写哪些测试，以及做到什么程度才算完成。计划与代码事实冲突时，以设计原则为准，就地决定，并写进设计文档的「实施记录」（规则见下文"偏差处理"）。

## 阶段总览

| 阶段 | 步骤 | 交付 | 对应决策 | 风险 |
|---|---|---|---|---|
| A 渠道层重构 | A0 | 基线：用例数、门禁结果 | — | 低 |
| | A1 | 频道 id 新格式；`ChannelEvent` 判别联合；附件工具移到 `channel/` | D8、D10 | 中 |
| | A2 | `Transport` / `Ingress` 契约；`runtime/ingress.ts` 收拢路由与队列；钉钉实现 `Transport`；`handler.ts` 删除；e2e 夹具改为 `RecordingTransport` | D4–D6、D9（部分）、T2–T4 | **高** |
| | A3 | `ChannelContext` 结构化（`emit` / `finish`）；agent 侧改为产生 `TurnEvent`；钉钉投递重写；`muteChannelContext` 删除 | D7、D27 | **高** |
| | A4 | `channel.json` 分段与开关；渠道注册与动态加载；daemon 锁；不可达频道跳过；公开导出调整 | D1、D2、D9、D28、INV-7、INV-8、INV-11 | 中 |
| B Web API | B0 | 核实：官方 SDK 走 unix socket 的方式，以及设计 §17 列出的其余事项 | D25、§17 | 中 |
| | B1 | 依赖、`src/webapi/` 骨架、配置、鉴权与安全钩子、错误格式、key 命令 | D2、D3、D22、D24 | 中 |
| | B2 | Conversations、存储、items 推导、models、归属、重启清理 | D12、D13、D23 | 中 |
| | B3 | HTTP `/v1/responses`：字段策略、输入转换、Response 状态机、SSE、background、续流、取消、webapi 的 `ChannelContext` | D14–D17、D19、D20 | **高** |
| | B4 | WebSocket 模式：通道、`response.create`、`response.steer`、Response 拆分、连接上限 | D18、D19、D22 | **高** |
| | B5 | 合成 Response、`push`、`quiet`、媒体、频道名 | D21、D4 | 中 |
| | B6 | webapi deterministic e2e（官方 SDK 当客户端） | INV-10、T4 | 中 |
| C TUI | C1 | TUI 改为 SDK 客户端 | D25 | 中 |
| | C2 | 没有 daemon 时的内嵌运行时 | D26 | 中 |
| | C3 | 删除旧 TUI 运行时和 `tui` 频道 / 会话种类；收窄架构表 | D10、D25 | 低 |
| R 收尾 | R1 | 文档、playbook、AGENTS.md、CLAUDE.md、changelog | D31 | 低 |
| | R2 | `docs/channel-migration.md` 与副本演练 | D29 | **高**（数据） |
| | R3 | 全量验收清单 | 全部 | — |
| | R4 | 在真实 `~/.pipiclaw` 上迁移并上线 | D29 | **需要用户在场并批准** |

依赖关系：A0 → A1 → A2 → A3 → A4 → B0 → B1 → B2 → B3 → B4 → B5 → B6 → C1 → C2 → C3 → R1 → R2 → R3。R1 的文档可以随各步同步起草，最后统一收尾。**R4 只能在用户明确批准后执行。**

---

## 通用规则（每一步都适用）

**分支**：在 `feat/channel-plane` 上开发（本 spec 就提交在这个分支上），不直接在 master 上提交。分支持续时间较长，每个阶段结束时 rebase 到最新的 master，冲突按本设计解决。

**提交级门禁**：每个提交都必须通过 `npm run lint && npm run typecheck && npm run arch`。

**步骤级门禁**：每一步结束时，以下全部通过：

```bash
npm run check                 # lint + typecheck + arch + deadcode + test
npm run test:e2e              # 会先 build
npm run eval:typecheck
npm run build && node dist/main.js --version
```

如果某一步确实无法单独让 e2e 通过（例如 A2 和 A3 改的是同一条投递链路），可以把两步合并成一个门禁点，但必须在实施记录里说明原因。**不允许跳过测试、缩小测试发现范围或调大超时来通过门禁。**

**提交纪律**：

- 遵循 conventional commits（`feat:`、`refactor:`、`test:`、`docs:`、`chore:`）。
- 每个提交只做一件能说清楚的事。纯移动、改名的提交与逻辑提交分开（移动文件优先用 `scripts/move-modules.mjs`，它会自动改写 import）。
- 遵守 CLAUDE.md：**不加 `Co-Authored-By` 之类的署名尾注**。

**测试纪律**：遵守 AGENTS.md 的 Unit-test admission and size control、e2e 硬规则，以及设计 D30（T1–T4）：

- 受本次改造影响大的测试**直接删除，按新代码重新设计**。不在旧测试上一点点改。每一步的删除清单写在下文。
- 与渠道层无关的测试原样保留（T1），只做频道 id 等机械替换。
- 已有功能的用例总数默认不增加；新增用例只用于 webapi 和 TUI 客户端。每个新增用例都要写清楚它防的是哪种故障。
- 新增的 deterministic e2e 用例必须做 mutation check：故意改坏它保护的代码，确认用例变红，并写进用例注释。
- 每一步结束时，在设计文档「实施记录」里写下单测和 e2e 各自的用例数 before → after，以及原因。

**代码约束**（AGENTS.md，本次特别容易违反的几条）：

- 不写兼容别名、re-export 垫片或迁移代码。唯一例外是 `src/index.ts` 中 D28 规定的两个类型别名。
- 不读取旧格式的 `channel.json` 或旧格式的频道 id。数据转换只写在 `docs/channel-migration.md`，由 agent 离线执行。
- 文件不超过 800 行；`scripts/architecture-baseline.json` 只能缩小。
- 新顶层目录 `src/webapi/` 必须同时登记在 `scripts/check-architecture.mjs` 和 AGENTS.md 的模块表里。
- 日志用 `log.logWarn(event, message, { channelId, reason, fields })`，事件名形如 `<domain>.<object>.<verb>`；webapi 的日志以 `webapi.` 开头。
- 用户文案（命令回复、推送、TUI 显示）用中文并遵守 spec 053 的规则；HTTP 错误的 `message`、CLI 输出、日志用英文。

**偏差处理**：

- 计划与代码事实不符时，按设计原则就地决定，写进「实施记录」：步骤、偏差、理由。
- 不为了照搬计划而新增反向依赖、兼容别名或转手文件。
- **遇到会改变用户可见行为、某个不变量或协议映射的决定，停下来问用户，不要自行拍板。** 例如：钉钉的任何可见行为变化；对 Responses 规范的任何偏离（新增字段、事件或 item 类型，接受原本应拒绝的参数）；放宽某项安全默认值。

---

## 阶段 A：渠道层重构（钉钉行为保持不变）

### A0 基线

- 运行步骤级门禁，确认 master 当前是绿的。
- 记录单测和 e2e 的用例数（`npx vitest list` 计数，或运行结果里的统计），写进「实施记录」。
- 记录这几个命令的现有输出，作为 A 阶段钉钉行为不变的对照：`pipiclaw --help`、`pipiclaw tui --help`。

### A1 频道 id 与 `ChannelEvent`

**目标**：数据层面换成新格式；渠道接口暂时不动。

改动：

1. `src/channel/channel-id.ts` 重写：
   - `parseChannelId(id)`、`transportOf(id)`、`TransportName`，只切第一个冒号；
   - 删除 `channelKind`、`conversationTypeOf`、`formatChannelLabel`、`ChannelKind`、`TUI_CHANNEL_ID`。
2. 钉钉专用的 id 工具放在 `src/dingtalk/channel-ids.ts`：`dingtalkDmChannelId(staffId)`、`dingtalkGroupChannelId(cid)`、`parseDingTalkChannelId(id) → { kind: "dm" | "group"; native }`、`conversationTypeFor(id)`，以及原 `formatChannelLabel` 里钉钉部分的标签渲染（A2 中挪进 `Transport.describe`）。
3. 钉钉入站（`dingtalk/inbound.ts` / `bot.ts`）产生新格式 id；`state/dingtalk/conversations.json` 用新格式的键（`conversation-meta.ts`）。
4. TUI 在 A 阶段继续走老路：频道 id `tui` 和会话种类 `tui` 变成 `src/tui/` 内部的常量（C3 删除）。`ConversationKind` 暂时保持 `"dm" | "group" | "tui"`。
5. `DeskRuntime`（`runtime/desk-runtime.ts`）不再调用 `channelKind`，改为在构造参数里接收 `conversationKindOf(channelId): ConversationKind | undefined`。bootstrap 注入"钉钉 id → `dm` / `group`，其他 → `undefined`"的实现（A2 中改为由渠道注册表提供）。
6. `src/channel/channel-event.ts` 改为 D8 的判别联合（`HumanEvent | WakeEvent`）：
   - 所有合成事件的生产方改为 `source: "wake"`，`producer` 取原来的 `user` 标签：`jobs/completion-wake.ts`、`subagents/completion-wake.ts`、`runtime/task-driver.ts`、`events/watcher.ts`；
   - 钉钉入站改为 `source: "human"`；
   - 删除 `type`、`conversationType`、`conversationId`。钉钉发送时需要的会话 id 和类型从 `conversation-meta` 和 `parseDingTalkChannelId` 获取。
7. `runtime/turn-run.ts` 的 `isSyntheticEvent` 改为 `event.source === "wake"`，删除 `isEvent` 参数及其所有传递。`runtime/durable-dispatch.ts`：生产方 switch 改按 `producer`，哈希输入去掉 `conversationId`，记录校验改为新形状。
8. `sniffImageMimeType`、`extensionForMimeType`、`MAX_INBOUND_IMAGE_BYTES` 移到 `src/channel/attachments.ts`。`runtime/inbound-images.ts` 改为从这里 import，去掉对 `dingtalk/` 的依赖。
9. `channel/channel-index.ts` 和 `desk/commands.ts` 里频道名的渲染改为调用注入的 `describeChannel`（A2 中由注册表提供）。

测试：

- 删除旧 channel-id helper 的测试用例（找 `channelKind`、`formatChannelLabel`、`conversationTypeOf` 的调用方）。
- 新增 `test/channel-id.test.ts`，只测解析边界：
  - 钉钉 cid 含 `:`、`/`、`+`、`=`；
  - 空 native；
  - 未知 transport；
  - 没有冒号。
- 所有 fixture 里的 `dm_…`、`group_…` 机械替换为新格式（T1）。
- durable dispatch 的测试改为新事件形状（同一批用例，不新增）。

完成标准：步骤级门禁通过；`rg -n "dm_|group_" src` 只在注释、文档字符串和迁移说明里出现；`rg -n "conversationType" src` 只在 `src/dingtalk/` 里出现。

### A2 `Transport` / `Ingress` 与入站流水线

**目标**：INV-1、INV-2 成立；钉钉通过 `Transport` 接入；回合输出口暂时还是旧形状。

改动：

1. 新建 `src/channel/transport.ts`、`src/channel/ingress.ts`，按 D4、D5 定义。`Transport.openTurn` 暂时返回旧形状的 `ChannelContext`，A3 再换。
   - `OutboundMedia`、`MediaSendResult` 移到 `transport.ts`；`StopOutcome` 移到 `ingress.ts`；`ChannelEventSink` 留在 `channel-event.ts`。
   - 删除 `MediaSender` 接口：`session-host.ts`、`tools/send-media.ts`、`tools/registry.ts` 改为接收一个 `sendMedia(channelId, media)` 函数（或 `Pick<Transport, "sendMedia">`），由 runner 工厂按频道从注册表取。
2. `src/runtime/channel-queue.ts`：从 `src/dingtalk/channel-queue.ts` 移过来（用 `scripts/move-modules.mjs`）。
3. `src/runtime/ingress.ts`：由 `runtime/turn-handler.ts` 改写，实现 `Ingress` 和 `ChannelEventSink`：
   - 把 `dingtalk/bot.ts` 的 `routeInboundEvent`、`enqueueStreamMessage`、`enqueueEvent`、`clearPendingMessages`、`resetChannelQueue`、`allChannelQueuesIdle` 的逻辑，以及 `turn-handler.ts` 的 `handleEvent`、`handleStop`、`handleNewSession`、`handleBusyMessage`、`runRuntimeCommand`、`prepareChannel`、`noteChannelActivity`、`reserveEvent`、`persistInboundImage`，全部收进这一个文件，按 D6 的顺序处理；
   - 文件超过 800 行时按职责拆分：`ingress.ts`（入口与顺序）、`ingress-busy.ts`（忙碌分支）、`ingress-commands.ts`（命令回复）。不要拆成"utils"之类的文件；
   - `policy.whenBusy === "queue"` 的分支和 `MAX_QUEUED_TURNS_PER_CHANNEL` 在这一步就实现（钉钉用不到，但它属于 Ingress 的路由矩阵，矩阵测试要覆盖）；
   - `textControlCommands === false` 的拒绝分支也在这一步实现；
   - 附件落盘移到 Ingress（D5）：绑定之后调用 `runtime/inbound-images.ts` 处理 `attachments`，并新增 `persistInboundFile`；落盘失败时用 `push` 发出"保存失败"提示（钉钉现有的文案原样移到 `runtime/inbound-images.ts`）；
   - `DeskRuntime.ensureDefaultBinding(channelId, desk)` 增加工位参数（D6 第 2 步），钉钉传 `default`。
4. `src/runtime/transports.ts`：渠道注册表，提供 `forChannel`、`isReachable`、`all`、`conversationKindOf`、`describeChannel`。A2 中只注册钉钉，并且仍然直接构造；动态加载和开关在 A4 做。
5. `src/dingtalk/transport.ts`：实现 `Transport`，组合 `bot.ts`（连接、入站）、`delivery.ts`（回合输出口）、`media.ts`、`cards.ts`。
   - `bot.ts` 删掉路由和队列，只做"收到消息 → 授权（`allowFrom`）→ 下载图片字节 → 组装 `InboundMessage` → `ingress.receive`"。
   - `policy` 来自 `busyMessageDefault`，`textControlCommands = true`。
   - `push` 等于原来的 `sendPlain`；`describe` 用 A1 中的钉钉标签渲染。
6. 删除 `src/dingtalk/handler.ts`。`DingTalkBotPort` 中卡片 generation 的部分变成 `delivery.ts` / `cards.ts` 的内部细节。`/stop` 时丢弃卡片不在 `Transport` 上开新方法：`Ingress.cancel` 只停止回合，卡片由钉钉自己的回合输出口在回合以中止结束时清理。旧形状的 `ChannelContext` 表达不了"以中止结束"的话，A2 和 A3 合并成一个门禁点，并在实施记录里写明。
7. `runtime/turn-run.ts`：用 `transports.forChannel(id).openTurn(...)` 取代 `createDingTalkContext`，用 `push` 取代 `bot.sendPlain`。`finishTaskStep`、`replyWithoutDesk`、`runDeskCommand` 改为接收 `Transport` 而不是 `DingTalkBotPort`。
8. `runtime/bootstrap.ts`：构造 `Ingress` 和注册表；durable dispatch、事件 watcher 的 sink 改为 Ingress；准入点改为启动注册表里的渠道。`shutdown.ts` 改为先停所有渠道。
9. `BootstrapOptions` 增加 `transports?: Transport[]`（测试和嵌入方覆盖渠道，D28），去掉 `createBot`。

测试（T2、T3、T4）：

- 直接删除：
  - `test/dingtalk.test.ts` 中测试路由、队列、忙碌的用例（它不测这些的部分保留并改为新接口）；
  - `test/runtime-stop.test.ts`、`test/runtime-context.test.ts`、`test/bootstrap.test.ts`、`test/bootstrap-structured-wake.test.ts` 中依赖 `DingTalkBot` / `DingTalkHandler` 结构的用例；
  - `test/helpers/fake-bot.ts`、`test/support/fake-bot.ts`、`test/support/harness-bot.ts`。
- 新建 `test/ingress.test.ts`，路由矩阵只放在这一个文件里：
  - 维度：空闲 / 忙碌 × 普通消息、`/new`、`/stop`、`/steer`、`/followup`、`/help`、报告命令、会话命令、未知命令 × `whenBusy`（steer / followUp / queue）× `textControlCommands`；
  - 外加：没有绑定时建立绑定（`allowedDesks` 首项和默认 `default`）、`desk_not_allowed`、`queue_full`、`shutting_down`、附件落盘失败的提示、合成事件的准入（沿用现有的 `admitsSyntheticEvent` 规则）；
  - 用一个记录调用的测试 `Transport` 和真实的 `ChannelQueue`。
  - 这张矩阵取代被删掉的钉钉路由用例，以及 C 阶段要删掉的 TUI controller 用例。在实施记录里写清用例数的变化。
- 新建 `test/support/recording-transport.ts`：真实实现 `Transport`，记录 `openTurn` / `push` / `sendMedia`。改写 `test/support/runtime-harness.ts`：通过 `BootstrapOptions.transports` 注册它，`sendUserMessage` 改为调用 Ingress（经 RecordingTransport 的 `receive` 入口）。`test/support/daemon-worker.mjs` 同样改用它。
- 钉钉专属的 deterministic e2e（`stop.test.ts`、`progress.test.ts`、`inbound-media.test.ts`，以及 `commands.test.ts` 里的忙碌部分）：如果它们断言的是卡片和普通消息的投递，就在 `dingtalk-stream` 的 `DWClient` 和钉钉 HTTP API 边界上替换（新建 `test/support/fake-dingtalk-stream.ts`），驱动真实的 `DingTalkTransport`。只是借钉钉驱动运行时的用例，改为通过 RecordingTransport 驱动。
- 其他 deterministic e2e 机械地改为新 harness，断言不变。

完成标准：
- 步骤级门禁通过；
- `rg -n "routeInboundEvent|DingTalkHandler|DingTalkBotPort|createDingTalkContext" src` 没有结果；
- `rg -n "from \"../dingtalk/" src/runtime` 只剩 `transports.ts`（构造钉钉渠道）和 `bootstrap.ts`（读取钉钉配置，A4 中移除）；
- 钉钉的 deterministic e2e 全部通过。

### A3 结构化的回合输出口

**目标**：D7 成立；钉钉投递在新接口上保持行为不变。

改动：

1. `src/channel/channel-context.ts` 改写为 D7 的 `ChannelContext`、`TurnEvent`、`TurnOutcome`。`ProgressStyle`、`FinalDelivery`、`ResponseMode` 及其函数移到 `src/dingtalk/response-mode.ts`。`muteChannelContext` 删除。`Transport.openTurn` 改为返回新形状。
2. agent 侧：
   - `agent/channel-runner.ts`：`run(turn: TurnInfo, ctx: ChannelContext, …)`，原来读 `ctx.message` 的地方改读 `turn`。`AgentRunner` 接口（`agent/types.ts`）同步修改。
   - `agent/session/session-events.ts`：
     - 工具开始和结束 → `tool.start` / `tool.end`（带 `callId`、`tool`、原始 `args`、`ok`、截断后的 `output`）；
     - 委派进度 → `tool.update`；
     - 思考 → `reasoning`；
     - 带工具调用的 assistant 文本 → `commentary`；
     - turn_end 的最终回答 → `answer`（`[SILENT]` 和空回答不发 `answer`，与现有判断一致）；
     - 自动压缩 → `compaction`；
     - 本回合首条 prompt 之后，再出现 role 为 user 的 `message_start` → `steer.applied`（D7，按设计 §17 第 4 条先核实）。
     - **删除 `formatProgressEntry` 的所有调用**，原有的"投递失败再改投"逻辑删除。
   - `agent/turn/turn-pipeline.ts`：备用模型切换和其他 `respondInThread` 提示 → `commentary`；`respond(formatProgressEntry("error", …))` → `commentary` 加 `level: "error"`（D7；钉钉渲染成 `✕` 行，webapi 不区分）。
   - `agent/turn/turn-finish.ts`：回合结束统一调用 `ctx.finish({ kind, message, usage })`。原来的 `deleteMessage` / `replaceMessage` 分支映射为 `silent` / `failed` / `cancelled`，失败文案作为 `message` 传入。`usage` 取 `runState.totalUsage`。
   - `agent/builtin-commands.ts`：命令输出 → `answer`。
   - `agent/session/compaction.ts`：两条提示 → `commentary`。
   - `agent/turn/progress-formatter.ts`：`formatProgressEntry` 移到 `src/dingtalk/progress.ts`（TUI 在 A 阶段临时复制一份自己的渲染，C1 删除）；`clipUserInput`、`extractToolResultText` 留在 agent。
3. 钉钉：`src/dingtalk/delivery.ts` 改写成消费 `TurnEvent` 的 `ChannelContext` 实现：
   - 进度渲染、滚动窗口、按 `tool.start` 计数；
   - 卡片预热：`openTurn` 时按原来 `primeCard` 的延迟启动；
   - `answer` 的投递，以及失败后改投普通消息；
   - `finish` 的四种结局；
   - `quiet` 时不建卡片，只投递 `answer`。
   
   文件超过 800 行时拆为 `delivery.ts`（状态机）和 `progress.ts`（渲染）。
4. 任务步骤（`runtime/turn-run.ts`、`runtime/task-*.ts`）：原来用 `muteChannelContext` 的地方改为 `openTurn(turn, { quiet: true })`，再加一个不投递 `answer` 的包装。按 D7，静默步骤只通过 `task_step_end` 的汇报 `push`，所以任务步骤的 `answer` 不投递。这个包装放在 `runtime/turn-run.ts` 内，不进 `channel/`。
5. TUI 的 `terminal-context.ts`：临时改为消费 `TurnEvent` 并渲染到终端，C1 中删除。

测试：

- 直接删除：`test/session-events.test.ts`、`test/delivery.test.ts`、`test/card-delivery.test.ts`。
- 新建：
  - `test/session-events.test.ts`：给定 SDK 事件序列，断言产生的 `TurnEvent` 序列，覆盖工具成功和失败、思考、中间文本、`[SILENT]`、空回答、错误中止、steering 注入后的第二次 `answer`；
  - `test/dingtalk-delivery.test.ts`：给定 `TurnEvent` 序列，断言卡片和普通消息的调用序列，覆盖三种 `responseMode`、卡片失败改投、`quiet`、`cancelled` 丢弃卡片、工具计数。
  
  这两个文件取代被删的三个文件。用例数写进实施记录。
- `test/user-copy-shape.test.ts` 继续通过：钉钉渲染出的进度和回执仍然是用户文案。
- 钉钉 deterministic e2e（`progress.test.ts`、`stop.test.ts`）断言卡片的投递序列，不断言文案。

完成标准：
- 步骤级门禁通过；
- `rg -n "respondPlain|replaceMessage|respondInThread|primeCard|muteChannelContext" src` 没有结果；
- 钉钉的进度、最终回答和 `/stop` 回执与 A0 时一致：e2e 断言投递序列；手动对比一次 `full_progress_then_plain_final` 的卡片文本，写进实施记录。

### A4 配置分段、动态加载、daemon 锁、不可达频道

改动：

1. `src/channel/config.ts`：读取 `channel.json`，校验顶层只有 `dingtalk` / `webapi`，校验 `enabled` 是布尔值，返回开启的段原文。它不校验各段的内部字段。
2. `src/dingtalk/config.ts`：`loadConfig` 改为校验并规范化 `dingtalk` 段（现有字段规则不变）。
3. `src/app/home.ts`：`CHANNEL_CONFIG_TEMPLATE` 改为 D2 的两段模板；首次初始化提示改为"编辑 `channel.json` 的 `dingtalk` 段，或开启 `webapi`"；`formatCliCommandsHelp` 中 daemon 的描述去掉 "DingTalk"。
4. `src/runtime/transports.ts`：
   - 按开关**动态 import** `dingtalk/transport.ts`（B1 之后还有 `webapi/transport.ts`）；
   - 没有任何开启的渠道就抛出 `StartupRefusal`，消息说明要在 `channel.json` 打开哪个段；
   - `BootstrapOptions.transports` 存在时，用它取代配置。
5. `runtime/bootstrap.ts`：
   - 删除对 `dingtalk/config.ts` 的静态 import；
   - 获取 `state/daemon.lock`（`shared/file-lock.ts`），拿不到就 `StartupRefusal`，说明持有者的 pid；
   - 关机时释放锁。
6. INV-8：
   - `runtime/task-driver.ts`：跳过条件加上 `!transports.isReachable(channel)`；
   - `events/watcher.ts`：用注入的 `isReachable`，不可达时写回执 `channel_unavailable`；
   - `runtime/durable-dispatch.ts`：目标渠道没有开启时按背压处理，记录保留为 pending，不计入投递次数。
7. `src/index.ts`：按 D28 调整。`DingTalkEvent = ChannelEvent`；`DingTalkHandler` 是 `Ingress` 的类型别名，只在 `index.ts` 中声明；`ResponseMode` 等改为从 `dingtalk/response-mode.ts` 导出；`BootstrapOptions` 去掉 `dingtalkConfig`。
8. AGENTS.md 模块表、`scripts/check-architecture.mjs`：`channel` 可以 import `usage`（`TurnOutcome.usage` 的类型）；`runtime` 对 `dingtalk/` 只剩注册表这一处依赖。

测试：

- 直接删除 `test/config-loader.test.ts` 中关于 `channel.json` 的用例。
- 新建 `test/channel-config.test.ts`：
  - 未知顶层键；
  - `enabled` 不是布尔值；
  - 关闭的段不校验内部字段；
  - 没有开启任何渠道；
  - 钉钉段的字段错误（只保留真正有分支的规则，不对每条错误文案逐一断言）。
- 新建或扩展 bootstrap 层的单测：daemon 锁冲突时拒绝启动；`transports` 覆盖生效。
- 事件 watcher 和任务驱动的现有测试各加一个"渠道不可达时跳过"的用例（属于新的故障模式，要说明理由）。

完成标准：
- 步骤级门禁通过；
- 用只开钉钉的配置启动 `node dist/main.js`（不连真实钉钉时可用假凭据，观察到加载和校验通过）；
- `channel.json` 两段都关闭时拒绝启动，错误信息可以照做；
- 用 `node --cpu-prof` 或日志确认，关闭钉钉时 `dingtalk-stream` 没有被加载（在实施记录中写明验证方法）。

**阶段 A 结束**：rebase 到 master，跑完整门禁；在实施记录里写下阶段 A 的用例数变化。

---

## 阶段 B：Web API

### B0 核实（不提交产品代码）

在 scratchpad 里写临时脚本，逐条核实设计 §17 的事项。结果和由此做出的选择写进实施记录：

1. 官方 `openai` SDK（选一个发布满两周的确切版本，≥ 7.10）：
   - HTTP 能否通过 `fetchOptions: { dispatcher: new undici.Agent({ connect: { socketPath } }) }` 走 unix socket；
   - `ResponsesWS`（`openai/resources/responses/ws`）能否走 unix socket（自定义 URL 如 `ws+unix://`，或注入 WebSocket 实现）；
   - 如果不能，按 D25 的退路执行。
2. SDK 在 background+stream 的流没有终态事件就结束时，迭代是正常结束还是抛错（D20）。
3. `UsageTotals.input` 是否包含缓存 token（读 pi-ai 的 usage 计算，D16）。
4. pi-agent-core 中 steering / follow-up 消息注入时，`message_start` 与 `turn_end` 的先后顺序（读 `agent-loop.js`，再用 mock provider 跑一次验证）。
5. Fastify 5 同时监听 unix socket 和 TCP 的方式：一个实例调用两次 `listen`，还是两个实例共用路由注册函数（D24 的 Host 检查只对 TCP 生效，必须能区分请求来自哪个监听）。

### B1 依赖与骨架

改动：

1. `package.json`：`dependencies` 增加 `fastify`、`@fastify/websocket`、`@fastify/rate-limit`、`openai`，都固定为发布满两周的确切版本（不用 `^`）；`npm install` 后检查 lockfile，并运行 `npm audit --omit=dev`，结果写进实施记录。
2. 新目录 `src/webapi/`，登记到 AGENTS.md 模块表（第 11 层，可以 import 第 0–10 层，与 `dingtalk` 同层、互不 import）和 `scripts/check-architecture.mjs`。文件：

| 文件 | 职责 |
|---|---|
| `config.ts` | 校验 `webapi` 段（D1、D2），包括 loopback 判断和 TLS 要求 |
| `limits.ts` | 所有数值常量：请求体上限、超时、连接数、通道数、队列、续流保留期、工具输出截断、限流 |
| `ids.ts` | `resp_`、`conv_`、`msg_`、`mcp_`、`rs_`、`steer_` 的生成（`crypto.randomBytes(16)` 转十六进制）与格式校验 |
| `errors.ts` | `WebApiError`（status、type、code、param、message）；HTTP 错误体与 WebSocket 错误包络的渲染（D22） |
| `auth.ts` | 主体（`{ name: string; desks?: string[]; local: boolean }`）；key 的 sha256 与 `timingSafeEqual` 比较（每个存储值都比完） |
| `server.ts` | 创建 Fastify 实例：`bodyLimit`、超时、`onProtoPoisoning: "error"`、`onConstructorPoisoning: "error"`；`onRequest` 钩子设置 CORS 头，检查 Host（只对 loopback TCP），允许无 key 的 `OPTIONS` 预检，并对实际请求鉴权；对 TCP 注册 `@fastify/rate-limit`；`setErrorHandler` 把 Ajv 错误和其他错误统一转成 D22 的格式；`setNotFoundHandler` 返回 404 错误体；监听 socket（先建 0700 目录，删除残留文件，listen 后 chmod 0600）和可选的 TCP/TLS |
| `transport.ts` | 实现 `Transport`；B1 中只有 `start` / `stop` / `describe` 和 `policy`（`whenBusy: "queue"`、`textControlCommands: false`） |

3. `runtime/transports.ts` 注册 webapi（动态 import）。
4. 审计：`security/logger.ts` 增加 webapi 的请求和鉴权失败记录（不写 key、请求体或输出）。
5. key 命令：新建 `src/app/webapi-key-command.ts`（`add` / `list` / `remove`，D3），在 `src/main.ts` 增加 `webapi` 子命令分支（保持 main.ts 很薄），并更新 `formatCliCommandsHelp`。写 `channel.json` 用 `shared/atomic-file.ts`，保持文件权限 0600。

测试：

- `test/webapi-config.test.ts`：
  - loopback 判断（`127.x`、`::1`、`localhost`、`0.0.0.0`、公网地址、IPv6 方括号）；
  - 非 loopback 必须有 TLS；
  - socket 和 tcp 都没开；
  - key 名、哈希、`desks` 的校验。
- `test/webapi-security.test.ts`：用 Fastify 的 `inject` 测：
  - 无 key、错误 key 返回 401，**并断言请求体解析器从未被调用**（INV-6）；
  - 带 Origin 的请求可用，CORS 预检无需 key，实际请求仍鉴权；
  - loopback TCP 上错误的 Host 返回 403，socket 上不检查；
  - 原型污染的 JSON 被拒绝；
  - 超过请求体上限返回 413；
  - 错误体格式（status、type、code、param）。
- key 命令：生成的 key 能通过 `auth.ts` 校验；写入后文件权限为 0600。

完成标准：步骤级门禁通过；`webapi.enabled: true` 时 daemon 能启动并监听 socket；`curl --unix-socket … /v1/models` 返回 401（还没有 key 校验之外的路由也没关系）。

### B2 Conversations、存储与 models

改动：

1. `src/webapi/store.ts`：按 D23 的布局读写 `conversation.json`（atomic write）、两个 `responses.jsonl`（追加写，用 `shared/` 里现有的 jsonl 追加工具）；启动时加载索引，并对所有未到终态的 Response 追加 `failed` 快照（D23）；接口按"会话 → 有序的 Response 快照"组织。
2. `src/webapi/items.ts`：由 Response 推导 conversation items 和 input items，处理分页（`after`、`limit`、`order`，返回 `{ object: "list", data, first_id, last_id, has_more }`）。
3. `src/webapi/routes/conversations.ts`：create（只接受 `metadata`；`items` 非空返回 400）、retrieve、update metadata、items list；归属检查（D12）。
4. `src/webapi/routes/models.ts`：`GET /v1/models`、`GET /v1/models/{id}`。
5. 所有路由都声明 JSON schema（body、querystring、params），设 `additionalProperties: false`。字段名和取值以 SDK 类型为准。

测试：

- `test/webapi-store.test.ts`：
  - 同一个 id 以最后一个快照为准；
  - 重启时未终态的 Response 被标为失败，且只标一次；
  - items 的顺序和分页边界；
  - 损坏的 jsonl 行（当前格式的完整性检查：跳过并告警，不让启动失败——沿用仓库对 jsonl 的现有做法）。
- 路由级的测试与 B3 合并在一张表驱动的 inject 测试里，不为每个端点单独写。

### B3 HTTP `/v1/responses`

改动：

1. `src/webapi/request-policy.ts`：D14 的字段策略写成一张表（字段 → 接受 / 只接受默认值 / 拒绝 / 提示性字段可忽略），校验函数返回第一个违规的 `param`。不在 schema 里散落写规则；schema 只管类型，策略表管语义。
2. `src/webapi/input.ts`：`input` → `InboundMessage`（D15）。
   - 文本拼接与 `[图片N]` / `[文件N]` 标记；
   - data URL 解析；
   - base64 按长度估算大小，超限返回 400；
   - 图片张数上限；
   - `user` / `userName` 设为主体名，`allowedDesks` 设为主体的 `desks`。
3. `src/webapi/response-state.ts`：Response 状态机（`queued` → `in_progress` → 终态；`cancelled`；steer 时 `incomplete`），每次状态转换都通过 store 落盘，并通知订阅者（流）。非法转换直接抛错，这属于程序错误。
4. `src/webapi/stream.ts`：
   - SSE 写出：`event:` 行等于 `type`，`data:` 为 JSON，每个流独立的 `sequence_number`，不发 `id:`，不发 `[DONE]`；
   - 背压：`reply.raw.write` 返回 false 时等待 `drain`；
   - background+stream 的事件缓冲与续流（`starting_after`），保留 `STREAM_REPLAY_TTL_MS`。
5. `src/webapi/turn-output.ts`：webapi 的 `ChannelContext`，把 `TurnEvent` 转成 output item 和流式事件（D20 的表格逐行对应）。
   - `quiet` 时只把 `answer` 写成 item；
   - B3 中 HTTP 没有 steer，webapi 也不使用 followUp（`whenBusy: "queue"`），所以 `steer.applied` 不会出现；出现就记一条 `webapi.turn.unexpected_steer` 告警并忽略。拆分在 B4 实现。
6. `src/webapi/routes/responses.ts`：
   - `POST /v1/responses`：
     1. 策略校验；
     2. 解析会话，规则同 D14（`conversation` 与 `previous_response_id` 互斥、只允许指向最新的 Response、隐式建会话）；
     3. 在内存里创建 Response（分配 id 作为 `ref`），此时**不落盘、对外不可见**；它在这期间收到的 `push(ref)` 和回合事件先缓冲；
     4. 调用 `ingress.receive`。`rejected` → 丢弃这个 Response，按 D22 返回错误（`control_command` → 400，`desk_not_allowed` → 403，`queue_full` → 429，`shutting_down` → 503），被拒绝的请求不产生 Response（INV-5）。其他结果 → 写入第一份快照并对外可见：`started` 为 `in_progress`；`queued` 保持 `queued`；`replied` 时内容已由 `push(ref)` 写入，直接 `completed`；
     5. 按 `stream` / `background` 决定立即返回、流式返回，还是等终态后返回。
   - `GET /v1/responses/{id}`：读取；`stream=true` 时续流（只对 background+stream 有效）。
   - `POST /v1/responses/{id}/cancel`：D19。
   - `GET /v1/responses/{id}/input_items`。
   - 断开连接即取消：非 background 的请求监听 `request.raw` 的 `close`。在 Response 到达终态前断开，`queued` 的调用 `ingress.dropQueued`，`in_progress` 的调用 `ingress.cancel`。
7. `transport.ts`：实现 `openTurn`（按 `turn.ref` 找到 Response，绑定 `turn-output`）、`push`（带 `ref` 写进对应的 Response；不带 `ref` 的在 B5 实现）。

测试：

- `test/webapi-request-policy.test.ts`：一张表驱动 D14 的每一行（接受、只接受默认值、拒绝、可忽略），断言 `param`；外加 `conversation` 与 `previous_response_id` 互斥、指向非最新 Response、隐式建会话。
- `test/webapi-input.test.ts`：标记顺序、data URL 格式错误、超限（估算阶段就拒绝，不解码）、张数上限、`file_id` / URL 被拒。
- `test/webapi-responses.test.ts`：用 inject 和一个假的 `Ingress` 测状态机：
  - `started` / `queued` / `replied` / `rejected`；
  - cancel 的幂等，以及非 background 的 Response 不能 cancel；
  - 断开连接时分别对 queued 和 in_progress 的处理；
  - SSE 的 `sequence_number` 单调递增、每个 item 的生命周期事件顺序、续流从 `starting_after` 之后开始、续流保留期过期后返回 400。
- `test/webapi-turn-output.test.ts`：`TurnEvent` 序列转成 output 和事件序列，覆盖 `mcp_call` 成功和失败、输出截断、`reasoning`、`commentary` 与 `final_answer`、`output_text` 的拼接、`usage` 的映射、`quiet`。

### B4 WebSocket 模式与 steering

改动：

1. `src/webapi/routes/websocket.ts`（`@fastify/websocket`，挂在 `GET /v1/responses` 上）：
   - 升级时做与 HTTP 相同的 Origin、Host、鉴权检查；
   - `maxPayload`；
   - 连接满 60 分钟时发 `websocket_connection_limit_reached` 后关闭；
   - 客户端事件只接受 `response.create`（字段同 D14，但 `stream`、`stream_options`、`background` 必须不存在）和 `response.steer`，其他类型返回 `invalid_request_error`。
2. 通道（`stream_id`）：
   - 格式校验，错误码 `invalid_stream_id`；
   - 最多 32 条命名通道（`websocket_stream_limit_reached`）；
   - 同一通道内先进先出、不重叠（用一个 promise 链排队）；
   - 每条连接最多 16 个进行中的 Response，超过的继续排队；
   - 事件都带上 `stream_id`。
3. `response.steer`（D18）：
   - 校验目标是本连接上创建的、正在进行的用户 Response；
   - 校验 `input`（规则同 D15）；
   - 每个 Response 未生效的 steer 不超过 `MAX_PENDING_STEERS`；
   - 调用 `ingress.steer`，回 `response.steer.accepted` 或 `response.steer.failed`（官方错误码）。
4. `turn-output.ts` 实现 `steer.applied` 的拆分：
   - 把当前 Response 中未完成的 item 补发 done 事件；
   - 以 `response.incomplete`（`reason: "steered"`）结束；
   - 创建后续 Response，`previous_response_id` 指向原 Response，`input_items` 为 steer 的输入，占用原来的通道位置；
   - 后续事件归到后续 Response 上；
   - 原 Response 先正常完成时，steer 作为下一个独立回合执行（`Ingress` 已有的"steer 到达时回合已结束 → 重新排队"逻辑），同样以后续 Response 的形式出现在同一条通道上。
5. 连接关闭时，这条连接上的 `queued` Response 丢弃，`in_progress` 的调用 `ingress.cancel`（D19）。

测试：

- `test/webapi-websocket.test.ts`：用真实监听（随机端口）加 `ws` 客户端测：
  - 通道 FIFO 与并行上限；
  - 32 条通道上限；
  - 非法的 `stream_id`；
  - 在 WebSocket 上出现 `background` 时报错；
  - steer 的每个失败码；
  - 连接关闭时取消；
  - 60 分钟上限（用可注入的时钟或常量覆盖来测，不真的等待）。
- 拆分的单测放在 `webapi-turn-output.test.ts` 里（扩展已有场景，不另开文件）。

### B5 合成 Response、`push`、`quiet`、媒体、频道名

改动：

1. `transport.ts`：
   - `openTurn` 遇到没有 `ref` 的回合（合成回合），**延迟到第一次 `answer`** 才创建 Response（`in_progress`），并且没有 input items；
   - 整个回合没有 `answer` 时不创建 Response（D21）；
   - `push` 不带 `ref` 时，创建一个只含一条 `final_answer` 消息的 `completed` Response。
2. `sendMedia` 返回 `{ ok: false, error: "This channel cannot receive attachments. Tell the user the file's path on the server instead." }`（给模型看的英文，带下一步）。
3. `describe`：通过 socket 创建的会话显示为 `终端`，key 创建的显示为 `API「<key 名>」`（用户文案，遵守 spec 053）。
4. `conversationKindOf`：`webapi:` 频道返回 `webapi`。`ConversationKind` 加入 `"webapi"`（`tui` 留到 C3 删除）。

测试：

- 在 `webapi-turn-output.test.ts` 中扩展 quiet 和合成场景：只有 `answer` 时产生 Response、`[SILENT]` 时不产生、`push` 不带 `ref` 时产生一个 completed 的 Response。

### B6 webapi 的 deterministic e2e

改动：

1. `test/support/webapi-harness.ts`：
   - 用测试 home 启动真实运行时，`channel.json` 只开 webapi（loopback TCP 随机端口 + 测试 key + socket），模型使用现有的 mock provider；
   - 提供官方 `openai` SDK 客户端（HTTP 和 `ResponsesWS`）；
   - 断言辅助函数：读 `state/webapi/`、读会话目录、读 provider 收到的请求。
2. 新增 `test/e2e/deterministic/webapi.test.ts`，每个用例注释写明它防的故障，以及 mutation check 的记录：
   1. **流式回合**：SSE 事件的类型与顺序（含一个 `mcp_call` 和一个 `final_answer`）；落盘内容（session 文件、`responses.jsonl` 的终态快照）；provider 恰好收到一次请求。防的是 `TurnEvent` 到事件的映射或终态落盘出错。
   2. **忙碌排队**：同一会话连续两个 background 请求，第二个先是 `queued`，provider 请求按顺序发生、不重叠；两个 Response 各有自己的 `output_text`。防的是 `whenBusy: "queue"` 退化成 followUp 合并。
   3. **WebSocket steer 拆分**：用 mock provider 的 `hold` 让工具调用停住，发 `response.steer`，断言原 Response 以 `incomplete` / `steered` 结束，后续 Response 的 `input_items` 是 steer 的内容，provider 的第二次请求里包含 steer 的文本。防的是拆分时机或归属出错。
   4. **取消**：background 的 Response 在 `hold` 中被 cancel，状态为 `cancelled`，provider 请求被中止；另一个 `queued` 的 Response 被 cancel 后 provider 请求数不增加；任务步骤被 cancel 时任务被暂停（沿用 `/stop` 语义）。防的是 cancel 与 `/stop` 的对应关系出错。
   5. **合成唤醒**：后台 job 完成后，会话 items 中出现一个新的 Response，它的 `input_items` 为空，内容不含给模型看的唤醒文本。防的是 INV-4 和 D21。
   6. **重启**（独立进程，用改写后的 `daemon-worker.mjs`）：in_progress 时 SIGKILL，重新启动后，该 Response 为 `failed`，provider 请求数不增加（没有重跑）。防的是重启后重跑或状态卡住。
3. 用例数写进实施记录（新功能新增 6 个 e2e 用例）。

**阶段 B 结束**：rebase、完整门禁、实施记录。

---

## 阶段 C：TUI

### C1 TUI 改为 SDK 客户端

改动：

1. `src/tui/client.ts`：
   - 按 B0 的结论建立 SDK 客户端（socket）；
   - 读写 `state/tui/conversations.json`（工位名 → conv id，atomic write）；
   - 处理 `--desk` / `--create` / `--new`（D25）：新会话的首条消息先发 `/desk bind` 或 `/desk new` + `/desk bind`，结果按普通回复显示。
2. `src/tui/session.ts`：
   - 一条 WebSocket 连接，用 `response.create` 发消息；
   - 回合进行中，`/steer` 和普通输入（与现在 TUI 的默认行为一致）发 `response.steer`，`/followup` 在客户端排队；
   - Ctrl-C 第一次断开连接（等于取消）并立即重连，第二次退出；
   - 空闲时每 `TUI_POLL_INTERVAL_MS`（代码常量）轮询一次会话 items，显示新增的合成 Response。
3. `src/tui/render.ts`：
   - 把流式事件渲染到现有的 frontend（`pitui-frontend.ts`、`plain-frontend.ts`、`renderer.ts` 保留）；
   - 工具标签用 `tools-contract/presentation.ts` 的 `describeToolCall`；
   - 进度显示多少按 `settings.json` 的 `tui.responseMode`（TUI 自己的 `progressStyleOf` 等函数放在这里，不 import `dingtalk/`）。
4. `src/tui/commands.ts`：只保留 `/exit`、`/quit` 两个本地命令，以及 `/stop`、`/steer`、`/followup` 到客户端动作的映射；其余命令原样发送。
5. `src/tui/cli.ts`：增加 `--new`；`--print` 改为一次同步 HTTP 请求，打印 `output_text`。

### C2 内嵌运行时

改动：

1. `runtime/bootstrap.ts` 新增 `bootstrapEmbedded(paths, io)`：
   - 渠道固定为"只开 webapi socket"，不读 `channel.json` 的开关；
   - 日志只写文件；
   - 返回一个 `stop()`。
2. `src/main.ts`：`tui` 分支改为 `runTui(argv, { startEmbeddedRuntime: bootstrapEmbedded })`。`runTui` 先尝试获取 daemon 锁：
   - 锁被占用 → 连接 socket；连不上时按 D26 报错（daemon 关闭了 webapi 或 socket）；
   - 拿到锁 → 把已经持有的锁句柄交给 `startEmbeddedRuntime(lock)`，内嵌运行时直接使用它，不再自己获取。锁只获取一次，避免"先释放再获取"之间被别的进程抢走。
3. 退出时按 `shutdown.ts` 的顺序关闭内嵌运行时，有最长等待时间（沿用现有的 `STORAGE_FLUSH_TIMEOUT_MS`）。

### C3 删除旧 TUI 与 `tui` 频道

改动：

1. 删除 `src/tui/app.ts` 中的运行时组装（文件如果只剩客户端逻辑就合并进 `client.ts`），以及 `turn-controller.ts`、`terminal-context.ts`、`terminal-media-sender.ts`。删除 A1 中移进 `tui/` 的 `tui` 频道常量和 A3 中临时复制的进度渲染。
2. `ConversationKind` 删除 `"tui"`；`desk/registry.ts` 的会话名解析同步修改。
3. 删除 `src/tools/background-delivery.ts` 及其调用（任务和事件的创建不再拒绝终端）。
4. AGENTS.md 模块表：`tui` 的"May import"收窄为 layers 0–1、`commands`（catalog）、`tools-contract`、`config`（读 `tui.responseMode`）；`scripts/check-architecture.mjs` 同步修改。
5. `rg -n "\"tui\"" src` 只剩 CLI 子命令名和 `state/tui/` 路径。

测试（C1–C3 一起）：

- 直接删除：`test/e2e/deterministic/tui-command.test.ts`、所有测试 `turn-controller` 和 `terminal-context` 的单测、测 `background-delivery` 的用例。
- 新建 `test/tui-session.test.ts`：命令到客户端动作的映射（`/stop` → 断开并重连、`/steer` → `response.steer`、`/followup` → 客户端排队），以及事件到 frontend 调用的渲染。用假的 SDK 连接（只录下调用，渲染断言的是 frontend 调用的结构，不断言文案）。
- 新增 1 个 deterministic e2e：`test/e2e/deterministic/tui-client.test.ts`，通过真实的 TUI 客户端模块（plain frontend）连接 webapi harness 的 socket，完成"一个回合 + 一次 steer + 一次 Ctrl-C 取消"。断言 provider 请求和 `responses.jsonl` 的终态。它防的是 TUI 与 webapi 的对接（路径、鉴权豁免、协议使用）出错。
- 内嵌模式：一个单测，验证 daemon 锁被占用时连接 socket、没有被占用时启动内嵌运行时（注入假的 `startEmbeddedRuntime`）。

**阶段 C 结束**：rebase、完整门禁、实施记录（含旧 TUI 测试删除带来的用例数变化）。

---

## 阶段 R：收尾

### R1 文档

按 D31 更新，逐项打勾：

- [ ] 新增 `docs/webapi.md`：
  - 端点和字段策略表（与 D13、D14 一致）；
  - 与规范的映射（`mcp_call`、`phase`、合成 Response、取消后的流直接结束）；
  - 安全说明（key 的权限等于 shell 权限、TLS、反向代理）；
  - SDK 示例：Python 和 JS，分别演示 HTTP、background + 续流、WebSocket steer，示例都要实际跑过一次；
  - 已知限制（D14 中所有被拒绝的字段，以及原因）。
- [ ] `docs/configuration.md`、`docs/configuration-reference.md`：`channel.json` 两段与开关、key 命令。
- [ ] `docs/deployment-and-operations.md`：只开 webapi 的部署方式、TLS 与反向代理、daemon 锁。
- [ ] `docs/security.md`：新的网络入口、默认值、审计。
- [ ] `docs/interaction-and-commands.md`：TUI 的变化（内嵌运行时、`--new`、steer 和 stop 的行为）；webapi 中控制命令的差异。
- [ ] `docs/architecture.md`、`docs/scaling-and-concurrency.md`、`docs/README.md`、`README.md`（以及英文 README）。
- [ ] `AGENTS.md`：模块表、Runtime Model（`channel.json` 两段、`state/webapi/`、`state/tui/`、`state/daemon.lock`）。
- [ ] `CLAUDE.md`：架构说明中 Transport → agent → delivery 的流程、并发模型（`ChannelQueue` 改归 runtime）、TUI 的描述。
- [ ] `src/playbooks/*.md`：出现频道 id 格式或"终端不能运行后台任务"的地方。
- [ ] `src/commands/catalog.ts`：提到 `channel.json` 字段的用户文案改为 `dingtalk` 段。
- [ ] changelog：一条破坏性变更说明（`channel.json` 结构、频道 id、`src/index.ts` 中类型形状的变化、TUI 行为变化），并链接迁移说明。**版本号由用户决定**，不要自行修改版本号。
- [ ] `docs/specs/README.md`：把 061 的状态更新为"已实施"，并链接验收记录。

### R2 迁移说明与演练

1. 写 `docs/channel-migration.md`，风格与 `docs/desk-migration.md` 一致（给执行 agent 的任务约定、停机与备份、转换表、校验、回退）。转换表以设计 D29 为准。要明确写出：
   - 运行时不读旧格式，旧版本不能读新格式；
   - 先确认安装的版本已实现 061，再转换数据；
   - `tui` 会话的处理（目录改名、生成 conv id、补绑定、写 `state/tui/conversations.json`）；
   - durable dispatch 的两种处理方式（先投递完，或者改写）。
2. 演练：
   - 用 master 的构建在临时 home 中造出一份"现有格式"的数据：dm、group 和 tui 会话，一个任务，一个事件，一个 durable dispatch 记录，一个 job 记录；
   - 按迁移说明转换（用临时命令，不加入仓库）；
   - 用新版本启动内嵌 TUI，验证：`/desk` 显示每个频道；TUI 接着用原来的会话（模型上下文延续，可用 mock provider 检查请求里的历史）；任务和事件能被解析；
   - 把过程和结果写进 `docs/specs/061-channel-plane/acceptance.md`。

### R3 验收清单

写进 `acceptance.md`，每项附证据（命令输出、e2e 用例名或实施记录的位置）：

- [ ] 步骤级门禁全部通过（附各命令的结尾输出）。
- [ ] INV-1：`rg` 证据——渠道代码里没有命令名分支（webapi 的 D17 拒绝也在 Ingress 里）。
- [ ] INV-2、INV-7：`npm run arch` 通过；关闭钉钉时 `dingtalk-stream` 未被加载的验证记录。
- [ ] INV-5、INV-6、INV-9、INV-10：对应的单测和 e2e 用例名。
- [ ] INV-8：任务驱动和事件跳过不可达频道的用例名。
- [ ] INV-11：daemon 锁冲突时拒绝启动的用例名。
- [ ] 钉钉行为不变：A0 与 A3 的对照记录。
- [ ] webapi 使用官方 SDK：`docs/webapi.md` 中的示例实际运行的输出。
- [ ] 安全默认值：只开 socket；TCP 非 loopback 必须有 TLS；Origin 和 Host 检查；鉴权失败不解析请求体；审计日志样例（已脱敏）。
- [ ] 迁移演练结果（R2）。
- [ ] 用例数：单测和 e2e 的 before → after，以及每次增减的理由汇总。

### R4 上线（需要用户在场）

在真实的 `~/.pipiclaw` 上按迁移说明执行：先完整备份，转换，用新版本启动 daemon，在钉钉里冒烟（私聊和群各发一条、`/status`、一次 `/stop`），再用 TUI 连接。**这一步必须由用户明确批准后才能执行，并且由用户在场确认结果。**

# 061 渠道层与 Web API：钉钉和 Responses API 并列为两个渠道

| 字段 | 内容 |
|---|---|
| 状态 | 设计已确认，待实施；实施顺序与验收见[实施计划](./plan.md) |
| 日期 | 2026-10-24 |
| 承接 | [060 Desk](../060-desk/design.md)：工位已与频道解耦；本 spec 进一步把"渠道"从运行时中解耦 |
| 用户决定 | Web API 是第三个渠道，但 TUI 改成它的客户端，所以代码里只剩钉钉和 Web API 两个渠道；协议严格遵循 OpenAI Responses API 官方规范；钉钉与 Web API 配置都放在 `channel.json`，分别在 `dingtalk`、`webapi` 段下，各有开关；Web API 依赖成熟的 HTTP 服务实现，安全优先；受本次改造影响大的测试直接删掉，按新代码重写；P0（渠道契约）、P1（频道 id）、P2（TUI 改为客户端）合并为一次发版、一次离线迁移 |

决策编号 D1–D31、不变量 INV-1–INV-11 供[实施计划](./plan.md)和代码注释引用。

## 1. 问题与结论

060 让同一个工位可以服务多个钉钉对话，但渠道本身仍然嵌在运行时里：

- runtime 和钉钉之间的真实接口是 `dingtalk/handler.ts` 里的 `DingTalkHandler` / `DingTalkBotPort`。`runtime/turn-run.ts` 直接调用 `createDingTalkContext`，`/stop` 直接调用 `bot.discardCard`。
- 命令和忙碌路由（`/new` 绕过队列、忙碌时 `/stop` `/steer` `/followup` 的处理、斜杠命令在回合中的限制）写在 `dingtalk/bot.ts` 的 `routeInboundEvent` 里；`tui/turn-controller.ts` 又实现了一份。按频道串行的 `ChannelQueue` 也放在 `dingtalk/` 下面。
- 回合进度是已经拼好的文本：`session-events.ts` 调用 `ctx.respond(formatProgressEntry("tool", label))`，钉钉侧（`delivery.ts`）靠判断文本是否以 `"➜ "` 开头来数工具调用次数。结构化客户端无法从中拿到工具调用。
- 频道 id 格式写死为 `dm_` / `group_` / `tui`；`ChannelEvent.conversationType`（钉钉的 `"1"`/`"2"`）是必填字段，任务驱动和两个完成唤醒还要从 id 前缀反推它。
- daemon 必须配置钉钉才能启动；TUI 是独立进程，只通过文件锁与 daemon 共用工位，没有 durable wake、事件和任务驱动。

结论：

1. **渠道（transport）只做两件事：把外部消息归一化后交给运行时，把运行时的结构化输出渲染到自己的协议上。** 授权之后的一切（绑定、命令、忙碌、排队、唤醒准入）由 runtime 的 `Ingress` 统一处理。
2. **两个渠道：钉钉，以及遵循 OpenAI Responses API 的 Web API。** TUI 改为 Web API 的客户端，Web 控制台、脚本和其他 agent 也通过同一套接口接入。
3. **Web API 是"有状态的 agent，接口长成 Responses 的样子"**，不是可以直接替换的模型接口。它只接受 pipiclaw 真正能兑现的参数，不支持的一律按规范的错误格式明确拒绝，不默默忽略。
4. **钉钉用户感觉不到变化**；部署者需要做一次停机迁移。

## 2. 目标与非目标

**目标**

- 渠道层只有两个窄接口（`Transport`、`Ingress`），回合输出口 `ChannelContext` 结构化。
- 钉钉、Web API 都可以按部署开关；关闭的渠道不加载代码、不监听、不写状态。
- Web API 覆盖 Responses API 的核心路径：同步、流式、后台、续流、取消、Conversations、WebSocket 模式与 mid-turn steering，官方 SDK 可以直接使用。
- TUI 通过 Web API 拿到 daemon 的全部能力（wake、事件、任务汇报、多端同时连接）。
- 网络入口的默认值安全：只开本机 unix socket；TCP 默认只允许 loopback，非 loopback 必须配 TLS。

**非目标（本 spec 不做）**

- 浏览器客户端、CORS、Web 控制台页面本身。
- Files API、`file_id` 引用、URL 方式的图片或文件输入、通过 Web API 下发附件。
- 客户端工具（`tools` / `function_call_output`）、`instructions`、`store: false`、响应分支、`/responses/compact`。
- webhook 推送（它不属于 Responses API，OpenAI 是在控制台里配置的）。
- 新的 IM 渠道（飞书等），以及跨渠道的通知兜底。
- 审批流程。它将来可以复用规范里的 `mcp_approval_request` / `mcp_approval_response`（见 D20），但不在本次范围内。

## 3. 概念与所有权

| 概念 | 是什么 | 由谁拥有 |
|---|---|---|
| 渠道（transport） | 一种外部协议的接入实现：`dingtalk`、`webapi` | `src/dingtalk/`、`src/webapi/`，各自实现 `Transport` |
| 频道（channel） | 一个具体的回复地址：某个钉钉私聊或群，某个 Web API 会话 | 由频道 id 标识（D10），绑定到一个工位 |
| 会话目录（conversation） | 某个频道在某个工位里的会话区 `conversations/<kind>-<n>/` | `desk/`，不变 |
| 入站流水线（Ingress） | 授权之后的一切路由：绑定、命令、忙碌、排队、取消、steer | `runtime/ingress.ts`，唯一 |
| 回合输出口（`ChannelContext`） | 一个回合向频道输出的结构化事件流 | 契约在 `channel/`，实现在各渠道 |
| Web API 会话（Conversation） | Responses API 的 `conv_…`，对应一个 `webapi:` 频道 | `webapi/` 存储；绑定仍由 `DeskRuntime` 记录 |
| Response | Web API 上一条入站消息对应的结果对象 | `webapi/` 存储 |
| TUI | Web API 的客户端（官方 `openai` SDK） | `src/tui/`，不再拥有运行时 |

## 4. 不变量

- **INV-1** 绑定、命令解析、忙碌判断、排队、取消、steer 只在 `runtime/ingress.ts` 决定。渠道代码不按命令名分支，也不持有频道队列。
- **INV-2** 渠道之间互不 import，也不 import `tui/`；runtime 只通过 `channel/` 里的契约和各渠道的工厂函数使用渠道。
- **INV-3** 频道 id 仍然不能当路径段用（沿用 060）。Web API 自己生成的 `conv_<hex>` 字符集固定，只在 `state/webapi/` 内当目录名用。
- **INV-4** 给模型看的文本不出现在任何用户能看到的输出里：合成回合的 Response 没有 input items；工具调用的用户标签与模型侧文本按同一结构分别渲染。
- **INV-5** Web API 上每条被接受的入站消息恰好产生一个 Response（steer 的后续 Response 是规范规定的例外，见 D18）；返回 4xx/5xx 错误的请求不产生 Response；每个 Response 恰好到达一个终态并落盘。
- **INV-6** 鉴权失败的请求不解析请求体、不进入 `Ingress`。
- **INV-7** 关闭的渠道不 import 代码、不监听端口、不写自己的状态目录。
- **INV-8** 频道所属的渠道没有启用时，这个频道等同于不可达：任务驱动和事件跳过它，它的 durable dispatch 记录保留到渠道重新启用的那次运行。
- **INV-9** 不支持的请求字段或值一律返回 400，只有 D14 列出的提示性字段可以被接受后忽略。
- **INV-10** Web API 支持的每条路径都能用官方 `openai` SDK 跑通；deterministic e2e 用官方 SDK 当客户端。
- **INV-11** 同一个 app home 同时只有一个运行时进程（daemon，或没有 daemon 时 TUI 内嵌的运行时），由 `state/daemon.lock` 保证。

## 5. 配置

### D1. 渠道配置合并在 `channel.json`，按渠道分段

```json
{
  "dingtalk": {
    "enabled": true,
    "clientId": "…",
    "clientSecret": "…",
    "robotCode": "…",
    "cardTemplateId": "…",
    "cardTemplateKey": "content",
    "allowFrom": ["…"],
    "busyMessageDefault": "steer",
    "responseMode": "full_progress_then_plain_final",
    "cardAutoLayout": true
  },
  "webapi": {
    "enabled": true,
    "socket": true,
    "tcp": "127.0.0.1:8787",
    "tls": { "cert": "/abs/cert.pem", "key": "/abs/key.pem" },
    "keys": [
      { "name": "laptop", "sha256": "<hex>", "desks": ["default", "pipiclaw"] }
    ]
  }
}
```

- `dingtalk` 段的字段和语义与现在根级的字段完全相同（`stateDir` 也保留），只是整体挪了一层，再加 `enabled`。
- `webapi` 段：
  - `socket`（布尔，默认 `true`）：在 `state/webapi/api.sock` 开本机 unix socket。
  - `tcp`（可选，`host:port`）：开 TCP 监听。
  - `tls`（可选）：证书与私钥的绝对路径。
  - `keys`（数组，默认空）：TCP 访问用的 key；只存 sha256，`desks` 至少一项（D12）。
- 请求体上限、超时、连接数、队列上限、限流等都是代码常量（`webapi/limits.ts`），符合"配置里只放产品意图"的规则。

### D2. 开关与校验

- 段缺失或 `enabled: false` 表示该渠道关闭。关闭的段只检查 `enabled` 是布尔值，其他字段不校验，凭据可以留在文件里。
- 开启的段按当前格式严格校验；**`channel.json` 顶层只允许 `dingtalk`、`webapi` 两个键**，未知键报错并指向配置文档。不写旧格式读取，也不做旧布局检测（AGENTS.md）。旧格式文件里的 `clientId` 会作为未知顶层键被拒绝，错误信息给出配置文档链接，迁移文档说明怎么改。
- daemon 启动时至少要开一个渠道，否则报错退出，并说明要在 `channel.json` 里开哪一个。
- `webapi.enabled: true` 时，`socket: false` 和未配置 `tcp` 不能同时出现（否则没有任何监听）。
- `tcp` 的 host 不是 loopback（`127.0.0.0/8`、`::1`、`localhost`）时必须配置 `tls`。
- `keys[].name` 唯一，匹配 `^[a-z0-9][a-z0-9-]{0,31}$`；`sha256` 为 64 位小写十六进制；`desks` 每项必须是合法的工位名（工位不存在不在加载时报错，绑定时才拒绝）。
- app home 初始化写出的模板：`dingtalk` 段是现有占位模板加 `"enabled": true`；`webapi` 段是 `{ "enabled": false, "socket": true, "keys": [] }`。

### D3. key 管理命令

`pipiclaw webapi key add <name> --desk <desk> [--desk <desk>…]`

- 生成 `pk_` + base64url(32 字节随机数) 的 key，**只打印一次**，把 sha256 写进 `channel.json` 的 `webapi.keys`。写入使用 atomic write，并保持文件权限 0600。
- `pipiclaw webapi key list` 只列出名字和 desks；`pipiclaw webapi key remove <name>` 删除一项。
- 改了 key 要重启 daemon 才生效，不做热加载。
- 这是部署者使用的命令，输出用英文。

## 6. 渠道层契约

### D4. `Transport`：渠道实现，runtime 调用

`src/channel/transport.ts`：

```ts
export type TransportName = "dingtalk" | "webapi";

export interface TransportPolicy {
  /** 忙碌时普通消息怎么处理。钉钉来自 `busyMessageDefault`；webapi 固定为 "queue"。 */
  whenBusy: "steer" | "followUp" | "queue";
  /** 是否接受文本形式的 `/stop` `/steer` `/followup`。webapi 为 false（D17）。 */
  textControlCommands: boolean;
}

export interface Transport {
  readonly name: TransportName;
  readonly policy: TransportPolicy;
  /** 开始接收消息。`ingress` 是唯一的入站去向。 */
  start(ingress: Ingress): Promise<void>;
  /** 停止接收新消息，把已在投递的发完；之后不再调用 ingress。 */
  stop(): Promise<void>;
  /** 一个回合的输出口。`quiet` 时只投递最终结果（后台唤醒）。 */
  openTurn(turn: TurnInfo, opts: { quiet: boolean }): ChannelContext;
  /** 回合外的推送：命令回复、回执、任务汇报、唤醒失败提示。返回是否送达。 */
  push(channelId: string, message: PushMessage): Promise<boolean>;
  /** `send_media` 工具的出口。 */
  sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult>;
  /** 用户看到的频道名（`/desk`、`/tasks`、`/events`、CHANNELS.md 使用）。 */
  describe(channelId: string, knownName?: string): string;
}

export interface TurnInfo {
  channelId: string;
  user: string;
  userName?: string;
  text: string;
  images?: InboundImage[];
  /** 渠道自己的关联引用（来自 `InboundMessage.ref`）；合成回合没有。 */
  ref?: string;
  ts: string;
}

export interface PushMessage {
  text: string;
  /** 有标题概念的渠道才使用（钉钉会话列表的标题）。 */
  title?: string;
  /** 回复某条入站消息时，带上那条消息的 `ref`；webapi 用它把命令回复归到对应的 Response。 */
  ref?: string;
}
```

`OutboundMedia`、`MediaSendResult`、`InboundImage` 保持现有定义，从 `channel-context.ts` / `channel-event.ts` 移到合适的文件。原来的 `MediaSender` 接口删除，由 `Transport.sendMedia` 取代。

### D5. `Ingress`：runtime 实现，渠道调用

`src/channel/ingress.ts`：

```ts
export interface InboundMessage {
  channelId: string;
  user: string;
  userName?: string;
  /** 群名或对端昵称，用于频道索引；没有就不填。 */
  channelName?: string;
  /** 用户文本；附件在文本中的位置用 `[图片N]` / `[文件N]` 标记（钉钉现有做法）。 */
  text: string;
  /** 原始附件字节，按标记顺序排列。渠道只负责下载或解码并检查大小，落盘由 Ingress 在绑定之后完成。 */
  attachments?: InboundAttachment[];
  ref?: string;
  ts: string;
  /** 这条消息的发送者能使用的工位；不填表示不限（钉钉白名单用户、本机 socket）。
   *  有值时第一项是这个发送者的默认工位：频道还没有绑定时绑到它，而不是 `default`。 */
  allowedDesks?: readonly string[];
}

export type InboundAttachment =
  | { kind: "image"; data: Buffer }
  | { kind: "file"; data: Buffer; fileName: string };

export type IngressResult =
  | { kind: "started" }                         // 立即开始一个回合
  | { kind: "queued" }                          // 排在当前回合之后（独立回合）
  | { kind: "replied" }                         // 命令或 steer 已处理，回复已经通过 push 发出（带 ref）
  | { kind: "rejected"; reason: IngressRejection };

export type IngressRejection =
  | { code: "control_command"; command: "stop" | "steer" | "followup" }  // textControlCommands=false 时
  | { code: "desk_not_allowed"; desk: string }
  | { code: "queue_full" }
  | { code: "shutting_down" };

export interface Ingress {
  receive(message: InboundMessage): Promise<IngressResult>;
  /** 把 message 注入 channelId 正在运行的用户回合（webapi 的 response.steer）。 */
  steer(channelId: string, message: InboundMessage): Promise<SteerResult>;
  /** 等同于 `/stop`。 */
  cancel(channelId: string): Promise<StopOutcome>;
  /** 丢弃还没开始的排队消息（webapi 取消 queued 的 Response）。返回是否找到并删除。 */
  dropQueued(channelId: string, ref: string): boolean;
}

export type SteerResult =
  | { kind: "accepted" }
  | { kind: "rejected"; code: "response_not_active" | "too_many_pending_steers" | "invalid_input" };
```

`StopOutcome` 沿用现有定义（含 `pausedTaskId`）。

附件落盘从渠道移到 runtime：现在 `DingTalkHandler.persistInboundImage` 是 runtime 注入给钉钉的钩子，改为由 `Ingress` 在第 2 步绑定之后调用 `runtime/inbound-images.ts`。图片按 magic bytes 识别格式（`sniffImageMimeType`、`extensionForMimeType` 从 `dingtalk/inbound-media.ts` 移到 `channel/attachments.ts`，两个渠道共用），得到 `InboundImage`；文件存进工位 `inbox/`，并在文本末尾追加一行给模型看的保存路径。落盘失败时的行为保持不变：图片不交给模型，用户收到"保存失败"提示（现在由钉钉发出，改为 Ingress 用 `push` 发出）。

### D6. `Ingress.receive` 的处理顺序（唯一实现）

把 `bot.routeInboundEvent` 和 `turn-handler.ts` 里现有的逻辑整体收拢到这里，顺序与现在钉钉的行为一致：

1. 正在关机 → `rejected: shutting_down`。
2. 记录频道活动（频道索引）。频道还没有绑定时，绑到发送者的默认工位：`allowedDesks[0]`，没有 `allowedDesks` 时为 `default`（现在固定是 `default`）。`DeskRuntime.ensureDefaultBinding(channelId)` 因此多一个工位参数。`allowedDesks` 不包含当前绑定的工位 → `rejected: desk_not_allowed`。
3. `/new` → 立即执行，不受忙碌影响（紧急边界，沿用现在的语义）。
4. 渠道 `textControlCommands` 为 false 且文本是 `/stop` `/steer` `/followup` → `rejected: control_command`。
5. 频道正忙：
   - `/help`、`/stop`、`/steer`、`/followup` 和报告类命令，按现在的忙碌规则处理，回复通过 `push(ref)` 发出 → `replied`；
   - 其他斜杠命令 → 回复忙碌提示 → `replied`；
   - 普通消息按 `policy.whenBusy` 处理：`steer` / `followUp` 走现有的 `handleBusyMessage` 逻辑（包括压缩中断、任务步骤延后等分支）；`queue` 作为独立回合排队 → `queued`。
6. 空闲：内置命令和报告命令直接回复 → `replied`；其余入队开始回合 → `started`。

每个频道的 `ChannelQueue` 从 `src/dingtalk/channel-queue.ts` 移到 `src/runtime/channel-queue.ts`，由 `Ingress` 独占。`queue` 策略下，每个频道排队中的独立回合不超过 `MAX_QUEUED_TURNS_PER_CHANNEL`（代码常量，8），超过返回 `queue_full`。钉钉现在的队列没有上限，这一点保持不变：上限只对 `queue` 策略生效。

合成事件（任务驱动、事件、完成唤醒）仍由 durable dispatch 与 `turn-run.ts` 处理，入口从 `bot.enqueueEvent` 改为 `Ingress` 内部的 `enqueueSynthetic`（不在 `Ingress` 公开接口上；durable dispatch 依赖的 `ChannelEventSink` 由 ingress 实现）。

### D7. `ChannelContext`：回合输出口

`src/channel/channel-context.ts` 保留 `ChannelContext` 这个导出名，形状改为：

```ts
export interface ChannelContext {
  /** 按发生顺序调用，不阻塞；渠道内部自己串行投递。 */
  emit(event: TurnEvent): void;
  /** 回合结束时调用一次；渠道在这里完成收尾（关闭卡片、写入 Response 终态）。 */
  finish(outcome: TurnOutcome): Promise<void>;
}

export type TurnEvent =
  | { type: "tool.start"; callId: string; tool: string; args: unknown }
  | { type: "tool.update"; callId: string; text: string }
  | { type: "tool.end"; callId: string; ok: boolean; output: string }
  | { type: "reasoning"; text: string }
  | { type: "commentary"; text: string; level?: "error" } // 回合中间的 assistant 文本，以及 runtime 提示；error 由钉钉渲染成 ✕ 行
  | { type: "answer"; text: string }                // 一次最终回答（turn_end 且没有工具调用）
  | { type: "steer.applied" }                       // SDK 把一条 steering / follow-up 消息注入了本回合
  | { type: "compaction"; phase: "start" | "end"; ok?: boolean };

export interface TurnOutcome {
  kind: "completed" | "silent" | "failed" | "cancelled";
  /** failed 时给用户看的原因（已经是用户文案）。 */
  message?: string;
  /** 本回合所有 LLM 调用的用量总和。 */
  usage: UsageTotals;
}
```

- 删除 `respond`、`respondPlain`、`replaceMessage`、`respondInThread`、`setTyping`、`setWorking`、`deleteMessage`、`primeCard`、`flush`、`close`、`progressStyle`、`finalDelivery`、`message`、`channelName`。回合输入信息改由 `openTurn(turn)` 的 `TurnInfo` 提供，需要输入的 agent 代码从 `TurnInfo` 取。
- `ProgressStyle`、`FinalDelivery`、`ResponseMode` 及其推导函数是钉钉的展示配置，移到 `src/dingtalk/`。`ResponseMode` 仍从 `src/index.ts` 导出（D28）。`settings.json` 里的 `tui.responseMode` 由 TUI 客户端自己解释（D25）。
- "最终回答投递失败就改用另一种方式"、卡片预热、工具次数统计、进度滚动窗口、`[SILENT]` 之后关闭卡片，全部收回钉钉的 `ChannelContext` 实现内部。
- `muteChannelContext` 删除：静默的任务步骤调用 `openTurn(turn, { quiet: true })`，并且只把 `task_step_end` 的汇报经 `push` 发出。`quiet` 的含义：渠道只投递 `answer`，不显示任何进度（钉钉不建卡片；webapi 见 D21）。
- 给模型看的事件不进入 `ChannelContext`：`tool.start` 带的是工具名和原始参数，用户标签由渠道调用 `tools-contract/presentation.ts` 的 `describeToolCall` 自己生成。
- `answer` 可能在一个 runner 回合里出现多次（steering 之后又产生一次最终回答），`finish` 只调用一次。

`agent/` 里的生产方：`session-events.ts`（工具、思考、中间文本、最终回答、压缩、steering 注入）、`turn-pipeline.ts`（备用模型切换提示 → `commentary`）、`turn-finish.ts`（结束与失败 → `finish`）、`builtin-commands.ts`（命令输出 → `answer`）、`compaction.ts`（提示 → `commentary`）。`steer.applied` 的判断：本 runner 回合内，第一条用户 prompt 之后再出现 `message_start` 且 `message.role === "user"`。pi-agent-core 的 agent-loop 在注入排队的 steering / follow-up 消息时会发出这个事件（`agent-loop.js` 中 `pendingMessages` 的处理）。

### D8. `ChannelEvent` 改为判别联合

`src/channel/channel-event.ts`：

```ts
export type ChannelEvent = HumanEvent | WakeEvent;

interface EventBase {
  channelId: string;
  ts: string;
  text: string;
  images?: InboundImage[];
  /** runtime 持有的 durable dispatch 记录 id。 */
  dispatchId?: string;
}
export interface HumanEvent extends EventBase {
  source: "human";
  user: string;
  userName: string;
  channelName?: string;
  ref?: string;
}
export interface WakeEvent extends EventBase {
  source: "wake";
  /** 生产方标签：JOB、TASK_DRIVER、SUBAGENT、EVENT…… */
  producer: string;
  desk: string;
  internalWake?: { kind: "job" | "subagent"; resourceId: string; taskId: string; dispatchId: string };
  presentation?: "awaited";
}
```

- 删除 `type: "dm" | "group"`、`conversationType`、`conversationId`。钉钉需要的会话类型和会话 id 由钉钉渠道根据频道 id 和 `state/dingtalk/conversations.json` 自己得出。
- `isSyntheticEvent` 改为 `event.source === "wake"`。现在用 `user` 标签判断合成事件的地方全部改为看 `source`。
- durable dispatch 的哈希输入去掉 `conversationId`。

### D9. 渠道注册与生命周期

`src/runtime/transports.ts`：

- 读取 `channel.json`，对每个开启的渠道**动态 import** 它的工厂模块（`dingtalk/transport.ts`、`webapi/transport.ts`），关闭的渠道连模块都不加载（INV-7）。
- 对外提供 `forChannel(channelId): Transport | undefined`（按频道 id 前缀查找）、`isReachable(channelId)`（渠道已开启）、`all()`。
- 启动顺序：所有持久化的 job 和 run 恢复之后（沿用现有的准入点），再依次 `start(ingress)`。关闭时先 `stop()` 所有渠道，再按现有顺序关闭其他子系统（`shutdown.ts`）。
- `INV-8` 的执行点：任务驱动的"频道没有绑定就跳过"条件扩展为"没有绑定或不可达"；事件 watcher 遇到不可达频道时跳过并写回执 `channel_unavailable`；durable dispatch 投递时目标渠道没有开启，按"背压"处理（保留记录，稍后重试，不计入投递次数）。
- `state/daemon.lock`：daemon 和 TUI 内嵌运行时启动时都用 `shared/file-lock.ts` 获取，在整个进程生命周期内持有。拿不到就拒绝启动，并说明是谁持有（D26）。

## 7. 频道 id 与会话种类

### D10. 格式 `<transport>:<native>`

| 渠道 | 频道 id | 会话种类 / 目录 |
|---|---|---|
| 钉钉私聊 | `dingtalk:dm:<staffId>` | `dm` / `dm-N` |
| 钉钉群 | `dingtalk:group:<conversationId>` | `group` / `group-N` |
| Web API 会话 | `webapi:conv_<32 位小写十六进制>` | `webapi` / `webapi-N` |

- `src/channel/channel-id.ts` 只提供 `parseChannelId(id) → { transport, native } | undefined` 和 `transportOf(id)`；第一个冒号之前是渠道名，后面的部分由渠道解释（钉钉的 conversationId 可能含 `/`、`+`、`=`，还可能含 `:`，解析时只切第一个冒号）。
- `channelKind`、`conversationTypeOf`、`TUI_CHANNEL_ID`、`formatChannelLabel` 删除。会话种类由渠道给出（`dingtalk` 解析 `dm:` / `group:`，`webapi` 固定为 `webapi`），`DeskRuntime` 分配会话目录时通过一个注入的 `conversationKindOf(channelId)` 拿到；频道名由 `Transport.describe` 给出。
- `ConversationKind` 改为 `"dm" | "group" | "webapi"`，`tui` 种类删除（迁移时 `tui-N` 目录改名为 `webapi-N`，见 D29）。
- `tools/background-delivery.ts` 里拒绝在终端创建任务和事件的守卫删除：TUI 的会话现在是正常绑定的频道，任务和事件可以照常运行。

## 8. Web API 协议

### D11. 依据与版本

- 规范以 OpenAI 官方文档为准（developers.openai.com，2026-10-24 获取）：
  - Responses create / retrieve / cancel / input_items、streaming events、WebSocket events；
  - Conversations create / retrieve / update / items list；
  - Background mode、WebSocket mode、Mid-turn steering、Conversation state 指南。
- 实施时，以官方 `openai` npm SDK（≥ 7.10，固定到一个发布满两周的确切版本）的类型定义作为字段名和事件名的机器可读依据，有疑问时以 SDK 类型为准。
- 不新增任何事件类型、item 类型或请求/响应字段。需要表达的 pipiclaw 语义都映射到规范已有的结构上（D20），映射关系写在本文和 `docs/webapi.md`（D31）。

### D12. 资源模型

| pipiclaw | Web API |
|---|---|
| 唯一的助手 | `model: "pipiclaw"`；`GET /v1/models` 只列出这一项 |
| `webapi:` 频道 | Conversation `conv_<hex>`。用 `POST /v1/conversations` 显式创建，或在一个既没有 `conversation` 也没有 `previous_response_id` 的请求里隐式创建 |
| 频道绑定的工位 | 与钉钉相同：会话的第一条消息经过 `Ingress` 时绑定到发送者的默认工位（TCP key 是 `desks[0]`，本机 socket 是 `default`，D6）。创建会话本身不写绑定。之后换工位用 `/desk bind <name>`，同样受 `desks` 限制 |
| 一条入站消息 | 一个 Response |
| 回合进行中 / 排队中 | `in_progress` / `queued` |
| `/stop` | `POST /v1/responses/{id}/cancel`，或同步、流式请求断开连接（D19） |
| 用户能看到的历史 | `GET /v1/conversations/{id}/items` |
| SDK 会话、压缩、`/new` | 服务端内部状态。**items 是投递记录，不是模型上下文**，压缩和 `/new` 都不改写 items |

**归属**：每个 Conversation 记录创建它的主体：TCP 是 key 名，本机 socket 是 `local`。key 只能访问自己创建的会话和 Response，访问别人的返回 404。`local` 可以访问全部（它的权限等同于能读 `channel.json` 的系统用户）。

### D13. 端点

基础路径 `/v1`，SDK 的 `baseURL` 设为 `http://127.0.0.1:8787/v1`，或 socket 上的等价地址。

| 端点 | 支持范围 |
|---|---|
| `POST /v1/responses` | 同步、`stream: true`、`background: true`、`background + stream` |
| `GET /v1/responses/{id}` | 读取；`stream=true&starting_after=N` 续流，只对以 `background: true, stream: true` 创建、且还在保留期内的 Response 有效（与规范一致）；`include` 必须为空 |
| `POST /v1/responses/{id}/cancel` | 只能取消 `background: true` 的 Response（规范原文）；对已终态的 Response 重复调用是幂等的，直接返回它的最终对象 |
| `GET /v1/responses/{id}/input_items` | `after`、`limit`（1–100，默认 20）、`order`（默认 `desc`）；`include` 必须为空 |
| `GET /v1/responses`（WebSocket 升级） | 客户端事件：`response.create`、`response.steer`；支持 `stream_id` |
| `POST /v1/conversations` | `metadata`（最多 16 对，键 ≤64 字符，值 ≤512 字符）；`items` 必须为空或不传 |
| `GET /v1/conversations/{id}` | 读取 |
| `POST /v1/conversations/{id}` | 修改 `metadata` |
| `GET /v1/conversations/{id}/items` | `after`、`limit`、`order`，参数同上；`include` 必须为空 |
| `GET /v1/models`、`GET /v1/models/{id}` | 只有 `pipiclaw` |

其他路径和方法（`DELETE` 各资源、会话 items 的增删改、`/responses/compact`、`/files` 等）返回 404，错误对象格式见 D22。

### D14. 请求字段策略（`POST /v1/responses` 与 WebSocket `response.create`）

| 字段 | 处理 |
|---|---|
| `model` | 必须是 `"pipiclaw"`。其他值返回 400，`param: "model"`，提示用 `/model` 切换底层模型 |
| `input` | 字符串，或 `message` item 数组：`role: "user"`，`content` 为字符串或 `input_text` / `input_image` / `input_file` 组成的数组。规则见 D15 |
| `conversation` | 字符串或 `{ id }` |
| `previous_response_id` | 与 `conversation` 同时出现返回 400（规范原文："Cannot be used in conjunction with conversation"）。只允许指向它所属会话**最新**的那个 Response，此时等同于指定这个会话；指向更早的 Response 返回 400（不支持分支）；找不到返回 404（WebSocket 上为 `previous_response_not_found`） |
| 都没传 | 隐式新建会话，Response 的 `conversation` 字段带上它的 id |
| `stream`、`background` | 支持（WebSocket 上不能出现，规范要求） |
| `stream_options` | 只有 `stream: true` 时允许；`include_obfuscation` 可以是任意值，pipiclaw 不加混淆字段（属于混淆的可选特性，不影响语义） |
| `metadata` | 支持，限制同上，存在 Response 上原样返回 |
| `store` | 必须是 `true` 或不传；`false` 返回 400 |
| `instructions` | 必须为空或不传；否则 400（规范要求 instructions 不延续到后续请求，pipiclaw 的会话历史做不到） |
| `tools`、`tool_choice`、`parallel_tool_calls`、`max_tool_calls`、`prompt`、`text`、`reasoning`、`temperature`、`top_p`、`top_logprobs`、`max_output_tokens`、`truncation`、`context_management`、`include`、`moderation`、`access_programs`、`prompt_cache_options`、`prompt_cache_retention` | 不传或 `null` 时接受；其他值返回 400，`param` 指向这个字段 |
| `user`、`safety_identifier`、`prompt_cache_key`、`service_tier`（仅 `"auto"` 或 `"default"`） | 接受并忽略：都是提示，忽略不改变语义 |
| 其他任何字段 | 400，`param` 指向这个字段 |

`input` 里的 `role: "assistant" | "system" | "developer"`、`function_call_output`、`item_reference`、`mcp_approval_response` 和其他 item 类型一律 400：历史由服务端持有，指令只能写在工位的 AGENTS.md 里，客户端工具不支持。

### D15. 输入内容

- **文本**：按 content 部件的顺序拼接成 `InboundMessage.text`：`input_text`（以及字符串 `content`）原样放入，每个 `input_image` 处插入 `[图片N]`，每个 `input_file` 处插入 `[文件N]`，与钉钉 richText 的做法一致。
- **`input_image`**：只接受 `image_url` 为 `data:<mime>;base64,…`。base64 解码前先按长度估算大小，超过 `MAX_INBOUND_IMAGE_BYTES`（5MB，现有常量）返回 400；解码后作为 `{ kind: "image" }` 附件交给 Ingress（D5）。声明的 mime 只用于校验 data URL 格式，实际格式按 magic bytes 识别。`detail` 字段接受并忽略。`file_id` 或 http(s) URL 返回 400（Files API 不在范围内；URL 抓取有 SSRF 风险）。每条消息最多 9 张图（沿用 `MAX_INBOUND_IMAGES_PER_MESSAGE`）。
- **`input_file`**：只接受 `file_data`（base64 或 data URL）加 `filename`，解码后不超过 `MAX_INBOUND_FILE_BYTES`（代码常量，5MB），作为 `{ kind: "file" }` 附件交给 Ingress；runtime 落盘时清洗文件名，并加时间戳前缀。`file_id` 或 `file_url` 返回 400。
- 一条消息里所有内容都为空返回 400。
- 消息的 `user` 是主体名（key 名或 `local`），`userName` 同上。

### D16. Response 对象

- `id`：`resp_<32 位十六进制>`，`object: "response"`，`created_at` / `completed_at` 为秒级 Unix 时间，`model: "pipiclaw"`。
- `status`：`queued` | `in_progress` | `completed` | `failed` | `cancelled` | `incomplete`。
- `conversation: { id }`，`previous_response_id` 原样记录，`background`、`metadata`、`store: true`。
- `output`：见 D20。`output_text`：所有 `phase: "final_answer"` 消息的文本拼接。
- `usage`：映射关系为 `input_tokens = input + cacheRead + cacheWrite`、`input_tokens_details.cached_tokens = cacheRead`、`input_tokens_details.cache_write_tokens = cacheWrite`、`output_tokens = output`、`output_tokens_details.reasoning_tokens = 0`（SDK 不单独提供）、`total_tokens = input_tokens + output_tokens`。实施时要核对 `UsageTotals.input` 是否已经包含缓存部分，统一按规范"input_tokens 包含缓存命中"的语义映射。
- `error`：失败时为 `{ code, message }`；用户可见的失败原因（已经是中文用户文案）放在 `message`，`code` 用 `server_error`。
- `incomplete_details`：只在 steering 打断时出现，为 `{ reason: "steered" }`。
- 其他规范字段按 SDK 类型填默认值：`tools: []`、`tool_choice: "auto"`、`parallel_tool_calls: true`、`temperature: null`、`top_p: null`、`instructions: null`、`truncation: "disabled"` 等。

### D17. 一条入站消息一个 Response；忙碌与命令

- **空闲**：Response 状态 `in_progress`，开始回合。
- **忙碌**（来自 HTTP 或另一条 WebSocket 通道）：Response 状态 `queued`，按到达顺序作为**独立回合**执行，开始时转为 `in_progress`。流式请求会依次收到 `response.created`（`status: "queued"`）、`response.queued`、之后的 `response.in_progress`。webapi 的 `policy.whenBusy` 固定为 `queue`，不使用 SDK 的 followUp，否则两条消息会并进同一个回合，两个 Response 无法一一对应。
- **斜杠命令**（`/status`、`/tasks`、`/desk …`、`/new`、`/model`、`/compact` 等）：由 `Ingress` 按与钉钉相同的规则执行，回复经 `push(ref)` 写成该 Response 的一条 `phase: "final_answer"` 消息，Response 直接 `completed`，`usage` 全 0。需要会话层的命令（`/model`、`/compact`）在空闲时作为回合执行，结果也落在这个 Response 上。
- **文本形式的 `/stop`、`/steer`、`/followup`**：返回 400，`param: "input"`，提示改用 cancel、`response.steer` 或直接再发一条消息。同一个动作只保留一种方式。
- **队列满**：429，`rate_limit_error`。

### D18. steering（只在 WebSocket 上，与规范一致）

1. 客户端在同一条连接上，收到目标 Response 的 `response.created` 之后，发送 `{ type: "response.steer", previous_response_id, input }`。`input` 必须是字符串或非空的 user message 数组，规则同 D15。
2. 目标必须是本连接上创建的、正在执行的用户 Response，而且正处于 `in_progress`。否则回 `response.steer.failed`，`error.code` 取官方值：`response_not_found`、`response_not_active`、`response_already_completed`、`invalid_input`、`too_many_pending_steers`（同一个 Response 未生效的 steer 超过 `MAX_PENDING_STEERS`，代码常量，4）。
3. 调用 `Ingress.steer` 成功后回 `response.steer.accepted { steer: { id: "steer_<32 位十六进制>", previous_response_id } }`。accepted 只表示已排队，不表示模型已经处理。
4. 回合中出现 `steer.applied` 时，当前 Response 先补发已完成 item 的 done 事件，然后以 `response.incomplete`（`incomplete_details.reason: "steered"`）结束；随后在同一条通道上创建**后续 Response**（`previous_response_id` 指向原 Response，`input_items` 为 steering 的输入），本 runner 回合之后的输出都归到它上面。
5. 如果原 Response 先正常完成（steer 在最后一次 turn_end 之后才到），原 Response 保持 `completed`，steer 作为下一个独立回合执行，同样以后续 Response 的形式出现（规范允许 completed 之后还有后续 Response）。
6. 后续 Response 继承原请求的设置；它占用原 Response 在 `stream_id` 通道上的位置，不重新排队。

HTTP 不支持 steer：规范只在 WebSocket 模式定义了 steering。

### D19. 取消

- `background: true` 的 Response：用 `POST /v1/responses/{id}/cancel` 取消。
  - `queued` → 用 `Ingress.dropQueued` 删除，状态变为 `cancelled`，不运行；
  - `in_progress` → `Ingress.cancel`，等同于 `/stop`（是任务步骤时会暂停任务；不取消委派，这与现有 `/stop` 语义一致），状态变为 `cancelled`；
  - 已终态 → 原样返回最终对象（幂等）。
- 非 background 的 Response 不能用 cancel 端点取消（400，规范原文），**同步或流式请求的客户端断开连接即视为取消**（规范："To cancel a synchronous response, terminate the connection"）。`queued` 的直接丢弃，`in_progress` 的调用 `Ingress.cancel`。
- WebSocket：规范没有 cancel 事件。连接关闭时，该连接上 `queued` / `in_progress` 的 Response 按上一条处理。
- 长任务的客户端应当使用 `background: true`，这要写进文档（D31）。

### D20. 输出 item 与流式事件

| pipiclaw 回合事件 | output item | 流式事件（都带 `sequence_number`、`output_index`、`item_id`） |
|---|---|---|
| `tool.start` → `tool.end` | **`mcp_call`**：`id: "mcp_<hex>"`、`server_label: "pipiclaw"`、`name: <工具名>`、`arguments: <JSON 字符串>`、`output: <截断到 MAX_TOOL_OUTPUT_CHARS（代码常量，4000）的结果>`、`error: null` 或失败原因、`status` 依次为 `in_progress` → `completed` / `failed` | `response.output_item.added` → `response.mcp_call_arguments.done` → `response.mcp_call.in_progress` → `response.mcp_call.completed` 或 `.failed` → `response.output_item.done` |
| `tool.update` | 不产生 item（只有委派工具发这个事件，内容会体现在最终 `output` 里） | 无 |
| `reasoning` | `reasoning`：`id: "rs_<hex>"`，`summary: [{ type: "summary_text", text }]` | `output_item.added` → `reasoning_summary_part.added` → `reasoning_summary_text.delta`（一次给完）→ `reasoning_summary_text.done` → `reasoning_summary_part.done` → `output_item.done` |
| `commentary` | `message`：`role: "assistant"`、`phase: "commentary"`、`content: [{ type: "output_text", text, annotations: [] }]` | `output_item.added` → `content_part.added` → `output_text.delta`（一次给完）→ `output_text.done` → `content_part.done` → `output_item.done` |
| `answer` | `message`，`phase: "final_answer"` | 同上 |
| `compaction` | 不产生 item；失败提示以 `commentary` 出现 | 无 |
| 回合结束 | — | `response.completed` / `response.failed` / `response.incomplete`；取消见下文 |

- **为什么用 `mcp_call`**：规范里的 `function_call` 表示由客户端执行，语义不对。`mcp_call` 是唯一一个表示"服务端执行的工具"的通用 item，各语言 SDK 都有类型，并且有官方配对的审批 item（`mcp_approval_request` / `mcp_approval_response`），以后可以直接用来做审批。代价是 pipiclaw 的工具并不是真的 MCP 工具，这一点写进 `docs/webapi.md`。`arguments` 和 `output` 对 key 持有者是可见的；key 本身就等同于 shell 权限，这不构成越权（D24）。
- message item 在消息完整后才发出，这样才能确定 `phase`。逐 token 输出不在本次范围内。
- `sequence_number` 在每个流（每个 SSE 连接，或 WebSocket 上每个 Response）内从 0 开始单调递增。SSE 的 `event:` 行等于 JSON 的 `type`，不发 `id:` 行，不发 `[DONE]`。
- 取消的 Response：官方规范没有"已取消"的流式事件，pipiclaw 也不自造（D11）。同步或流式请求的取消由客户端断开连接触发，流本来就已经结束；对 background+stream 的 Response 调用 cancel 时，服务端在已发出的事件之后**直接结束 SSE 流，不发送终态事件**，取消方从 cancel 的返回值（状态为 `cancelled` 的 Response 对象）得知结果，其他读者用 GET 得知结果。
- 错误：流内发生错误时先发 `error` 事件，再发 `response.failed`（规范要求）。

### D21. 主动推送与静默回合

- **合成回合**（任务汇报、事件、委派或后台任务完成唤醒）在所属会话里产生一个**没有请求方**的 Response：`input_items` 为空（INV-4），`metadata` 为空，其他字段与普通 Response 相同，状态从 `in_progress` 走到终态。
- `quiet: true` 的回合（后台唤醒）只把 `answer` 写成 item，不产生 `commentary`、`reasoning`、`mcp_call`。整个回合都没有 `answer` 时（`[SILENT]`）**不产生 Response**：在 `finish` 之前不落盘、不对外可见。静默的任务步骤同理不产生 Response。
- **`push`**：没有 `ref` 时（回执、通知、任务汇报），在会话里产生一个 `completed` 的 Response，只含一条 `final_answer` 消息；带 `ref` 时写入对应的 Response（D17 的命令回复）。
- 客户端用标准的 `GET /v1/conversations/{id}/items?order=asc&after=<最后看到的 item id>` 拉取新内容。不新增推送通道（D11）。

### D22. 错误

- HTTP 错误体：`{ "error": { "message", "type", "param", "code" } }`。状态码决定官方 SDK 抛出的错误类，必须准确：

| 状态码 | `type` | 场景 |
|---|---|---|
| 400 | `invalid_request_error` | 参数错误；`code` 取 `unknown_parameter`、`unsupported_parameter`、`unsupported_value`、`invalid_value`、`missing_required_parameter`、`branching_not_supported` |
| 401 | `invalid_request_error` | 缺少 key 或 key 无效；`code: "invalid_api_key"` |
| 403 | `invalid_request_error` | 工位不在 key 的 `desks` 内；`code: "desk_not_allowed"` |
| 404 | `invalid_request_error` | 资源不存在或不属于该 key；`code: "not_found"` |
| 413 | `invalid_request_error` | 请求体超过上限 |
| 429 | `rate_limit_error` | 限流或队列满，带 `Retry-After` |
| 500 | `server_error` | 内部错误，不回显内部细节 |
| 503 | `server_error` | 正在关机 |

- `message` 用英文（读者是开发者和部署者，AGENTS.md 的受众规则），内容要说明能做什么：例如 `"instructions is not supported: put durable instructions in the desk's AGENTS.md."`。不回显 key、文件内容或内部路径之外的敏感信息。
- WebSocket 错误按规范的包络：`{ type: "error", status, error: { type, code, message, param }, stream_id? }`；连接满 60 分钟时发 `websocket_connection_limit_reached` 后关闭；`stream_id` 不合法发 `invalid_stream_id`；命名通道超过 32 条发 `websocket_stream_limit_reached`。
- Ajv 校验错误由统一的 `setErrorHandler` 转成上面的格式；不能把 Fastify 默认的错误体暴露出去。

### D23. 存储与重启

```text
state/webapi/                       # 0700
├── api.sock                        # 本机 socket，0600
├── responses.jsonl                 # response id → conversation id 索引，只追加
└── conversations/<conv_id>/
    ├── conversation.json           # { id, created_at, metadata, owner }，atomic write
    └── responses.jsonl             # 每个 Response 在创建时和到达终态时各追加一份快照；同 id 以最后一行为准
```

- 存储放在渠道自己的 state 下而不是工位目录里，这样 `/desk bind` 换工位后会话历史仍然完整。
- conversation items 由 `responses.jsonl` 推导：按 Response 顺序，先列它的 input items（给 user message 生成 `msg_<hex>` id），再列 output items。
- 启动时扫描索引：没有到达终态的 Response（`queued` 或 `in_progress`）一律追加一份 `failed` 快照，`error.message` 写明"服务重启，回合被中断"，**不自动重跑**（工具可能已经产生副作用）。
- 续流缓冲：只保留在内存里，每个 background+stream 的 Response 一份事件列表，终态后再保留 `STREAM_REPLAY_TTL_MS`（代码常量，5 分钟）；过期后用 `stream=true` 读取返回 400。
- 本次不做保留期和清理：Response 和会话一直保留，与钉钉会话的日志相同。

## 9. 安全

### D24. HTTP 服务与默认值

选型 **Fastify 5**（OpenJS 基金会维护，使用广泛）、**`@fastify/websocket`**（基于 `ws`）、**`@fastify/rate-limit`**。理由：

- 内置 Ajv JSON schema 校验，路由级 schema 设 `additionalProperties: false`；
- 内置 `secure-json-parse`，`onProtoPoisoning` / `onConstructorPoisoning` 设为 `error`；
- `bodyLimit`、`connectionTimeout`、`keepAliveTimeout`、`requestTimeout`、`maxParamLength` 都有现成设置；
- `onRequest` 钩子在解析请求体之前执行；
- 原生支持监听 unix socket，也支持 HTTPS。

SSE 直接写 `reply.raw`，不再增加依赖。依赖版本固定到发布满两周的确切版本。

| 威胁 | 措施 |
|---|---|
| 未鉴权的请求消耗资源 | `onRequest` 钩子鉴权，失败直接 401，**不读请求体**（INV-6）；WebSocket 在升级阶段鉴权 |
| key 泄漏或被猜中 | key 有 256 位随机熵；只存 sha256；比较时对每个存储值都用 `crypto.timingSafeEqual` 比完，不提前返回 |
| 明文传输 bearer token | 非 loopback 的 `tcp` 必须配 TLS（D2） |
| 浏览器跨站请求（CSRF、跨站 WebSocket 劫持） | 带 `Origin` 头的 HTTP 请求和 WebSocket 升级一律 403；不注册 CORS |
| DNS rebinding | TCP 绑定在 loopback 时，`Host` 必须是 `127.0.0.1:<port>`、`localhost:<port>` 或 `[::1]:<port>`，否则 403。unix socket 上不检查 Host；非 loopback 地址由 TLS 证书约束主机名 |
| 越权使用工位或会话 | key 只能使用 `desks` 内的工位；会话和 Response 按归属隔离（D12） |
| 大请求、慢请求 | `bodyLimit` 8MB；`requestTimeout` 30 秒（只限制接收请求的时间，不限制回合时长）；WebSocket `maxPayload` 8MB；base64 先按长度估算大小再解码 |
| 资源耗尽 | `server.maxConnections` 64；每条 WebSocket 连接最多 16 个进行中的 Response、32 条命名通道、最长 60 分钟（数值来自规范）；每个频道排队上限 8；TCP 上按来源 IP 用 `@fastify/rate-limit` 限流（每分钟 300 次），socket 不限流 |
| 本机其他用户 | `state/webapi/` 目录 0700，socket 0600；监听前删除残留的 socket 文件，这是安全的，因为此时已经持有 daemon 锁（INV-11） |
| 事后追查 | 每个请求的主体、方法、路径、会话、状态码，每次鉴权失败的来源 IP，都写进 `security/logger` 的审计日志；日志里不写 key、请求体或输出内容 |
| 关闭的渠道 | 不加载模块、不监听（INV-7） |

**写进文档的权限说明**：一把 key 的权限等于宿主机上的 shell 权限（agent 有 `bash`）。本机 socket 的访问范围等同于运行 daemon 的系统用户。

## 10. TUI

### D25. TUI 是 Web API 的客户端

- TUI 用官方 `openai` SDK 连接 `state/webapi/api.sock`：发消息走 WebSocket 模式的 `response.create`，回合进行中发 `response.steer`，Ctrl-C 断开当前 Response（按规范等于取消），空闲时轮询 `GET /v1/conversations/{id}/items` 显示合成回合的结果（D21）。
- 官方 SDK 能否走 unix socket（HTTP 用 `fetchOptions.dispatcher`，WebSocket 用自定义连接）在实施的第一步验证（plan B0）。如果 SDK 的 WebSocket 客户端不支持 unix socket，TUI 用 `ws` 直接实现 WebSocket 通道，但请求和事件的类型仍然用 SDK 的 TypeScript 类型；HTTP 部分仍然用 SDK。这样 INV-10 的一致性检验由 e2e 在 loopback TCP 上用 SDK 完成。
- TUI 显示工具调用时，用 `tools-contract/presentation.ts` 的 `describeToolCall(name, JSON.parse(arguments))` 生成标签，用 `settings.json` 的 `tui.responseMode` 决定显示多少进度。
- TUI 只保留本地命令 `/exit`、`/quit`；其他斜杠命令原样作为 input 发给服务端。`/stop` 和 `/steer` 分别映射成断开连接和 `response.steer`；`/followup` 映射成"等当前 Response 结束后再发"，由客户端自己排队。
- TUI 记住每个工位上次用的会话：`state/tui/conversations.json`（工位名 → conv id），属于客户端状态。
- `--desk <x>`：用这个工位上次的会话；没有就新建会话，第一条消息先发 `/desk bind <x>`。`--create` 先发 `/desk new <x>`，再 `/desk bind <x>`。`--new` 总是新建会话。
- `--print`：发一次同步请求，打印 `output_text` 后退出；`--quiet`、`--plain` 语义不变。
- 删除：`tui/app.ts` 里的运行时搭建、`tui/turn-controller.ts`、`tui/terminal-context.ts`、`tui/terminal-media-sender.ts`，以及 `conversations/tui-N/.lock`。`tui/` 只依赖 `openai`、`commands/catalog.ts`、`tools-contract/`、`paths.ts`、`config/settings.ts`（读 `tui.responseMode`）和自己的渲染代码。

### D26. 没有 daemon 时的内嵌运行时

- `pipiclaw tui` 先尝试获取 `state/daemon.lock`：
  - **锁被占用**：说明 daemon 在运行，直接连接它的 socket。daemon 关闭了 webapi 或 `socket: false` 时，TUI 报错，并说明两种做法：打开 `channel.json` 的 webapi socket，或者先停掉 daemon。
  - **拿到锁**：在本进程里启动完整的运行时，渠道配置被覆盖为"只开 webapi 的 socket"（不连钉钉、不开 TCP），然后 TUI 作为客户端连上去。运行时的日志只写文件，不写终端。
- 组装放在 `src/main.ts`（`entry` 可以 import 任何模块）：`runTui(argv, { startEmbeddedRuntime })`，其中 `startEmbeddedRuntime` 调用 `runtime/bootstrap.ts` 新增的 `bootstrapEmbedded(...)`。`tui/` 不 import `runtime/`。
- **行为变化**：没有 daemon 时，TUI 打开期间事件和任务驱动也会运行；TUI 退出等于运行时关闭（按 `shutdown.ts` 的顺序关闭）。钉钉频道的任务和事件在内嵌运行时里不可达，按 INV-8 跳过。

## 11. 钉钉渠道

### D27. 钉钉的变化

| 方面 | 变化 |
|---|---|
| 钉钉用户 | **没有变化**：卡片流式输出、三种 `responseMode`、`busyMessageDefault`、所有命令、白名单、图片收发、`/stop` 的回执文案都保持不变 |
| `bot.ts` | 只保留 Stream 连接、入站归一化（`InboundMessage`）、`allowFrom` 授权、图片下载。`routeInboundEvent`、队列、`enqueueEvent`、`clearPendingMessages`、`resetChannelQueue` 删除 |
| `transport.ts`（新增） | 实现 `Transport`；`policy.whenBusy` 来自 `busyMessageDefault`；`policy.textControlCommands = true` |
| `delivery.ts` | 改写成钉钉的 `ChannelContext` 实现，消费 `TurnEvent`，内部渲染进度（`formatProgressEntry` 移入 `dingtalk/`）、按 `tool.start` 计数、处理"卡片发送失败就改发普通消息"、预热卡片、`quiet` 时不建卡片 |
| `handler.ts` | 删除（`DingTalkHandler` / `DingTalkBotPort` 不再存在）；`/stop` 时丢弃卡片，由钉钉自己的 `ChannelContext` 在收到 `finish({ kind: "cancelled" })` 时处理 |
| `config.ts` | 读取 `channel.json` 的 `dingtalk` 段；`BusyMessageMode`、`ResponseMode` 等类型在这里 |
| 会话元数据 | `state/dingtalk/conversations.json` 的键改成新格式的频道 id；钉钉渠道用它和频道 id 推导会话类型 |
| 依赖加载 | `enabled: false` 时不加载 `dingtalk-stream` |

## 12. 公开导出

### D28. `src/index.ts`

导出名是兼容承诺（spec 035，AGENTS.md），名字全部保留：

| 导出名 | 之后指向 |
|---|---|
| `ChannelContext` | 新形状（D7） |
| `FinalDelivery`、`ProgressStyle`、`ResponseMode` | 移到 `dingtalk/` 后的同名类型 |
| `DingTalkBot` | 钉钉渠道的实现类（构造参数改变） |
| `DingTalkConfig` | `channel.json` `dingtalk` 段的类型 |
| `DingTalkEvent` | `ChannelEvent` 的别名（沿用现有做法） |
| `DingTalkHandler` | `Ingress` 的别名，**只在 `index.ts` 里声明**（`export type { Ingress as DingTalkHandler }`），内部代码一律使用 `Ingress` |
| `bootstrap`、`BootstrapOptions`、`AppContext`、路径常量、`PipiclawSettings` | 不变；`BootstrapOptions` 去掉 `dingtalkConfig` / `createBot`，改为可选的渠道覆盖 |

形状和签名的变化属于破坏性变更，写进 changelog。不新增导出名。

## 13. 迁移与发版

### D29. 一次发版、一次离线迁移

A、B、C 三个阶段在同一个开发分支上完成，作为一个版本发布。新增 `docs/channel-migration.md`，风格与 `docs/desk-migration.md` 一致：由 AI agent 在停机快照上执行，不交付迁移脚本，运行时不读旧格式。需要处理的内容：

| 数据 | 转换 |
|---|---|
| `channel.json` | 根级字段整体移进 `dingtalk`，加 `"enabled": true`；新增 `webapi` 段（默认 `enabled: false`） |
| `workspace/desk-bindings.json` | 键 `dm_x` → `dingtalk:dm:x`，`group_x` → `dingtalk:group:x`；`tui` 没有绑定记录，不涉及 |
| 每个工位的 `desk.json` `conversations` | 同上改键；`tui` 键对应的会话目录 `tui-N` 改名为 `webapi-N`，新键为 `webapi:conv_<新生成的 id>`，并在 `desk-bindings.json` 中为它补一条绑定（指向该工位） |
| `state/webapi/conversations/<conv_id>/conversation.json` | 为上一步生成的每个会话创建，`owner: "local"`；`responses.jsonl` 为空（旧的 TUI 历史不进 items，session 文件保留，模型上下文延续）；`state/tui/conversations.json` 写入工位到会话的映射，让 TUI 接着用 |
| `tasks/*.md` frontmatter `channel` | 按上面的映射改写（原来是 `tui` 的指向该工位新生成的 webapi 会话） |
| `events/*` 的 `channelId` | 同上 |
| `state/subagent-runs/`、`state/jobs/` 里的 `channelId` | 同上 |
| `state/dispatch/` 的待投递记录 | 改写 `event` 为 D8 的形状（加 `source: "wake"` 和 `producer`，删除 `type` / `conversationType` / `conversationId`，改写 `channelId`）；也可以先让 daemon 把它们投递完再停机 |
| `state/dingtalk/conversations.json` | 改键 |
| `workspace/CHANNELS.md` | 不改，由新版本启动时重新生成 |
| 模型写的事件文件、playbook 示例、文档里出现的旧 id 格式 | 文档和 playbook 在代码里更新；工作区里模型写过的文本只改机器读取的字段 |

会话目录 `dm-N`、`group-N` 不动。迁移文档要列出校验步骤：新版本 `pipiclaw` 能正常启动；`/desk` 能显示每个频道；TUI 能接着用原来的会话。

## 14. 测试策略

### D30. 删除重写，而不是逐步改造

下面四条在计划中称为 T1–T4。

- **T1 原样保留**：memory、tasks、subagents、tools、security、web、skills、usage、desk 等与渠道层无关的测试。fixture 里频道 id 字符串的改动是机械替换，不算重写。
- **T2 直接删除**：主要测试旧渠道接口、旧 `ChannelContext` 或 TUI 运行时的测试和支撑代码。清单在 plan 里，包括：
  - `dingtalk.test.ts`、`delivery.test.ts`、`card-delivery.test.ts`、`session-events.test.ts`、`runtime-stop.test.ts`、`bootstrap.test.ts`、`runtime-context.test.ts`；
  - `config-loader.test.ts` 中关于 channel.json 的部分；
  - `test/support/{fake-bot,harness-bot,runtime-harness}.ts`、`test/helpers/fake-bot.ts`；
  - e2e 的 `tui-command.test.ts`。
- **T3 按新代码重新设计的单测**，每张矩阵只放在它所属的领域里：
  - `channel-id` 解析的边界；
  - `Ingress` 的路由矩阵：空闲/忙碌 × 命令种类 × `whenBusy` × `textControlCommands`，取代原来的钉钉路由测试和 TUI controller 测试；
  - `session-events` 生成的 `TurnEvent` 序列（含 `steer.applied`、多次 `answer`）；
  - 钉钉 `ChannelContext`：`TurnEvent` 到卡片和普通消息的投递、失败改投、`quiet`；
  - `channel.json` 校验；
  - webapi 的请求字段策略（一张表驱动）、鉴权（哈希比较、`desks`、归属、Origin/Host）、Response 状态机（排队、取消幂等、steer 拆分、重启后标为失败、items 推导）、事件序列的 `sequence_number` 与 item 生命周期。
- **T4 deterministic e2e 重建**：
  - 非渠道用例（memory、tasks、subagent-chain、jobs、guards、compaction 等）通过 `test/support/recording-transport.ts` 驱动：它是一个真实实现 `Transport` 的测试渠道，经 `BootstrapOptions` 的渠道覆盖注册，消息走真实的 `Ingress`，记录 `TurnEvent`、`finish` 和 `push`。断言 provider 请求、落盘结果、事件类型与顺序，不断言文案。独立进程的用例（`daemon-worker.mjs`）同样用它。
  - 钉钉专属用例在 `dingtalk-stream` SDK 边界上替换 `DWClient` 和钉钉 HTTP API，覆盖卡片、进度和 `/stop`。
  - webapi 用例启动只开 webapi 的真实运行时（loopback TCP 加测试 key，同时开 socket），用官方 `openai` SDK 当客户端（INV-10）。
- 已有功能的用例总数不增加；新增用例只用于 webapi 和 TUI 客户端这两个新功能，每个新增的 e2e 用例都要按 AGENTS.md 做一次故意改坏代码、确认用例变红的检查，并把用例数的变化写进实施记录。

## 15. 文档

### D31. 需要同步更新的文档

- 新增 `docs/webapi.md`：端点、字段策略、与规范的映射（`mcp_call`、`phase`、合成 Response）、安全说明、SDK 示例（HTTP、background、WebSocket steer）。
- 新增 `docs/channel-migration.md`（D29）。
- 更新：`docs/configuration.md`、`docs/configuration-reference.md`（channel.json 新结构、开关、key 命令）、`docs/deployment-and-operations.md`（只开 webapi 的部署、TLS、反向代理）、`docs/security.md`（新的网络入口）、`docs/interaction-and-commands.md`（TUI 变化、webapi 的命令差异）、`docs/architecture.md`、`docs/scaling-and-concurrency.md`、`docs/README.md`、`README.md`。
- 更新 `AGENTS.md` 的模块表和 Runtime Model、`CLAUDE.md` 的架构说明、`scripts/check-architecture.mjs`。
- 更新 playbook 里出现频道 id 格式的地方（`src/playbooks/runtime-orientation.md` 等），以及 `commands/catalog.ts` 里提到 `channel.json` 字段的用户文案。
- `docs/specs/README.md` 加上本 spec。

## 16. 取舍与风险

| 取舍 | 选择 | 代价 |
|---|---|---|
| 不支持的字段拒绝还是忽略 | 拒绝（INV-9） | 依赖这些字段的通用客户端用不了 |
| 工具调用的表示方式 | `mcp_call` | 借用了 MCP 的语义 |
| TUI 是否保留独立模式 | 不保留，没有 daemon 就内嵌运行时 | TUI 打开期间会运行后台工作 |
| 主动推送 | 合成 Response 加轮询 items | 没有实时推送，TUI 空闲时轮询本地 socket |
| 存储位置 | `state/webapi/`，与工位分开 | 与工位的 `log.jsonl` 有内容重复 |
| 发版 | 一次发版、一次迁移 | 分支存在时间长，需要频繁同步 master |

风险：

- **回合输出口重写**影响最敏感的投递路径（卡片、`/stop`、失败改投）。缓解：钉钉的 deterministic e2e 覆盖卡片、进度和 `/stop`，在 A 阶段结束前必须全部通过。
- **steer 拆分 Response** 依赖 SDK 的 `message_start` 事件时机。缓解：B 阶段专门有一个 e2e 用例，用 mock provider 的 `hold` 构造精确的注入时机。
- **官方 SDK 能否走 unix socket** 有不确定性。缓解：B0 先验证，D25 给出了退路。
- **迁移出错**。缓解：迁移文档要求在完整备份的副本上演练，并列出校验步骤；运行时对不认识的 `channel.json` 格式直接拒绝启动，不会带着错误数据运行。

## 17. 实施时必须先核实的事项

1. 官方 `openai` SDK 的 HTTP 和 `ResponsesWS` 能否走 unix socket（D25）。
2. 官方 SDK 在 background+stream 的流没有终态事件就结束时的表现：应当正常结束迭代而不是抛错（D20）；如果会抛错，记录在实施记录里，并在 `docs/webapi.md` 中说明。
3. `UsageTotals.input` 是否包含缓存命中的 token（D16）。
4. pi-agent-core 在 steering / follow-up 注入时 `message_start` 的顺序，以及与 `turn_end` 的先后（D7、D18）。
5. Fastify 5 + `@fastify/websocket` 在同一个实例上同时监听 unix socket 和 TCP 的方式（可能需要两个实例共用路由注册函数）。

核实结果和由此做出的决定写进下面的实施记录。

## 18. 实施记录

按阶段填写：偏差与理由、核实结果、用例数变化 before → after。

### 阶段 A（渠道层重构）

**A0 基线**：单测 918 个（134 个文件），deterministic e2e 63 个（25 个文件）；`npm run check`、`test:e2e`、`eval:typecheck`、`build` 全绿。

**A1**（单测 918 → 921，e2e 63 → 63）：新增 `test/channel-id.test.ts`（3 个用例，防的是 `:` / `/` / `+` / `=` 出现在钉钉会话 id 里时切错渠道）。其余是 fixture 里频道 id 的机械替换。`TransportName` 放在 `channel/transport.ts`（计划写在 `channel-id.ts`），因为 `channel-id.ts` 不需要知道有哪些渠道。

**A2 + A3 合并成一个门禁点**。原因：计划自己指出的那点——`/stop` 时立即关闭卡片，在旧形状的 `ChannelContext`（`respond*` 加 `deleteMessage`）上无法由渠道自己表达，必须等回合输出口改成 `emit` / `finish` 才能做；两步改的是同一条投递链路。

偏差与就地决定（每条都以"钉钉用户感觉不到变化"为准）：

1. **`TurnEvent` 比 D7 多三处**，都是内部契约，不影响 Responses 协议映射，webapi 一律忽略：
   - `commentary.level` 取 `"error" | "warning" | "notice"`。D7 只有 `"error"`，但旧代码里 `respondInThread` 的提示（跳过压缩、截断输入、更新 skill、图片提示）是**不进卡片的独立消息**，而且在 `final_card_only` 下也要发；模型切换提示则是"有进度就写成 ✕ 行，没有进度就发 ⚠️ 独立消息"。三种行为只用一个 `"error"` 表达不了，合并就会让钉钉可见行为变化。
   - `tool.end` 多一个可选的 `failure`：给用户看的失败行（守卫拒绝按结构化形态渲染，其余取首行）。它由 agent 在知道"这是用户要看见的错误，还是模型自己能修的拒绝"的地方算出，渠道不再猜。
   - `quiet` 只表示"不显示进度"，不改变答案的投递方式：`final_card_only` 下的后台唤醒答案照旧以卡片发出（旧行为），而不是 D7 字面说的"只投递 answer 的普通消息"。
2. **运行器内置命令（`/help`、`/context`、空闲时的 `/stop` `/steer` `/followup` 提示）不走 `answer` 事件**：`AgentRunner.handleBuiltinCommand` 改成返回回复文本，由回合流水线用 `push`（带标题、`markdown: true`、`ref`）发出，与报告类命令完全同一条路径。理由：它们本来就是带标题、不归档的"命令回复"，用 `answer` 还得再给事件加 `title` 字段。代价是旧代码在普通消息发送失败时会再试一次卡片，这条兜底随之去掉（报告类命令早就没有）。`PushMessage` 因此多了可选的 `markdown` 字段。
3. **`/stop` 立即关卡片**：`ChannelRunner.requestStop()` 现在同时调用 `TurnOutput.cancel()`，立刻对渠道发 `finish({ kind: "cancelled" })` 并丢弃之后的事件；钉钉在 `finish(cancelled)` 里同步 `discardCard`（不排在正在进行的投递之后）。这与旧的 `handleStop` 里直接 `discardCard` 的时序一致。`TurnOutput`（agent 内）保证渠道只收到一次 `finish`。副作用：关机时的 abort 现在也以 `cancelled` 收尾，卡片文字从"已处理，无需答复。"变成"处理已结束。"，仅此一处文案差异。
4. **钉钉的队列上限是 20，不是"没有上限"**：D6 的描述与代码不符。保留 20 条上限与"消息积压过多"提示（由 Ingress 用 `push` 发出）；`whenBusy: "queue"` 的渠道用 `MAX_QUEUED_TURNS_PER_CHANNEL`（8），超限静默 `rejected: queue_full`，由渠道自己回错误。
5. **附件的"保存失败"仍是文本标记**（`[图片N：保存失败]`、`[图片N：格式不支持，已保存]`），不是 `push` 出去的提示——这才是钉钉现有的行为。`InboundAttachment` 因此带 `index`（标记里的 N）。落盘与标记改写由 `runtime/inbound-images.ts` 的 `resolveInboundAttachments` 完成，并新增文件落盘（`inbox/file-<时间>-<清洗后的文件名>`）。
6. **保留的既有行为（不是本次引入的，记在这里避免被当成回归）**：
   - 钉钉里一个回合出现两次最终回答（steering 之后）时，只有第一次会送达——旧的 `sendFinal` / `replaceWithFinal` 都在 `ending` / 已送达之后直接返回。
   - 滚动模式的头部"工具 N"现在只数 `tool.start`；旧代码因为靠 `"➜ "` 前缀数，会把委派的进度更新也算进去。
7. **日志**：`log.logThinking` 不再只在显示进度时才记（agent 不再知道渠道显不显示进度）。
8. **`RunQueue` 保留**，只用来给"刷新 skill 后再提示"这类非投递工作排序；回合事件直接 `emit`，顺序由渠道内部的串行链保证。
9. **`dingtalk/handler.ts` 的 `BusyMessageResult`** 变成 `runtime/ingress-busy.ts` 的 `BusyOutcome`（多了 `steered`，供 `Ingress.steer` 使用）。`Ingress` 被拆成 `ingress.ts`（入口与顺序）、`ingress-busy.ts`（忙碌与 `/stop`）、`ingress-commands.ts`（`/new` 与报告类命令）、`ingress-deps.ts`（依赖清单）。`IngressService` 在接口之外多暴露测试用的 `handleEvent` / `reserveEvent` / `routeEvent` / `isIdle` / `isRunning` / `runRuntimeCommand`。
10. **测试策略的一处偏差**：deterministic e2e 的夹具没有改成 `RecordingTransport`，而是继续用**真实的 `DingTalkTransport` + 捕获出站调用的 `HarnessDingTalkBot`**。理由：这样原来 63 个用例对钉钉投递序列的断言一条没动、全部通过，是"钉钉行为不变"最直接的证据；换成 `RecordingTransport` 反而会丢掉这层断言。`RecordingTransport` 用于 Ingress / 运行时的单测（`test/ingress.test.ts` 等）。
11. **`TUI`** 在 A 阶段保持自己的运行时，只做了编译所需的最小改动：`terminal-context.ts` 消费 `TurnEvent`，`tui/progress.ts` 临时复制了一份进度格式，`tui/channel-label.ts` 放 `tui` 频道常量和标签；`tools/background-delivery.ts` 里写死了 `"tui"`。这些都在 C 阶段删除。
12. `AppContext` 去掉了 `bot`（`DingTalkBot` 不再是运行时必有的东西），`RuntimeContext.handler` 改为 `ingress`；`BootstrapOptions` 新增 `transports`。

**用例数（A2 + A3）**：单测 921 → 944，e2e 63 → 63。删除：`delivery`（13）、`card-delivery`（10）、`runtime-stop`（4）、`dingtalk.test.ts` 中的路由 / 队列 / 忙碌 8 例；新增：`dingtalk-delivery`（25，含 2 个新故障模式：`commentary` 各级别的展现、`cancelled` 不排在进行中的投递之后）、`ingress`（27，路由矩阵 + 准入 + 取消 / steer / `/new`）、`session-events`（6 → 9，新增 3 个 `TurnEvent` 序列）、`turn-output`（2）。净增主要来自两个新契约（`TurnEvent`、`Ingress`）的矩阵；C 阶段删掉旧 TUI controller 的用例后会回落，届时在 C 的记录里复核。

**A4**（单测 944 → 948，e2e 63 → 63）：`channel/config.ts`、`dingtalk/config.ts`（`parseDingTalkConfig`）、`runtime/transports.ts`（按开关动态 import）、`runtime/daemon-lock.ts`、INV-8 的三处执行点（任务驱动、事件 watcher、durable dispatch）。

- 新增 `test/channel-config.test.ts`（5）：取代原来 `bootstrap.test.ts` 里关于 `channel.json` 的 2 个用例；加上 `runtime-context` 的"一个 app home 只能有一个运行时"（1）；`events` / `task-driver` / `durable-dispatch` 各在既有用例里加了"渠道不可达"的断言（0 个新用例）。
- **INV-7 验证**：用 `module.register` 的 `load` 钩子打印所有名字含 `dingtalk` 的模块加载：`import('dist/runtime/bootstrap.js')` 和 `node dist/main.js --version` 两条路径都**没有**加载任何 dingtalk 模块；`dingtalk-stream` 只在钉钉段为开时随 `dingtalk/transport.js` 动态加载。
- **配置 / 锁的手动验证**（临时 `PIPICLAW_HOME`）：首次运行写模板并 exit 0；占位符 → exit 1 并逐项列出；两个段都关 → exit 1 并说明要开哪个；带旧格式的根级 `clientId` → exit 1 并指向文档；另一个进程持有 `state/daemon.lock` → exit 1，消息带 pid 和主机名。
- `webapi.enabled: true` 目前（B1 之前）会拒绝启动并说明该渠道还不存在。
- 假凭据启动的 daemon 会在首次连接失败后退出（exit 0）：这是旧版本就有的行为（重连定时器是 unref 的），不是回归，已用 `70cd4b8` 的构建对照确认。
- `events/watcher.ts` 超过 800 行预算，把 `EventPreActionError` 抽到 `events/pre-action-error.ts`。
- `HumanEvent.allowedDesks`（`/desk bind` 受 key 的 `desks` 限制）没有在 A 阶段加，留到 B3，那时才有调用方。


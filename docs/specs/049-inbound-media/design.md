# 入站图片（图文混排 / 纯图片）设计方案

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | 待实现 |
| 日期 | 2026-08-30 |
| 关联实现 | `src/runtime/dingtalk.ts`, `src/channel/channel-event.ts`, `src/channel/channel-context.ts`, `src/runtime/delivery.ts`, `src/runtime/bootstrap.ts`, `src/agent/channel-runner.ts`, `src/agent/model-fallback.ts`, `src/channel/store.ts`, `src/shared/config-diagnostic.ts` |
| 测试 | `test/dingtalk-inbound-media.test.ts`, `test/inbound-image-prompt.test.ts`, `test/e2e/deterministic/inbound-media.test.ts` |
| 对偶 spec | `030-outbound-media`（出站附件）——本 spec 是它显式列为"正交，独立立项"的入站方向 |

---

## 背景：一次真实事故

2026-08-30 00:00–00:02，用户在钉钉私聊 `dm_015262473638858016` 里两次发图并要求解读，机器人两次都回复"没有收到图片"。

日志给出了完整证据，而且暴露的是**两条不同的失败路径**：

| 时刻 | 用户动作 | 钉钉 `msgtype` | 实际发生 |
|---|---|---|---|
| 00:00:47 | 图文混排（文字 + 图片一起发） | `richText` | 文字被正确提取（`messageLength: 18`，正是那句话的字数），**图片被静默丢弃，没有任何日志** |
| 00:01:48 | 只发一张图，无文字 | `picture` | 整条消息被丢弃，只留下一行 `DingTalk: empty message (type=picture)` |

```
~/.pipiclaw/state/logs/runtime.jsonl
{"ts":"2026-08-30T00:00:47.309+08:00","level":"info","event":"runtime.dingtalk.message_received",
 "channelId":"dm_015262473638858016","fields":{"messageType":"dm","messageLength":18}}
{"ts":"2026-08-30T00:01:48.388+08:00","level":"warn","event":"system.warning",
 "message":"DingTalk: empty message (type=picture)"}
```

模型说"没收到图片"是**如实的**：它那一轮的上下文里确实只有文字。两种形态都必须支持，而 `richText` 那条尤其危险——它连一行 warn 都没有，只有对着日志逐字数才能发现图片丢了。

## 根因：入站附件在整条链路上从未实现

不是 bug，是能力缺口。四层全缺，任何一层单独补都不成立：

**1. 解析层 —— `src/runtime/dingtalk.ts:1276` `extractContent()`**

```ts
const textContent = (data.text?.content || "").trim();
if (textContent) return textContent;
if (data.content?.richText) {
    for (const item of data.content.richText) {
        if (item.text) parts.push(item.text);   // ← 只取 text，downloadCode 直接忽略
    }
}
return "";
```

钉钉的图片负载是 `content.downloadCode`（`picture`）或 `content.richText[].downloadCode`（`richText`）。这里既不读 `downloadCode`，也没有下载动作。返回空串后 `dingtalk.ts:1305` 打一行 warn 就 `return`。

**2. 事件模型 —— `src/channel/channel-event.ts:10`** `ChannelEvent` 只有 `text: string`，没有附件字段。

**3. 交付契约 —— `src/channel/channel-context.ts:65`** `ChannelContext.message` 同样只有 `text`。注意这里是单向的：出站方向 `OutboundMedia` / `MediaSender`（spec 030）做得很完整，入站方向一个对应物都没有。

**4. 送模型 —— `src/agent/channel-runner.ts:558`** `await this.session.prompt(text)`，只传字符串。

**底层 SDK 早就支持。** `AgentSession.prompt/steer/followUp` 都带 `images?: ImageContent[]`；`ImageContent = { type:"image", data: base64, mimeType }`。`read` 工具（`src/tools/read.ts:147`）已经在用这条通路读本地图片。缺的纯粹是 pipiclaw 从传输层到 runner 的这一段。

**还有一个隐藏的第五层。** SDK 的 `provider-composer` 里：

```js
input: (definition.input ?? ["text"])
```

`models.json` 里自定义 provider 的模型只要没写 `input`，就默认纯文本；随后 provider 转换层把 image 块替换成字符串 `"(see attached image)"`——**用户和模型都收不到任何提示**。用户机器上的 `zpai/glm-5.3-flash`（事故当轮正在跑的模型）正是这种情况。所以即使前四层全部补齐，不动 `models.json` 仍然一张图都进不去，而且失败形态和今天一模一样：模型说"我没看到图"。

---

## 目标

- **两种形态都支持**：`richText` 图文混排（可含多图，文字与图片交错）、`picture` 纯图片无文字。
- **图片落盘保留**在 channel workspace，agent 可用 `read` 复看，历史可追溯，上下文压缩后仍可找回。
- **传输中立**：入站附件是一个与 `OutboundMedia` 成对的端口，不把钉钉细节泄进 `agent/`。
- **顺序不乱**：下载引入的延迟不得让后到的消息插到先到的消息前面。
- **忙时可排队**：回合进行中收到图片走 steer/followUp，而不是被"空消息"拒绝。
- **绝不静默丢弃**：下载失败、超限、模型不支持视觉——每一种都要让用户看见，并告知图片存在哪。
- `models.json` 补 `input`，并对缺失 `input` 的自定义模型给出启动诊断。

## 非目标

- **入站语音 / 视频 / 非图片文件**。`downloadCode` 机制对它们是一样的，解析层按 `msgtype` 预留分支，但本期只实现 image：其余类型需要各自的转文本策略（ASR、抽帧、pdftotext），是独立的一件事。
- **图片压缩 / 缩放 / 格式转换**。超过尺寸上限的图片落盘并告知路径，不做自动降采样（需要引入图像库，且降采样后模型看到的和用户发的不是同一张图）。
- **OCR**。视觉模型自己会读图上的字。
- **TUI 侧粘贴图片入站**。契约留好（`InboundImage` 是传输中立的），实现留给 TUI 自己。
- **`inbox/` 的自动清理**。按需求"落盘保留"，本期明确不做，风险与未来挂载点见 §7。

---

## 关键设计决策

### D1. 事件里传路径，不传字节

`InboundImage` 携带 `path` + `mimeType` + `byteSize`，不携带 `Buffer`。

理由：`ChannelEvent` 会被 `DurableDispatchService` 序列化成 JSON 落盘、会被日志打印摘要、会在 `ChannelQueue` 里排队最多 20 条。把 base64 塞进去会撑爆 dispatch 记录、污染日志、让队列内存随图片大小线性增长。而"落盘保留"本来就是需求，落盘是必须动作，路径就是最自然的载体。

**与出站 `OutboundMedia`（带内传 `Buffer`）故意不对称**，这不是疏忽：出站的字节来自 `Executor`（可能是远端/沙箱），没有"本地文件"这个概念，spec 030 D4 已经论证过；入站的字节必须先落到本地盘上才能满足保留需求，再从事件里重复传一份就是纯浪费。两边的注释要互相指认，避免后来者以为是漏改。

### D2. 在接收时下载，不在 turn 时下载

`downloadCode → downloadUrl` 是临时凭证，`downloadUrl` 本身也有短有效期。而 channel 忙时消息可能在 `ChannelQueue` 里排队数分钟（队列上限 20 条，每条都是一个完整回合）。turn 开始时再去下载，凭证大概率已经过期——而且失败得很晚，用户已经等了很久。

所以：解析 → 下载 → 落盘，全部在 `onStreamMessage` 里、入队之前完成。

这不会阻塞钉钉的 ACK：`dingtalk.ts:594` `handleRawMessage` 是**先立即 ACK，再 fire-and-forget** 地调 `onStreamMessage`。但它引入了 D3。

### D3. 新增 per-channel 入站摄取串行队列

这是本设计最容易被漏掉、后果最难查的一点。

今天 `onStreamMessage` 到 `enqueueStreamMessage` 之间没有任何网络等待，所以 N 条 fire-and-forget 的处理虽然并发，但**到达顺序 == 入队顺序**。加入下载后这个隐式保证就没了：一条要下载 300ms 的图文混排消息，会被紧随其后、无需下载的纯文本消息超车。

而这恰恰就是事故当天的消息形态（图文混排 + 紧接着的另一条消息）。用户会看到机器人先回答后一句、再回答前一句。

方案：用已有的 `src/shared/serial-queue.ts` 的 `createSerialQueue<string>()`，按 `channelId` 串行化"解析 → 下载 → 落盘 → `routeInboundEvent`"整段。同一 channel 严格保序，不同 channel 互不阻塞，且不阻塞 ACK。

**配套改动（否则 e2e 必然 flaky）**：`dingtalk.ts:1478` `allChannelQueuesIdle()` 必须把"在途摄取"计入。否则 `waitForIdle()` 会在图片还没下载完、消息还没入队时就判定空闲，测试断言跑在消息到达之前。

### D4. 纯图片消息合成文本，不再当空消息丢

`picture` 消息文本为空。保留"空消息就丢弃"的规则，但把判定改成"**文本为空且没有图片**"。有图片时合成文本：单图 `[图片]`，多图 `[图片 x3]`。

合成文本不是装饰，有两处硬依赖：

- `bootstrap.ts:569` `handleBusyMessage` 对空 `queueText` 直接回"无法排队"。忙时发来的纯图片会被这条规则拒掉。
- `log.jsonl` / 记忆层以 `text` 为唯一载体。空文本会在历史里留下一个没有任何内容的洞，后续的 `HISTORY.md` 摘要和 `session_search` 都看不到这轮发生过什么。

### D5. 文本里放定位标记，图片按序附加

SDK 的 `prompt(text, { images })` 组装出的用户消息是 `[{type:"text"}, ...images]`（`agent-session.js:872`）——**所有图片排在文本之后，交错位置信息全部丢失**。

图文混排里"这张图"、"上面那张"指的是哪一张，全靠标记。所以展开 `richText` 时按数组顺序在文本流里插入 `[图片1]` `[图片2]`，`images` 数组保持同序。模型即使只看到"文本 + 尾部三张图"，也能靠标记把第 N 张对上。

`picture` 单图消息同理：合成文本就是 `[图片1]`（对外显示为 `[图片]`，见 D4——两者取其一，实现时统一成 `[图片1]` 形式即可，一致性优先于措辞）。

### D6. 复用已有的 `inbox/` 目录；transport 只管网络，落盘归 bootstrap

**位置**：`<channelDir>/inbox/`。`channel-runner.ts:1117` `persistOversizedInput` 已经在用这个目录落超长消息，注释里明确写了理由——"放在 channel 目录下就落在 `read` 已允许的路径里"。图片沿用同一目录、同一 `localStampForFilename()` 命名、同一 `mode: 0o600`。

文件名：`image-<stamp>-<n>.<ext>`。**扩展名由嗅探结果决定，绝不来自远端**（见 D8 的安全约束）。

**分层**：`DingTalkBot` 不应该知道 channel workspace 的目录布局——它今天也不知道（`stateDir` 是它自己的，workspace 是 bootstrap 的）。所以：

- transport 负责 `downloadMessageFile(downloadCode) → { data, mimeType }`（纯网络）；
- `DingTalkHandler` 新增钩子 `persistInboundImage?(channelId, payload): Promise<InboundImage | null>`，由 `bootstrap` 实现（它持有 `options.paths.workspaceDir`）。

副作用是 e2e 天然可注入：harness 覆写 transport 的下载方法即可零网络跑通全链路，与现有 `HarnessDingTalkBot` 覆写 `sendPlain` / `ensureCard` 是同一套模式。

### D7. 模型不支持视觉时必须显式降级

这是最容易复发的失败形态，必须专门处理：provider 转换层会把 image 块替换成 `"(see attached image)"` 占位符，**没有异常、没有日志、没有用户提示**，表现和今天的 bug 完全一样。

回合开始前检查 `session.model.input.includes("image")`。不支持时：

1. 不把 `images` 传给 `prompt`；
2. 在用户消息文本里补一句"当前模型 `X` 不支持图片输入，图片已保存到 `<相对路径>`"；
3. `ctx.respondInThread` 给用户一条可见提示。

**模型回退路径同样要过这个检查。** `src/agent/model-fallback.ts:126` `runPromptWithFallback` 会在主模型出错后切到备用模型重跑同一个 prompt。主模型支持视觉、备用不支持时，重试那一次必须重新判定，否则图片在第二次请求里被静默吃掉。

### D8. 上限与校验都用代码常量，`settings.json` 不加键

按 `AGENTS.md`：`settings.json` 只接受产品意图（布尔、枚举、模型引用），数值阈值是代码常量。本期不需要任何新配置键——"能不能收图"不是产品选项，是基本能力。

新常量（`dingtalk.ts`）：

| 常量 | 值 | 理由 |
|---|---|---|
| `MAX_INBOUND_IMAGE_BYTES` | `5 * 1024 * 1024` | 对齐 `tools/truncate.ts:21` 的 `MAX_INLINE_BINARY_BYTES`，让"入站图片"和"`read` 读图"用同一把尺子 |
| `MAX_INBOUND_IMAGES_PER_MESSAGE` | `9` | 钉钉单条消息的图片数量上限量级；防御性硬顶 |
| `MEDIA_DOWNLOAD_TIMEOUT_MS` | `60_000` | 与已有的 `MEDIA_UPLOAD_TIMEOUT_MS` 同量级；默认的 15s HTTP 超时对多 MB 下载太紧 |

**安全约束**（transport 的 HTTP 不走 `src/security/` 守卫——那套守卫管的是 agent 发起的动作，和今天的 `media/upload` 一样是运行时自身 I/O，这点要在注释里写明，避免误读为漏挡）：

- **文件名绝不来自远端**。用我们自己的 stamp + 嗅探出的扩展名，杜绝路径穿越和伪装扩展名。
- **mimeType 以 magic bytes 为准**，`Content-Type` 只作参考。JPEG `FF D8 FF` / PNG `89 50 4E 47` / GIF `47 49 46 38` / WebP `RIFF....WEBP`。嗅探不出来的：**仍然落盘**（`.bin`）、**不进 prompt**、告知用户——不能把来路不明的字节当图片喂给模型。
- **下载用 `maxContentLength` 硬限字节数**，不要先收完再判断大小。

### D9. `models.json` 补 `input` + 启动诊断

**改配置**（用户机器 `~/.pipiclaw/models.json`）：给 `zpai/glm-5.3-flash` 加 `"input": ["text", "image"]`（用户已确认支持视觉）。`zpai/glm-5-turbo` 的视觉能力未确认，本期不动——留着并由下面的诊断提醒。

**加诊断**：`models.json` 里自定义 provider 的模型未声明 `input` 时，启动给一条 warning：

> `models.json: <provider>/<id> 未声明 input，将按纯文本模型处理；发给它的图片会被丢弃。支持视觉请加 "input": ["text","image"]。`

挂在现有的 `src/shared/config-diagnostic.ts` 通道上。这条诊断是本 spec 的**长期价值**所在：以后每加一个自定义模型，配错都会被当场指出来，而不是几个月后在一次"它说没收到图"的对话里才发现。

---

## 设计

### 1. 传输层 `src/runtime/dingtalk.ts`

**类型扩展**

```ts
interface DingTalkIncomingMessage {
    msgtype?: string;
    text?: { content?: string };
    content?: {
        richText?: Array<Record<string, string>>;
        /** `picture` 消息的图片凭证。 */
        downloadCode?: string;
    };
}
```

**`extractContent` → `parseInboundMessage`**

```ts
interface ParsedInboundMessage {
    /** 已插好 [图片N] 标记的文本；纯图片消息为合成文本。 */
    text: string;
    /** 与文本里的标记同序。 */
    downloadCodes: string[];
}
```

- `text.content` → 文本
- `msgtype === "picture"` → `content.downloadCode` 单个
- `richText` → 顺序遍历：`item.text` 进文本流，`item.downloadCode` 进 `downloadCodes` 并在文本流对应位置插 `[图片N]`
- 都没有 → `{ text: "", downloadCodes: [] }`，调用方维持现有的 warn + 丢弃

这是一个**纯函数**，不碰网络，可以直接单测所有形态。

**`protected async downloadMessageFile(downloadCode)`**

两步，都复用现有的 `getAccessToken()` 与 `http` axios 实例：

1. `POST https://api.dingtalk.com/v1.0/robot/messageFiles/download`
   header `x-acs-dingtalk-access-token`，body `{ robotCode, downloadCode }`
   `robotCode` 用现成的 `this.config.robotCode || this.config.clientId`（同 `dingtalk.ts:1036`）
2. `GET downloadUrl` 取字节，`responseType: "arraybuffer"`，`maxContentLength: MAX_INBOUND_IMAGE_BYTES`，`timeout: MEDIA_DOWNLOAD_TIMEOUT_MS`

`protected` 而非 `private`：`HarnessDingTalkBot` 覆写它就能让 e2e 零网络跑通，与现有覆写模式一致。

**`onStreamMessage`** 改为经 D3 的摄取队列，顺序：

```
parseInboundMessage
  → 无文本且无图片：warn + 丢弃（现状不变）
  → allowFrom / channelId 解析（现状不变，且必须在下载之前——
     未授权的发送者不应该让我们去下载他的文件）
  → 并行下载至多 MAX_INBOUND_IMAGES_PER_MESSAGE 张（按下标回填，保序）
  → handler.persistInboundImage 落盘
  → 组装 ChannelEvent（带 images）
  → routeInboundEvent
```

失败处理：某张图下载/嗅探/落盘失败 → 该张从 `images` 里去掉，但**消息照常投递**，文本里的 `[图片N]` 换成 `[图片N：接收失败]`。整条消息因为图片失败而消失，是比看不见图更糟的行为。

### 2. 契约层

`src/channel/channel-event.ts`：

```ts
/**
 * 用户在渠道里发来的一张图片，已经落到本地盘。
 *
 * 与出站的 `OutboundMedia` 故意不对称：出站带 Buffer（字节来自可能是远端的
 * Executor，没有本地文件语义），入站带 path（字节必须先落盘保留，事件里再
 * 复制一份纯属浪费，而且 ChannelEvent 会被 durable dispatch 序列化）。
 */
export interface InboundImage {
    /** `<channelDir>/inbox/` 下的绝对路径。 */
    path: string;
    mimeType: string;
    /** 盘上字节数；runner 用它跳过超限图片而不必先读进内存。 */
    byteSize: number;
}
```

`ChannelEvent` 加 `images?: InboundImage[]`；`ChannelContext.message` 加 `images?: InboundImage[]`。

### 3. delivery / TUI

`src/runtime/delivery.ts:61` `buildContext()` 透传 `images: this.event.images`。TUI（`src/tui/terminal-context.ts:44`）不产图片，字段可选，无需改动——契约已经为它备好。

### 4. `src/runtime/bootstrap.ts`

- **实现 `persistInboundImage` 钩子**：`getChannelDir(workspaceDir, channelId)/inbox/`，`mkdir -p`，`writeFile(..., { mode: 0o600 })`，返回 `InboundImage`。
- **`archiveIncomingMessage`**：`LoggedMessage`（`src/channel/store.ts:12`）加 `images?: string[]`（相对 `channelDir` 的路径）。**文本里只留 `[图片N]` 标记，路径放独立字段**——记忆层的摘要输入不该被一串文件路径污染，但 `log.jsonl` 里必须留全信息，否则历史里那轮就成了无从追查的 `[图片1]`。
- **`handleBusyMessage`**（`bootstrap.ts:569`）：空文本判定改为"文本为空**且** `event.images` 为空"；steer/followUp 带上 images。requeue 路径 (`enqueueStreamMessage(event, result.text)`) 用的是 `{...event, text}` 展开，images 自动保留，无需改。
- **`handleNewSession`** 的归档路径同样带 images。

### 5. `src/agent/channel-runner.ts`

`run()` 里，在 `assembleTurnPrompt` 之前：

```
ctx.message.images
  → 逐张：byteSize > MAX_INBOUND_IMAGE_BYTES ? 剔除 + 记原因 : 读盘 → base64 → ImageContent
  → 模型 input 不含 "image" ? 全部剔除 + 记原因 (D7)
  → 被剔除的：文本里补说明 + ctx.respondInThread 提示，并给出 inbox 路径
```

其余改动：

- `maybeRunPreventiveCompactionForIncomingText` 目前只按文本估算。图片每张约 1000–1600 token，三张图就能顶掉一次该触发的预防性压缩。把图片计入估算（`pi-ai` 有 `estimateTextAndImageContentTokens`，或用每张固定估值常量）。
- `FallbackRunDeps.prompt(text, images?)`；`runPromptWithFallback(promptText, images, deps)`；回退后重新执行 D7 判定。
- `queueSteer(text, userName, images?)` → `session.steer(text, images)`。
- `formatUserMessage` / `clipUserInput` / `MAX_USER_MESSAGE_CHARS` 不变——图片不占文本预算。

### 6. 文档

- `docs/interaction-and-commands.md`：新增"发图片给它"一节，说明两种发送形态、群聊需 @ 机器人、图片存在 `inbox/` 可以让它 `read` 复看。
- `docs/architecture.md`：消息生命周期补入站附件一段；磁盘布局补 `inbox/`。
- `docs/configuration-reference.md`：`models.json` 的 `input` 字段（默认 `["text"]`、不写会丢图）。
- `docs/specs/README.md`：主题分组表加 `049`。

---

## 测试

按 `CLAUDE.md` 的要求，每条都要能被真实回归打破，并注明变异检查。

**单元 `test/dingtalk-inbound-media.test.ts`**（纯函数 + 注入的下载）

| 用例 | 变异检查 |
|---|---|
| `picture` 消息解析出 1 个 downloadCode + 合成文本 | 恢复"空文本即丢弃"，用例失败 |
| `richText` 文字+图片交错解析出同序的文本标记与 codes | 把标记插入改成"图片全部追加到末尾"，标记与序号错位，用例失败 |
| `richText` 纯文字仍走原路径、不产生 images | 防止改动把纯文本消息也拖进下载路径 |
| 无文本无图片仍然丢弃并 warn | 防止合成文本泛化到真正的空消息 |
| magic bytes 与 `Content-Type` 冲突时以 magic bytes 为准 | 改成信任 `Content-Type`，用例失败 |
| 嗅探失败：落盘为 `.bin`、不进 images、消息仍投递 | 改成"嗅探失败即丢整条消息"，用例失败 |
| 单张下载失败：其余图片保留、消息仍投递、标记变为"接收失败" | 改成 `Promise.all` 直接 reject，用例失败 |
| 超过 `MAX_INBOUND_IMAGES_PER_MESSAGE` 时截断 | — |

**单元 `test/inbound-image-prompt.test.ts`**（runner 层）

| 用例 | 变异检查 |
|---|---|
| 模型 `input` 含 `image` → images 进入 `prompt` 调用 | 去掉透传，用例失败 |
| 模型 `input` 不含 `image` → images 不进 prompt，且有可见提示 | 去掉 D7 检查，images 被静默吃掉，用例失败——**这是防止事故以同样形态复发的那条测试** |
| 回退到不支持视觉的备用模型后，第二次请求不带 images | 只在首次判定，用例失败 |
| `byteSize` 超限 → 该张剔除 + 提示带路径 | — |

**e2e deterministic `test/e2e/deterministic/inbound-media.test.ts`**（覆写 `downloadMessageFile`，零网络）

| 用例 | 断言 |
|---|---|
| 图文混排 | provider 收到的 user message 含 image 块；`inbox/` 下确有文件；`log.jsonl` 的 `images` 字段有相对路径 |
| 纯图片 | 起了一个真实回合（不再是 `empty message` 丢弃）；文本为合成标记 |
| **保序**：先发一条需要下载 100ms 的图文混排，紧接着发纯文本 | `log.jsonl` 顺序 == 发送顺序。**变异检查：去掉 D3 的摄取串行队列，这条必挂**——它是本 spec 唯一能抓住乱序回归的测试 |
| 忙时发图 | 走 steer 排队，不出现"无法排队" |

---

## 风险与取舍

**磁盘增长（已知、有意接受）。** `inbox/` 无清理。按每天 20 张、每张 800KB 估算约 16MB/天、6GB/年，单 channel。用户明确要求保留，本期不做清理；未来若要做，挂载点是 `src/memory/scheduler.ts` 那套已有的门控维护流水线（加一个按总字节数封顶的清扫 job），不要新起一套定时器。

**上下文压缩会吃掉图片。** SDK 的 compaction 把历史摘要成文本，图片块不会保留。这正是"落盘保留"的第二重价值：`inbox/` 路径写在 `log.jsonl` 里，agent 事后可以 `read` 把图重新拉回上下文。文档要写清楚这一点。

**群聊限制。** 钉钉平台规则：群里只有 @ 机器人的消息才会推给它，图片同理。非本设计可控，文档说明即可。

**`glm-5-turbo` 未确认。** 本期只给 `glm-5.3-flash` 加 `input`，turbo 留给 D9 的诊断提醒。

---

## 实施顺序

每步结束都能 `npm run check` 通过：

1. **契约 + 解析**：`InboundImage`、`ChannelEvent.images`、`ChannelContext.message.images`、`parseInboundMessage`（纯函数）+ 它的单测。此时行为不变。
2. **下载 + 落盘 + 摄取队列**：`downloadMessageFile`、`persistInboundImage` 钩子、D3 串行队列、`allChannelQueuesIdle` 计入在途。此时图片已落盘，但还没进 prompt。
3. **送模型**：runner 读盘→`ImageContent`、D7 能力检查、fallback 透传、压缩估算。端到端打通。
4. **忙时路径**：`handleBusyMessage` 空判定 + steer/followUp 带图。
5. **配置与文档**：`models.json` 的 `input`、启动诊断、四篇文档、e2e 用例。

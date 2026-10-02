# 出站附件（图片 / 文件）设计方案

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | 已实现 |
| 日期 | 2026-07-20 |
| 关联实现 | `src/runtime/channel-context.ts`, `src/runtime/dingtalk.ts`, `src/tools/send-media.ts`, `src/tools/registry.ts`, `src/tools/index.ts`, `src/agent/runner-factory.ts`, `src/agent/channel-runner.ts`, `src/runtime/bootstrap.ts`, `src/tui/terminal-media-sender.ts`, `src/tui/app.ts` |
| 测试 | `test/send-media.test.ts` |

---

## 背景

pipiclaw 以钉钉为主渠道，但出站只有一条路径：`DingTalkBot.sendPlain()`（text / markdown）与 AI Card 流式。两者的 `msgKey` 只用了 `sampleText` / `sampleMarkdown`，**没有任何图片或文件消息类型**。工具层（`ToolBuildContext`）也不持有 bot 或任何"往渠道回传"的句柄——agent 手里的 read/bash/write/web 等工具都无法把一个生成好的产物（报表、截图、图表、导出文件）交回给用户。

结果就是：agent 能在 workspace 里生成 `report.pdf`，却只能把路径当文本发出去，用户在钉钉里拿不到文件本身。

## 目标

- 让 agent 能把 workspace 内的**本地文件**作为**原生附件**发回当前渠道：图片内联展示，其余作为可下载文件。
- 作为一个**显式工具** `send_media` 暴露给 agent（不是隐式解析最终答案里的标记）。
- 与现有工具层保持**架构一致**：static 注册、构建期绑定 channelId、经 path-guard、经 executor 读字节。
- 传输中立：钉钉与终端 TUI 都实现同一个出站附件端口，`send_media` 不依赖任何具体 transport。

## 非目标

- **最终答案里的附件标记**（`![](path)` 之类由 delivery 层解析）——评估后不做，容易误触发且要改 delivery 解析逻辑。显式工具更可控、可审计。
- **跨渠道发送**（把文件发到 agent 当前渠道以外的群）。channelId 构建期绑定当前渠道，LLM 无法指定目的地。若将来有定时任务跨群推送的需求，再以**可选** `channel` 参数 + 白名单守卫的形式增量加入。
- **入站附件**（用户发来的图片/文件的接收与解析）——正交，独立立项。
- **音频 / 视频消息类型**。当前只覆盖 `sampleImageMsg` 与 `sampleFile`。

---

## 关键设计决策

### 1. 显式工具，而非答案标记

评估过两种触发方式：

- **A（采用）· 显式 `send_media` 工具**：agent 明确决定"把这个文件发给用户"。控制清晰、可审计、易加 path-guard，与现有工具化架构一致。
- B · 最终答案里的附件标记：更"自然"，但要改 delivery 解析、容易把答案里的普通链接误当附件。

### 2. per-channel 绑定 ≠ per-turn 绑定

这是本设计最关键的认知，避免了一次不必要的大改动。

- **turn 绑定**是 `ChannelContext` / delivery 那套 per-turn 的东西——附件工具**不碰**它。
- **channel 绑定**才是工具需要的：现有 `read` / `bash` / `edit` / `write` **全都**在构建期通过 `fileToolOptions(ctx)` 把 `ctx.channelId` 焊进闭包。它们在 `TOOL_REGISTRY` 里是**单一 static 注册**，但每个 channel 的 runner 各自 build 一份带自己 channelId 的实例。

`send_media` 照抄这个模式：`TOOL_REGISTRY` 注册一次，channelId 从 `ctx` 来。因此**不需要**把 sender 沿 runner→bootstrap 做 per-channel 穿线，真正新增的只有一个**进程级单例依赖**（`mediaSender`）注入 `ToolBuildContext`。

### 3. channelId 由运行时提供，不由 LLM 提供

曾考虑把 channelId 做成 LLM 参数以让工具"完全与渠道解耦"，但否决了：

1. **LLM 不知道这个 id。** channelId 是内部格式 `dm_{staffId}` / `group_{conversationId}`，不是自然语言里的东西；让模型照抄既脆又难看。
2. **跨渠道泄露。** channel A 的 agent 只要拼出 channel B 的 id 就能把敏感文件发到 B。
3. **与现有工具不一致。** read/bash 从不让 LLM 指定 channel。

因此 channelId 构建期绑当前渠道，LLM 只见 `path` / `fileName`——无法打错渠道。

### 4. 字节在带内传，不传路径

`OutboundMedia` 携带 `data: Buffer` 而非路径。`send_media` 经 `Executor`（`base64 < file`，与 `read` 读图片完全一致）读出字节再交给 sender。这样 sender 与"文件物理位置"解耦——即使 executor 是远端/沙箱，出站也成立。

---

## 设计

### 传输中立契约（`src/runtime/channel-context.ts`）

```ts
export interface OutboundMedia {
  data: Buffer;               // 文件字节（带内传输）
  fileName: string;           // 展示名，如 "report.pdf"
  kind: "image" | "file";     // image 内联；file 可下载
}
export interface MediaSendResult { ok: boolean; error?: string; }
export interface MediaSender {
  sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult>;
}
```

`MediaSender` 与 `ChannelContext` 并列放在这个 transport-neutral 模块里。注意它**不是** `ChannelContext` 的一部分——`ChannelContext` 是 per-turn 的，而 `MediaSender` 是长生命周期的进程级端口。

### 钉钉实现（`src/runtime/dingtalk.ts`，`DingTalkBot implements MediaSender`）

两步（钉钉机器人发图/发文件必须先上传拿 `media_id`，不能直接塞 URL）：

1. **`uploadMedia(type, data, fileName)`** → `POST https://oapi.dingtalk.com/media/upload?access_token=<TOKEN>&type=image|file`，multipart 字段名 `media`（Node 22 原生 `FormData` + `Blob`）。该 oapi 端点以 HTTP 200 + 非零 `errcode` 表示失败，因此**显式检查 body.errcode**。60s 超时（覆盖至多 20MB 上传，比 15s 默认宽松）。
2. **`sendRobotMessage(meta, msgKey, msgParam)`** → 复用现有 `v1.0/robot/oToMessages/batchSend`（单聊）/ `v1.0/robot/groupMessages/send`（群聊）端点分支。
   - 图片：`msgKey: "sampleImageMsg"`，`msgParam: {"photoURL": "<media_id>"}`
   - 文件：`msgKey: "sampleFile"`，`msgParam: {"mediaId": "<media_id>", "fileName": "...", "fileType": "<ext>"}`

`sendMedia()` 编排：大小校验（图片 1MB / 文件 20MB）→ 文件类型校验（`sampleFile` 支持的扩展名白名单）→ 会话元数据存在性 → 上传 → 发送。任一步失败返回 `{ ok:false, error }`，由工具抛给 agent。

> `sendPlain` 早于本特性，保留其内联的端点分支副本，不做提取重构以规避回归风险；`sendRobotMessage` 是媒体路径的共享助手。

### 工具（`src/tools/send-media.ts`）

`createSendMediaTool(executor, { mediaSender, channelId, securityConfig, securityContext })`：

- LLM 可见参数仅 `path` / `fileName`（可选，默认取文件名）。
- 执行流：path-guard（`operation: "read"`，越权写审计日志并抛错）→ `test -f` 存在性/常规文件检查 → `base64` 读字节 → 空文件拦截 → 扩展名判定 image/file → `mediaSender.sendMedia(channelId, …)` → 失败抛错。
- `availableToSubagents: false`（子 agent 不直接对渠道发东西）。

### 注册与注入

- `TOOL_REGISTRY` 新增 `send_media`，`enabledBy: (ctx) => ctx.mediaSender != null`——没有 sender 就不构建，prompt 的 `## Tools` 段落也不会 advertise（因为 prompt 从 `currentTools` 生成）。
- 依赖沿 `ToolBuildContext.mediaSender` → `createPipiclawTools` → `RunnerFactoryPaths.mediaSender` → `ChannelRunner` 注入。`mediaSender` **不进** runner 缓存 key（它是稳定的进程级 transport 句柄）。
- **DingTalk**（`bootstrap.ts` 的 `getRunner`）：注入 `mediaSender: bot`。`bot` 与 `getRunner` 同处 `createRuntimeContext` 作用域，且 `getRunner` 仅在收到消息时调用（此时 `bot` 已初始化），闭包引用合法。
- **TUI**（`app.ts`）：注入 `createTerminalMediaSender(io)`——文件已在本地磁盘，"发送"即打印一条 `📎 [send_media] …` 通知，保持双 transport 对称而非在 TUI 下静默缺席。

---

## 数据流

```
agent → send_media(path)
  └─ path-guard(read) ─ test -f ─ base64(executor) ─→ OutboundMedia{data,fileName,kind}
       └─ MediaSender.sendMedia(channelId, media)
            ├─ DingTalk: uploadMedia → media_id → sampleImageMsg / sampleFile
            └─ TUI:      打印通知
```

## 安全

- 每次发送前走与文件工具**同一个 path-guard**：只允许 workspace 内文件，越权路径写安全审计日志并拒绝。这是"把任意本地文件发出去"的边界。
- channelId 构建期绑定，agent 无法把文件发到当前渠道以外。
- 大小/类型上限在上传前拦截，避免把明知会被 API 拒绝的请求发出去。

## 运行时未验证的假设 ⚠️

`oapi.dingtalk.com/media/upload` 复用了 `/v1.0/oauth2/accessToken` 铸造的 token 作为 `access_token`。钉钉已统一企业内部应用跨两个 host 的 token，理应通用；`uploadMedia` 的显式 `errcode` 检查会在失败时打日志。若真机上传返回鉴权类 `errcode`，改动仅限 `uploadMedia` 一处：单独用 `oapi.dingtalk.com/gettoken` 取 token。

## 后续

- 可选跨渠道发送（`channel` 参数 + 白名单）。
- 入站附件接收/解析。
- 音频 / 视频消息类型。
- 大文件流式上传（当前经 `base64` stdout 读入内存，受 20MB 上限约束，尚可接受）。

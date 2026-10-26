# Web API

> **适合谁**：想从脚本、其他服务或自己的客户端里使用 Pipiclaw 的开发者和部署者。
> **前置阅读**：[配置指南](./configuration.md)（`channel.json`）、[安全模型](./security.md)。
> **读完你会得到**：如何打开 Web API、如何鉴权、每个端点和字段的取舍、与 OpenAI Responses 规范的映射，以及能直接运行的 Python / JS 示例。

Web API 是 Pipiclaw 的第二个渠道（与钉钉并列）。它的形状是 **OpenAI Responses API**：用官方 `openai` SDK（Python、JS 等）就能连上，一次请求生成一个 Response。支持客户端重放历史、用 `previous_response_id` 接续响应，以及用 `conversation` 维护服务端会话。显式会话是一个频道，绑定工位并使用其记忆、任务和文件；不带会话标识的请求使用独立内存会话。

终端界面（`pipiclaw tui`）也是这个 API 的客户端，用的是同一个本机 socket。

## 打开它

在 `channel.json` 里打开 `webapi` 段（旧版本的 `channel.json` 结构见[迁移说明](./channel-migration.md)）：

```json
{
  "dingtalk": { "enabled": false },
  "webapi": {
    "enabled": true,
    "socket": true
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 关闭时不加载任何 Web API 代码，也不监听 |
| `socket` | `true` | 在 `state/webapi/api.sock` 上监听本机 unix socket，权限 `0600`，目录 `0700`。**走 socket 不需要 key**：能打开这个文件的就是运行 daemon 的系统用户 |
| `tcp` | 不监听 | `"host:port"`（IPv6 写 `"[::1]:8787"`）。TCP 上每个请求都必须带 key |
| `tls` | 无 | `{ "cert": "/abs/cert.pem", "key": "/abs/key.pem" }`。可选。不配置时 TCP 是明文 HTTP（bearer key 明文过网络）：只适合 TLS 由前置反向代理终止、或可信内网 |
| `keys` | `[]` | `[{ "name", "sha256", "desks" }]`，用命令管理，见下 |

至少要开一个监听（`socket` 或 `tcp`），否则拒绝启动。所有启动问题都会逐项列出并以非 0 退出，不会带着半截配置运行。

### key

```bash
pipiclaw webapi key add ci --desk default --desk lab   # 生成 key，只显示一次，只保存它的 SHA-256
pipiclaw webapi key list
pipiclaw webapi key remove ci
```

- key 形如 `pk_…`（256 位随机），请求头 `Authorization: Bearer pk_…`。
- `desks` 限定这把 key 能使用哪些工位：新会话默认用第一个；`/desk bind` 到不在列表里的工位会被拒绝（`desk_not_allowed`）。
- 一把 key 创建的会话和 Response，别的 key 看不到（返回 404）；本机 socket 视为 `local`，能看到全部；因此 TCP key 不能取名 `local`。
- 改动在 daemon **下次启动**时生效。

## 连接

SDK 的 `baseURL` 设为 `http://127.0.0.1:8787/v1`（TCP），模型名固定写 `"pipiclaw"`。底层模型用 `/model` 命令切换，不是请求参数。

### Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="pk_…")

# 1. 一次请求，一个答案
response = client.responses.create(model="pipiclaw", input="你好")
print(response.status, response.output_text)

# 2. 会话保留历史；工具调用以 mcp_call item 出现
conversation = client.conversations.create()
response = client.responses.create(model="pipiclaw", conversation=conversation.id, input="列出当前目录")
for item in response.output:
    print(item.type, getattr(item, "name", ""), getattr(item, "status", ""))

# 3. 流式事件
for event in client.responses.create(model="pipiclaw", conversation=conversation.id, input="再说一遍", stream=True):
    print(event.sequence_number, event.type)

# 4. 长任务用 background + stream；连接断了可以从最后看到的事件之后续流
stream = client.responses.create(
    model="pipiclaw", conversation=conversation.id, input="继续", background=True, stream=True
)
seen = response_id = None
for event in stream:
    seen = event.sequence_number
    if event.type == "response.created":
        response_id = event.response.id
    if seen >= 3:
        break  # 连接断开，工作继续
for event in client.responses.retrieve(response_id, stream=True, starting_after=seen):
    print(event.type)
print(client.responses.retrieve(response_id).status)

# 5. 会话里的内容，从旧到新
for item in client.conversations.items.list(conversation.id, order="asc", limit=5):
    print(item.type, getattr(item, "role", ""))
```

WebSocket 与 steering（回合进行中改变方向）：

```python
with client.responses.connect() as connection:
    connection.response.create(model="pipiclaw", input="开始一个长任务")
    running = None
    for event in connection:
        if event.type == "response.created" and running is None:
            running = event.response.id
            connection.send({"type": "response.steer", "previous_response_id": running, "input": "改成只回答一句话"})
        if event.type == "response.completed":
            print(event.response.output_text)
            break
```

被 steer 的 Response 以 `response.incomplete`（`incomplete_details.reason: "steered"`）结束，后续事件属于新的 Response，它的 `previous_response_id` 指向原来的那个。

### 浏览器前端（TCP）

浏览器可以直接通过 HTTP 调用 TCP 入口，包括 `stream: true` 的 SSE 流。服务端允许任意来源（`Access-Control-Allow-Origin: *`），支持无需 key 的 `OPTIONS` 预检，并允许预检请求中声明的请求头，包括 `Authorization`、`Content-Type` 和 SDK 自带的请求头。实际 API 请求仍必须携带 bearer key。

```js
const response = await fetch("http://127.0.0.1:8787/v1/responses", {
  method: "POST",
  credentials: "omit",
  headers: {
    Authorization: "Bearer pk_…",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ model: "pipiclaw", input: "你好" }),
});
const result = await response.json();
```

鉴权使用显式 bearer key，不使用 Cookie；前端不要设置 `credentials: "include"`。成功、错误及 SSE 响应都带 CORS 头，前端也能读取限流响应的 `Retry-After`。预检机制见 [Fetch 标准](https://fetch.spec.whatwg.org/#http-cors-protocol)。

### JavaScript（走本机 socket，不需要 key）

```js
import { connect } from "node:net";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import { Agent, fetch } from "undici";

const socketPath = `${process.env.HOME}/.pipiclaw/state/webapi/api.sock`;
const client = new OpenAI({
  apiKey: "local", // socket 上不检查，SDK 要求有一个值
  baseURL: "http://localhost/v1",
  fetch, // 必须用 npm 的 undici fetch：Node 内置的 fetch 不接受它的 dispatcher
  fetchOptions: { dispatcher: new Agent({ connect: { socketPath } }) },
});

const response = await client.responses.create({ model: "pipiclaw", input: "你好" });
console.log(response.status, response.output_text);

const ws = new ResponsesWS(client, { createConnection: () => connect(socketPath) });
ws.on("event", (event) => console.log(event.type));
ws.on("response.completed", () => ws.close());
ws.send({ type: "response.create", model: "pipiclaw", input: "你好" });
```

> `Node 的内置 fetch` 与 npm 的 `undici` 是两份实现，把后者的 `Agent` 交给前者会报 `invalid onRequestStart method`。

## 端点

| 端点 | 支持范围 |
|---|---|
| `POST /v1/responses` | 同步、`stream: true`、`background: true`、`background` + `stream` |
| `GET /v1/responses/{id}` | 读取；`stream=true&starting_after=N` 续流，只对以 `background: true, stream: true` 创建、且结束后 5 分钟内的 Response 有效 |
| `POST /v1/responses/{id}/cancel` | 只能取消 `background: true` 的 Response；重复调用是幂等的 |
| `GET /v1/responses/{id}/input_items` | `after`、`limit`（1–100）、`order` |
| `GET /v1/responses`（WebSocket 升级） | `response.create`、`response.steer`，支持 `stream_id` |
| `POST /v1/conversations`、`GET/POST /v1/conversations/{id}` | 创建（仅 `metadata`）、读取、改 `metadata` |
| `GET /v1/conversations/{id}/items` | `after`、`limit`、`order` |
| `GET /v1/models`、`GET /v1/models/{id}` | 只有 `pipiclaw` |

其他路径和方法（`DELETE`、会话 item 的增删改、`/files` 等）返回 404。

## 上下文管理

每个会话选择一种主要方式，客户端不需要 Pipiclaw 专用参数：

| 方式 | 本轮请求 | 行为 |
|---|---|---|
| 客户端管理历史 | 历史消息 + 本轮消息，不传两种标识 | 本次 input 是完整上下文，不自动继承其他请求 |
| 响应链 | previous_response_id + 本轮输入 | 接续指定已保存响应，支持从旧响应分支 |
| 服务端会话 | conversation + 本轮输入 | 服务端维护历史，同会话请求排队 |

```python
# 通用客户端：历史由客户端保存，角色无需过滤。
response = client.responses.create(
    model="pipiclaw", store=False, instructions="请用中文回答。",
    input=[
        {"role": "user", "content": "我正在修改登录模块。"},
        {"role": "assistant", "content": "需要排查哪个问题？"},
        {"role": "user", "content": "继续排查重定向。"},
    ],
)

# 响应链：保存不等于自动接续，第二轮显式引用第一轮。
first = client.responses.create(model="pipiclaw", input="检查登录模块。")
second = client.responses.create(model="pipiclaw", previous_response_id=first.id, input="接着检查重定向。")

# 服务端会话：只提交本轮输入，保存并复用 conversation.id。
conversation = client.conversations.create()
response = client.responses.create(model="pipiclaw", conversation=conversation.id, input="检查登录模块。")
```

`store` 默认 true，控制响应资源的保存、检索和后续引用；不负责自动关联请求。独立请求的 Response.conversation 为 null。`store=False` 的独立请求不保存聊天会话或响应快照，不自动提炼回放历史，结束后 retrieve/接链返回 404；它仍会执行明确要求的工具操作，审计和用量独立记录。

显式 conversation 中只含 user 消息的 input（字符串或 message 数组都一样）是一个普通频道回合：带工位上下文和首轮记忆，识别斜杠命令，附件保存到工位，`instructions` 只叠加在本次生成上；含 assistant/system/developer 的 input 才作为上下文导入。显式 conversation 即使使用 store:false 也会保存会话 items，响应资源仍不可检索。background:true 要求 store:true。instructions 仅作用于当前生成及工具迭代，接链时不会继承，下一轮需要时再次传入。不要同时发送两种会话标识；显式会话中重复发送完整历史会将它们再次追加。

新的独立请求使用 key 的第一个授权工位（本机 socket 使用 default）；响应链接续原响应的工位并重新检查授权，保留文件、命令、搜索等工具及守卫；持久任务、事件、委派、后台 shell 和 WebSocket steering 需要显式 conversation。普通前台工具的文件修改不因 store:false 而回滚。无会话标识的字符串按模型输入处理，原生斜杠命令使用显式会话；TUI 已处理这一点。

## 请求字段

Pipiclaw 只接受它真能做到的参数；会改变行为的参数**按名字拒绝**，不会悄悄忽略。

| 字段 | 处理 |
|---|---|
| `model` | 必须是 `"pipiclaw"` |
| `input` | 字符串，或 user/assistant/system/developer 的 message 数组；用户支持 input_text/input_image/input_file，其余角色支持文本，assistant 可回放 output_text 和 phase |
| `conversation` | 会话 id 或 `{ "id" }` |
| `previous_response_id` | 不能和 `conversation` 同用；指向调用方可访问、已保存并结束的 Response，支持分支 |
| 都没传 | 以本次 input 独立生成，不创建持久会话；Response.conversation 为 null |
| `stream`、`background`、`stream_options` | 支持；WebSocket 上不能出现 |
| `metadata`、`store` | 支持；store 默认 true，false 不保存可检索的响应资源；显式会话仍保存 items |
| `user`、`safety_identifier`、`prompt_cache_key`、`service_tier` | 接受并忽略（只是提示） |
| `instructions` | 支持字符串，仅作用于本次生成；不修改工位 AGENTS.md |
| `tools`、`tool_choice`、`parallel_tool_calls`、`max_tool_calls`、`prompt`、`text`、`reasoning`、`temperature`、`top_p`、`top_logprobs`、`max_output_tokens`、`truncation`、`context_management`、`include`、`moderation`、`access_programs`、`prompt_cache_options`、`prompt_cache_retention` | 不传或 `null` 可以，其他值拒绝：由 Pipiclaw 的 agent 配置决定 |
| 其他字段 | 拒绝（`unknown_parameter`） |

`input` 可包含历史 assistant 消息、system/developer 指令，以及 Pipiclaw 自己输出的 reasoning 摘要和 mcp_call。历史工具记录作为观察信息提供给模型，不会执行。客户端工具闭环（function_call_output）、item_reference 和加密 reasoning 等仍未实现，明确返回 400。

**图片和文件**只接受请求里带的数据：`input_image` 的 `image_url` 必须是 `data:…;base64,…`（≤10 MiB，最多 10 张），`input_file` 用 `file_data` 加 `filename`（≤10 MiB）。`file_id` 和 http(s) 地址会被拒绝——前者需要 Files API，后者会让服务端替调用方去抓取任意地址。base64 在解码前先按长度估算，过大直接拒绝。文本里图片和文件的位置会被写成 `[图片N]`、`[文件N]`，和钉钉一致。作为上下文导入的 input（独立请求、响应链、含其他角色的会话 input）里，文件以 UTF-8 文本内联；PDF、Office 文档等二进制文件返回 400（`param` 指向该 `file_data`），请放在只含 user 消息的 conversation 里发送，文件会保存到工位供工具读取。

## 回合怎么变成 Response

- **忙碌时**同一会话的新请求状态是 `queued`，按到达顺序作为**独立回合**执行，开始时变为 `in_progress`；流式请求依次收到 `response.created`（queued）、`response.queued`、`response.in_progress`。队列满返回 429。
- **斜杠命令**（`/status`、`/tasks`、`/desk …`、`/new`、`/model`…）与钉钉的规则相同，回复是该 Response 的一条 `final_answer` 消息。文本形式的 `/stop`、`/steer`、`/followup` 返回 400：改用取消、`response.steer`，或直接再发一条消息。
- **工具调用**是 `mcp_call` item（`server_label: "pipiclaw"`，`arguments` 为 JSON 字符串，`output` 截断到 4000 字符）。选 `mcp_call` 是因为 `function_call` 表示"客户端执行"，语义不对；代价是这些工具并不是真的 MCP 工具。模型的推理是 `reasoning` item，回合中的说明是 `phase: "commentary"` 的消息，最终答案是 `phase: "final_answer"` 的消息，`output_text` 是所有最终答案的拼接。Pipiclaw 的扩展字段：`mcp_call` 失败时若有面向用户的措辞（守卫拒绝等）带 `pipiclaw_failure`——没有它的失败是模型自己会修正的观察，不必展示；运行时写的说明消息带 `pipiclaw_level`（`error` / `warning` / `notice`）。
- **message 在完整后一次给出**（先 `output_text.delta` 再 `done`），不逐 token 流式。
- **usage**：`input_tokens` 含缓存读写，`cached_tokens` 是缓存命中；`reasoning_tokens` 恒为 0。
- **没有请求方的 Response**：任务汇报、定时事件、委派或后台作业完成的唤醒，会在所属会话里出现一个 `input_items` 为空的 Response。后台唤醒回合若整个回合都静默（`[SILENT]`）则不产生 Response。客户端用 `GET /v1/conversations/{id}/items?order=asc&after=<最后看到的 item id>` 拉取。会话 items 对游标客户端是追加序列：存在排队或进行中的 Response 时，排在它之后的 Response 的 items 要等它结束才出现，所以已读到的游标之前不会再插入新 item。
- **取消**：`background: true` 的 Response 用 `POST …/cancel`（等同于 `/stop`）；同步或流式请求，**断开连接就是取消**。对 background + stream 的 Response 取消时，流在已发出的事件之后直接结束，不发终态事件——结果看 cancel 的返回值或再 `GET` 一次。WebSocket 连接关闭时，它上面排队和进行中的 Response 都被取消。
- **steering 只在 WebSocket 上**（规范如此）。目标必须是本连接上创建、正在 `in_progress` 的 Response，失败时回 `response.steer.failed`，`error.code` 是 `response_not_found`、`response_not_active`、`response_already_completed`、`invalid_input` 或 `too_many_pending_steers`（每个 Response 最多 4 个未生效的 steer）。这是对规范的扩展：官方 OpenAI 对会话绑定的 Response 不支持 steering，Pipiclaw 支持。
- **重启**：进行中的 Response 在重启后标为 `failed`（"服务重启，回合被中断"），**不会自动重跑**，因为它的工具可能已经产生了副作用。

## WebSocket

`GET /v1/responses` 升级为 WebSocket，客户端事件是 `response.create`（字段同 HTTP，但不能带 `stream`、`stream_options`、`background`）和 `response.steer`。

- `stream_id`（1–64 个字母数字、`-`、`_`）把一条连接分成多个通道：同一通道内的 Response 先进先出，不同通道并行；服务端事件带同样的 `stream_id`。
- 每条连接最多 16 个进行中的 Response（多的排队）、32 个已受理未开始的请求且合计不超过 64 MiB（超出返回 `websocket_backlog_full`）、32 条命名通道、60 分钟（到点发 `websocket_connection_limit_reached` 后关闭，客户端重连即可）。
- 错误用规范的包络：`{ "type": "error", "status", "error": { "type", "code", "message", "param" }, "stream_id"? }`。

## 错误

HTTP 错误体是 `{ "error": { "message", "type", "param", "code" } }`，状态码决定官方 SDK 抛出的错误类：

| 状态码 | 场景 |
|---|---|
| 400 | 参数错误（`unknown_parameter`、`unsupported_parameter`、`unsupported_value`、`invalid_value`、`missing_required_parameter` 等），`param` 指向字段 |
| 401 | 缺少或无效的 key（`invalid_api_key`） |
| 403 | `Host` 不对，或工位不在 key 的 `desks` 内 |
| 404 | 资源不存在或不属于这把 key |
| 413 | 请求体超过 30 MiB |
| 429 | 限流或队列满，带 `Retry-After` |
| 500 / 503 | 内部错误 / 正在关机 |

`message` 是英文，并说明下一步该怎么做。

## 安全

- **一把 key 的权限等于宿主机上的 shell 权限**（agent 有 `bash`，受[安全模型](./security.md)的路径和命令守卫约束）。给它的人要和给 shell 的人一样可信。本机 socket 的访问范围等于运行 daemon 的系统用户。
- 默认只监听本机 socket；TCP 要显式打开。非 loopback 且不配 `tls` 时是明文 HTTP，key 会明文过网络——只在 TLS 由前置反向代理终止、或可信内网中这样用。
- 允许带 `Origin` 头的请求（包括 WebSocket 升级）；HTTP 支持任意来源的 CORS，允许浏览器前端直接调用。loopback TCP 仍校验 `Host`，防 DNS rebinding。
- `OPTIONS` 预检无需 key，不访问业务数据；实际请求在读请求体**之前**鉴权，失败直接 401。key 只存 SHA-256，比较是常量时间的。
- 限制：请求体 30 MiB、单个请求 30 秒内接收完、最多 64 个连接、TCP 上每个来源 IP 每分钟 300 次。
- 审计：每个请求（主体、方法、路径、会话、状态码）和每次鉴权失败（来源、原因）都写进安全审计日志；日志里没有 key、请求体或输出。

## 已知限制

- 不逐 token 流式；不支持客户端工具、结构化输出、Files API、加密 reasoning 回放。
- 显式会话及 store:true 的响应一直保留，没有保留期和清理；独立 store:false 请求仅在运行时内存中保留到清理窗口结束。
- 一个会话同一时刻只有一个回合在跑；同一个会话的并发请求排队，不并行。
- 重启不接续进行中的回合，也不重放已断开的非 background 流。

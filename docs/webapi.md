# Web API

> **适合谁**：想从脚本、其他服务或自己的客户端里使用 Pipiclaw 的开发者和部署者。
> **前置阅读**：[配置指南](./configuration.md)（`channel.json`）、[安全模型](./security.md)。
> **读完你会得到**：如何打开 Web API、如何鉴权、每个端点和字段的取舍、与 OpenAI Responses 规范的映射，以及能直接运行的 Python / JS 示例。

Web API 是 Pipiclaw 的第二个渠道（与钉钉并列）。它的形状是 **OpenAI Responses API**：用官方 `openai` SDK（Python、JS 等）就能连上，一次请求是一条消息，一个 Response 是这条消息的结果；会话（conversation）就是一个频道，和钉钉里的一个私聊或群一样，绑定在某个工位上，共享该工位的记忆、任务和文件。

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
- 一把 key 创建的会话和 Response，别的 key 看不到（返回 404）；本机 socket 视为 `local`，能看到全部。
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

## 请求字段

Pipiclaw 只接受它真能做到的参数；会改变行为的参数**按名字拒绝**，不会悄悄忽略。

| 字段 | 处理 |
|---|---|
| `model` | 必须是 `"pipiclaw"` |
| `input` | 字符串，或 `role: "user"` 的 `message` 数组，`content` 为字符串或 `input_text` / `input_image` / `input_file` 数组 |
| `conversation` | 会话 id 或 `{ "id" }` |
| `previous_response_id` | 不能和 `conversation` 同用；只能指向所属会话**最新**的 Response（不支持分支） |
| 都没传 | 隐式新建会话，Response 的 `conversation` 字段带上它的 id |
| `stream`、`background`、`stream_options` | 支持；WebSocket 上不能出现 |
| `metadata`、`store: true` | 支持；`store: false` 拒绝（会话由服务端保存） |
| `user`、`safety_identifier`、`prompt_cache_key`、`service_tier` | 接受并忽略（只是提示） |
| `instructions` | 拒绝：持久指令写进工位的 `AGENTS.md` |
| `tools`、`tool_choice`、`parallel_tool_calls`、`max_tool_calls`、`prompt`、`text`、`reasoning`、`temperature`、`top_p`、`top_logprobs`、`max_output_tokens`、`truncation`、`context_management`、`include`、`moderation`、`access_programs`、`prompt_cache_options`、`prompt_cache_retention` | 不传或 `null` 可以，其他值拒绝：由 Pipiclaw 的 agent 配置决定 |
| 其他字段 | 拒绝（`unknown_parameter`） |

`input` 里的 `assistant` / `system` / `developer` 角色、`function_call_output`、`item_reference` 等一律拒绝：历史由服务端持有，客户端工具不支持。

**图片和文件**只接受请求里带的数据：`input_image` 的 `image_url` 必须是 `data:…;base64,…`（≤5 MB，最多 9 张），`input_file` 用 `file_data` 加 `filename`（≤5 MB）。`file_id` 和 http(s) 地址会被拒绝——前者需要 Files API，后者会让服务端替调用方去抓取任意地址。base64 在解码前先按长度估算，过大直接拒绝。文本里图片和文件的位置会被写成 `[图片N]`、`[文件N]`，和钉钉一致。

## 回合怎么变成 Response

- **忙碌时**同一会话的新请求状态是 `queued`，按到达顺序作为**独立回合**执行，开始时变为 `in_progress`；流式请求依次收到 `response.created`（queued）、`response.queued`、`response.in_progress`。队列满返回 429。
- **斜杠命令**（`/status`、`/tasks`、`/desk …`、`/new`、`/model`…）与钉钉的规则相同，回复是该 Response 的一条 `final_answer` 消息。文本形式的 `/stop`、`/steer`、`/followup` 返回 400：改用取消、`response.steer`，或直接再发一条消息。
- **工具调用**是 `mcp_call` item（`server_label: "pipiclaw"`，`arguments` 为 JSON 字符串，`output` 截断到 4000 字符）。选 `mcp_call` 是因为 `function_call` 表示"客户端执行"，语义不对；代价是这些工具并不是真的 MCP 工具。模型的推理是 `reasoning` item，回合中的说明是 `phase: "commentary"` 的消息，最终答案是 `phase: "final_answer"` 的消息，`output_text` 是所有最终答案的拼接。
- **message 在完整后一次给出**（先 `output_text.delta` 再 `done`），不逐 token 流式。
- **usage**：`input_tokens` 含缓存读写，`cached_tokens` 是缓存命中；`reasoning_tokens` 恒为 0。
- **没有请求方的 Response**：任务汇报、定时事件、委派或后台作业完成的唤醒，会在所属会话里出现一个 `input_items` 为空的 Response。后台唤醒回合若整个回合都静默（`[SILENT]`）则不产生 Response。客户端用 `GET /v1/conversations/{id}/items?order=asc&after=<最后看到的 item id>` 拉取。
- **取消**：`background: true` 的 Response 用 `POST …/cancel`（等同于 `/stop`）；同步或流式请求，**断开连接就是取消**。对 background + stream 的 Response 取消时，流在已发出的事件之后直接结束，不发终态事件——结果看 cancel 的返回值或再 `GET` 一次。WebSocket 连接关闭时，它上面排队和进行中的 Response 都被取消。
- **steering 只在 WebSocket 上**（规范如此）。目标必须是本连接上创建、正在 `in_progress` 的 Response，失败时回 `response.steer.failed`，`error.code` 是 `response_not_found`、`response_not_active`、`response_already_completed`、`invalid_input` 或 `too_many_pending_steers`（每个 Response 最多 4 个未生效的 steer）。这是对规范的扩展：官方 OpenAI 对会话绑定的 Response 不支持 steering，Pipiclaw 支持。
- **重启**：进行中的 Response 在重启后标为 `failed`（"服务重启，回合被中断"），**不会自动重跑**，因为它的工具可能已经产生了副作用。

## WebSocket

`GET /v1/responses` 升级为 WebSocket，客户端事件是 `response.create`（字段同 HTTP，但不能带 `stream`、`stream_options`、`background`）和 `response.steer`。

- `stream_id`（1–64 个字母数字、`-`、`_`）把一条连接分成多个通道：同一通道内的 Response 先进先出，不同通道并行；服务端事件带同样的 `stream_id`。
- 每条连接最多 16 个进行中的 Response（多的排队）、32 条命名通道、60 分钟（到点发 `websocket_connection_limit_reached` 后关闭，客户端重连即可）。
- 错误用规范的包络：`{ "type": "error", "status", "error": { "type", "code", "message", "param" }, "stream_id"? }`。

## 错误

HTTP 错误体是 `{ "error": { "message", "type", "param", "code" } }`，状态码决定官方 SDK 抛出的错误类：

| 状态码 | 场景 |
|---|---|
| 400 | 参数错误（`unknown_parameter`、`unsupported_parameter`、`unsupported_value`、`invalid_value`、`missing_required_parameter` 等），`param` 指向字段 |
| 401 | 缺少或无效的 key（`invalid_api_key`） |
| 403 | 带了 `Origin` 头、`Host` 不对，或工位不在 key 的 `desks` 内 |
| 404 | 资源不存在或不属于这把 key |
| 413 | 请求体超过 8 MB |
| 429 | 限流或队列满，带 `Retry-After` |
| 500 / 503 | 内部错误 / 正在关机 |

`message` 是英文，并说明下一步该怎么做。

## 安全

- **一把 key 的权限等于宿主机上的 shell 权限**（agent 有 `bash`，受[安全模型](./security.md)的路径和命令守卫约束）。给它的人要和给 shell 的人一样可信。本机 socket 的访问范围等于运行 daemon 的系统用户。
- 默认只监听本机 socket；TCP 要显式打开。非 loopback 且不配 `tls` 时是明文 HTTP，key 会明文过网络——只在 TLS 由前置反向代理终止、或可信内网中这样用。
- 浏览器的跨站请求被挡掉：带 `Origin` 头的请求（包括 WebSocket 升级）一律 403，不提供 CORS；loopback TCP 还校验 `Host`，防 DNS rebinding。
- 鉴权在读请求体**之前**完成，失败直接 401。key 只存 SHA-256，比较是常量时间的。
- 限制：请求体 8 MB、单个请求 30 秒内接收完、最多 64 个连接、TCP 上每个来源 IP 每分钟 300 次。
- 审计：每个请求（主体、方法、路径、会话、状态码）和每次鉴权失败（来源、原因）都写进安全审计日志；日志里没有 key、请求体或输出。

## 已知限制

- 不逐 token 流式；不支持客户端工具、结构化输出、分支（`previous_response_id` 指向旧 Response）、Files API、`instructions`。
- 会话和 Response 一直保留，没有保留期和清理。
- 一个会话同一时刻只有一个回合在跑；同一个会话的并发请求排队，不并行。
- 重启不接续进行中的回合，也不重放已断开的非 background 流。

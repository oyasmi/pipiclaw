# Spec 061 验收记录

日期：2026-10-24。分支 `feat/channel-plane`，基线 `master` 的 `d6d04fb`。**R4（在真实 `~/.pipiclaw` 上线）未执行**，需要用户明确批准并在场。

## 1. 门禁

| 命令 | 结果 |
|---|---|
| `npm run check`（lint + typecheck + arch + deadcode + test） | 通过；单测 971 个 / 144 个文件 |
| `npm run test:e2e` | 通过；70 个 / 26 个文件（整套并行跑时 `memory.test.ts` 的 M8 出现过一次失败，单独重跑和换用 master 构建都通过，未复现，见实施记录） |
| `npm run eval:typecheck` | 通过 |
| `npm run build && node dist/main.js --version` | 通过，输出 `0.9.5-beta.1`（版本号未改动，由用户决定） |
| `npm run test:evals`（离线） | 69 / 69 通过 |

## 2. 用例数

| | 基线（master） | 阶段 A | 阶段 B | 阶段 C（最终） |
|---|---|---|---|---|
| 单测 | 918（134 个文件） | 948 | 964 | 971（144 个文件） |
| deterministic e2e | 63（25 个文件） | 63 | 69 | 70（26 个文件） |

增减的理由逐阶段写在设计文档 §18：A 的增加来自两个新契约（`TurnEvent`、`Ingress`）的矩阵并删除了被取代的投递 / 路由用例；B 的 +16 / +6 全部属于 Web API；C 的 +7 / +3 属于终端客户端，−2 是删除旧 `tui-command` e2e。已有功能没有净增用例。

## 3. 不变量与证据

- **INV-1**（命令、绑定、忙碌、排队只在 Ingress 决定）：渠道代码里没有命令名分支。
  `rg -n "parseBuiltInCommand|slashCommandName|startsWith\(\"/" src/dingtalk src/webapi` 无结果；渠道只通过 `policy.textControlCommands` 声明文本形式的 `/stop` 等是不是控制命令，判断在 `src/runtime/ingress.ts`（`!transport.policy.textControlCommands` 分支）。
- **INV-2 / INV-7**（渠道互不 import；关闭的渠道不加载代码、不监听、不写状态）：`npm run arch` 通过（`webapi` 与 `dingtalk` 的允许依赖里互不包含，`tui` 不 import `runtime/`）。运行验证（用 `module.register` 的 `load` 钩子记录加载的模块，`dist/main.js`，临时 home）：
  - 只开钉钉：加载了 15 个 `dist/dingtalk/` / `dingtalk-stream` 模块，`webapi` / `fastify` / `ws` 模块 0 个，`state/` 下没有 `webapi/`。
  - 只开 Web API：加载 23 个 `dist/webapi/` / `fastify` / `ws` 模块，`dingtalk` 模块 0 个，`state/webapi/api.sock` 已创建。
- **INV-3 / INV-4**：`test/channel-id.test.ts`；W5（合成唤醒的 Response `input_items` 为空，不含给模型看的唤醒文本）。
- **INV-5**（每条被接受的消息恰好一个 Response，恰好一个终态并落盘）：e2e W1–W6、T1；`test/webapi-store.test.ts`（快照顺序、崩溃截断的末行、重启时只标一次 `failed`）；W6（SIGKILL 后为 `failed` 且不重跑）。
- **INV-6**（鉴权失败不解析请求体）：`test/webapi-security.test.ts`——语法错误的 JSON 体配缺失 / 错误的 key，得到的是 401 而不是 400。
- **INV-8**（渠道未启用时频道不可达）：任务驱动、事件 watcher、durable dispatch 各有"渠道不可达"断言（`task-driver`、`events`、`durable-dispatch` 测试）；迁移演练里关闭钉钉后，钉钉频道的 dispatch 记录保持 `pending`（§5）。
- **INV-9**（不支持的字段按名字拒绝）：`test/webapi-request.test.ts` 的策略表。
- **INV-10**（每条路径官方 SDK 都能跑通）：e2e 全部用官方 `openai` SDK 作客户端（HTTP、`ResponsesWS`、unix socket 与 TCP 两条路）；Python SDK 的实际运行见 §4。
- **INV-11**（一个 app home 一个运行时）：`test/runtime-context.test.ts` 的锁用例；`test/channel-config.test.ts`；e2e T3（内嵌运行时连续运行两次，第二次不被锁拒绝）；A4 手动验证了另一个进程持有锁时拒绝启动并带 pid 与主机名。
- **钉钉行为不变**：A0 / A3 的对照记录见设计 §18。原有 63 个 e2e 对钉钉投递序列的断言只随频道 id 和夹具做了机械调整，没有放宽，全部通过（夹具继续用真实的 `DingTalkTransport`），已知的细微差异（关机中止的卡片文字、工具计数、thinking 日志）逐条列在 §18 阶段 A 的第 3、6、7 条。

## 4. 官方 SDK 示例（`docs/webapi.md`）

示例都对一个跑着 mock provider 的真实运行时执行过：

- Python（`openai` 的 Python SDK，`websockets` 作 WebSocket 传输）：同步请求、会话与 `mcp_call` item、流式事件（`sequence_number` 从 0 单调递增）、`background` + `stream` 断开后用 `starting_after` 续流并取得 `response.completed`、会话 items 的分页；WebSocket 的 `response.steer` 得到 `response.steer.accepted`，原 Response 以 `response.incomplete` 结束，后继 Response 以 `response.completed` 结束。
- JavaScript（走 unix socket，`undici` 的 fetch 加 `Agent`，`ResponsesWS` 的 `createConnection`）：同步请求与 WebSocket 事件序列。

## 5. 安全默认值

- 只开 socket：`webapi.enabled` 默认 `false`；打开后默认 `socket: true`、不监听 TCP。socket 目录 `0700`、文件 `0600`（`test` 里的 harness 也在这个权限下运行）。
- TCP 非 loopback 必须 TLS：`test/webapi-config.test.ts`（`0.0.0.0` 无 `tls` 被拒绝，`127.0.0.1.evil.com`、`128.x` 不被当成 loopback）。
- Origin 与 Host：`test/webapi-security.test.ts`（带 `Origin` 的请求在两个监听器上都是 403；loopback TCP 上外来的 `Host` 是 403；socket 上不检查 `Host`、不需要 key）。
- 鉴权失败不解析请求体：同上。审计：`webapi-auth` 记录里是来源、原因、方法和路径，没有 key 和请求体（`src/security/types.ts`）。
- 污染的 JSON、超大请求体、错误的媒体类型：同一个测试里分别得到 400、413、415，且都是 API 的错误格式。

## 6. 迁移演练（R2）

目的：证明 `docs/channel-migration.md` 的转换表和校验步骤在**真实的旧格式数据**上有效。步骤与结果：

1. **造旧数据**：用 `master` 的构建（临时 worktree，`tsc` 构建）和它的 deterministic harness 造出一个 home——`dm_staff001`（工位 `e2e`）和 `group_cidTEST/abc==`（工位 `lab`，会话 id 里有 `/` 和 `=`）各聊了一轮；`bash async` 启动了一个后台 job（`state/jobs/e2e/…json`，里面有 `channelId`）；工位 `lab` 里有一个投递到群的任务、一个投递到 `tui` 的任务、一个投递到群的周期事件；一条待投递的 durable-dispatch 记录（旧形状，带 `type`、`conversationType`、`user`）；以及 `lab` 上的一次真实 `pipiclaw tui --print` 对话（产生 `conversations/tui-1/` 和 `state/memory/lab/tui-1.json`）。
2. **转换**：按迁移说明写了一个临时脚本（不进仓库）在这份副本上执行：`channel.json` 分段、`desk-bindings.json` 与 `desk.json` 改键、`tui-1` → `webapi-1` 目录与记忆状态改名、生成 `webapi:conv_…` 会话（`state/webapi/conversations/…`、绑定、`state/tui/conversations.json`）、任务 frontmatter / 事件 / job 记录的 `channelId`、dispatch 记录改写为 wake 形状。
3. **校验**（副本，`dingtalk.enabled` 设为 `false`，模型换成 mock provider，用新版本的 `bootstrapEmbedded` 和 `pipiclaw tui --print`）：
   - `/desk` 列出 `default`（未绑定）、`e2e`（`dingtalk:dm:staff001`）、`lab`（`dingtalk:group:cidTEST/abc==`、终端）。
   - `pipiclaw tui --desk lab --print "继续上次的话题"`：**续上了原来的会话**——发给模型的请求历史里有转换前的"终端你好"。
   - `/tasks` 列出两个任务（群任务显示投递到 `dingtalk:group:…`，终端任务属于当前频道）；`/events` 列出周期事件和新的投递频道。
   - 待投递记录被解析为 `{ source: "wake", producer: "TASK_DRIVER", channelId: "dingtalk:group:…", desk: "lab" }`，在钉钉关闭时保持 `pending`，没有报错；job 的完成记录也生成了对未启用渠道的待投递 wake。
4. **发现**：迁移说明里补上了 `state/memory/<desk>/<conversation>.json`（以 `tui-N` 命名，需要同步改名）；`memory-review.jsonl` 和会话 `context.jsonl` 里的旧频道 id 只是历史文字，不需要改。

没有碰真实的 `~/.pipiclaw`。

## 7. 未完成项

- **R4 上线**：必须由用户批准并在场——完整备份、转换、用新版本启动 daemon、在钉钉里冒烟（私聊和群各一条、`/status`、一次 `/stop`），再用终端连接。
- `fastify` 5.12.5 有一条低危公告（header schema 的 `propertyNames`，5.12.6 修复）；本 API 不用 header schema 做鉴权，按计划在 2026-10-27 之后升级。
- 版本号和发布由用户决定；`CHANGELOG.md` / `CHANGELOG.zh-CN.md` 的 `[Unreleased]` 里已有不兼容变更说明，发布说明待发版时写。

# 并发与容量参考（Scaling and Concurrency Reference）

> **读者**：想知道"这个实例能扛多少人、什么时候该拆"的维护者。
> **前置**：已经在运行 Pipiclaw（[deployment-and-operations.md](./deployment-and-operations.md)）。
> **读完你能**：说出哪里串行、哪里并行、真正的瓶颈是什么，以及何时该拆成多个实例。

Pipiclaw 是单进程 Node.js 应用，定位是个人与小团队助手；这里的目标不是教你横向扩容，而是让你理解它的隔离与并发模型。可调参数见 [configuration.md](./configuration.md)。

## 会话隔离模型（Session Isolation Model）

Pipiclaw 按**会话通道（channel）**隔离状态，每个通道有独立的对话历史、记忆和执行上下文：

| 场景 | 通道 ID | 说明 |
|------|---------|------|
| 私聊 | `dm_{staffId}` | 按发送者隔离 |
| 群聊 | `group_{conversationId}` | 按群隔离 |

你和同事分别私聊同一个实例，各自是独立通道；同一个人在两个群里交互，也是两个通道。通道之间的对话历史、`SESSION.md`、`MEMORY.md` 互不可见。

## 并发模型（Concurrency Model）

**通道之间并行。** 不同通道的消息处理互不阻塞，并行能力来自 async/await 异步模型：LLM 请求和网络 I/O 等待期间不占用 CPU，其他通道正常推进。

**同一通道内串行。** 每个通道由一条运行队列（run queue）保证同一时刻只执行一个任务；记忆写入另有每通道串行队列，与后台维护互不竞态。通道忙碌时，新消息的行为：

| 新消息 | 行为 |
|--------|------|
| 普通消息 | 按 `channel.json` 的 `busyMessageDefault`：默认作为 steer 插入当前任务，配置 `followUp` 则排队 |
| `/steer` / `/followup` / `/stop` | 即时干预 / 排队 / 中止 |
| `/help` `/events` `/tasks` `/status` `/usage` | 由传输层立即响应，不占用运行队列 |
| 会话命令（`/model` `/new` `/compact` `/session`） | 提示空闲后再用 |
| 未知 `/` 命令 | 直接拒绝并提示 `/help`，不发给模型 |

**后台负载也在同一进程里。** 除用户回合外，还有几类受控的后台工作会消耗 LLM API：

- 记忆维护调度器：本地闸门通过后才做 LLM 整理，默认每 tick 最多处理 1 个通道（`memoryMaintenance.maxConcurrentChannels`）；
- 内建 task driver：扫描本身零 token，只对到点的任务入队唤醒，默认每 tick 最多派发 4 个通道，有进展续跑冷却与停滞退避两层节流；
- 后台作业（`bash async`）：每通道最多 5 个并发子进程，不占运行队列。

## 资源占用与已知瓶颈（Footprint and Known Bottlenecks）

**真正的约束是 LLM API，不是硬件。** 一个活跃通道的一轮对话平均产生 2–5 次 LLM 请求（含记忆维护与压缩）。Pipiclaw 没有全局 LLM 限流，多个通道同时活跃时可能触发模型提供方的速率限制。CPU、磁盘 I/O 在个人与小团队规模下都不构成瓶颈；内存上每个通道常驻约几 MB 到几十 MB，随对话长度增长。成本可随时用 `/usage` 查看（见[配置手册](./configuration.md)的成本账本）。

**通道 Runner 不会自动释放。** Runner 对象创建后常驻内存直到进程重启，没有空闲驱逐。累计交互过的通道很多时内存会缓慢上升；定期重启进程即可释放，持久化记忆（`MEMORY.md`、`HISTORY.md` 等）不受影响。

**单 WebSocket 连接是单点。** 所有通道共享一条钉钉连接，断开时全部通道暂停收发直到重连完成。运行时自己接管重连：重连前清理旧 socket，对长时间无响应的连接强制终止后按退避重试，降低复杂网络下僵尸连接叠加的风险。日志里频繁出现 reconnect / forced termination 时优先排查网络或代理层。

**子进程无池化。** 每次 `bash` 调用 spawn 新进程，极端并发下会同时存在多个子进程，通常不构成问题。

## 部署与监控建议（Recommendations）

- 个人与小团队（约 10 人以内）：单实例足够，2C4G 级别机器即可；用 `allowFrom` 控制范围，关注模型提供方 API 配额。
- 使用量上来后：监控 Node.js RSS 与日志中的 rate limit / timeout 报错，必要时定期重启释放不活跃通道。
- 如果同时活跃对话的通道经常超过 10–30 个（取决于 API 速率配额）：按群或团队拆分多个实例，各自绑定不同的钉钉应用、独立管理工作区。

| 监控指标 | 获取方式 | 关注点 |
|----------|---------|--------|
| Node.js RSS | `ps aux` 或进程管理器 | 接近可用内存 80% |
| API 报错 | 进程日志、`state/logs/runtime.jsonl` | rate limit / timeout 频繁出现 |
| LLM 成本 | `/usage`、`state/usage/usage-YYYY-MM.jsonl` | 后台维护与任务驱动的额外消耗 |
| WebSocket 重连 | 日志中的 reconnect / forced termination | 频繁出现时排查网络、代理、防火墙 |
| 磁盘 | `du -sh ~/.pipiclaw/workspace/` | 长期运行后清理旧通道目录 |

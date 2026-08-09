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

`/tasks` 命令虽然不占用运行队列，但同一 task 的命令、agent 工具调用、driver 治理和启动迁移会经过进程内 keyed queue 串行修改，避免 read-modify-write 相互覆盖。这个保证只在单进程内成立：**不要让多个 Pipiclaw 进程共享同一个 workspace**；需要拆实例时必须使用彼此独立的工作区。

**后台负载也在同一进程里。** 除用户回合外，还有几类受控的后台工作会消耗 LLM API：

- 记忆维护调度器：本地闸门通过后才做 LLM 整理，每 tick 最多处理 1 个通道（内置常量；整体可用 `memoryMaintenance.enabled` 关闭）；
- 内建 task driver：扫描本身零 token，只对到点的任务入队唤醒，每 tick 最多派发 4 个通道，有进展续跑冷却与停滞退避两层节流（均为内置常量；整体由 `tools.tasks.enabled` 控制）；
- 后台作业（`bash async`）：每通道最多 5 个并发子进程，不占运行队列。
- 委派 run：内置子智能体超过 120 秒后可跨回合存活，外部智能体从派发开始即独立于主回合；每频道最多 6 个、整台主机最多 20 个运行中 run。

委派 run 完成后通过 durable dispatch 唤醒所属频道。`/stop` 只停止主回合；委派必须用 `/subagents cancel` 单独终止。

### 委派写锁

`mutates: write` 的委派会按 `workingDirectory` 的真实路径获取排他写锁。同一目录以及互为父子的目录视为冲突，第二个写 run 会被立即拒绝并返回持锁 runId，不会排队等待。`mutates: read` 不取锁，也不会被写锁阻塞。

需要并行实现时，先为每个写 run 创建独立 `git worktree`，再分别传入不同的 `workingDirectory`。写锁只避免 Pipiclaw 自己同时派发两个声明写入的角色；外部进程、其他用户或未如实声明的角色仍可能在同一目录写入。

## 资源占用与已知瓶颈（Footprint and Known Bottlenecks）

**通常最先遇到的约束是模型 API 和外部 CLI 配额。** 一个活跃通道的一轮对话可能产生多次模型请求；多个频道、内置子智能体和记忆 sidecar 同时活跃时容易触发 provider rate limit。外部 Claude Code / Codex CLI 使用各自账号和限额，Pipiclaw 的主模型限流不会替它们做统一配额管理。

CPU、磁盘 I/O 在个人与小团队规模下通常不是主瓶颈；内存上每个通道常驻约几 MB 到几十 MB，随对话长度增长。重型外部角色会额外启动完整 coding-agent 进程，其 CPU、内存、子进程和网络占用由目标 CLI 决定。成本可用 `/usage` 查看，但 Codex CLI 不报告成本、`exec` 不报告 token 或成本，报告中的 unknown 不能当成 0。

**通道 Runner 不会自动释放。** Runner 对象创建后常驻内存直到进程重启，没有空闲驱逐。累计交互过的通道很多时内存会缓慢上升；定期重启进程即可释放，持久化记忆（`MEMORY.md`、`HISTORY.md` 等）不受影响。

**单 WebSocket 连接是单点。** 所有通道共享一条钉钉连接，断开时全部通道暂停收发直到重连完成。运行时自己接管重连：重连前清理旧 socket，对长时间无响应的连接强制终止后按退避重试，降低复杂网络下僵尸连接叠加的风险。日志里频繁出现 reconnect / forced termination 时优先排查网络或代理层。

**子进程无池化。** 每次 `bash` 调用和每个外部委派都会启动新进程。频道/主机 run 上限只约束委派，不会把后台 job、外部 CLI 自己派生的子进程和其他系统进程纳入同一个总量预算。

## 部署与监控建议（Recommendations）

- 个人与小团队（约 10 人以内）：单实例足够，2C4G 级别机器即可；用 `allowFrom` 控制范围，关注模型提供方 API 配额。
- 使用量上来后：监控 Node.js RSS 与日志中的 rate limit / timeout 报错，必要时定期重启释放不活跃通道。
- 如果同时活跃对话的通道经常超过 10–30 个（取决于 API 速率配额）：按群或团队拆分多个实例，各自绑定不同的钉钉应用、独立管理工作区。

| 监控指标 | 获取方式 | 关注点 |
|----------|---------|--------|
| Node.js RSS | `ps aux` 或进程管理器 | 接近可用内存 80% |
| API 报错 | 进程日志、`state/logs/runtime.jsonl` | rate limit / timeout 频繁出现 |
| LLM 成本 | `/usage`、`state/usage/usage-YYYY-MM.jsonl` | 后台维护与任务驱动的额外消耗 |
| 委派 run | `/subagents`、`state/subagent-runs/` | 长时间运行、失败、lost、unknown usage、写锁冲突 |
| 外部进程 | 进程管理器、`ps`、角色产物目录 | Claude/Codex 的 CPU、内存、派生进程和 stderr |
| WebSocket 重连 | 日志中的 reconnect / forced termination | 频繁出现时排查网络、代理、防火墙 |
| 磁盘 | `du -sh ~/.pipiclaw/workspace/` | 长期运行后清理旧通道目录 |

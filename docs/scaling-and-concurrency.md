# 并发与容量参考（Scaling and Concurrency Reference）

> **读者**：想知道"这个实例能扛多少人、什么时候该拆"的维护者。
> **前置**：已经在运行 Pipiclaw（[deployment-and-operations.md](./deployment-and-operations.md)）。
> **读完你能**：说出哪里串行、哪里并行、真正的瓶颈是什么，以及何时该拆成多个实例。

Pipiclaw 是单进程 Node.js 应用，定位是个人与小团队助手。一个机器人实例不是“一次只能回答一个人”：它可以同时推进多个私聊和群聊中的工作。本页说明它的隔离与并发模型、共享资源边界，以及什么时候应该拆分实例。可调参数见 [configuration.md](./configuration.md)。

## 会话隔离模型（Session Isolation Model）

Pipiclaw 按**会话通道（channel）**隔离状态，每个通道有独立的对话历史、记忆和执行上下文：

| 场景 | 通道 ID | 说明 |
|------|---------|------|
| 私聊 | `dm_{staffId}` | 按发送者隔离 |
| 群聊 | `group_{conversationId}` | 按群隔离 |

你和同事分别私聊同一个实例，各自是独立通道；同一个人在两个群里交互，也是两个通道。同一个群里的所有成员则共享一个群通道，而不是每人建立一条独立会话。通道之间的对话历史、`journal/` 和 channel 级 `memory/`/`MEMORY.md` 互不可见；workspace 根目录的 `MEMORY.md` 是所有通道都可读取的共享知识，不属于私密的 channel 记忆。

## 并发模型（Concurrency Model）

**通道之间并行。** 每个通道有自己的消息队列和 Runner。不同通道不会因为另一个通道正在等待 LLM 或钉钉网络 I/O 而被串行阻塞，因此多个私聊和群聊可以同时推进。它们仍共享同一个 Node.js 进程、模型账号、网络连接和宿主机资源，所以“并行”不代表无限吞吐。

**同一通道内串行。** 每个通道由一条 channel queue 保证同一时刻只执行一个主回合；记忆写入另有每通道串行队列，与后台维护互不竞态。群里多人同时 @机器人时，他们仍在同一条共享会话线上，后到的消息不会创建一个与当前群会话并行的主回合。通道忙碌时，新消息的行为：

| 新消息 | 行为 |
|--------|------|
| 普通消息 | 按 `channel.json` 的 `busyMessageDefault`：默认作为 steer 插入当前任务，配置 `followUp` 则排队 |
| `/steer` / `/followup` / `/stop` | 即时干预 / 排队 / 中止 |
| `/help` `/events` `/tasks` `/status` `/usage` | 由传输层立即响应，不占用运行队列 |
| `/new` | 绕过 busy 检查和旧 channel queue，立即建立新的会话边界；旧回合在后台收尾 |
| 其他会话命令（`/model` `/compact` `/session`） | 提示空闲后再用 |
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

### 跨通道共享项目目录

channel 隔离的是会话状态，不会自动复制或锁住项目 checkout。两个 channel 可以同时指向同一个 project root；此时两个主智能体执行的 `write`、`edit`、`bash` 或 Git 操作可能作用于同一棵目录。上面的委派写锁不覆盖主智能体自己的工具调用，因此不能把 channel 隔离理解成项目文件的事务隔离。

如果多个群或私聊可能同时交办写代码任务，建议按风险从低到高选择：

- 约定同一时刻只有一个 channel 对共享 checkout 做写操作；
- 为并行任务创建独立 Git worktree，并在 `security.json` 的 `projectAccess` 允许后，让各 channel 通过 `/project set <absolute-path>` 选择各自目录；
- 按团队或项目拆分 Pipiclaw 实例，并使用彼此独立的 workspace 和 checkout。

## 资源占用与已知瓶颈（Footprint and Known Bottlenecks）

**通常最先遇到的约束是模型 API 和外部 CLI 配额。** 一个活跃通道的一轮对话可能产生多次模型请求；多个频道、内置子智能体和记忆 sidecar 同时活跃时容易触发 provider rate limit。外部 Claude Code / Codex CLI 使用各自账号和限额，Pipiclaw 的主模型限流不会替它们做统一配额管理。

CPU、磁盘 I/O 在个人与小团队规模下通常不是主瓶颈；内存上每个通道常驻约几 MB 到几十 MB，随对话长度增长。重型外部角色会额外启动完整 coding-agent 进程，其 CPU、内存、子进程和网络占用由目标 CLI 决定。成本可用 `/usage` 查看，但 Codex CLI 不报告成本、`exec` 不报告 token 或成本，报告中的 unknown 不能当成 0。

**通道 Runner 有空闲 LRU 驱逐。** 单个 daemon 的 Runner 缓存目标上限是 50；创建新 channel 的 Runner 并超过上限时，会优先释放最久未使用且当前空闲的 Runner，忙碌 Runner 不会被中途销毁。释放只清理内存中的 session、订阅和维护状态，持久化的会话、`memory/*.md`、`journal/` 等不受影响。若同时忙碌的通道很多，缓存可暂时超过 50；它们空闲后，会在后续创建新 channel Runner 时再次参与回收。

**单 WebSocket 连接是单点。** 所有通道共享一条钉钉连接，断开时全部通道暂停收发直到重连完成。运行时自己接管重连：重连前清理旧 socket，对长时间无响应的连接强制终止后按退避重试，降低复杂网络下僵尸连接叠加的风险。日志里频繁出现 reconnect / forced termination 时优先排查网络或代理层。

**子进程无池化。** 每次 `bash` 调用和每个外部委派都会启动新进程。频道/主机 run 上限只约束委派，不会把后台 job、外部 CLI 自己派生的子进程和其他系统进程纳入同一个总量预算。

## 部署与监控建议（Recommendations）

- 个人与小团队（约 10 人以内）：单实例足够，2C4G 级别机器即可；用 `allowFrom` 控制范围，关注模型提供方 API 配额。
- 使用量上来后：监控 Node.js RSS 与日志中的 rate limit / timeout 报错；Runner 会自动驱逐，但后台进程、长会话和其他缓存仍可能推高内存。
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

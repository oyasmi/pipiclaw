# 部署与运维指南（Deployment and Operations Guide）

> **读者**：准备把 Pipiclaw 作为常驻服务长期运行的维护者。
> **前置**：已完成首次接入（[README](../README.md)）与基本配置（[configuration.md](./configuration.md)）。
> **读完你能**：用 systemd/pm2/supervisor 常驻运行它，并在出问题时知道先看哪份日志。

## 适用范围（Scope）

当前这份文档只覆盖主机环境中的长期运行方式。

## 部署前检查（Pre-Deployment Checklist）

建议在正式部署前确认下面这些事项：

| 检查项 | 建议 |
|--------|------|
| Node.js | `>= 22.19.0` |
| 钉钉应用 | 已开启机器人能力和 Stream Mode |
| AI Card | 建议配置完成，便于观察执行过程 |
| 模型 | 已通过 `/model` 验证可见模型和默认模型，必要时可用唯一片段切换模型 |
| Web 工具 | 如需 `web_search` / `web_fetch`，已检查 `tools.json` 与代理设置 |
| 外部智能体 | 目标 CLI 已安装并登录；从服务账号的 `PATH` 可找到；角色的 sandbox 与 `mutates` 已审查 |
| 灰度范围 | 初期建议先配 `allowFrom` 控制测试人群 |
| 工作目录 | 确认 `~/.pipiclaw/` 所在磁盘可长期持久化 |

## 推荐部署方式（Recommended Deployment Patterns）

Pipiclaw 更像一个长期运行的服务，而不是一次性命令。推荐使用进程管理器托管，而不是手工开一个终端窗口。

常见选择：

- `systemd`：Linux 服务器首选
- `pm2`：跨平台、上手快
- `supervisor`：传统 Linux 进程托管方案，适合已有 Supervisor 体系的环境
- 其他现成的进程托管方案：只要能拉起、重启、收集日志，都可以

Pipiclaw 面向 Linux / macOS 等 POSIX 环境，工具执行层依赖 `sh`/`bash` 语义，不支持 Windows。

## 方式一：使用 systemd（Option 1: systemd）

适合 Linux 服务器。

示例服务文件：

```ini
[Unit]
Description=Pipiclaw
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/env pipiclaw
Restart=always
RestartSec=5
EnvironmentFile=-/home/pipiclaw/.config/pipiclaw/runtime.env
Environment=PIPICLAW_DEBUG=0
WorkingDirectory=/home/pipiclaw
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

把模型凭据和代理变量写进仅服务账号可读的 `runtime.env`，不要把真实 key 直接提交到 unit 文件。外部智能体还依赖服务进程的 `PATH`、HOME 和自身认证文件；在交互 shell 可用不代表 systemd 环境也能找到，部署后应使用相同账号和环境执行一次 `command -v claude` / `command -v codex`。

常用命令：

```bash
sudo systemctl daemon-reload
sudo systemctl enable pipiclaw
sudo systemctl start pipiclaw
sudo systemctl status pipiclaw
journalctl -u pipiclaw -f
```

建议：

- 使用专门的运行账号
- 不要把工作目录放在临时目录
- 如果密钥较多，优先使用 `EnvironmentFile`

## 方式二：使用 pm2（Option 2: pm2）

适合想快速托管进程的场景。

启动示例：

```bash
pm2 start pipiclaw --name pipiclaw
```

如果需要环境变量：

```bash
ANTHROPIC_API_KEY=sk-ant-... pm2 start pipiclaw --name pipiclaw
```

常用命令：

```bash
pm2 status
pm2 logs pipiclaw
pm2 restart pipiclaw
pm2 save
```

## 方式三：使用 supervisor（Option 3: supervisor）

适合已经在用 Supervisor 管理常驻进程的环境。

示例配置：

```ini
[program:pipiclaw]
command=/usr/bin/env pipiclaw
directory=/home/pipiclaw
autostart=true
autorestart=true
startsecs=5
stopasgroup=true
killasgroup=true
environment=ANTHROPIC_API_KEY="sk-ant-...",PIPICLAW_DEBUG="0"
stdout_logfile=/var/log/pipiclaw.stdout.log
stderr_logfile=/var/log/pipiclaw.stderr.log
```

常用命令：

```bash
supervisorctl reread
supervisorctl update
supervisorctl status pipiclaw
supervisorctl restart pipiclaw
supervisorctl tail -f pipiclaw
```

建议：

- `directory` 使用稳定的工作目录
- 日志文件放到统一的日志目录中
- 如果环境变量较多，优先通过外部环境文件或部署系统注入

## 日志与排障入口（Logs and Troubleshooting Entry Points）

### 零 LLM 成本的运行时入口（Zero-Cost Runtime Commands）

排障不必先"问 agent"。下面这些命令由传输层直接读文件渲染，不触发 LLM 回合，忙碌时也可用：

- `/status` —— 执行状态、当前模型、上下文用量、运行时长、版本
- `/usage [7d|month]` —— 本通道与全局的 LLM 成本与 token，按类型和 Top 模型拆分（本地模型成本为 0，但 token 仍然记账）；账本里每条记录还带 `taskId`，任务本身不再记账目
- `/tasks doctor` —— 任务台账与事件一致性的只读体检，每条问题附下一步建议
- `/tasks set <id> <字段> <值>` —— 直接改 wake / next / deadline，不花一个 LLM 回合
- `/subagents` —— 运行中的委派、最近结果和角色可用性摘要
- `/subagents show <runId>` / `output <runId>` —— 实际 argv、工作目录、stderr 与文本产出
- `/subagents cancel <runId|all>` —— 不经过模型，直接终止委派

### 结构化日志与成本账本（Structured Logs and Cost Ledger）

除 console 输出外，守护进程默认把结构化日志写到 `${PIPICLAW_HOME:-~/.pipiclaw}/state/logs/runtime.jsonl`（每行一条 JSON，按大小轮转），把 LLM 成本按月写到 `state/usage/usage-YYYY-MM.jsonl`。适合 `grep` 特定 channel 或 event 做事后排查。日志级别与落盘开关见[配置手册](./configuration.md)的 `logging` 一节。

### 进程日志（Process Logs）

首先看你的进程管理器日志：

- `journalctl -u pipiclaw -f`
- `pm2 logs pipiclaw`

这类日志最适合看：

- 进程是否启动成功
- 钉钉连接是否正常
- 模型调用是否报错
- 事件文件是否被解析失败

关于钉钉 Stream 连接，当前运行时会自己管理重连，并在重连前主动清理旧 socket；如果正常关闭迟迟不完成，还会记录 forced termination 并强制回收连接后再重试。因此如果你在日志里频繁看到 reconnect 或 forced termination，通常更应该优先排查网络层或代理层，而不是把它当作单纯的业务错误。

### 工作区运行文件（Workspace Runtime Files）

Pipiclaw 还会在 app home 下的 `workspace/` 中写入运行数据。默认路径是 `~/.pipiclaw/workspace/`；如果设置了 `PIPICLAW_HOME`，则对应为 `${PIPICLAW_HOME}/workspace/`。

常见文件：

| 文件 | 用途 |
|------|------|
| `<channel>/log.jsonl` | 原始运行日志 |
| `<channel>/context.jsonl` | 会话事件冷存储 |
| `<channel>/subagent-runs.jsonl` | 子代理执行摘要 |
| `<channel>/subagent-artifacts/<runId>/` | 每次委派的完整输出；外部 run 还包含 prompt、system prompt、协议事件和 stderr |
| `<channel>/memory/<name>.md` | 一条记忆一个文件（frontmatter 元数据） |
| `<channel>/memory/.tombstones.jsonl` | 遗忘防复活的 name + 内容哈希，不含原文 |
| `<channel>/MEMORY.md` | 从 `memory/*.md` 生成的索引，勿手改 |
| `<channel>/journal/YYYY-MM-DD.md` | 按天追加的工作记录，只由后台反思 pass 写 |
| `<channel>/memory-review.jsonl` | 反思/工具写回的动作、suggestion 和 skipped 决策审计 |
| `<channel>/.memory-v1/` | v1→v2 迁移时原样搬来的旧文件（`SESSION.md`/`MEMORY.md`/`HISTORY.md` 等），不删除 |
| `<channel>/.migrated-v2` | 迁移完成标记 |

委派的权威运行状态另存于 `${PIPICLAW_HOME:-~/.pipiclaw}/state/subagent-runs/<channelId>/<runId>.json`（目录名与 workspace 一致，把 channelId 里的 `/` 折成 `__`）。频道内的 `subagent-runs.jsonl` 是便于检索的执行摘要，不能替代状态文件做取消或重启恢复。

运行时记忆分层（spec 050）：

- `memory/*.md` + 生成的 `MEMORY.md` 索引是 durable channel memory：稳定事实、决策、偏好、约束。索引在会话首轮（含 `/new`、压缩之后）整份注入，之后靠 `memory_search` 按需补查。
- `journal/YYYY-MM-DD.md` 是按天的工作记录，只由后台反思写；一次性进度、临时计划不会被写成 durable 记忆。
- `log.jsonl`、`log.jsonl.1`、`context.jsonl` 是冷存储，正常 turn 不会预加载，只能通过当前 channel 的 `session_search` 显式检索。
- `memory-review.jsonl` 是诊断与审计文件。
- `/memory status|list|show|journal` 提供当前频道的只读管理面；`/memory forget <name>` 直接删除、不经过模型。sidecar usage 与 review outcome 通过 correlation id 关联，便于按次核算成本与有效写入。

首次使用某个频道时会自动、确定性地把旧版布局迁移到上表结构，不调用模型；原文件整份移到 `.memory-v1/`。回滚：把 `.memory-v1/` 里的文件移回频道目录原位，删除 `memory/`、`journal/`、生成的 `MEMORY.md` 和 `.migrated-v2` 标记，换回旧版本运行。

### 内置记忆维护任务（Memory Maintenance Scheduler）

Pipiclaw 会启动一个内置 memory maintenance scheduler。它不使用 `workspace/events/`，也不会创建用户可见的 event 文件；删除或清空 `workspace/events/` 不会影响记忆维护。

spec 050 把 v1 的三个 job（session refresh / checkpoint / structural maintenance）合并成一个：**反思（reflect）**。它同时产出 journal 新增行和 memory 的增/改/删/touch。内置间隔（常量，不可配）：

| 任务 | 最小间隔 | LLM 调用前的本地 gate |
|------|----------|------------------------|
| Reflect | 20 分钟 | channel dirty、已空闲、增量窗口有实质对话 |

另有两条固定约束：channel 静默满 10 分钟才允许后台 LLM work，每个 tick 只处理 1 个 channel。

如果 gate 不通过，任务会跳过，并且不会调用 LLM。相关 skipped/action/failure 会写到对应 channel 的 `memory-review.jsonl`，便于排查 token 消耗和自动写回行为。

内部状态文件位于：

```text
${PIPICLAW_HOME:-~/.pipiclaw}/state/memory/<channelId>.json
```

这些文件只用于调度，记录 dirty、阈值计数、最近运行时间和失败 backoff。它们不是记忆来源，不需要用户编辑。

维护节奏是内置常量，不再通过 `settings.json` 调节（spec 035）。降低 token 消耗可用的选项只有两个：

```json
{
  "sessionSearch": { "summarizeWithModel": false },
  "memoryMaintenance": { "enabled": false }
}
```

第一项砍掉一次可选的 LLM 调用，影响有限。第二项是关掉整个后台反思——journal 不再自动追加，`MEMORY.md` 不再自动固化，长期使用会明显丢失连续性；仍可用 `memory_save` 当场写入。**优先只关第一项**；确认后台维护是成本大头之后再考虑第二项。旧版的 `memoryRecall.*` 系列设置项已随 spec 050 一起退役（每轮实时召回被取消，D1），设置里仍留着会在启动日志里收到警告。

### 精确提示词排查（Prompt Inspection）

如果要看某次请求最终拼出来的 prompt，可以设置：

```bash
export PIPICLAW_DEBUG=1
```

之后运行时会在对应会话通道目录中写出 `last_prompt.json`。

## 升级流程（Upgrade Procedure）

建议用下面的顺序升级：

1. 备份 app home 目录。默认是 `~/.pipiclaw/`，如果设置了 `PIPICLAW_HOME`，则备份 `${PIPICLAW_HOME}/`
2. 阅读 [CHANGELOG](../CHANGELOG.md) / [中文更新日志](../CHANGELOG.zh-CN.md)
3. 升级 npm 包
4. 重启 Pipiclaw
5. 在钉钉中发送 `/model` 和一条普通消息做冒烟验证；如需切换模型，可使用精确引用或能唯一命中的片段字符串

升级命令：

```bash
npm install -g @oyasmi/pipiclaw@latest
```

如果你固定版本运行，也可以明确写版本号。

## 备份与恢复（Backup and Restore）

最重要的是备份 app home 目录。默认是 `~/.pipiclaw/`；如果设置了 `PIPICLAW_HOME`，则使用对应目录。至少应包含：

- `channel.json`
- `auth.json`
- `models.json`
- `settings.json`
- `tools.json`
- `security.json`
- `workspace/`
- `state/events/history.jsonl`（可选，事件调度审计记录）
- `state/dispatch/`（待处理的 synthetic event / task-driver wake；运行完成后删除，崩溃恢复时会重放 lease 已过期的记录）
- `state/subagent-runs/`（委派 run 的状态、pid、实际 argv、结算与唤醒幂等标记；外部 run 重启对账需要）
- `state/usage/`（可选，LLM 成本账本）与 `state/logs/`（可选，结构化日志）

其中 `workspace/` 最关键，因为它包含：

- 工作区级 `SOUL.md`、`AGENTS.md`、`MEMORY.md`
- 工作区级 `skills/`
- `events/`
- `sub-agents/`
- 每个会话通道目录下的历史、记忆和日志
- 每个会话通道的 `subagent-artifacts/`，其中包含委派完整产出和外部 harness 诊断文件

workspace `skills/` 是 procedural memory。workspace skill 只会由显式的 `write`/`edit` 调用创建或更新（`skill` 工具本身只读），后台记忆管线不会自动写 skill。

为了得到一致快照，应在 daemon 仍运行时先用 `/subagents list running` 检查外部委派，等待需要保留的 run 完成，或显式取消不再需要的 run，然后再停止 daemon 并备份。外部 run 是 detached 进程，单独停止 daemon 不会终止它。同一主机上的 daemon 重启可以按 pid 和产物重新对账；**在途外部 run 不能迁移到另一台主机**，因为持久化 pid 只对原主机有意义。跨主机迁移前必须先把所有 run 结算到终态。

恢复时把文件放回相同的 app home，再启动 Pipiclaw，并依次检查 `/status`、`/model`、`/tasks doctor` 和 `/subagents`。

## 灰度与正式上线建议（Rollout Recommendations）

建议按下面的顺序推进：

1. 自己先在私聊里跑通
2. 配置 AI Card，确认过程展示正常
3. 用 `allowFrom` 限制少量测试账号
4. 观察 1 到 3 天日志和会话效果
5. 再逐步放开使用范围

## 常见运维问题（Common Operational Issues）

### 进程启动后立即退出

通常先检查：

- `channel.json` 是否仍保留 `your-*` 占位值
- 模型凭据是否可用
- 默认模型是否存在

### 机器人能收到消息，但没有正常回复

通常先检查：

- `allowFrom` 是否把测试账号挡住了
- 模型是否真的可用，而不只是配置文件存在
- AI Card 模板是否有效
- 钉钉应用的 Stream Mode 是否正常

### 周期事件没有执行

通常先检查：

- 事件文件是否放在 `workspace/events/`
- 文件名是否为 `.json`
- `schedule` 是否合法（cron 按主机时区解释；确认主机时区正确）
- 进程日志里是否出现事件解析失败
- `${PIPICLAW_HOME:-~/.pipiclaw}/state/events/history.jsonl` 中是否有 `invalid`、`skipped`、`pre_action_blocked` 或 `queue_full` 记录

### 任务没有被自动推进

通常先检查：

- `/tasks` 中该任务的 `status`、`enabled` 与 `wake`：disabled、waiting 无 wake 和归档任务不会被 driver 继续；future wake 属于正常等待。被治理器停止的任务显示为 `status: active` + `enabled: false` + `control.stop.by: "governor"`
- `/tasks doctor` 是否报出坏 frontmatter、超预算、缺失依赖等问题
- 上一轮是否没有留下任何台账变化——driver 会对无变化的任务退避（默认 60 分钟）再重试，重启进程会清空退避、下一次扫描重新接起
- `tools.json` 的 `tools.tasks.enabled`（自主长程任务总开关）是否被关闭

### 智能体角色没有被正常使用

通常先检查：

- 文件是否放在 `workspace/sub-agents/`
- frontmatter 是否缺少 `name` 或 `description`
- 正文是否为空
- `/subagents roles [name]` 是否显示 discovery warning 或 `unavailable`
- 内置角色的 `model` 是否能在 Pipiclaw 模型目录中精确解析
- 外部角色是否错误填写了 `tools`、`cwd`、`maxTurns` 等只适用于内置角色的字段
- 外部角色的目标二进制是否在 daemon 的 `PATH` 上，而不只是你的交互 shell 中可用

### 外部委派一直运行、失败或没有唤醒

按下面顺序检查：

1. `/subagents show <runId>`：确认状态、实际 argv、工作目录、pid、stderr 尾部和失败原因。
2. `/subagents output <runId>`：确认是否已经产生部分文本结果。
3. 查看 `<channel>/subagent-artifacts/<runId>/events.jsonl` 与 `stderr.log`。`claude-code` / `codex-cli` 这类结构化 harness 必须产生可识别的终态事件，只有退出码为 0 但没有终态事件仍会判失败；通用 `exec` 没有事件协议，正常运行时只按退出码判断，因此不能承担 `purpose=verify`。
4. 检查角色的 `maxWallTimeSec`、目标 CLI 登录状态、模型名和 sandbox 参数。
5. daemon 重启后，外部进程仍可能存活；runtime 会探测 pid 并在进程结束后从产物补判。内置 run 无法跨进程恢复，会标为 `lost`。

如果只是当前工作已经不再需要，使用 `/subagents cancel <runId>`。`/stop` 不会终止委派。

## 生产环境建议（Production Recommendations）

- 为 Pipiclaw 单独准备运行账号
- 配置 AI Card，降低观察成本
- 初期使用 `allowFrom` 做灰度
- 定期备份 `~/.pipiclaw/`
- 升级前先看 `CHANGELOG.md` / `CHANGELOG.zh-CN.md`
- 修改 `events/` 和 `sub-agents/` 时保留版本管理记录
- 高权限外部角色尽量使用独立 worktree、最小权限账号和目标 CLI 的 sandbox

## 相关文档（Related Docs）

- 配置项说明：[configuration.md](./configuration.md)
- 事件、任务台账与 `/tasks` 命令：[events-and-tasks.md](./events-and-tasks.md)
- 并发模型与容量边界：[scaling-and-concurrency.md](./scaling-and-concurrency.md)
- 智能体委派、产物与安全边界：[sub-agents.md](./sub-agents.md)

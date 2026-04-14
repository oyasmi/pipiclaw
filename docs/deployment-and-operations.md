# 部署与运维指南（Deployment and Operations Guide）

这份文档面向准备长期运行 Pipiclaw 的使用者和维护者。

如果你还没有完成首次接入，请先看：

- [README](../README.md)
- [configuration.md](./configuration.md)

## 适用范围（Scope）

当前这份文档只覆盖主机环境中的长期运行方式。

## 部署前检查（Pre-Deployment Checklist）

建议在正式部署前确认下面这些事项：

| 检查项 | 建议 |
|--------|------|
| Node.js | `>= 22` |
| 钉钉应用 | 已开启机器人能力和 Stream Mode |
| AI Card | 建议配置完成，便于观察执行过程 |
| 模型 | 已通过 `/model` 验证可见模型和默认模型，必要时可用唯一片段切换模型 |
| Web 工具 | 如需 `web_search` / `web_fetch`，已检查 `tools.json` 与代理设置 |
| 灰度范围 | 初期建议先配 `allowFrom` 控制测试人群 |
| 工作目录 | 确认 `~/.pi/pipiclaw/` 所在磁盘可长期持久化 |

## 推荐部署方式（Recommended Deployment Patterns）

Pipiclaw 更像一个长期运行的服务，而不是一次性命令。推荐使用进程管理器托管，而不是手工开一个终端窗口。

常见选择：

- `systemd`：Linux 服务器首选
- `pm2`：跨平台、上手快
- `supervisor`：传统 Linux 进程托管方案，适合已有 Supervisor 体系的环境
- 其他现成的进程托管方案：只要能拉起、重启、收集日志，都可以

### Windows 补充说明（Windows Notes）

如果你在 Windows 上使用 host 模式运行 Pipiclaw，需要额外注意工具执行环境：

- Pipiclaw 的工具执行层依赖 POSIX shell，不适合直接依赖 `cmd.exe` 语义
- 建议安装 Git Bash，并确保 `bash` 可在 PATH 中找到
- 如果 `bash` 不在 PATH 中，可以通过 `PIPICLAW_SHELL` 指向 `bash.exe`
- 如果你希望执行环境更稳定一致，优先考虑 Docker sandbox

示例：

```powershell
$env:PIPICLAW_SHELL = "C:\Program Files\Git\bin\bash.exe"
pipiclaw
```

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
Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=PIPICLAW_DEBUG=0
WorkingDirectory=/home/pipiclaw
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

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

Pipiclaw 还会在 app home 下的 `workspace/` 中写入运行数据。默认路径是 `~/.pi/pipiclaw/workspace/`；如果设置了 `PIPICLAW_HOME`，则对应为 `${PIPICLAW_HOME}/workspace/`。

常见文件：

| 文件 | 用途 |
|------|------|
| `<channel>/log.jsonl` | 原始运行日志 |
| `<channel>/context.jsonl` | 会话事件冷存储 |
| `<channel>/subagent-runs.jsonl` | 子代理执行摘要 |
| `<channel>/SESSION.md` | 当前工作态 |
| `<channel>/MEMORY.md` | 会话通道级持久记忆 |
| `<channel>/HISTORY.md` | 更早上下文摘要 |

### 精确提示词排查（Prompt Inspection）

如果要看某次请求最终拼出来的 prompt，可以设置：

```bash
export PIPICLAW_DEBUG=1
```

之后运行时会在对应会话通道目录中写出 `last_prompt.json`。

## 升级流程（Upgrade Procedure）

建议用下面的顺序升级：

1. 备份 app home 目录。默认是 `~/.pi/pipiclaw/`，如果设置了 `PIPICLAW_HOME`，则备份 `${PIPICLAW_HOME}/`
2. 阅读 [CHANGELOG](../CHANGELOG.md)
3. 升级 npm 包
4. 重启 Pipiclaw
5. 在钉钉中发送 `/model` 和一条普通消息做冒烟验证；如需切换模型，可使用精确引用或能唯一命中的片段字符串

升级命令：

```bash
npm install -g @oyasmi/pipiclaw@latest
```

如果你固定版本运行，也可以明确写版本号。

## 备份与恢复（Backup and Restore）

最重要的是备份 app home 目录。默认是 `~/.pi/pipiclaw/`；如果设置了 `PIPICLAW_HOME`，则使用对应目录。至少应包含：

- `channel.json`
- `auth.json`
- `models.json`
- `settings.json`
- `tools.json`
- `workspace/`

其中 `workspace/` 最关键，因为它包含：

- 工作区级 `SOUL.md`、`AGENTS.md`、`MEMORY.md`
- `events/`
- `sub-agents/`
- 每个会话通道目录下的历史、记忆和日志

恢复时，通常只需要把这些文件恢复到原路径，再重启 Pipiclaw。

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
- `schedule` 是否合法
- `timezone` 是否正确
- 进程日志里是否出现事件解析失败

### 子代理没有被正常使用

通常先检查：

- 文件是否放在 `workspace/sub-agents/`
- frontmatter 是否缺少 `name` 或 `description`
- `model` 是否写成了不可精确匹配的引用
- 正文是否为空

## 生产环境建议（Production Recommendations）

- 为 Pipiclaw 单独准备运行账号
- 配置 AI Card，降低观察成本
- 初期使用 `allowFrom` 做灰度
- 定期备份 `~/.pi/pipiclaw/`
- 升级前先看 `CHANGELOG.md`
- 修改 `events/` 和 `sub-agents/` 时保留版本管理记录

## 相关文档（Related Docs）

- 配置项说明：[configuration.md](./configuration.md)
- 事件与子代理用法：[events-and-sub-agents.md](./events-and-sub-agents.md)

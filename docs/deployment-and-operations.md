# 部署与运维指南（Deployment and Operations Guide）

> **适合谁**：准备在 Linux 服务器、Mac mini 或开发机上把 Pipiclaw 作为 7×24 小时常驻服务托管、升级、备份与排障的维护者。
> **读完你会得到**：上线前核对清单、`systemd` / `pm2` / `supervisor` 常驻配置模板、渠道与单实例锁规则、零成本排障命令与慢请求定位方法，以及一致性备份恢复流程。

> Pipiclaw 面向 Linux 与 macOS 等 POSIX 环境（工具执行层依赖 `bash` / `sh` 语义），不支持原生 Windows（Windows 用户请使用 WSL2）。首次安装验证请先完成 [快速上手指南](./quickstart.md)。

---

## 1. 上线前检查清单

| 检查项 | 建议标准 |
|---|---|
| **运行环境与账号** | Node.js `>= 22.19.0`；生产服务器建议使用独立的低权限系统账号（如 `pipiclaw`），数据盘持久化保存 `~/.pipiclaw/` |
| **模型真实可用** | 已通过 `pipiclaw auth login` 或 `models.json` 配好模型，并用 `pipiclaw tui` 实测一轮普通问答成功（仅模型列表可见不代表密钥或代理链路畅通） |
| **渠道与灰度范围** | 仅本机/内网调用可保持默认 `webapi` 开启；接入钉钉时已开启 Stream 模式与 AI Card，初期建议配置 `dingtalk.allowFrom` 限制测试人员 `staffId` |
| **外部智能体环境** | 若启用了 `workspace/sub-agents/` 外部角色，须切换到**服务运行账号**实测 `command -v claude` / `codex` / `agent` / `agy` 在 `PATH` 中且已完成登录 |

---

## 2. 常驻进程托管方案

长期使用（尤其是挂载钉钉机器人、定时事件、后台任务与异步外部委派）应通过进程管理器常驻运行 `pipiclaw` 主服务。

### 方式一：`systemd`（Linux 服务器首选）

创建 `/etc/systemd/system/pipiclaw.service`（请用 `command -v pipiclaw` 确认实际二进制路径；敏感 API Key 与 `PIPICLAW_PROXY` 放入权限 `0600` 的 `runtime.env`）：

```ini
[Unit]
Description=Pipiclaw Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pipiclaw
Group=pipiclaw
WorkingDirectory=/home/pipiclaw
Environment=HOME=/home/pipiclaw
Environment=PIPICLAW_HOME=/home/pipiclaw/.pipiclaw
EnvironmentFile=-/home/pipiclaw/.config/pipiclaw/runtime.env
ExecStart=/usr/local/bin/pipiclaw
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

启用并查看实时日志：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pipiclaw
sudo systemctl status pipiclaw
journalctl -u pipiclaw -f
```

### 方式二：`pm2`（跨平台快速托管）

```bash
pm2 start "$(command -v pipiclaw)" --name pipiclaw
pm2 save
pm2 logs pipiclaw
```

### 方式三：`supervisor`

```ini
[program:pipiclaw]
user=pipiclaw
command=/usr/local/bin/pipiclaw
directory=/home/pipiclaw
autostart=true
autorestart=true
startsecs=5
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/pipiclaw.stdout.log
stderr_logfile=/var/log/pipiclaw.stderr.log
```

---

## 3. 渠道组合与单实例锁（`daemon.lock`）

- **单实例互斥锁**：同一个 `PIPICLAW_HOME` 同一时刻只允许运行**一个** daemon 进程（由 `state/daemon.lock` 保证）。重复启动第二个 `pipiclaw` 会明确提示持锁进程的 `pid` 并拒绝启动；进程异常崩溃遗留的陈旧锁会在下次同机启动时自动检测并回收。`pipiclaw tui` 检测到已有 daemon 在线时会自动复用其本机 Socket，不会冲突。
- **按需组合 `channel.json` 的两个渠道**（至少开启一个）：
  - **默认开箱模式（仅 Web API）**：`webapi.enabled: true`（本机 Socket + `127.0.0.1:8787`）、`dingtalk.enabled: false`，无需钉钉凭据即可供 `pipiclaw tui` 和本机 SDK 调用；
  - **钉钉 + 本机终端协同**：同时开启 `dingtalk` 与 `webapi`（若不需要 HTTP 端口可将 `webapi.tcp` 设为 `null`，仅保留 `socket: true` 供 `pipiclaw tui` 免密连接）；
  - **只用钉钉**：将 `webapi.enabled` 设为 `false`，完全不监听任何本地端口或 Socket；
  - **跨机器 API 服务**：设置 `webapi.tcp` 并用 `pipiclaw webapi key add <名称> --desk <工位>` 签发密钥（**新增或吊销密钥后在线热生效，无需重启 daemon**；非回环地址请配置 `tls` 或前置 HTTPS 反向代理）。
- 某渠道暂时关闭时，绑定在该渠道上的定时事件与后台任务汇报会自动挂起暂存，重新开启渠道后自动恢复。

---

## 4. 日志、慢阶段定位与运维排障

### 4.1 零成本运行时自检命令

遇到异常时，先发以下**不调用大模型、忙碌时也立即可用**的斜杠命令缩小范围：

| 排查目标 | 命令 |
|---|---|
| 查看当前模型、备用模型状态、后台任务计数与版本 | `/status` |
| 查看本工位/本频道/全局 Token 与已知费用汇总 | `/usage [7d\|month]` |
| 诊断任务卡顿、状态、执行记录或文件异常 | `/tasks show <id>`、`/tasks log <id>`、`/tasks doctor` |
| 查看在途/失败委派的实际 `argv`、PID 与 `stderr` | `/subagents`、`/subagents show <runId>`、`/subagents output <runId>` |
| 查看定时事件定义与最近触发/跳过原因 | `/events list`、`/events history [name]` |
| 查看记忆条目与后台整理状态 | `/memory status`（记忆机制详见 [记忆管理](./memory.md)） |

### 4.2 结构化运行日志与慢请求定位

- **运行日志**：`${PIPICLAW_HOME:-~/.pipiclaw}/state/logs/runtime.jsonl`（按大小自动轮转），每行均带结构化 `event` 字段，可用 `jq` 精确过滤：
  ```bash
  jq 'select(.event == "subagent.settle.failed" or .level == "error")' ~/.pipiclaw/state/logs/runtime.jsonl
  ```
- **月度成本账本**：`${PIPICLAW_HOME:-~/.pipiclaw}/state/usage/usage-YYYY-MM.jsonl`。
- **定位一轮响应慢在哪里**：临时设置环境变量 `PIPICLAW_LOG_LEVEL=debug` 重启复现后，按同一 `request` / `toolCallId` 观察三段耗时（排查完毕请恢复默认 `info` 级别）：
  - `agent.provider.started` → `agent.provider.output`：等待大模型首字响应的网络与推理耗时；
  - `agent.tool.preparing` → `agent.tool.execute_started`：工具参数准备与同批次调度等待；
  - `agent.tool.execute_started` → `agent.tool.execute_finished`：工具真实执行耗时（含 `elapsedMs`）。
- **检查最终组装 Prompt**：设置 `PIPICLAW_DEBUG=1` 后，运行时会在对应频道会话区（`workspace/desk-<name>/conversations/<kind>-<n>/`）写出最近一轮的 `last_prompt.json`。

---

## 5. 版本升级、一致性备份与恢复

### 标准升级步骤

1. 阅读 [中文更新日志](../CHANGELOG.zh-CN.md)（若从早期旧版本跨代升级，检查 [历史数据迁移说明](./migrations/README.md)）；
2. 用 `/subagents list running` 确认无关键在途外部委派（或等待其完成），停止 daemon 并备份整个 `~/.pipiclaw/`；
3. 升级包并重启服务：
   ```bash
   npm install -g @oyasmi/pipiclaw@latest
   sudo systemctl restart pipiclaw   # 或 pm2 restart pipiclaw
   ```
4. 发送 `/status`、`/model` 及一条普通消息做冒烟验证。

### 一致性备份清单

备份整个应用根目录 `${PIPICLAW_HOME:-~/.pipiclaw}/` 即可完整保留实例状态，核心内容包括：
- **6 个根级配置文件**：`channel.json`、`auth.json`、`models.json`、`settings.json`、`tools.json`、`security.json`
- **`workspace/`（最核心资产）**：全局 `SOUL.md` / `AGENTS.md` / `MEMORY.md`、`skills/`、`sub-agents/`、`desk-bindings.json`，以及所有 `desk-<name>/` 工位的记忆、工作日记、任务、事件与会话历史（若使用了宿主账号共享的 `~/.agents/skills/`，需另行备份）
- **`state/`（运行恢复状态）**：`dispatch/`、`subagent-runs/`、`jobs/`、`memory/`、`webapi/`（`api.sock` 除外）、`dingtalk/`、`usage/`

> **跨机器迁移注意**：外部 Coding Agent 是独立 detached 进程，其持久化的 `pid` 仅对原宿主机有效。**迁移到新服务器前，必须先等待所有在途外部委派结算完成或用 `/subagents cancel all` 终止**，停机后再打包复制 `~/.pipiclaw/`。

---

## 6. 常见运维故障速查

| 现象 | 排查顺序 |
|---|---|
| **进程启动后立即退出（Exit 1）** | 1. 检查进程日志：是否在开启 `dingtalk.enabled: true` 时仍保留了 `your-*` 占位符；<br>2. 检查是否有另一个 `pipiclaw` 进程正持有 `state/daemon.lock`，或 `127.0.0.1:8787` 端口被占用；<br>3. 检查 JSON 配置文件是否有语法错误（如多余尾逗号）或 `desk-bindings.json` 损坏。 |
| **钉钉发消息无响应或无法流式更新** | 1. 检查 `dingtalk.allowFrom` 是否拦截了当前发送者的 `staffId`；<br>2. 检查钉钉后台是否开启了 **Stream 模式**、群聊是否 **@机器人**；<br>3. 若日志频繁出现 `reconnect` / `forced termination`，优先排查宿主机出站网络或代理闪断；<br>4. 发送 `/model` 与普通消息确认模型凭据有效。 |
| **定时事件到点未触发** | 1. 执行 `/events list` 与 `/events history <name>` 查看是否有 `channel_not_bound`（目标频道未绑定本工位）、`pre_action_blocked`（门控脚本返回非 0）或 `invalid`；<br>2. 确认宿主机系统时区与预期一致（Cron 按主机本地时区解析）；<br>3. 若是任务模板事件，用 `/tasks` 检查是否因上一轮实例未结束而被防重入跳过。 |
| **后台任务停滞不推进** | 1. 执行 `/tasks show <id>`：确认是否处于 `等你回复`（无超时，需 `/tasks msg <id> ...` 回答）、`已暂停`（超预算或触发守护，用 `/tasks resume <id> +steps 10` 恢复），或汇报是否因频道换绑而暂存（切回工位或 `/tasks adopt <id>` 即可接收；渠道关闭时冻结）；<br>2. 检查是否达到并发槽上限（单工位 3 / 全局 5）正在排队，或未运行常驻 daemon。 |
| **外部子代理不可用或一直卡住** | 1. 执行 `/subagents roles <name>` 检查是否提示二进制不在服务账号 `PATH` 中或 Frontmatter 字段写错；<br>2. 执行 `/subagents show <runId>` 查看实际 `argv` 与 `stderr` 尾部（排查目标 CLI 登录过期、模型名错误或缺少 `--force` 等权限参数）；不再需要时用 `/subagents cancel <runId>` 终止。 |

---

## 相关阅读

- [配置速查](./configuration.md) · [配置字段参考](./configuration-reference.md)
- [安全指南](./security.md)
- [并发与容量参考](./scaling-and-concurrency.md)
- [历史数据迁移说明](./migrations/README.md)

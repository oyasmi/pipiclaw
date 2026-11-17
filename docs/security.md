# 安全指南（Security Guide）

> **适合谁**：决定 Pipiclaw 实例允许访问哪些目录、执行哪些命令、暴露哪些网络端口，以及如何审查外部 Coding Agent 权限边界的使用者与管理员。
> **读完你会得到**：五层安全边界的清晰职责、默认拦截清单、`~/.pipiclaw/security.json` 实用配置模板，以及 Web API 与外部 CLI 的真实信任边界。

---

## 1. 五道安全防线总览

理解 Pipiclaw 安全模型最关键的一条原则是：**区分“内置工具层守卫”与“外部子进程宿主边界”**。

| 防线 | 约束对象 | 配置位置 | 能力与边界 |
|---|---|---|---|
| **命令守卫（Command Guard）** | 主智能体与内置子代理的 `bash` 工具 | `security.json → commandGuard` | 有界 Shell 语法解析，递归检查链式命令与 `$()` 子命令，拦截破坏性操作、提权与混淆执行 |
| **路径守卫（Path Guard）** | `read` / `write` / `edit` / `send_media` 工具 | `security.json → pathGuard` | 解析真实路径与符号链接，放行工作目录并硬性拒绝密钥、浏览器凭据与系统敏感路径 |
| **网络守卫（Network Guard）** | `web_search` / `web_fetch` 出站请求与重定向 | `security.json → networkGuard` | 拦截 `localhost`、云元数据（`169.254.169.254`）与私网 CIDR，防 SSRF |
| **Web API 入口鉴权** | HTTP / WebSocket 远程与本地 API 调用 | `channel.json → webapi` | 本机 Socket 凭 `0600` 文件权限限制同账号访问；TCP 强制 SHA-256 Bearer Key 鉴权与工位隔离 |
| **外部智能体宿主边界** | `runtime: external` 角色（Claude / Codex / Cursor / Antigravity / 脚本） | `workspace/sub-agents/*.md` | **不经过前四道工具守卫**；真实边界完全取决于角色 `command` 中的 CLI sandbox 参数与系统运行账号 |

当内置守卫拦截操作时，模型会收到结构化拒绝原因以自行改用合规方案，而你的聊天进度卡会清晰显示一行中文提示（完整记录同时写入审计日志 `~/.pipiclaw/workspace/.pipiclaw/security.log`）：

```text
✕ 已拦截：写入允许范围以外的路径 `/etc/hosts`（如需放行，由部署者调整 security.json）
✕ 已拦截：命令 `rm -rf /` 属于破坏性文件操作（如需放行，由部署者调整 security.json）
```

---

## 2. 默认拦截与放行策略

安全配置文件位于 `${PIPICLAW_HOME:-~/.pipiclaw}/security.json`（权限自动收紧为 `0600`）。

### 2.1 `bash` 默认拦截的高危命令类别

普通开发命令（`git`、`npm`、`python3`、常规单文件 `rm`、`scp`）默认正常放行；以下高危模式默认拦截：
- **破坏性文件操作**：`rm -rf /`、`find ... -delete`、`shred`、`mkfs`
- **系统与服务操纵**：`shutdown`、`reboot`、`systemctl stop`
- **提权与账户篡改**：`sudo`、`su root`、`passwd`、`visudo`
- **进程清杀与历史抹除**：`killall`、`pkill`、`history -c`
- **网络外带与反弹**：`curl --upload-file`、监听型 `nc`、反弹 Shell
- **容器逃逸与混淆执行**：`nsenter`、`docker run --privileged`、`base64 -d | bash`、`eval $(...)`、无法静态确认安全的动态命令或未闭合引号/heredoc

### 2.2 文件工具默认允许与硬性拒绝路径

- **默认允许访问**：`~/.pipiclaw/workspace/`、当前系统用户主目录下的普通工作文件、`/tmp`（及 `/var/tmp`、macOS `/private/tmp`），以及内置只读 Playbook 目录。
  > 注意：同一系统账号下不同工位（`desk-<name>/`）属于应用层会话与记忆隔离，并非 OS 文件隔离；需强隔离请使用独立系统账号或容器。
- **默认硬性拒绝位置**：
  - 常见密钥与云凭据：`~/.ssh/`、`~/.gnupg/`、`~/.aws/`、`~/.azure/`、`~/.gcloud/`、`~/.kube/`、`~/.docker/`、`~/.netrc`、`~/.npmrc`、`~/.pypirc`
  - Shell 历史、系统钥匙串与浏览器资料：`~/.bash_history`、`~/.zsh_history`、`~/Library/Keychains/`、`~/.local/share/keyrings/`、Chrome / Firefox 配置目录
  - 系统敏感文件：`/etc/shadow`、`/etc/sudoers*`、`/var/run/secrets/`、`/proc/kcore`、`/proc/<pid>/mem`
  - 启发式私钥文件名拦截：`.pem` / `.key` / `.p12` / `.pfx` 扩展名及含 `id_rsa`、`id_ed25519`、`private`、`secret`、`credentials` 的文件名（启发式规则不扫描文件内容，自定义敏感目录请显式加入 `readDeny` / `writeDeny`）。

### 2.3 网络守卫的两个“默认”

- **首次初始化生成的 `security.json` 模板**：显式写入 `"networkGuard": { "enabled": false }`，避免个人开发机配置本地代理或内网 SearXNG 时受阻；
- **代码内置回退值**：若删除 `security.json` 或移除 `networkGuard.enabled` 字段，默认值为 **`true`**（自动拦截回环、云元数据与私网解析，每次重定向均重新校验；可通过 `allowedHosts` 或 `allowedCidrs` 精确放行可信内网服务）。

---

## 3. `security.json` 实用配置模板

你只需在 `~/.pipiclaw/security.json` 中填写需要覆盖的字段（完整字段表见 [配置字段参考](./configuration-reference.md#7-securityjson安全守卫策略)）。

### 模板 A：个人开发机（保护私有财务/密钥目录，保持日常开发顺畅）

```json
{
  "enabled": true,
  "commandGuard": {
    "enabled": true,
    "allowPatterns": ["scp "],
    "blockObfuscation": true
  },
  "pathGuard": {
    "enabled": true,
    "readDeny": ["~/secrets/", "~/finance/"],
    "writeDeny": ["~/secrets/", "~/finance/", "~/bin/"],
    "resolveSymlinks": true
  },
  "networkGuard": {
    "enabled": false
  },
  "audit": {
    "logBlocked": true
  }
}
```

### 模板 B：长期托管服务器（收紧运维破坏命令与系统目录，开启防 SSRF）

```json
{
  "enabled": true,
  "commandGuard": {
    "enabled": true,
    "additionalDenyPatterns": [
      "\\bsystemctl\\s+restart\\b",
      "\\bkubectl\\s+delete\\b",
      "\\bterraform\\s+destroy\\b"
    ],
    "blockObfuscation": true
  },
  "pathGuard": {
    "enabled": true,
    "readDeny": ["~/secrets/", "~/ops-private/"],
    "writeDeny": [
      "~/secrets/",
      "~/ops-private/",
      "~/.config/systemd/",
      "~/.local/bin/",
      "/etc/",
      "/usr/"
    ],
    "resolveSymlinks": true
  },
  "networkGuard": {
    "enabled": true,
    "allowedHosts": ["searx.internal.example"],
    "allowedCidrs": [],
    "maxRedirects": 5
  },
  "audit": {
    "logBlocked": true
  }
}
```

> 💡 `allowPatterns` 是对 `bash` 命令文本的子串放行，请尽量写具体（如 `"sudo systemctl status"`），**切勿单独写 `"sudo"`**。

---

## 4. Web API 安全边界

首次初始化时，`channel.json` 默认启用 `webapi` 并仅绑定在**本机**：
- **本机 Unix Socket**（`state/webapi/api.sock`，文件权限 `0600`、父目录 `0700`）：仅运行 Pipiclaw 的同一系统用户（如 `pipiclaw tui`）可连接，无需 Bearer Key。
- **本机回环 TCP**（默认 `127.0.0.1:8787`）：外部机器无法直连，且**所有非 `OPTIONS` 的 TCP 请求在读取请求体前均强制校验 `Authorization: Bearer pk_...`**（失败直接返回 `401` 并记入审计日志），同时校验回环 `Host` 头防御浏览器 DNS Rebinding 攻击。
- **密钥权限等同于助手工具权限**：持有有效 `pk_...` 密钥即可驱动该密钥 `desks` 白名单内的助手执行命令与读写文件。`channel.json` 只保存密钥的 SHA-256 哈希；通过 `pipiclaw webapi key add|remove` 增删密钥后运行中服务**自动热生效**，无需重启。若将 `tcp` 改为局域网/公网地址，请务必配置 `tls` 证书或置于终止 HTTPS 的反向代理之后（详见 [Web API 手册](./webapi.md)）。

---

## 5. 外部智能体的授权边界

将 `runtime: external` 的角色文件放入 `workspace/sub-agents/*.md`，等同于**授予主智能体随时按该 `command` 启动宿主机外部 CLI 的持续授权**（无二次弹窗确认）。管理员在放入或修改外部角色前应逐项审查：

1. **命令与沙箱参数**：`command` 启动的可执行文件是否带有目标 CLI 自身的权限限制（如只读审查角色使用 `codex exec --sandbox read-only` 或 `agent --mode ask`）。仅在提示词里写“不要改文件”不是强隔离。
2. **如实声明 `mutates`**：会改写文件的角色必须声明 `mutates: write`，以便运行时通过工作目录排他锁防止并发写冲突（注意 `mutates` 仅作并发锁与审计，不限制进程系统调用）。
3. **禁止滥用 `shell: true` 与多余环境变量**：结构化 harness 直接以 `argv` 启动进程并拒绝 `shell: true`；切勿在角色 `env` 中注入无关高权限密钥，也不要开启非必要的 `memory: index` 向第三方 CLI 外发工位记忆。
4. **保护 `workspace/sub-agents/` 目录**：内置 `write` / `edit` 工具硬性禁止修改 `workspace/sub-agents/`，防止模型自建高权限外部角色；建议将该目录纳入 Git 版本管理与变更审查。
5. **警惕目标仓库不可信提示词**：外部 CLI 会自行加载目标仓库内的 `CLAUDE.md`、`AGENTS.md`、`.cursor/rules` 等文件，其输出与自评应作为待核实数据对待。每次外部派发均遵循“先写审计日志、后启动子进程”。

---

## 6. 已知非内核沙箱边界

Pipiclaw 的内置守卫是**应用工具层硬护栏，而非操作系统内核级沙箱**：
- **进程级隔离**：在多租户或不可信代码分析场景下，请将整个 Pipiclaw 实例放入独立低权限 Linux 账号或 Docker 容器中运行。
- **Shell 内部程序行为**：`commandGuard` 解析并拦截危险 Shell 命令结构，但不追踪被调用的普通脚本（如 `python3 build.py`）内部自行发起的系统调用。
- **极端并发 TOCTOU**：文件工具直接通过 `node:fs` 操作经 `guardPath` 解析后的路径并拒绝覆写符号链接，但若宿主机存在恶意并发进程在检查与打开间隙替换父目录，仍需依赖 OS 账号/容器权限兜底。

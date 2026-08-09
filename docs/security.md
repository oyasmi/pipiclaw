# Pipiclaw 安全文档（Security Guide）

> **读者**：要决定这个实例能碰哪些文件、能跑哪些命令的管理员。
> **前置**：已完成 [README](../README.md) 的安装；配置全貌见 [configuration.md](./configuration.md)。
> **读完你能**：说出默认拦截了什么、如何按需放行或收紧、以及这套守卫的边界在哪。

这份文档讲清楚默认策略是什么、哪些地方仍然有边界，以及如何通过 `~/.pipiclaw/security.json` 调整策略。长期部署的运维配套见 [deployment-and-operations.md](./deployment-and-operations.md)。

## 总览（Overview）

Pipiclaw 的安全控制分成四个需要分别理解的部分：

1. 命令防护（command guard）
   作用于 `bash` 工具，拦截明显高风险的命令

2. 路径防护（path guard）
   作用于 `read` / `write` / `edit` 等显式文件工具，统一判断路径是否允许访问

3. 网络防护（network guard）
   作用于 web 工具的出站请求与重定向，避免访问 localhost、云元数据服务和私网地址

4. 外部智能体授权
   作用于 `workspace/sub-agents/` 中声明为 `runtime: external` 的角色；角色文件决定允许启动哪个 CLI、使用什么 sandbox 和是否声明写入

前三项是 Pipiclaw 自己的工具层守卫。外部智能体不使用这些工具实现，因此不会经过 command/path/network guard；它的强边界来自目标 CLI 自身的 sandbox、运行账号和宿主环境。两类边界不能混为一谈。

## 配置文件位置（Security Config Path）

安全配置是 **Pipiclaw 实例级** 配置，不是 workspace 内的项目文件。

默认路径：

```text
~/.pipiclaw/security.json
```

如果设置了：

```bash
export PIPICLAW_HOME=/your/custom/pipiclaw-home
```

那么配置路径变为：

```text
$PIPICLAW_HOME/security.json
```

说明：

- 这份配置约束的是整个 Pipiclaw 实例的工具边界
- 首次启动会生成一份最小模板；如果文件不存在，就使用内置默认值
- 相关代码见 `src/security/config.ts`

## 当前默认安全策略（Default Security Policy）

### 1. `bash` 默认会拦截什么

当前默认会拦截这些高风险命令类别：

- 破坏性文件操作
  - 例如 `rm -rf /`、`find ... -delete`、`shred`、`mkfs`
- 系统操纵
  - 例如 `shutdown`、`reboot`、`systemctl stop`
- 权限提升与账户篡改
  - 例如 `sudo`、`su root`、`passwd`、`visudo`
- 进程与历史篡改
  - 例如 `killall`、`pkill`、`history -c`
- 网络滥用
  - 例如 `curl --upload-file`、监听型 `nc`、反弹 shell
- 容器逃逸
  - 例如 `nsenter`、`docker run --privileged`
- 常见混淆执行
  - 例如 `base64 -d | bash`、`eval $(...)`

说明：

- `scp` 默认允许
- 普通开发命令，如 `git`、`npm`、`python3 -c "print(42)"`、普通 `rm file.txt`，默认不拦截

### 2. 文件工具默认允许访问哪些地方

当前默认允许：

- Pipiclaw workspace 目录
- 当前用户主目录中的普通工作文件
- `/tmp`、`/var/tmp`、macOS 的 `/private/tmp`

当前默认拒绝：

- 密钥、凭据、认证配置、浏览器资料、keychain 等敏感位置
- 高风险系统目录和系统敏感文件

### 3. 默认拒绝的典型敏感位置

包括但不限于：

```text
~/.ssh/
~/.gnupg/
~/.gpg/
~/.aws/
~/.azure/
~/.gcloud/
~/.config/gcloud/
~/.kube/
~/.docker/
~/.netrc
~/.npmrc
~/.pypirc
~/.bash_history
~/.zsh_history
~/Library/Keychains/
~/.local/share/keyrings/
~/Library/Application Support/Google/Chrome/
~/Library/Application Support/Firefox/
~/.config/google-chrome/
~/.mozilla/firefox/

/etc/shadow
/etc/gshadow
/etc/sudoers
/etc/sudoers.d/
/var/run/secrets/
/proc/kcore
/proc/<pid>/mem
```

此外还有一些启发式规则，例如：

- 私钥扩展名：`.pem`、`.key`、`.p12`、`.pfx`
- 文件名关键词：`id_rsa`、`id_ed25519`、`private`、`secret`、`credentials`

这些扩展名和关键词检查是**尽力而为的启发式防线**，不是内容扫描：把敏感文件改成普通名称即可绕过它。对自定义凭据目录应配置明确的 `readDeny` / `writeDeny`；高价值部署还应使用独立账号或容器做 OS 级隔离。

### 4. 网络守卫默认策略

需要区分两种“默认”：

- **首次初始化生成的 `security.json` 模板**：显式写入 `networkGuard.enabled: false`，减少个人开发机上代理、内网 SearXNG 等场景的启动摩擦。
- **代码内置默认值**：如果 `security.json` 不存在，或你删除了 `networkGuard.enabled` 字段，则 `networkGuard.enabled` 默认为 `true`。

启用后，network guard 只允许 `http` / `https` URL，并会拦截：

- `localhost`、`*.localhost`、`metadata`、`metadata.google.internal`、`169.254.169.254`
- 解析到私网、回环、链路本地、CGNAT、benchmark 等地址段的主机
- 解析失败的主机

需要访问可信内网服务时，用 `allowedHosts` 精确放行主机名，或用 `allowedCidrs` 放行地址段。重定向目标也会重新检查，最多跟随 `maxRedirects` 次。

## 配置文件示例（Example `~/.pipiclaw/security.json`）

下面给出一个完整示例：

```json
{
  "enabled": true,
  "commandGuard": {
    "enabled": true,
    "additionalDenyPatterns": [
      "\\bterraform\\s+destroy\\b",
      "\\bkubectl\\s+delete\\s+namespace\\b"
    ],
    "allowPatterns": [
      "sudo apt install",
      "scp "
    ],
    "blockObfuscation": true
  },
  "pathGuard": {
    "enabled": true,
    "readAllow": [
      "~/Documents/",
      "~/work-notes/"
    ],
    "readDeny": [
      "~/secrets/",
      "~/finance/"
    ],
    "writeAllow": [
      "~/Documents/",
      "~/work-notes/"
    ],
    "writeDeny": [
      "~/bin/",
      "/etc/"
    ],
    "resolveSymlinks": true
  },
  "networkGuard": {
    "enabled": true,
    "allowedHosts": [
      "searx.internal.example"
    ],
    "allowedCidrs": [
      "10.20.0.0/16"
    ],
    "maxRedirects": 5
  },
  "audit": {
    "logBlocked": true,
    "logFile": "~/.pipiclaw/workspace/.pipiclaw/security.log"
  }
}
```

说明：

- 这只是示例，不是推荐你照抄所有字段
- 只写你真正要覆盖的部分即可
- 未提供的字段会回退到默认值

## 字段说明（Field Reference）

### 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | `boolean` | 是否启用整套安全层 |
| `commandGuard` | `object` | `bash` 工具的命令防护 |
| `pathGuard` | `object` | 文件工具的路径防护 |
| `networkGuard` | `object` | web 工具的出站网络防护 |
| `audit` | `object` | 阻断事件审计日志 |

### `commandGuard`

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | `boolean` | 是否启用命令防护 |
| `additionalDenyPatterns` | `string[]` | 额外的正则 deny 规则 |
| `allowPatterns` | `string[]` | 对部分命令文本做放行覆盖 |
| `blockObfuscation` | `boolean` | 是否拦截常见混淆执行手法 |

说明：

- `additionalDenyPatterns` 使用 JavaScript 正则表达式语法
- 无效正则会被忽略，不会让 Pipiclaw 启动失败
- `allowPatterns` 是简单字符串匹配，不是完整规则系统
- `allowPatterns` 只影响 `bash`，不影响文件工具的路径守卫

### `pathGuard`

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | `boolean` | 是否启用路径防护 |
| `readAllow` | `string[]` | 额外允许读取的路径前缀 |
| `readDeny` | `string[]` | 额外拒绝读取的路径前缀 |
| `writeAllow` | `string[]` | 额外允许写入的路径前缀 |
| `writeDeny` | `string[]` | 额外拒绝写入的路径前缀 |
| `resolveSymlinks` | `boolean` | 是否在判断前解析符号链接 |

说明：

- 支持 `~/` 写法
- 相对路径会相对 Pipiclaw workspace 根解析
- 这是“前缀型路径规则”，不是任意 glob 匹配
- 基础敏感路径 deny 仍然保留；配置不是“完全绕过所有底线”的总开关

### `networkGuard`

| 字段 | 类型 | 说明 |
|------|------|------|
| `enabled` | `boolean` | 是否启用网络防护；首次生成模板为 `false`，内置默认值为 `true` |
| `allowedHosts` | `string[]` | 精确放行的主机名；匹配规范化后的 hostname，不是 glob |
| `allowedCidrs` | `string[]` | 允许访问的 CIDR 地址段，可用于可信内网服务 |
| `maxRedirects` | `number` | web fetch 最多跟随的重定向次数；必须为正数，默认 `5` |

说明：

- 只支持 `http` / `https`。
- `allowedHosts` 会直接放行对应 hostname；`allowedCidrs` 会放行解析后的 IP。
- 未放行时，localhost、云元数据服务、私网和链路本地地址会被拦截。
- 每次重定向后的目标 URL 都会重新执行同一套检查。

### `audit`

| 字段 | 类型 | 说明 |
|------|------|------|
| `logBlocked` | `boolean` | 是否记录阻断日志 |
| `logFile` | `string` | 自定义日志文件路径 |

默认日志路径目前是：

```text
~/.pipiclaw/workspace/.pipiclaw/security.log
```

如果你不设置 `logFile`，就会写到这个位置。

## 常见配置场景（Common Configuration Patterns）

### 1. 增加一批个人工作目录

适合：

- 主目录里有多份日常笔记、脚本、草稿和项目目录
- 你希望这些目录明确被允许，而不是完全依赖默认 home 放开

示例：

```json
{
  "pathGuard": {
    "readAllow": ["~/Documents/", "~/notes/", "~/projects/"],
    "writeAllow": ["~/Documents/", "~/notes/", "~/projects/"]
  }
}
```

### 2. 额外保护某些敏感目录

适合：

- 你主目录里还有其他不希望 Pipiclaw 访问的私有目录

示例：

```json
{
  "pathGuard": {
    "readDeny": ["~/secrets/", "~/archive/private/"],
    "writeDeny": ["~/secrets/", "~/archive/private/"]
  }
}
```

### 3. 阻止特定高风险运维命令

适合：

- 某台机器上有你明确不想让代理碰的运维命令

示例：

```json
{
  "commandGuard": {
    "additionalDenyPatterns": [
      "\\bsystemctl\\s+restart\\b",
      "\\bkubectl\\s+delete\\b",
      "\\bterraform\\s+destroy\\b"
    ]
  }
}
```

### 4. 放行少量你明确接受的命令文本

适合：

- 某个日常命令会被 guard 挡住，但你确认这个实例应该允许

示例：

```json
{
  "commandGuard": {
    "allowPatterns": [
      "sudo apt install",
      "sudo systemctl status"
    ]
  }
}
```

说明：

- `allowPatterns` 是比较粗的放行方式
- 不要把它写成过宽的模式，例如单独放行 `"sudo"`

## 推荐模板（Recommended Templates）

下面给两套可直接作为起点的模板。它们不是唯一正确答案，但适合大多数场景先落地，再逐步调整。

### 模板 1：个人开发机（Personal Workstation）

适合：

- 你在自己的开发机上长期运行 Pipiclaw
- 需要让它访问主目录里的多个项目、笔记和脚本
- 但仍希望保护常见凭据和高风险命令

建议特点：

- 保持默认主目录可访问
- 额外补一些你自己的私有目录 deny
- 打开审计日志

```json
{
  "enabled": true,
  "commandGuard": {
    "enabled": true,
    "additionalDenyPatterns": [],
    "allowPatterns": [
      "scp "
    ],
    "blockObfuscation": true
  },
  "pathGuard": {
    "enabled": true,
    "readAllow": [],
    "readDeny": [
      "~/secrets/",
      "~/finance/",
      "~/archive/private/"
    ],
    "writeAllow": [],
    "writeDeny": [
      "~/secrets/",
      "~/finance/",
      "~/archive/private/",
      "~/bin/"
    ],
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

说明：

- `readAllow` / `writeAllow` 留空即可，默认主目录普通文件已经允许访问
- 重点是根据你自己的机器情况补 `readDeny` / `writeDeny`
- 如果你有更多私有资料目录，优先补 deny，而不是关闭整个安全层

### 模板 2：长期部署主机（Long-Running Hosted Instance）

适合：

- Pipiclaw 作为长期服务运行
- 机器上还有其他服务或运维资产
- 你希望对命令和路径都更保守一些

建议特点：

- 额外禁止常见运维破坏命令
- 收紧部分主目录写入位置
- 强制保留审计日志

```json
{
  "enabled": true,
  "commandGuard": {
    "enabled": true,
    "additionalDenyPatterns": [
      "\\bsystemctl\\s+restart\\b",
      "\\bkubectl\\s+delete\\b",
      "\\bterraform\\s+destroy\\b",
      "\\buseradd\\b",
      "\\busermod\\b"
    ],
    "allowPatterns": [
      "scp "
    ],
    "blockObfuscation": true
  },
  "pathGuard": {
    "enabled": true,
    "readAllow": [],
    "readDeny": [
      "~/secrets/",
      "~/ops-private/"
    ],
    "writeAllow": [],
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
    "allowedHosts": [],
    "allowedCidrs": [],
    "maxRedirects": 5
  },
  "audit": {
    "logBlocked": true,
    "logFile": "~/.pipiclaw/workspace/.pipiclaw/security.log"
  }
}
```

说明：

- 这套模板更强调“长期托管时不要碰系统和运维资产”
- 如果这台机器上还有其他高价值目录，继续补 deny
- 如果你已经用独立账号或 Docker 跑 Pipiclaw，这套模板仍然有价值，但可以适度放宽

## 外部智能体的授权边界

外部智能体没有单独的 `security.json` 配置段。把下面三项写进一个角色文件，本身就是一份持续有效、可版本管理的授权：

```yaml
runtime: external
command: codex exec --sandbox read-only --skip-git-repo-check
mutates: read
```

这份授权表示主智能体可以在角色适用时直接启动对应命令，不会再弹出第二道 Pipiclaw 确认。管理员应像审查部署脚本一样审查每个外部角色，重点检查：

- `command` 最终启动什么可执行文件，是否带目标 CLI 的 sandbox / approval 参数
- `mutates` 是否如实声明 `read` 或 `write`
- 通用 `exec` 角色的 `shell: true` 是否真的必要；它会把整条命令交给 `/bin/sh -lc`，重新引入 shell 展开风险（结构化 harness 会直接驳回该组合）
- `env` 是否注入了不应交给该角色的凭据或配置
- 正文是否明确允许的副作用、停止条件、验证方式和交付物

必须了解以下事实：

1. **Pipiclaw 不沙箱化外部进程。** `workingDirectory` 只决定启动目录，不是文件系统边界；`mutates` 只用于审计、验收准入和写锁，也不是权限控制。
2. **目标 CLI 的 sandbox 才是强边界。** 例如 Codex 的 `--sandbox read-only` 能让只读声明落到执行层；只在提示词里写“不要修改”属于行为约束，不是强制隔离。
3. **外部进程继承 Pipiclaw 环境。** 它需要用自己的认证，也可能看到 daemon 已有的环境变量。长期部署应使用最小权限账号和最小化环境。
4. **仓库内容对外部智能体是不可信输入。** 外部 CLI 会自行读取目标仓库的 `AGENTS.md`、`CLAUDE.md` 等文件；它的最终声明和自我验收不能替代主智能体或独立 verifier 的检查。
5. **每次派发先审计、后 spawn。** 审计包含 runId、角色、harness、完整 argv、工作目录、`mutates` 和模型；严格审计写入失败时外部进程不会启动。

Pipiclaw 的 `write` / `edit` 工具禁止修改 `workspace/sub-agents/`，避免模型自行创建高权限外部角色再调用。但拥有 `bash` 的智能体仍可能通过通用 shell 改写该目录；这是工具层安全模型的已知边界。建议把角色目录纳入版本控制或至少纳入定期备份和变更审查。

并发写角色还受 workspace 排他写锁约束：同一工作目录或互为父子的目录不能同时运行两个 `mutates: write` run。写锁防止意外并发覆盖，不替代权限隔离。

## 已知边界（Known Limits）

当前实现有几个需要明确知道的边界：

### 1. 这不是 OS 级沙箱

Pipiclaw 的安全层是工具层硬约束，不是内核级隔离。

更强的隔离仍然依赖：

- 在容器中运行整个 Pipiclaw 进程
- 独立运行账号
- 主机级权限管理
- 外部智能体各自提供的 sandbox / approval 模式

### 2. `bash` 防护不是完整 shell parser

当前命令防护采用的是“轻量拆分 + 规则匹配”。

它已经能覆盖：

- 链式命令
- `$()` 和反引号子命令
- 一部分混淆与全路径二进制名绕过

但它不是一个完整 shell 语义解释器，不应被当成完备的 shell 沙箱。

### 3. 写入场景仍有 TOCTOU 边界

由于当前 `write` 实现仍保持 `mkdir -p ... && cat > path` 这种 shell 驱动方式，路径防护虽然会做 `realpath` 与符号链接检查，但不能提供最强的原子级防护。

这意味着：

- 常见越权写入与符号链接绕过已经能拦住大部分
- 但理论上的极端竞态条件仍不是 100% 消除

## 推荐做法（Recommendations）

建议按下面的顺序使用这套安全配置：

1. 先直接使用默认配置运行一段时间
2. 根据真实工作流，再补 `readDeny` / `writeDeny`
3. 只对必要命令增加 `allowPatterns`
4. 长期运行环境尽量把整个进程放进容器或独立账号里跑
5. 保持 `logBlocked: true`，便于排查策略是否误伤

## 排障建议（Troubleshooting）

### 1. 某条命令被挡住了

先看报错里的：

- 分类
- 原因
- 匹配文本

如果你确认它应该允许：

- 优先考虑调整工作方式，避免使用高风险命令
- 其次再考虑是否通过 `allowPatterns` 放行

### 2. 某个文件路径被挡住了

先确认：

- 它是否命中了敏感路径 deny
- 它是否通过符号链接落到了敏感位置
- 它是否其实不在你认为的目录下

如果路径确实合理，再考虑加到：

- `readAllow`
- `writeAllow`

### 3. 想看阻断历史

默认去看：

```text
~/.pipiclaw/workspace/.pipiclaw/security.log
```

如果你在 `audit.logFile` 里改过路径，则看你自定义的位置。

# Pipiclaw 安全文档（Security Guide）

这份文档讲清楚 Pipiclaw 当前这轮安全增强做了什么、默认策略是什么、哪些地方仍然有边界，以及如何通过 `~/.pi/pipiclaw/security.json` 调整策略。

如果你还没有看过整体配置说明，建议同时参考：

- [configuration.md](./configuration.md)
- [deployment-and-operations.md](./deployment-and-operations.md)

## 总览（Overview）

Pipiclaw 的安全控制目前主要分成两层：

1. 命令防护（command guard）
   作用于 `bash` 工具，拦截明显高风险的命令

2. 路径防护（path guard）
   作用于 `read` / `write` / `edit` / `attach` 等显式文件工具，统一判断路径是否允许访问

这套防护的目标不是把 Pipiclaw 变成强隔离沙箱，而是在保留日常可用性的前提下，把最常见、最危险的误操作和越权访问挡在工具层外面，而不是只靠 prompt 提示。

## 配置文件位置（Security Config Path）

安全配置是 **Pipiclaw 实例级** 配置，不是 workspace 内的项目文件。

默认路径：

```text
~/.pi/pipiclaw/security.json
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
- 它不会自动生成；如果文件不存在，就使用内置默认值
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

### 4. `attach` 比普通读取更严格

即使主目录中的某些文件可以被 `read`，`attach` 也不会因此自动允许对外发送。

当前实现里：

- `attach` 先走正常路径守卫
- 然后再额外要求文件必须位于 workspace 内

这意味着：

- 普通 `read` 可以读主目录中的普通工作文件
- 但 `attach` 默认只能上传 workspace 内的文件

## 配置文件示例（Example `~/.pi/pipiclaw/security.json`）

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
  "audit": {
    "logBlocked": true,
    "logFile": "~/.pi/pipiclaw/workspace/.pipiclaw/security.log"
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

### `audit`

| 字段 | 类型 | 说明 |
|------|------|------|
| `logBlocked` | `boolean` | 是否记录阻断日志 |
| `logFile` | `string` | 自定义日志文件路径 |

默认日志路径目前是：

```text
~/.pi/pipiclaw/workspace/.pipiclaw/security.log
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
  "audit": {
    "logBlocked": true,
    "logFile": "~/.pi/pipiclaw/workspace/.pipiclaw/security.log"
  }
}
```

说明：

- 这套模板更强调“长期托管时不要碰系统和运维资产”
- 如果这台机器上还有其他高价值目录，继续补 deny
- 如果你已经用独立账号或 Docker 跑 Pipiclaw，这套模板仍然有价值，但可以适度放宽

## 已知边界（Known Limits）

当前实现有几个需要明确知道的边界：

### 1. 这不是 OS 级沙箱

Pipiclaw 的安全层是工具层硬约束，不是内核级隔离。

更强的隔离仍然依赖：

- Docker 模式
- 独立运行账号
- 主机级权限管理

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
4. 长期运行环境尽量配合 Docker 或独立账号
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
~/.pi/pipiclaw/workspace/.pipiclaw/security.log
```

如果你在 `audit.logFile` 里改过路径，则看你自定义的位置。

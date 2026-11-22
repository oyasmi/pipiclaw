# Spec 005: Pipiclaw 安全增强设计

## Context

当前 Pipiclaw 的工具执行层缺少硬性安全边界，风险点主要集中在以下几处：

1. `bash` 工具直接执行任意 shell 命令，没有命令级阻断
2. `read` / `edit` 通过 shell 读取文件，没有路径授权判断
3. `write` 通过 `cat > path` 写文件，没有写入路径限制，也没有符号链接防护
4. Host 模式下代理运行在宿主机，现有约束主要依赖 prompt 提示，不是强制机制

当前实际风险不是“已有防护不够强”，而是“缺少统一、可验证的安全层”。

本设计的目标不是把代理变成强隔离沙箱，而是在现有架构内建立一套可靠、可维护、默认安全的执行边界：

1. 对 `bash` 建立命令级风险阻断
2. 对文件工具建立统一的路径读写授权
3. 默认允许访问 workspace / channel / temp / 用户主目录，但排除机密信息保存位置与高风险系统路径
4. 对越权、符号链接和常见绕过手法提供明确阻断和审计

本轮约束：

- 只增加安全防护，不改变工具的基本实现方式
- `read` / `edit` / `write` 仍保持当前基于 shell / `executor.exec()` 的实现模式
- 不在本轮把文件工具迁移到 Node `fs`

---

## 一、设计目标

### 1.1 目标

- 为 `bash` 提供基础但有效的高风险命令阻断
- 为 `read` / `write` / `edit` / `attach` 提供统一路径校验
- 默认限制对宿主机机密与高风险位置的访问范围
- 支持实例级安全配置覆盖，但默认策略保持保守
- 保持现有工具接口和运行时结构基本稳定
- 为后续扩展审计日志、策略分级、按工具授权留出接口

### 1.2 非目标

- 不尝试通过正则完整解析 shell 语法
- 不把 `bash` 做成完全精确的文件访问审计器
- 不实现 OS 级强隔离；Docker 仍然是更强的隔离手段
- 不改变现有 DingTalk/runtime/memory 领域边界

---

## 二、威胁模型

### 2.1 主要威胁

1. 破坏性命令
   例如 `rm -rf`、`mkfs`、`shutdown`、`systemctl stop`

2. 越权读取敏感信息
   例如读取 SSH key、云凭据、系统认证文件、浏览器配置、K8s secret

3. 越权写入敏感位置
   例如写入 `~/.ssh/authorized_keys`、`~/.bashrc`、`/etc/cron*`、`/usr/bin/*`

4. 符号链接绕过
   例如在 workspace 中创建一个指向 `/etc/passwd` 或 `~/.ssh/id_rsa` 的链接，再通过文件工具访问

5. 命令混淆与链式绕过
   例如 `echo x; rm -rf /`、`$(...)`、反引号、`/bin/rm`、base64 管道执行

6. 数据外泄
   例如读取敏感文件后通过 `curl --upload-file`、反弹 shell，或其他网络工具发出

### 2.2 现实假设

- 这是一个长期工作的编码助手，不应只被假定服务于单一 workspace
- 代理的正常工作除了 workspace、channel 和临时目录，还可能覆盖用户主目录下的多个项目与个人工作文件
- `bash` 需要保留足够实用性，因此不能纯 allowlist
- 文件工具的路径控制应比 `bash` 更强，因为其语义明确、可精确校验

---

## 三、总体方案

采用两层控制：

1. **命令防线**
   仅用于 `bash` 工具。通过轻量结构化拆分与 deny 规则阻断高风险命令。

2. **路径防线**
   用于 `read` / `write` / `edit` / `attach` 等显式文件工具。通过统一路径解析、真实路径校验、读写分离授权来决定是否允许操作。

核心原则：

- `bash` 负责“明显危险”的阻断，不负责精确文件授权
- 文件工具必须经过统一路径守卫，不能再直接信任传入路径
- 默认权限覆盖 workspace / channel / temp / home，但显式拒绝机密和高风险位置
- 配置可以放宽，但默认不能放宽到整机全开

---

## 四、架构落点

### 4.1 新增模块

新增 `src/security/`：

```text
src/security/
  command-guard.ts      # bash 命令风险检查
  path-guard.ts         # 统一路径解析与读写授权
  config.ts             # security 配置加载与合并
  types.ts              # 共享类型定义
  logger.ts             # 阻断审计日志（可选启用）
```

### 4.2 接入点

- `src/tools/bash.ts`
  在真正执行前调用 `guardCommand()`

- `src/tools/read.ts`
  在读取前调用 `guardPath(path, "read")`

- `src/tools/write-content.ts`
  在创建目录、写入文件前调用 `guardPath(path, "write")`
  保持现有 `mkdir -p` 与 `cat > path` 方式，仅增加前置校验

- `src/tools/edit.ts`
  在读取目标文件前做 `read` 校验，在写回前做 `write` 校验

- `src/tools/attach.ts`
  在上传前调用 `guardPath(path, "read")`
  并加 workspace 附件范围检查

- `src/tools/index.ts`
  为工具构造函数注入 security config / path guard 上下文

- `src/sandbox.ts`
  保持为执行器；不要把复杂安全策略塞进 executor 本体

这样可以保持领域边界清晰：

- `src/tools/` 负责工具行为
- `src/security/` 负责安全决策
- `src/sandbox.ts` 只负责“如何执行”

---

## 五、路径安全设计

### 5.1 核心原则

对显式文件工具执行统一路径守卫：

- 同一条路径判断逻辑供 `read` / `write` / `edit` / `attach` 复用
- 区分 `read` 和 `write`
- 所有判断基于规范化后的真实路径
- 默认允许访问明确受控区域以及用户主目录中的普通工作文件，但排除机密位置

### 5.2 默认权限模型

| 位置 | 读取 | 写入 |
|---|---|---|
| workspace 根目录及子目录 | 允许 | 允许 |
| 当前 channel 目录及子目录 | 允许 | 允许 |
| `/tmp` / `/var/tmp` / macOS `/private/tmp` | 允许 | 允许 |
| 用户主目录普通位置 | 允许 | 允许 |
| 系统目录 | 默认拒绝 | 拒绝 |

说明：

- `channel` 目录本身已包含在 workspace 中，但保留该概念便于未来单独做更细粒度策略
- `~/` 默认开放给普通工作文件与目录
- 主目录中的凭据、私钥、认证配置、浏览器资料、keychain 等位置由 deny 清单显式排除
- 系统目录仍保持严格限制；如确有需要，由工作区配置显式增加 allow

### 5.3 敏感路径拒绝

以下路径无论 read 或 write，默认都应拒绝：

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
/proc/*/mem
```

额外启发式拒绝：

- 扩展名：`.pem` `.key` `.p12` `.pfx`
- 文件名关键词：`id_rsa` `id_ed25519` `private` `secret` `credentials`

说明：

- 这些 deny 规则的目标不是限制普通个人文件，而是限制常见凭据、私钥、认证材料和敏感客户端状态
- 主目录中不在 deny 范围内的普通项目、文档、脚本、配置和笔记文件默认允许访问

### 5.4 路径解析算法

```ts
function guardPath(rawPath: string, operation: "read" | "write", ctx: PathGuardContext): PathGuardResult
```

处理步骤：

1. 去除 `\0`
2. 做 Unicode NFKC 标准化
3. 展开 `~`
4. 相对路径按当前 workspace 根解析
5. 进行 `normalize`
6. 对已存在目标用 `realpath`
7. 对不存在目标，解析父目录 `realpath(parent)` 再拼接 basename
8. 用解析后的真实路径做 allow / deny 判断

### 5.5 符号链接策略

默认策略：

- 读取：如果目标真实路径落到 deny 区域，则拒绝
- 写入：如果目标本身是符号链接，拒绝
- 写入不存在文件：校验父目录真实路径是否允许

### 5.6 TOCTOU 与本轮边界

写入必须避免“先检查后被替换”为符号链接：

1. 路径检查基于 `realpath`
2. 在生成最终 shell 写入命令前再次对目标路径做一次 guard
3. 对已存在且为符号链接的目标一律拒绝
4. 对不存在目标，校验其父目录真实路径

说明：

由于本轮不改变 `cat > path` 的实现方式，无法提供 `O_NOFOLLOW` 级别的原子防护，因此这里的策略是“降低风险”而不是“彻底消除 TOCTOU”。

需要明确记录残余风险：

- 如果攻击者能在 guard 完成后、shell 实际打开文件前完成竞态替换，理论上仍可能绕过
- 该残余风险在 host 模式下高于 docker 模式

本轮接受该取舍，后续若要进一步强化，再单独评估是否改写底层文件实现。

### 5.7 附件策略

`attach` 额外约束：

- 只有 workspace 内的文件允许上传
- 即使工作区配置放宽一般 `read`，也不默认放宽 `attach`

原因：

- “可读”不等于“可对外发送”
- 附件是天然外发通道，应该比普通读取更严格

---

## 六、命令安全设计

### 6.1 核心原则

`bash` 的安全设计目标不是精确理解 shell，而是拦截明显危险、误伤可控的高风险命令。

因此采用：

1. 轻量结构化拆分
2. 命令标准化
3. 分类 deny 规则
4. 少量混淆检测

不做：

- 完整 shell parser
- 从 `bash` 命令中提取全部读写路径并精确授权

### 6.2 命令拆分

```ts
function splitCommandChain(command: string): string[]
```

目标：

- 在引号外对 `;`, `&&`, `||`, `|` 做拆分
- 递归提取 `$()` 和反引号中的子命令进行检查
- 去掉引号外注释

这是“检查辅助”，不是“执行语义复现”。

### 6.3 标准化

```ts
function normalizeCommand(command: string): string
```

处理项：

1. 去除 null 字节
2. Unicode NFKC 标准化
3. 反斜杠还原常见混淆
4. 去除简单引号拼接
5. 归一化全路径二进制名，例如 `/bin/rm` -> `rm`

### 6.4 默认阻断类别

#### 类别 1：破坏性文件操作

```text
rm -rf /, rm -rf ~, rm -rf *
shred
mkfs
wipefs
find ... -delete
find ... -exec rm
```

说明：

- 不阻断普通 `rm file.txt`
- 重点阻断递归强删和不可恢复删除

#### 类别 2：系统操纵

```text
shutdown
reboot
halt
poweroff
systemctl stop|disable|mask|reboot|poweroff
service <name> stop|restart
launchctl unload|remove|bootout
sysctl -w
```

#### 类别 3：权限提升与账户篡改

```text
sudo
su root
passwd
visudo
chmod u+s / g+s
chown root
setcap
```

说明：

- `sudo` 建议默认 block，不只是 warn
- DingTalk 长驻代理不应把“尝试提权”当作普通提示

#### 类别 4：进程与环境破坏

```text
kill -9 1
killall
pkill
history -c
unset HISTFILE
export HISTSIZE=0
```

#### 类别 5：网络滥用与外泄

```text
curl --upload-file
wget --post-file
nc -l
socat ... exec
bash -i >&
/dev/tcp/
mkfifo ... nc
```

说明：

- `scp` 默认允许，不作为通用阻断项
- 如果后续需要对“携带敏感路径的外传命令”做更细粒度识别，应作为单独增强项处理，而不是在本轮直接封禁 `scp`

#### 类别 6：容器与宿主逃逸

```text
nsenter
docker run --privileged
docker exec --privileged
docker run -v /:/
```

#### 类别 7：编码与混淆绕过

```text
base64 -d | bash
eval $(
python -c ... subprocess|os.system|exec
perl -e system|exec
ruby -e system|exec
node -e child_process|exec|spawn
\xNN
$'...'
```

### 6.5 结果接口

```ts
export interface CommandGuardResult {
  allowed: boolean;
  category?: string;
  rule?: string;
  reason?: string;
  matchedText?: string;
}
```

### 6.6 命令守卫边界

`commandGuard` 不承担：

- shell 级完整语义解析
- here-doc、函数、复杂重定向的精确理解
- 一切数据外泄的完全阻断

因此应明确把它定位为：

- `bash` 工具的第一道风险闸门
- 不是系统级沙箱

---

## 七、配置设计

### 7.1 配置位置

使用 Pipiclaw 实例级配置：

```text
<app-home>/security.json
```

默认路径：

```text
~/.pi/pipiclaw/security.json
```

如果设置了 `PIPICLAW_HOME`，则路径变为：

```text
$PIPICLAW_HOME/security.json
```

原因：

- 这份策略约束的是整个 Pipiclaw 实例的工具执行边界
- 它不应该伪装成 workspace 内的普通项目文件
- 路径策略本身已经允许访问主目录与多个项目，因此按实例统一管理更符合实际模型

### 7.2 配置结构

```ts
export interface SecurityConfig {
  enabled: boolean;

  commandGuard: {
    enabled: boolean;
    additionalDenyPatterns: string[];
    allowPatterns: string[];
    blockObfuscation: boolean;
  };

  pathGuard: {
    enabled: boolean;
    readAllow: string[];
    readDeny: string[];
    writeAllow: string[];
    writeDeny: string[];
    resolveSymlinks: boolean;
  };

  audit: {
    logBlocked: boolean;
    logFile?: string;
  };
}
```

### 7.3 默认值

```json
{
  "enabled": true,
  "commandGuard": {
    "enabled": true,
    "additionalDenyPatterns": [],
    "allowPatterns": [],
    "blockObfuscation": true
  },
  "pathGuard": {
    "enabled": true,
    "readAllow": [],
    "readDeny": [],
    "writeAllow": [],
    "writeDeny": [],
    "resolveSymlinks": true
  },
  "audit": {
    "logBlocked": true
  }
}
```

### 7.4 配置原则

- `allowPatterns` 只应用于 `bash` 命令守卫，不应用于文件工具
- 路径放宽应以目录前缀为主，不支持随意 glob
- `attach` 不继承一般 `readAllow`
- 配置只能放宽受支持范围，不能关闭基础敏感路径 deny
- 主目录默认已允许访问，因此常见配置主要用于补充 deny 或放开少量系统路径

---

## 八、错误信息与审计

### 8.1 错误信息

阻断时返回结构化、可行动的信息：

```text
Command blocked [destructive-file-op]
Reason: recursive forced deletion is not allowed
Rule: rm-rf
```

```text
Path blocked [write-sensitive-path]
Reason: writing to a sensitive or disallowed path is not allowed
Resolved path: /home/user/.ssh/authorized_keys
```

要求：

- 输出最终解析路径
- 不泄露额外敏感文件内容
- 文案简洁，可直接展示给模型和日志

### 8.2 审计日志

建议记录：

- 时间
- 工具名
- 原始输入
- 解析后的路径或命令原子片段
- 阻断类别
- 触发规则
- channelId

默认日志位置：

```text
<workspace>/.pipiclaw/security.log
```

---

## 九、实现步骤

### 9.1 第一步：建立类型与配置

新增：

- `src/security/types.ts`
- `src/security/config.ts`

内容：

- `SecurityConfig`
- `CommandGuardResult`
- `PathGuardResult`
- 默认配置
- 工作区配置加载与校验

### 9.2 第二步：实现路径守卫

新增：

- `src/security/path-guard.ts`

内容：

- 路径净化
- `~` 展开
- workspace 相对路径解析
- `realpath` 处理
- allow / deny 判断
- 符号链接写入防护

### 9.3 第三步：接入文件工具前置校验

- `src/tools/read.ts`
- `src/tools/edit.ts`
- `src/tools/write-content.ts`
- `src/tools/attach.ts`

目标：

- 保持现有 shell 驱动实现方式
- 在执行 shell 命令前统一经过 `pathGuard`
- `edit` 的读取与写回分别按 `read` / `write` 校验
- `write-content.ts` 在 `mkdir -p` 和 `cat > path` 前完成目标路径与父目录检查

### 9.4 第四步：实现命令守卫

新增：

- `src/security/command-guard.ts`

内容：

- 轻量命令拆分
- 标准化
- 分类规则匹配
- 返回结构化阻断结果

### 9.5 第五步：接入 bash 工具

修改：

- `src/tools/bash.ts`

流程：

1. 调用 `guardCommand(command, config)`
2. 若阻断，返回明确错误
3. 若允许，再执行 `executor.exec()`

### 9.6 第六步：接入工具工厂

修改：

- `src/tools/index.ts`
- 必要时修改构造参数类型

把 `workspaceDir`、`channelDir`、security config 注入到工具层。

### 9.7 第七步：增加审计日志

新增：

- `src/security/logger.ts`

要求：

- 阻断日志不影响主流程
- 写日志失败不能让工具本身失败

---

## 十、测试设计

### 10.1 新增测试文件

```text
test/security-command-guard.test.ts
test/security-path-guard.test.ts
test/security-config.test.ts
test/security-bypass.test.ts
test/tool-security-read-write.test.ts
test/tool-security-bash.test.ts
```

### 10.2 命令守卫测试

应放行：

- `rm file.txt`
- `rm -f temp.log`
- `npm install`
- `git push`
- `python3 -c "print(42)"`
- `docker build .`
- `chmod 644 file.txt`

应拦截：

- `rm -rf /`
- `echo hi; rm -rf /`
- `echo hi && shutdown now`
- `$(rm -rf /)`
- `` `rm -rf /` ``
- `/bin/rm -rf /`
- `echo xxx | base64 -d | bash`
- `r\\m -rf /`

### 10.3 路径守卫测试

应放行读取：

- `<workspace>/src/main.ts`
- `<workspace>/<channel>/SESSION.md`
- `~/notes/todo.md`
- `~/projects/other-repo/README.md`
- `/tmp/pipiclaw-test.txt`

应拦截读取：

- `~/.ssh/id_rsa`
- `~/.aws/credentials`
- `/etc/shadow`
- 指向 `~/.ssh/id_rsa` 的 workspace 内符号链接

应放行写入：

- `<workspace>/output.txt`
- `<workspace>/events/task.json`
- `~/notes/daily.md`
- `~/projects/other-repo/tmp.txt`
- `/tmp/scratch.txt`

应拦截写入：

- `/etc/passwd`
- `~/.ssh/authorized_keys`
- `~/.bashrc`
- 指向 `/etc/passwd` 的 workspace 内符号链接

### 10.4 工具级集成测试

需要覆盖：

- `read` 被路径守卫阻断
- `write` 被路径守卫阻断
- `edit` 读写都受路径守卫约束
- `attach` 只能上传 workspace 文件
- `bash` 在高风险命令上被阻断
- 正常 workspace 内操作不受影响
- 现有 shell 命令构造方式未被破坏

### 10.5 回归重点

- 不破坏现有 `tool-read`, `tool-write`, `edit`, `bash` 正常测试语义
- 不影响 memory/runtime/event 相关行为
- host 与 docker 模式都应保持一致的工具层安全判断

---

## 十一、兼容性与取舍

### 11.1 为什么默认允许整个主目录

Pipiclaw 不是只服务于单一仓库的一次性 CLI，而是长期工作的助手。把能力严格收敛到 workspace 会明显削弱它处理用户主目录下多个项目、笔记、脚本和日常工作文件的价值。

因此本设计默认允许访问 `~/` 中的普通文件。

但“允许主目录访问”不等于“允许读取和修改主目录中的一切内容”。主目录里的凭据、私钥、浏览器资料、认证配置与 keychain 仍然由 deny 清单显式排除。

### 11.2 为什么不让 command guard 精确解析所有路径

因为 shell 语法面过大。尝试从 `bash` 字符串中完整恢复路径语义，复杂度高且误判多。相比之下，显式文件工具更适合作为精确授权入口。

### 11.3 为什么本轮不改底层文件实现

因为本轮目标是补安全防护，而不是重构工具实现。把文件工具迁移到 Node `fs` 会引入额外行为变化与回归面，包括：

- 文本与二进制读取路径的兼容性变化
- shell 相关错误信息与退出码行为变化
- 现有测试与工具语义需要重新校准

因此本轮采用“在现有实现前增加 guard”的最小改动策略。

同时应接受一个现实限制：

- 在保持 `cat > path` 的前提下，无法做到最强的原子写入防护
- 这意味着本轮主要解决的是默认越权访问与常见绕过，而不是所有底层竞态问题

---

## 十二、最终建议

建议按以下优先级推进：

1. 先实现 `pathGuard` 并接入 `read` / `write` / `edit` / `attach`
2. 再实现 `commandGuard` 并接入 `bash`
3. 最后补审计日志和工作区可配置放宽

原因：

- 文件工具的越权风险最明确、最容易精确收敛
- `bash` 的命令阻断更像附加保险，不应先于路径控制

本设计完成后，Pipiclaw 的安全模型将从“prompt 约束为主”升级为“工具层硬约束为主，prompt 约束为辅”。

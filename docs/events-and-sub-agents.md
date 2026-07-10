# 事件与子代理使用指南（Events and Sub-Agents Guide）

这份文档讲的是 Pipiclaw 的两类长期能力：

- 定时事件（events）
- 预定义子代理（sub-agents）

它们都放在 app home 下的 `workspace/` 中。默认路径是 `~/.pi/pipiclaw/workspace/`；如果设置了 `PIPICLAW_HOME`，则对应为 `${PIPICLAW_HOME}/workspace/`。这些内容已经不只是“把配置填完整”这么简单，而是会直接影响你如何日常使用 Pipiclaw。

如果你还没有完成钉钉和模型配置，请先看 [README](../README.md) 和 [configuration.md](./configuration.md)。

## 总览（Overview）

| 能力 | 目录 | 适合做什么 |
|------|------|------------|
| 定时事件 | `workspace/events/` | 提醒、巡检、定期回顾、固定时间触发任务 |
| 预定义子代理 | `workspace/sub-agents/` | 把 reviewer、researcher、planner 等角色沉淀成可复用能力 |

## 定时事件（Events）

### 它是什么（What It Is）

在 `~/.pi/pipiclaw/workspace/events/` 中放入一个 `.json` 文件，运行中的 Pipiclaw 就会读取它，并把它转成一条发给指定会话通道（channel）的事件消息。

适合的场景：

- 每天固定时间提醒
- 每周回顾记忆文件
- 某个时间点的一次性跟进
- 周期性的值班检查或日报提醒

### 支持的事件类型（Supported Event Types）

| 类型 | 说明 | 是否自动删除 |
|------|------|--------------|
| `immediate` | 进程看到文件后立即触发 | 是 |
| `one-shot` | 在指定时间触发一次 | 是 |
| `periodic` | 按 cron 周期触发 | 否 |

### 通用字段（Common Fields）

三类事件都需要下面三个字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | `immediate`、`one-shot` 或 `periodic` |
| `channelId` | 是 | 目标会话通道 ID，例如 `dm_<staffId>` 或 `group_<conversationId>` |
| `text` | 是 | 事件触发后发送给 Pipiclaw 的文本内容 |
| `preAction` | 否 | 触发前执行的动作门控，见下方说明 |

### 事件动作门控（Action Gate）

事件支持一个可选的 `preAction` 字段，用于在将事件发给LLM之前执行一段确定性脚本。脚本退出码决定事件是否入队：

- **退出码 0**：条件满足，事件正常入队给LLM处理
- **非0退出码**：条件不满足，事件被静默跳过

这比让LLM自行判断更可靠（不消耗token），也比依赖 `[SILENT]` 机制更彻底（不会启动LLM会话）。

`preAction` 字段结构：

| 字段 | 必填 | 说明 |
|------|------|------|
| `preAction.type` | 是 | 目前仅支持 `"bash"` |
| `preAction.command` | 是 | 要执行的shell命令，不能为空 |
| `preAction.timeout` | 否 | 超时毫秒数，默认 10000（10秒） |

示例：只在本周最后一个工作日触发周报提醒（考虑到节假日调休，最后一个工作日需要使用代码逻辑来判断，比起使用大模型判断，既保证准确又节省 token）

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "现在是本周最后一个工作日的下午，请帮我整理本周周报。",
  "schedule": "0 16 * * 1-5",
  "timezone": "Asia/Shanghai",
  "preAction": {
    "type": "bash",
    "command": "node ~/.pi/pipiclaw/workspace/skills/check-last-workday.js"
  }
}
```

注意事项：

- 没有 `preAction` 字段的事件行为完全不变
- 对于 `periodic` 事件，门控拦截仅跳过当次执行，cron调度继续运行，下次触发时重新评估
- `preAction.command` 会经过安全命令卫士（command guard）检查，危险命令会被拦截
- 脚本应尽快完成，超时会导致事件被跳过

### 事件类型 1：立即事件（Immediate Event）

最适合手动触发一次任务。

```json
{
  "type": "immediate",
  "channelId": "dm_your-staff-id",
  "text": "整理当前会话的 MEMORY.md，把过时内容删掉。"
}
```

说明：

- 文件被检测到后会尽快执行
- 事件入队成功后，文件会被自动删除
- 如果这是进程启动前遗留的旧文件，Pipiclaw 会把它当成过期事件并删除

### 事件类型 2：单次事件（One-Shot Event）

最适合未来某个时间点的一次性提醒。

```json
{
  "type": "one-shot",
  "channelId": "dm_your-staff-id",
  "text": "提醒我检查今天的发布结果。",
  "at": "2026-04-03T18:00:00+08:00"
}
```

额外字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `at` | 是 | 带时区偏移的 ISO 8601 时间 |

说明：

- `at` 必须是将来的时间
- 时间非法、已经过去，或超出 Node.js 定时器支持范围时，文件会被删除
- 触发成功后文件会自动删除

### 事件类型 3：周期事件（Periodic Event）

最适合固定频率的例行任务。

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "回顾本周的 MEMORY.md，清理过时项并补充缺失的稳定事实。",
  "schedule": "0 9 * * 1",
  "timezone": "Asia/Shanghai"
}
```

额外字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `schedule` | 是 | 推荐使用五段 cron：分钟 小时 日 月 星期 |
| `timezone` | 是 | IANA 时区，例如 `Asia/Shanghai` |

说明：

- 周期事件不会自动删除；要停用时，直接删除对应 `.json` 文件
- 修改文件内容后，运行中的 Pipiclaw 会重新装载这条事件
- 如果 cron 表达式不合法，文件会被删除

### 常见 cron 示例（Common Cron Examples）

建议统一使用五段 cron。底层解析器对部分六段格式也能处理，但为了降低歧义，不建议在团队里混用。

| 表达式 | 含义 |
|--------|------|
| `0 9 * * 1-5` | 工作日每天 09:00 |
| `0 18 * * 5` | 每周五 18:00 |
| `0 3 * * 0` | 每周日 03:00 |
| `30 10 1 * *` | 每月 1 日 10:30 |

### 通过 Slash Command 管理事件（Event Slash Commands）

钉钉渠道中可以用 `/events` 查看和删除现有事件。第一版只支持管理已有文件，不支持通过命令创建或更新事件；需要新增或修改事件时，仍然直接编辑 `workspace/events/*.json`。

支持的命令：

| 命令 | 说明 |
|------|------|
| `/events list` | 列出事件文件名、类型、`channelId`、`schedule` / `at` 和文本预览 |
| `/events show <name>` | 展示 `workspace/events/<name>.json` 的完整 JSON |
| `/events delete <name>` | 删除对应事件文件 |
| `/events history [name]` | 读取最近的事件调度历史；传入 `name` 时只显示该事件 |

事件名只允许普通文件名字符：字母、数字、`.`、`_`、`-`。可以写 `weekly-review` 或 `weekly-review.json`，Pipiclaw 会统一归一化为同一个事件名。命令不会访问 `workspace/events/` 之外的路径。

### `channelId` 怎么写（How to Find `channelId`）

常见形态：

- 私聊：`dm_<staffId>`
- 群聊：`group_<conversationId>`

如果你已经和机器人正常对话过，Pipiclaw 会在 `workspace/` 下创建对应的会话通道目录。目录名通常就能帮助你定位 `channelId`。

### 周期事件的静默规则（Silent Completion for Periodic Events）

对于周期事件，如果这次检查“没有需要汇报的内容”，可以让 Pipiclaw 只返回：

```text
[SILENT]
```

这适合：

- 巡检没有异常时不刷屏
- 定期检查没有新结果时不打扰用户

### 调度历史记录（Event History）

### 可靠投递与恢复

event 触发后不会直接依赖内存 queue：runtime 会先把 synthetic event 写入 app home 的 `state/dispatch/`，再尝试入队。handler 开始时取得 lease，正常完成后删除记录；进程在入队后或执行中退出，重启后的 runtime 会重新投递 lease 已过期的记录。因此语义是 **at-least-once**：任务与 event handler 应保持可重试，外部动作应在 task 的显式授权与自身幂等约束下执行。

已错过的 one-shot 会在 watcher 恢复时补执行一次，而不是因时间已过静默删除。周期 event 不补跑全部历史 occurrence，仍按下一次 cron 节奏触发。

Pipiclaw 会把事件调度层的审计记录写入：

```text
~/.pi/pipiclaw/state/events/history.jsonl
```

如果设置了 `PIPICLAW_HOME`，则写入对应 app home 下的 `state/events/history.jsonl`。

该文件是 JSON Lines，每行记录一次调度动作，例如：

- 事件文件加载成功或解析失败
- `one-shot` / `periodic` 被安排调度
- 事件到达触发点
- `preAction` 通过、阻止或执行失败
- synthetic event 成功入队或遇到队列满
- 事件文件被删除或调度被取消

示例：

```json
{"ts":"2026-06-25T10:00:00.123+08:00","eventName":"weekly-review","eventPath":"/Users/me/.pi/pipiclaw/workspace/events/weekly-review.json","eventType":"periodic","channelId":"dm_123","action":"enqueued","result":"ok","schedule":"0 10 * * 1","timezone":"Asia/Shanghai","textPreview":"检查当前 workspace 和 channel 的 MEMORY.md...","queue":{"accepted":true}}
```

说明：

- `ts` 使用本地时区时间，不使用 UTC `Z` 时间。
- `history.jsonl` 只记录调度层行为，不记录 agent 最终回复；最终对话结果仍在对应 channel 的 `log.jsonl` / `context.jsonl` 中。
- 为避免泄露过多业务内容，记录中只保存 `textPreview`，不会保存完整事件文本。
- 文件会在事件 watcher 启动或首次写入时自动创建。

### 推荐场景（Recommended Patterns）

#### 1. 每周记忆整理

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "检查当前 workspace 和 channel 的 MEMORY.md，删除过时项、合并重复项，并补充长期有效的事实。",
  "schedule": "0 10 * * 1",
  "timezone": "Asia/Shanghai"
}
```

#### 2. 发布后一次性跟进

```json
{
  "type": "one-shot",
  "channelId": "dm_your-staff-id",
  "text": "检查今天发布后的错误反馈和回滚风险。",
  "at": "2026-04-03T21:30:00+08:00"
}
```

#### 3. 工作日早间提醒

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "列出今天最需要跟进的待办、未完成事项和风险点。",
  "schedule": "0 9 * * 1-5",
  "timezone": "Asia/Shanghai"
}
```

#### 4. 带条件门控的周报提醒

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "现在是本周最后一个工作日的下午，请帮我整理本周周报。",
  "schedule": "0 16 * * 1-5",
  "timezone": "Asia/Shanghai",
  "preAction": {
    "type": "bash",
    "command": "node ~/.pi/pipiclaw/workspace/skills/check-last-workday.js"
  }
}
```

### 常见问题（Common Mistakes）

- 文件不是 `.json`
- `channelId` 写错，写成用户名、群名或其他业务字段
- `one-shot` 的 `at` 没带时区偏移
- `periodic` 的 `schedule` 写成六段或其他不兼容格式
- 指望 `periodic` 事件自动删除文件
- `preAction.command` 为空字符串
- `preAction.type` 写成 `bash` 以外的值
- `preAction.timeout` 设得太短，脚本来不及执行完

## `event_manage` 工具（Agent 自调度）

前面讲的都是**你**（人）如何管理事件：手工编辑 `workspace/events/*.json`，或用 `/events` 命令查看删除。`event_manage` 则是给**主 agent** 的一等工具，让它能创建、修改、删除周期节奏、独立提醒和外部传感器。任务台账的普通继续、等待和异常恢复已经由[内建 task driver](./tasks.md#内建-task-driver)根据 `wake` 驱动，不再需要为每个等待点创建 one-shot check-in。

### 与 `/events` 命令的分工

| | 谁用 | 能做什么 |
|---|------|----------|
| `/events` 命令 | 人（钉钉侧） | list / show / delete / history —— 只读 + 删除 |
| `event_manage` 工具 | 主 agent | create / update / delete —— 带写入时校验 |
| 手工编辑 `*.json` | 人 | 任意增改，不受工具的约束闸门限制 |

三者操作的是**同一个** `workspace/events/` 目录，互不冲突。

### 参数

| 字段 | 必填 | 说明 |
|------|------|------|
| `label` | 是 | 一句话说明这次调度改动（展示给用户） |
| `action` | 是 | `create` / `update` / `delete` |
| `name` | 是 | 事件名（不含 `.json`）。任务派生事件请用 `task.<channelId>.<taskId>.<用途>`，如 `task.dm_123.weekly-report.schedule` |
| `definition` | create/update 必填 | 完整事件 JSON（字符串）。`channelId` 可省略，默认填当前 channel |

### 写入时校验（工具的核心价值）

裸用 `write` 工具写事件 JSON 有个隐患：格式错误的文件会被 watcher **静默删除**，agent 以为安排好了回访，实际什么都没留下。`event_manage` 在**落盘前**就把问题拦下并大声报错：

1. **结构校验**：`definition` 必须能通过与 watcher 相同的 `parseScheduledEventContent`——工具写出的文件必然可被装载。
2. **路径安全**：`name` 经 traversal 拦截（拒绝 `../` 等越界），字符集限定 `[A-Za-z0-9._-]`。
3. **channel 所有权**：`definition.channelId` 必须等于当前 channel；update/delete 前会读取目标文件校验归属，一个 channel 不能操纵或打扰其他 channel 的事件。
4. **`preAction` 安全**：命令写入时即过 `command-guard`，被拦截则整个操作失败（触发时的检查仍保留）。
5. **防自激励闸门**（防止 agent 把自己拖入烧 token 的自唤醒循环）：
   - 禁止 `immediate` 类型（create 与 update 双侧）——当下能做的事就在当前回合做完；
   - `one-shot` 的 `at` 必须至少晚于现在 2 分钟；
   - `periodic` 的 cron 最密每 **30 分钟**一次；**带 `preAction` 门控时放宽到最密每 5 分钟**——传感器忙时静默、零 token，是完成驱动检查（如轮询 agentmux 实例直到空闲，见 [tasks.md](./tasks.md#agentmux-完成驱动回访)）的正确形态；硬子下限仍是 5 分钟；
   - `workspace/events/` 内事件文件数达到 50 时拒绝再 create。

> 用户手工编辑 `*.json` 或用 `/events` 不受这些闸门限制——它们只约束 agent 的自调度。
> 注意：第 4 条的两道 guard 检查都以 `security.json` 里 `commandGuard.enabled` 为前提；全局关闭 command guard 时，写入时与触发时的检查都不生效（这是既有安全语义）。

### 典型用法

安排一个与 task 无关的独立提醒：

```json
{
  "type": "one-shot",
  "text": "提醒我检查季度预算。",
  "at": "2026-07-08T14:00:00+08:00"
}
```

为一个新周期任务安排节奏（periodic）：

```json
{
  "type": "periodic",
  "text": "推进任务 weekly-report。",
  "schedule": "30 9 * * 1",
  "timezone": "Asia/Shanghai"
}
```

完整的任务生命周期、事件命名约定、以及 agent 该在什么时机调用这个工具，见 [tasks.md](./tasks.md)。

## 子代理（Sub-Agents）

### 它是什么（What It Is）

预定义子代理是放在 `~/.pi/pipiclaw/workspace/sub-agents/*.md` 中的 Markdown 文件。主代理在合适的时候可以调用它们，把某类任务交给更聚焦的角色处理。

适合的场景：

- 代码审查
- 信息收集
- 风险检查
- 某类固定格式的总结

不适合的场景：

- 只需要主代理顺手完成的一步小事
- 需要继续递归创建下级代理的复杂代理树

### 最小示例（Minimal Example）

文件：`~/.pi/pipiclaw/workspace/sub-agents/reviewer.md`

```md
---
name: reviewer
description: Review code changes for correctness, regressions, and missing tests
tools: read,bash
contextMode: contextual
memory: relevant
paths:
  - src/
  - test/
maxTurns: 24
maxToolCalls: 48
maxWallTimeSec: 300
bashTimeoutSec: 120
---

You are a focused code reviewer.

Review the code or task given to you.
Prioritize correctness issues, regressions, risky assumptions, and missing tests.
Keep findings concise and actionable.
```

### 文件结构（File Structure）

一个子代理文件由两部分组成：

1. YAML frontmatter：定义名字、描述、模型、工具和限制
2. Markdown 正文：作为这个子代理的系统提示词（system prompt）

### Frontmatter 字段说明（Frontmatter Reference）

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | - | 子代理名称，必须唯一 |
| `description` | 是 | - | 给主代理看的简短用途描述 |
| `tools` | 否 | `read,bash` | 允许的工具，支持 `read`、`bash`、`edit`、`write` |
| `model` | 否 | 当前主代理模型 | 精确模型引用，建议写成 `provider/modelId` |
| `contextMode` | 否 | `isolated` | `isolated` 或 `contextual` |
| `memory` | 否 | `isolated` 时为 `none`，`contextual` 时为 `relevant` | `none`、`session`、`relevant` |
| `paths` | 否 | 空 | 建议优先关注的文件或目录 |
| `maxTurns` | 否 | `24` | 最大 assistant 轮数 |
| `maxToolCalls` | 否 | `48` | 最大工具调用次数 |
| `maxWallTimeSec` | 否 | `300` | 最大总执行时长，秒 |
| `bashTimeoutSec` | 否 | `120` | 子代理内 bash 命令默认超时，秒 |

### 关键字段怎么理解（How to Use the Key Fields）

#### `tools`

建议尽量收窄，而不是一上来给满。

常见组合：

- `read,bash`：只读检查、分析、审查
- `read,edit,write,bash`：需要实际修改文件

#### `contextMode`

| 值 | 含义 |
|----|------|
| `isolated` | 默认值，不自动带入主会话上下文 |
| `contextual` | 自动注入一小部分相关会话 / 记忆上下文 |

如果子代理需要理解当前任务背景，通常用 `contextual` 更合适。

#### `memory`

| 值 | 含义 |
|----|------|
| `none` | 不注入额外记忆 |
| `session` | 注入会话工作态摘要 |
| `relevant` | 注入筛选后的相关记忆与上下文 |

推荐：

- 代码审查、研究类：`contextMode: contextual` + `memory: relevant`
- 单点执行类：`contextMode: isolated` + `memory: none`

#### `model`

如果要指定，建议使用精确模型引用，例如：

```text
anthropic/claude-sonnet-4-5
my-gateway/gpt-4.1
```

如果引用不唯一或模型不存在，这个子代理定义会被忽略。

### 正文怎么写（System Prompt Body）

frontmatter 后面的正文就是子代理的系统提示词。它应该明确说明：

- 这个角色的职责
- 优先级和判断标准
- 输出风格
- 不该做什么

建议写法：

- 聚焦单一职责
- 避免把项目级通用规则重复写进每个子代理
- 把真正稳定的规则留在 `AGENTS.md`

### 运行时规则（Runtime Rules）

- 子代理没有 `subagent` 工具，不能继续创建下一级代理
- 默认 `isolation: shared`：只隔离对话上下文，文件系统与主代理共享
- `isolation: worktree` + `taskId`：host sandbox 下从 committed HEAD 创建 task-owned git worktree；runtime 自动把 path/branch 写回 task control，父代理负责 review、merge、cleanup。Docker 暂不支持 worktree 模式
- `purpose: verify` + `taskId`：进入独立验收协议，去掉 write/edit 工具，检测 verifier 期间的 git workspace 变化，并要求最后一行明确 `VERDICT: PASS|FAIL`
- verifier attestation 直接持久化到 `<channel>/tasks/.verifications/`，主代理用返回的 runId 调 `task_manage verify`；普通运行摘要仍写 `<channel>/subagent-runs.jsonl`
- worktree 只包含 committed HEAD；委派前必须处理好子任务依赖的未提交变更

### 推荐写法（Recommended Presets）

#### 1. Reviewer

适合：

- 审查改动
- 找回归风险
- 补测试建议

推荐字段：

- `tools: read,bash`
- `contextMode: contextual`
- `memory: relevant`
- `paths: src/, test/`

#### 2. Researcher

适合：

- 收集代码现状
- 列出候选方案
- 做只读分析

推荐字段：

- `tools: read,bash`
- `contextMode: contextual`
- `memory: relevant`

#### 3. Worker

适合：

- 执行边界清晰的局部改动

推荐字段：

- `tools: read,edit,write,bash`
- `contextMode: contextual`
- `memory: relevant`
- `paths` 明确写出负责的目录

### 常见问题（Common Mistakes）

- 缺少 `name` 或 `description`
- 同一个目录里定义了重复的 `name`
- `tools` 写了不支持的工具名
- `contextMode` 或 `memory` 写了不支持的值
- 正文为空，只有 frontmatter
- `model` 只写了模糊名字，结果无法精确匹配

## 什么时候该看哪份文档（Which Doc to Read Next）

- 想查 `channel.json`、`auth.json`、`models.json`、`settings.json`：看 [configuration.md](./configuration.md)
- 想把 Pipiclaw 长期跑在服务器上：看 [deployment-and-operations.md](./deployment-and-operations.md)

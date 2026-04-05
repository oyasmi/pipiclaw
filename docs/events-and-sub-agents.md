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

### 常见问题（Common Mistakes）

- 文件不是 `.json`
- `channelId` 写错，写成用户名、群名或其他业务字段
- `one-shot` 的 `at` 没带时区偏移
- `periodic` 的 `schedule` 写成六段或其他不兼容格式
- 指望 `periodic` 事件自动删除文件

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
- 子代理隔离的是对话上下文，不隔离文件系统
- 预定义子代理和主代理共享同一个工作区
- 运行摘要会记录到 `<channel>/subagent-runs.jsonl`

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

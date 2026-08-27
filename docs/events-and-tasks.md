# 事件与任务（Events and Tasks）

这份文档讲 Pipiclaw 的两层长程能力，它们合起来让 Pipiclaw 从"被动应答的聊天机器人"变成"能被时间和台账驱动、带着进度本干活"的助手：

- **定时事件（events）** 回答**"什么时候唤醒 agent"**——一个无状态的时间原语。
- **任务台账（tasks）** 回答**"有哪些在途工作、进展到哪、验收标准是什么"**——事件缺失的那块持久记忆。

两者由 runtime 协调，但各自独立：**内建 task driver** 依据任务的 `wake` 时间恢复工作、并按任务的 `schedule` cron 开启新周期；事件 watcher 负责与任务无关的提醒和外部传感器。任务不需要配套事件才能继续。

> 一句话记忆：**event 无记忆，只管定时；task 会积累手艺、自带节奏；driver 按 wake / schedule 驱动任务。**

如果你还没完成钉钉和模型配置，请先看 [README](../README.md) 和 [configuration.md](./configuration.md)。子代理（sub-agents）是另一条正交的**委派**能力，见 [sub-agents.md](./sub-agents.md)。

## 怎么读这份文档（Reading Guide）

本文覆盖三类读者，按需跳读，不必从头到尾：

| 你想做什么 | 从哪读起 |
|---|---|
| 用 `/events`、`/tasks` 查看和管理已有的事件与任务 | [`/events` 命令](#events-命令人用只读--删除)、[任务可见性与命令](#可见性与命令) |
| 手写一个事件 JSON，或看懂 agent 建的那个 | [支持的事件类型](#支持的事件类型supported-event-types)、[通用字段](#通用字段common-fields) |
| 看懂任务文件的格式与 frontmatter 契约 | [任务模型](#任务模型)、[Frontmatter 契约](#frontmatter-契约) |
| 排查“没有按时触发 / 任务没被推进” | [调度历史记录](#调度历史记录event-history)、[异常恢复](#异常恢复)、[部署排障](./deployment-and-operations.md#常见运维问题common-operational-issues) |
| 理解 driver 的调度与治理机制 | [内建 task driver](#内建-task-driver-与-governor)、[Control 与恢复事实](#control-与恢复事实) |

agent 侧的操作纪律不在本文，而在随包发布的 runtime playbook 里，见 [runtime-playbooks.md](./runtime-playbooks.md)。

## 心智模型（Mental Model）

| 层 | 载体 | 持有什么 | 谁维护 |
|----|------|----------|--------|
| **tasks** | `workspace/<channelId>/tasks/*.md` | 意图、DoD、手册、状态、周期日志、下一次 `wake`、周期 `schedule` | 主 agent 经 `task_create`/`task_update`/`task_close`/`task_verify` 维护 |
| **task driver** | runtime 确定性扫描 | 找出已到点 / 可继续 / 该开新周期的任务并唤醒对应 channel | Pipiclaw runtime，扫描本身零 token |
| **events** | `workspace/events/*.json` | 非 task 的独立提醒、外部传感器 | 人（手工 / `/events`）或主 agent（`event_manage`）维护 |

三层文件都放在 app home 下的 `workspace/` 中。默认路径 `~/.pipiclaw/workspace/`；若设置了 `PIPICLAW_HOME`，则为 `${PIPICLAW_HOME}/workspace/`。

**为什么需要两层。** 只有事件时，每次唤醒都是无状态的：agent 醒来只知道事件文本那一句话，不知道有哪些在途工作、上次做到哪、验收标准是什么——触发一次就归零。任务台账补上这块记忆，让工作变成：

> 醒来 → 查看在途工作 → 推进最需要推进的一项 → 记下状态和下次检查点 → 睡去。

下面先讲底层的**事件**，再讲其上的**任务台账**，最后用一个完整周期演示两者如何协作。

---

# 第一部分：定时事件（Events）

## 它是什么（What It Is）

在 `~/.pipiclaw/workspace/events/` 中放入一个 `.json` 文件，运行中的 Pipiclaw 就会读取它，并把它转成一条发给指定会话通道（channel）的事件消息。

适合的场景：

- 每天固定时间提醒
- 每周回顾记忆文件
- 某个时间点的一次性跟进
- 周期性的值班检查或日报提醒

## 支持的事件类型（Supported Event Types）

| 类型 | 说明 | 是否自动删除 |
|------|------|--------------|
| `one-shot` | 在指定时间触发一次 | 是 |
| `periodic` | 按 cron 周期触发 | 否 |

## 通用字段（Common Fields）

两类事件都需要下面几个字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | `one-shot` 或 `periodic` |
| `channelId` | 是 | 目标会话通道 ID，例如 `dm_<staffId>` 或 `group_<conversationId>` |
| `text` | 是 | 事件触发后发送给 Pipiclaw 的文本内容 |
| `preAction` | 否 | 触发前执行的动作门控，见下方说明 |

各类型的专属字段（`at`、`schedule`）在下面对应小节列出。cron 一律按主机时区解释，没有 `timezone` 字段。

## 事件动作门控（Action Gate）

事件支持一个可选的 `preAction` 字段，用于在把事件发给 LLM 之前执行一段确定性脚本。脚本退出码决定事件是否入队：

- **退出码 0**：条件满足，事件正常入队给 LLM 处理
- **非 0 退出码**：条件不满足，事件被静默跳过

这比让 LLM 自行判断更可靠（不消耗 token），也比依赖 `[SILENT]` 机制更彻底（不会启动 LLM 会话）。

`preAction` 字段结构：

| 字段 | 必填 | 说明 |
|------|------|------|
| `preAction.type` | 是 | 目前仅支持 `"bash"` |
| `preAction.command` | 是 | 要执行的 shell 命令，不能为空 |
| `preAction.timeout` | 否 | 超时毫秒数，默认 10000（10 秒） |

示例：只在本周最后一个工作日触发周报提醒（考虑到节假日调休，最后一个工作日需要用代码逻辑判断，比让大模型判断既准确又省 token）：

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "现在是本周最后一个工作日的下午，请帮我整理本周周报。",
  "schedule": "0 16 * * 1-5",
  "preAction": {
    "type": "bash",
    "command": "node ~/.pipiclaw/workspace/skills/check-last-workday.js"
  }
}
```

注意事项：

- 没有 `preAction` 字段的事件行为完全不变。
- 对于 `periodic` 事件，门控拦截仅跳过当次执行，cron 调度继续运行，下次触发时重新评估。
- `preAction.command` 会经过安全命令卫士（command guard）检查，危险命令会被拦截。
- 脚本应尽快完成，超时会导致事件被跳过。

Pipiclaw 只定义 preAction 的退出码门控，不捆绑第三方工具的检测脚本或状态协议。工具专属命令应由用户层可执行文件和 workspace skill 提供。

## 两类事件详解（The Two Event Types）

### Immediate 已退役

旧版本的 `immediate` 事件已经退役。当前回合能完成的事应直接在当前回合完成；需要未来唤醒时使用 `one-shot`，需要周期检查时使用 `periodic`。

### 单次事件（One-Shot）

最适合未来某个时间点的一次性提醒。额外字段 `at`（本地时间，必填；建议带偏移如 `+08:00`，省略则按主机时区解释）：

```json
{
  "type": "one-shot",
  "channelId": "dm_your-staff-id",
  "text": "提醒我检查今天的发布结果。",
  "at": "2026-04-03T18:00:00+08:00"
}
```

- `at` 必须是将来的时间。
- 时间非法、已经过去，或超出 Node.js 定时器支持范围时，文件会被删除（错过的补执行语义见下方[可靠投递与恢复](#可靠投递与恢复)）。
- 触发成功后文件会自动删除。

### 周期事件（Periodic）

最适合固定频率的例行任务。额外字段 `schedule`（cron 表达式，必填）。cron 按**主机时区**解释，没有 `timezone` 字段：

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "回顾本周的 MEMORY.md，清理过时项并补充缺失的稳定事实。",
  "schedule": "0 9 * * 1"
}
```

- 周期事件不会自动删除；要停用时，直接删除对应 `.json` 文件。
- 修改文件内容后，运行中的 Pipiclaw 会重新装载这条事件。
- 如果 cron 表达式不合法，文件会被删除。
- 旧文件里残留的 `timezone` 字段会被忽略（不视为解析错误、不删文件）；若它与主机时区不一致，会在 `history.jsonl` 记一条 warning 提示触发时刻可能偏移。

**常见 cron 示例**——建议统一使用五段 cron（分钟 小时 日 月 星期）。底层解析器对部分六段格式也能处理，但为降低歧义，不建议在团队里混用。

| 表达式 | 含义 |
|--------|------|
| `0 9 * * 1-5` | 工作日每天 09:00 |
| `0 18 * * 5` | 每周五 18:00 |
| `0 3 * * 0` | 每周日 03:00 |
| `30 10 1 * *` | 每月 1 日 10:30 |

## 周期事件的静默规则（Silent Completion）

对于周期事件，如果这次检查"没有需要汇报的内容"，可以让 Pipiclaw 只返回：

```text
[SILENT]
```

这适合巡检无异常、定期检查无新结果时不刷屏、不打扰用户。

## 可靠投递与恢复

event 触发后不直接依赖内存 queue：runtime 会先把 synthetic event 写入 app home 的 `state/dispatch/`，再尝试入队。handler 开始时取得 lease，正常完成后删除记录；进程在入队后或执行中退出，重启后的 runtime 会重新投递 lease 已过期的记录。因此语义是 **at-least-once**：事件 handler 应保持可重试，外部动作应在自身幂等约束下执行。

已错过的 one-shot 会在 watcher 恢复时补执行一次，而不是因时间已过静默删除。周期 event 不补跑全部历史 occurrence，仍按下一次 cron 节奏触发。

## 调度历史记录（Event History）

Pipiclaw 会把事件调度层的审计记录写入：

```text
~/.pipiclaw/state/events/history.jsonl
```

（设置了 `PIPICLAW_HOME` 时写入对应 app home 下的 `state/events/history.jsonl`。）

该文件是 JSON Lines，每行记录一次调度动作，例如：事件文件加载成功或解析失败、`one-shot` / `periodic` 被安排调度、事件到达触发点、`preAction` 通过 / 阻止 / 执行失败、synthetic event 成功入队或遇到队列满、事件文件被删除或调度被取消。

示例：

```json
{"ts":"2026-06-25T10:00:00.123+08:00","eventName":"weekly-review","eventPath":"/Users/me/.pipiclaw/workspace/events/weekly-review.json","eventType":"periodic","channelId":"dm_123","action":"enqueued","result":"ok","schedule":"0 10 * * 1","textPreview":"检查当前 workspace 和 channel 的 MEMORY.md...","queue":{"accepted":true}}
```

说明：

- `ts` 使用本地时区时间，不使用 UTC `Z` 时间。
- `history.jsonl` 只记录调度层行为，不记录 agent 最终回复；最终对话结果仍在对应 channel 的 `log.jsonl` / `context.jsonl` 中。
- 为避免泄露业务内容，记录中只保存 `textPreview`，不保存完整事件文本。
- 文件会在事件 watcher 启动或首次写入时自动创建。

## `channelId` 怎么写（How to Find `channelId`）

常见形态：

- 私聊：`dm_<staffId>`
- 群聊：`group_<conversationId>`

如果你已经和机器人正常对话过，Pipiclaw 会在 `workspace/` 下创建对应的会话通道目录，目录名通常就能帮你定位 `channelId`。

## 谁来管理事件：三个入口

同一个 `workspace/events/` 目录有三个互不冲突的管理入口：

| 入口 | 谁用 | 能做什么 |
|------|------|----------|
| 手工编辑 `*.json` | 人 | 任意增改；最终仍由 watcher 装载校验 |
| `/events` 命令 | 人（钉钉侧） | list / show / delete / history —— 只读 + 删除 |
| `event_manage` 工具 | 主 agent | list / create / update / delete —— 带写入时校验和防自激励闸门 |

### `/events` 命令（人用，只读 + 删除）

钉钉渠道中用 `/events` 查看和删除现有事件。它只管理已有文件，不支持通过命令创建或更新；需要新增或修改时，直接编辑 `workspace/events/*.json` 或让 agent 用 `event_manage`。

| 命令 | 说明 |
|------|------|
| `/events list` | 列出事件文件名、类型、`channelId`、`schedule` / `at`（无 timezone 列）和文本预览 |
| `/events show <name>` | 展示 `workspace/events/<name>.json` 的完整 JSON |
| `/events delete <name>` | 删除对应事件文件 |
| `/events history [name]` | 读取最近的事件调度历史；传入 `name` 时只显示该事件 |

事件名只允许普通文件名字符（字母、数字、`.`、`_`、`-`）。可以写 `weekly-review` 或 `weekly-review.json`，Pipiclaw 会统一归一化。命令不会访问 `workspace/events/` 之外的路径。

### `event_manage` 工具（agent 自调度）

`event_manage` 是给**主 agent** 的一等工具，让它能列出、创建、修改、删除周期节奏、独立提醒和外部传感器。`action=list` 只返回当前 channel 的事件（每条一行，含无法解析的文件），用于在闭环或改期前核对真实事件名。它与 `/events`、手工编辑操作**同一个**目录。

**参数：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `label` | 是 | 一句话说明这次调度改动（展示给用户） |
| `action` | 是 | `list` / `create` / `update` / `delete` |
| `name` | create/update/delete 必填 | 事件名（不含 `.json`），`list` 忽略。只允许字母、数字、`.`、`_`、`-`；任务不再创建配套事件 |
| `definition` | create/update 必填 | 完整事件 JSON（字符串）。`channelId` 可省略，默认填当前 channel |

**写入时校验（工具的核心价值）。** 裸用 `write` 写事件 JSON 有个隐患：格式错误的文件会被 watcher **静默删除**，agent 以为安排好了回访，实际什么都没留下。`event_manage` 在**落盘前**就把问题拦下并大声报错：

1. **结构校验**：`definition` 必须能通过与 watcher 相同的 `parseScheduledEventContent`——工具写出的文件必然可被装载。
2. **路径安全**：`name` 经 traversal 拦截（拒绝 `../` 等越界），字符集限定 `[A-Za-z0-9._-]`。
3. **channel 所有权**：`definition.channelId` 必须等于当前 channel；update/delete 前会读取目标文件校验归属，一个 channel 不能操纵或打扰其他 channel 的事件。
4. **`preAction` 安全**：命令写入时即过 `command-guard`，被拦截则整个操作失败（触发时的检查仍保留）。
5. **防自激励闸门**（防止 agent 把自己拖入烧 token 的自唤醒循环）：
   - 禁止 `immediate` 类型（create 与 update 双侧）——当下能做的事就在当前回合做完；
   - `one-shot` 的 `at` 必须至少晚于现在 2 分钟；
   - `periodic` 的 cron 最密每 **30 分钟**一次；**带 `preAction` 门控时放宽到最密每 5 分钟**——传感器条件不成立时静默、零 token，适合调用用户已安装的稳定检测命令；硬下限仍是 5 分钟；
   - `workspace/events/` 内事件文件数达到 50 时拒绝再 create。

> 手工编辑会绕过 `event_manage` 的 channel 所有权、提前量等即时错误提示，但 watcher 仍是最终信任边界：`immediate`、过密 cron、过多事件和被 command guard 拒绝的 `preAction` 仍会被拒绝。`one-shot` 的 2 分钟提前量只用于约束 agent 写入；手工文件若是在当前进程启动前遗留且已经错过，会按可靠恢复语义补投递一次。
> 注意：第 4 条的两道 guard 检查都以 `security.json` 里 `commandGuard.enabled` 为前提；全局关闭 command guard 时，写入时与触发时的检查都不生效（这是既有安全语义）。

**典型用法。** 安排一个与 task 无关的独立提醒：

```json
{
  "type": "one-shot",
  "text": "提醒我检查季度预算。",
  "at": "2026-07-08T14:00:00+08:00"
}
```

安排一个非 task 的独立周期提醒（periodic）：

```json
{
  "type": "periodic",
  "text": "每周一早上列出本周待办。",
  "schedule": "0 9 * * 1"
}
```

任务的继续、等待、异常恢复**以及周期节奏**都由内建 task driver 根据任务文件驱动（`wake` + `schedule` frontmatter），**不要**再为任务创建配套事件；旧的任务事件与 `.schedule` 命名约定已经退役。event 层只负责与 task 无关的提醒和外部传感器，任务模型见下方[任务台账](#第二部分任务台账tasks)。

## 推荐场景（Recommended Patterns）

**每周记忆整理：**

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "检查当前 workspace 和 channel 的 MEMORY.md，删除过时项、合并重复项，并补充长期有效的事实。",
  "schedule": "0 10 * * 1"
}
```

**发布后一次性跟进：**

```json
{
  "type": "one-shot",
  "channelId": "dm_your-staff-id",
  "text": "检查今天发布后的错误反馈和回滚风险。",
  "at": "2026-04-03T21:30:00+08:00"
}
```

**工作日早间提醒：**

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "列出今天最需要跟进的待办、未完成事项和风险点。",
  "schedule": "0 9 * * 1-5"
}
```

## 常见错误（Common Mistakes）

- 文件不是 `.json`。
- `channelId` 写错，写成用户名、群名或其他业务字段。
- `one-shot` 的 `at` 没带时区偏移。
- `periodic` 的 `schedule` 写成六段或其他不兼容格式。
- 指望 `periodic` 事件自动删除文件。
- `preAction.command` 为空字符串，或 `preAction.type` 写成 `bash` 以外的值。
- `preAction.timeout` 设得太短，脚本来不及执行完。

---

# 第二部分：任务台账（Tasks）

事件解决“什么时候唤醒”，任务台账保存“为什么做、做到哪、下一步是什么”。Task 创建即持续委托：只要任务仍在活动目录且 enabled=true，runtime 会按任务状态和 wake 继续推进。外部动作不产生额外的人工作业流；模型必须遵守任务 Goal、能力配置、真实状态查询和幂等约束。

本节以 Task v3 为准。reader 只认当前契约——`control.version` 必须是 3，其他值一律 `controlReadable: false`（fail-open，交给 `/tasks doctor` 引导修复）。旧格式的兼容解析只存在于启动迁移里：daemon 每次启动都会扫描活动目录，把还停在旧 `control.version` 或旧 `status` 词表上的任务文件原地升级，不依赖一次性标记文件——所以即使是手改回旧格式的文件，也会在下一次启动时自愈。

## 任务模型

### 目录布局

```text
workspace/<channelId>/tasks/
├── weekly-report.md
├── fix-ci.md
└── archive/
    └── released-note.md
```

活动目录只包含 `active`、`waiting`、`sleeping` 三种 live status。一次性任务 complete/cancel 后移入 `archive/`，归档文件以 `outcome: completed|cancelled` 和 `closedAt` 记录结果，不再进入 driver 扫描。

### 文件格式

```markdown
---
status: waiting
enabled: true
wake: 2026-08-04T14:00:00+08:00
schedule: 0 9 * * 1
control: {"version":3,"waitingFor":"time","verification":{"required":true,"status":"pending"},"nextAction":"检查草稿反馈"}
---

# 周报编写与发布

## Goal
每周一完成周报草稿，收到反馈后发布到指定频道。

## DoD
- [ ] 内容覆盖目标时间段的全部工作
- [ ] 数据已由可复现命令核对
- [ ] 草稿、目标频道和发布参数已准备

## Manual
1. 收集素材并起草。
2. 将需要的反馈写入任务等待条件。
3. 发布后查询真实结果，并把稳定结果写入 Current Cycle。

## Verification
Independent verification: required

## Current Cycle
- 等待反馈；next step: 收到反馈后核对草稿

## History
```

### Frontmatter 契约

- `status` 必须是 `active`、`waiting` 或 `sleeping`；reader 对其他值一律 fail-open 为 `active`，不再像旧版本那样把 `blocked`/`awaiting-user`/`done` 等 v1 词汇当场翻译成对应状态——那套翻译表只存在于启动迁移里，负责把文件原地升级，读路径本身不再猜测。
- `enabled` 缺省按 `true` 读取。false 时 driver 永不 dispatch；`control.stop` 保存 actor、reason、at。
- `wake` 是本地时间或带偏移时间。active 写入 future wake 会规范成 waiting + `waitingFor: time`；waiting 无 wake 是 signal parked，driver 不轮询。
- `schedule` 是按主机时区解释的五字段 cron，存在时任务是 recurring；sleeping 必须同时有合法 schedule 和作为下一 occurrence 的 wake。
- `control` 是单行 JSON，`version` 必须是 `3`；其余字段只有 `deadline`、`nextAction`、`waitingFor`、`verification`、`cycleId`、`stop` 六个。
- 归档 frontmatter 只需 `outcome: completed|cancelled` 与 `closedAt`；活动任务不写 archive outcome。

### Control 与恢复事实

v3 的 `control` 只剩 11 个叶子字段，且都是恢复要用的事实，没有旁路账目：

- `deadline` 是唯一的调度/治理硬约束，用户真实意图，不需要模型估算。
- `nextAction` 是下一条可执行动作，也是等待时"等什么、条件、下一步"的记录位置——没有单独的 blockedReason 字段。
- `verification` 是独立事实：`required`、`pending`/`passed`/`failed`、`runId`。`status` 只是展示缓存，从不作为门禁；真正的权威永远是按 `runId` 重新读盘的 attestation 文件（校验 `taskId`、verdict、contract body hash 新鲜度、artifact subject hash 新鲜度）。
- `waitingFor` 只是记录性展示——`time`、`user`、`job` 或 `external-signal`，不改变生命周期，也不决定能否恢复（见下方[Waiting 与真实恢复源](#waiting-与真实恢复源)）。
- `cycleId` 标记当前或最近一次闭环的 recurring occurrence。
- `stop` 只在 disabled 时存在；enabled=true 时写路径会清除它。

没有按任务计数的 attempt 预算、usage 账目或 generation 守卫——那类"模型自己也估不准的数字"已经从 control 里拿掉了。真实的成本可见性来自 `UsageLedger`（按 `taskId` 聚合，见 `/usage`），失控兜底来自 deadline 加上 driver 进程内存里的一次性唤醒计数与连续无 effect 唤醒计数，两者都不落盘、不进 control、模型也看不到。

## 状态与生命周期

| 动作 | 前置 | 结果 |
|---|---|---|
| create one-shot | none | active |
| create recurring | none | sleeping + next wake |
| progress | active/waiting | active 或 waiting |
| verify | active/waiting | active，写入 verdict |
| complete one-shot | active | archive/completed |
| complete recurring | active | sleeping + next occurrence |
| skip | active/waiting，recurring | sleeping + next occurrence |
| cancel | active/waiting/sleeping | archive/cancelled |
| pause | 任一 live status | status 不变，enabled=false |
| resume | 任一 disabled live status | status/wake/schedule 不变，enabled=true |
| run | active/waiting | active + immediate dispatch |
| run | sleeping | 提前打开新 cycle + dispatch |
| wait-due | waiting + due wake | 原子改 active、清 wake，再 dispatch |
| cycle-due | sleeping + due wake | 原子打开 cycle、改 active，再 dispatch |
| governor-stop | 任一 live status | status 不变，enabled=false |

没有独立的 `request-verification` 动作：验收就是一次普通委派，见下方[Verification](#verification)。`verify` 不再要求任务必须处于 `waiting`——它认的是 attestation 文件里的 `taskId`，不是任务当时的生命周期状态，所以无论调用发生在完成唤醒之前还是之后都合法。

一次性任务不使用 sleeping。complete 原则上从 active 发生；等待中的任务先由真实恢复源转 active。cancel 可以从任一 live status 归档。

## 周期任务

创建 recurring task 只写 sleeping 和下一 occurrence，不派发首轮工作。首轮和之后每一轮都调用同一个 runtime `openRecurringTaskCycle`：

1. 确认 sleeping、enabled、合法 schedule 和 due wake。
2. cycleId 绑定 schedule occurrence，例如 `cycle-2026-08-04`。
3. 首轮只初始化 Current Cycle，不把创建占位写进 History；后续轮次才折叠上一轮 Current Cycle。
4. 重置本周期 verification、DoD/Plan checkbox 和 stop。
5. 清 wake，写 active，再派发普通 `[TASK_DRIVER]`。

complete 会写 summary/evidence、清理 task-owned events、计算下一 occurrence 并回到 sleeping。skip 只记录原因，不伪造 DoD 或 completion evidence。active/waiting 未闭环时，driver 不并发开启新 cycle；doctor 会报告错过 occurrence。

## Waiting 与真实恢复源

`waiting + wake` 是定时等待，`waiting + no wake` 是信号等待。driver 只处理前者到点恢复，绝不周期性唤醒后者。

恢复源只有真实信号，`waitingFor` 写了什么不参与判断：

- wake 到点：runtime 先落盘 active + clear wake，再 dispatch。
- background job / 委派（含 `purpose: verify` sub-agent）完成：runtime 校验这个已 settle 的 run/job 记录里的 `taskId` 确实指向本任务，再激活所属 task 并派发所属 channel 的回合——这个绑定来自 runtime 自己写的 run 记录，不是任务文件里 `waitingFor` 那个模型可写的字符串。
- `/tasks run <id>`：明确的人工强制推进。
- 相关用户消息：Agent 判断相关后用 progress 把任务恢复 active；普通闲聊不批量唤醒 waiting tasks。

需要轮询的外部条件应设置合理 wake，或使用周期 event 作为零 token sensor。

## Verification

需要独立验收的任务显式设置 `control.verificationRequired: true`。验收不是一个独立的生命周期分支，而是一次普通委派：

1. 完成 DoD checklist 后，像任何其他委派一样派发一个 `subagent purpose=verify`、带 `taskId` 的 sub-agent。
2. 用带 `note` 的 `task_update` 把任务停泊为 `waiting`（不设 wake），和其他委派完全同一套停泊/唤醒机制——没有单独的 `request-verification` 动作，也没有 `waiting + waitingFor: verification` 这个特殊状态。
3. checker 只判断、不修复被验收实现并写 attestation；需要运行会生成临时产物的测试/构建时，可使用声明 `mutates: write` 的 verifier，它会持有目标工作区独占 lease，结论为 `advisory`。完成后 runtime 通过完成唤醒恢复所属 task。
4. Agent 调用 `task_verify` 导入 runId；PASS/FAIL 都恢复 active。`task_verify` 认的是 attestation 文件里的 `taskId`，不是任务当时的状态字符串。
5. complete 重新检查 attestation、contract hash 和 artifact subject。新 subject 固定验证开始时的 `baseCommit`，所以提交同一份已验收内容不应破坏 PASS；Goal/DoD/Manual/Verification、tracked 内容、既有 untracked 产品文件或范围外新文件变更必须重验。

无 verification requirement 的任务不会产生额外 checker turn。

## 内建 task driver 与 governor

driver 是自适应 timer + nudge 的零 token 扫描，不固定轮询：

- enabled=false、archive outcome、waiting 无 wake 永不 dispatch。
- waiting due 和 sleeping due 在 dispatch 前先完成原子状态转换；这个转换是幂等的——一旦任务不再是 `waiting`，重复或重放的唤醒都是安全的 no-op，不需要额外的 claim/handoff 簿记来判重。
- sleeping 缺 wake 时按 schedule 零 token 自愈；schedule 缺失或非法则写 governor stop、保持 sleeping 并通知 doctor/用户。
- channel 正在运行时不重复入队；按 deadline/wake 和 channel round-robin 选择任务。
- 有真实 effect 的回合快速接续；只有台账变化使用普通延迟；无变化走 stalled retry。
- 连续 3 次唤醒没有真实可见 effect：写 enabled=false + stop(by=governor)，status 保持 active，并由 runtime 直接发送 deterministic receipt，不开启额外诊断回合。这个计数只存在于 driver 的进程内存里，不落盘、不进 control，重启的代价至多是多一轮耐心。
- deadline 是唯一持久化的硬性 stop-loss；同一 recurring cycle 内的单周期唤醒次数上限是另一层失控兜底，同样只在进程内存里。

所有任务执行必须保持 at-least-once 可重放安全：外部动作前查询真实状态，使用稳定 request/message id，并把结果和证据写入 Current Cycle 或 completion evidence。

## 可见性与命令

`/tasks` 是 transport 层零 LLM 成本视图：

```text
/tasks
/tasks show <id>
/tasks archive
/tasks pause <id>
/tasks resume <id>
/tasks run <id>
/tasks set <id> <wake|next|deadline> <value>
/tasks doctor
```

展示至少包含 status、enabled/stop reason、wake、waitingFor、schedule/next occurrence、current/last cycle、verification、deadline 和 nextAction。pause/resume 不改变 status、wake 或 schedule。旧命令按 unknown action 返回 usage，不做隐式替代。成本可见性不再由任务文件承担——按 `taskId` 聚合的花费查 `/usage`。

长程任务由五个工具组成，按 payload 形状切分（spec 046），而不是一个按 action 分支的工具：

```text
task_list
task_create
task_update
task_close
task_verify
```

- `task_list`：返回活动任务和完整 control。
- `task_create`：标准 Goal/DoD/Manual/Verification/Current Cycle/History；recurring 初始 sleeping。
- `task_update`：带 `note` 时原子追加 Current Cycle 并更新状态/wake/control（checkpoint，仅 active/waiting）；不带 `note` 时是纯 metadata 修复，也是唯一能修复不可解析 control 行的路径，sleeping 也可用。
- `task_close`：`outcome` 为 complete/skip/cancel，分别闭环、跳过 occurrence、归档放弃。
- `task_verify`：导入独立验收 sub-agent 的 attestation。

每回合注入 `<task_agenda>`，包含活动目录中的 active/waiting/sleeping 任务，也显示 disabled、wake、waitingFor、cycle 和 verification；它是背景参考，不是新指令。

## 外部委派

智能体工作使用 `subagent` 委派，并把 `taskId` 绑定到 run。内置角色超过同步宽限后会转为后台 run；外部 Claude Code / Codex / exec 角色从一开始就是异步 run。任务等待时写 `waitingFor: external-signal`、不设 wake；run 完成后，runtime 校验这个已 settle 的 run 记录里的 `taskId` 确实指向本任务，再激活所属 task，把结果和产物路径交还频道——独立验收的 `purpose: verify` sub-agent走的是同一条通道，没有特殊路径。

普通长命令使用 `bash async` 并绑定 `taskId`，对应 `waitingFor: job`。不要为了等待智能体再在外层包一层 `bash async`、event 或轮询；那会失去统一的 run 状态、取消、完成唤醒、用量和重启对账。

无论哪种异步工作，都应在任务正文或 Current Cycle 记录：使用的角色或工具、工作目录、runId/job id、预期产物、验收方法和幂等恢复方式。用户反馈使用 `waitingFor: user`。

## 完整周报流程

1. 创建 recurring task：它先 sleeping，不在创建回合执行发布。
2. occurrence 到点，runtime open cycle 后派发普通 task wake。
3. Agent 收集素材、起草、查询真实发布状态，使用 progress 写 evidence 和 nextAction。
4. 需要反馈就 waiting/user 或 waiting + wake；不要轮询 parked task。
5. 需要独立检查时派发 `purpose=verify` sub-agent 并停泊为 waiting，checker PASS 后调用 verify，再 active。
6. 发布前再次查询真实目标，使用稳定幂等 id；成功结果写入 Current Cycle。
7. complete 后任务 sleeping，等待下一 occurrence；不再需要则 cancel 归档。

## 异常恢复

- /tasks doctor 检查 unreadable frontmatter、不可解析的 control（旧版本会直接判为不可读）、future wake 藏在 active、waiting parked 是否有真实可恢复来源（有效 wake，或一条正在跑、`taskId` 指向本任务的 job/委派记录——不看 `waitingFor` 写了什么）、sleeping schedule/wake、enabled/stop 一致性、missed occurrence 和 attestation 漂移。
- repair 只写 metadata/body，不自动执行外部动作。
- daemon restart 不会补跑多个 occurrence；至多按当前 schedule 补一次，at-least-once 下仍须查询真实状态并幂等。
- governor stop 之后用 /tasks resume 保留原阶段，或先调整 deadline；cancel 用于不再需要的任务。

## 相关文档

- [runtime-playbooks.md](./runtime-playbooks.md)：随包 playbook 目录。
- [configuration.md](./configuration.md)：tasks、events、web 配置。
- [deployment-and-operations.md](./deployment-and-operations.md)：长期运行与排障。
- [sub-agents.md](./sub-agents.md)：委派与独立验收。
- [spec 038](./specs/038-task-autonomy-state-v2/design.md)：当前状态模型。

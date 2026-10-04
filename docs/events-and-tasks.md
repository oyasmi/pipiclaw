# 事件与任务（Events and Tasks）

这份文档讲 Pipiclaw 的两层长程能力，它们合起来让 Pipiclaw 从"被动应答的聊天机器人"变成"能被时间驱动、带着团队把项目做完的负责人"：

- **事件（events）** 回答**"什么时候"**——唯一的时间源：提醒、周期与定时工作、外部条件传感器。
- **任务（tasks）** 回答**"做什么、做到哪、在等谁"**——一个一次性项目：目标、验收清单、工作项，以及每次派发和结算的记录。

两者由 runtime 协调，但职责不重叠：事件决定何时唤醒，周期或定时的工作由事件**按模板生成一个任务实例**；任务只管一个项目从开始到交付；委派与后台作业决定谁来做。

> 一句话记忆：**event 管时间，task 带着契约、看板和一张可兑现的等待票把一个项目做完。**

如果你还没完成钉钉和模型配置，请先看 [README](../README.md) 和 [configuration.md](./configuration.md)。子代理（sub-agents）的角色配置见 [sub-agents.md](./sub-agents.md)。

## 怎么读这份文档（Reading Guide）

| 你想做什么 | 从哪读起 |
|---|---|
| 用 `/events`、`/tasks` 查看和管理已有的事件与任务 | [`/events` 命令](#events-命令人用只读--删除)、[可见性与命令](#可见性与命令) |
| 安排周报、巡检这类周期工作 | [任务模板事件](#任务模板事件周期与定时工作)、[周期与定时工作](#周期与定时工作) |
| 手写一个事件 JSON，或看懂 agent 建的那个 | [支持的事件类型](#支持的事件类型supported-event-types)、[通用字段](#通用字段common-fields) |
| 看懂任务文件的格式与 frontmatter 契约 | [任务模型](#任务模型)、[Frontmatter 契约](#frontmatter-契约) |
| 搞清楚一个任务在等什么、为什么没动 | [等待票](#等待票ticket)、[异常恢复](#异常恢复) |
| 排查"没有按时触发 / 任务没被推进" | [调度历史记录](#调度历史记录event-history)、[异常恢复](#异常恢复)、[部署排障](./deployment-and-operations.md#常见运维问题common-operational-issues) |
| 理解 driver、预算与委派看板 | [内建 task driver](#内建-task-driver)、[预算与停止](#预算与停止)、[团队看板](#团队看板与工作项) |

agent 侧的操作纪律不在本文，而在随包发布的 runtime playbook 里（负责人的工作法见 `task-lead.md`），见 [runtime-playbooks.md](./runtime-playbooks.md)。

## 心智模型（Mental Model）

| 层 | 载体 | 持有什么 | 谁维护 |
|----|------|----------|--------|
| **events** | `workspace/events/*.json` | 何时唤醒：提醒、周期与定时工作的模板、外部传感器 | 人（手工 / `/events`）或主 agent（`event_manage`） |
| **tasks** | `workspace/<channelId>/tasks/<id>.md` + `<id>.jsonl` | 契约（目标、验收清单、工作项）、等待票、用量；循环日志记着每一步、每次派发与结算 | 主 agent 经 `task_create`/`task_update`/`task_close` 建档，任务循环经 `task_step_end` 推进 |
| **task driver** | runtime 确定性扫描 | 兑现到期的票、兜底过期的票、停下超预算的任务、排下一步 | Pipiclaw runtime，扫描本身零 token |

三层文件都放在 app home 下的 `workspace/` 中。默认路径 `~/.pipiclaw/workspace/`；若设置了 `PIPICLAW_HOME`，则为 `${PIPICLAW_HOME}/workspace/`。

**为什么需要两层。**只有事件时，每次唤醒都是无状态的：agent 醒来只知道事件文本那一句话，不知道有哪些在途工作、上次做到哪、验收标准是什么。任务补上这块记忆，让工作变成：

> 醒来 → 读契约、团队看板和最近几条日志 → 推进一个具体步骤（拆分、派发、检查、汇报）→ 记下证据，并说清楚接下来在等什么 → 睡去。

下面先讲底层的**事件**，再讲其上的**任务**。

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
| `text` | 与 `task` 二选一 | 事件触发后发送给 Pipiclaw 的聊天文本 |
| `task` | 与 `text` 二选一 | **任务模板**：触发时按它生成一个任务实例，见[任务模板事件](#任务模板事件周期与定时工作) |
| `preAction` | 否 | 触发前执行的动作门控，见下方说明 |

各类型的专属字段（`at`、`schedule`）在下面对应小节列出。cron 一律按主机时区解释，没有 `timezone` 字段。`text` 与 `task` 必须且只能出现一个。

## 任务模板事件：周期与定时工作

需要拆工作项、委派、检查、汇报的周期或定时工作（周报、巡检、定期整理），不要把一段文字投进聊天让模型在聊天会话里做完——那会把任务过程塞满聊天上下文。改用 `task` 模板：

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "schedule": "0 9 * * 1",
  "task": {
    "title": "周报编写",
    "goal": "汇总上周 pipiclaw 仓库的合并、发布与未决问题，生成周报并发给我。只读仓库与 issue，不做任何写操作。",
    "dod": "- [ ] 覆盖上周全部合并的 PR\n- [ ] 列出未决问题及其负责人\n- [ ] 周报正文已在 report 中交付",
    "items": [{ "text": "收集上周合并与发布记录" }, { "text": "整理未决问题" }],
    "budget": { "usd": 5 }
  }
}
```

`task` 的形状与 `task_create` 完全一致（只是没有 `id`），用同一个校验器：DoD 必须是 `- [ ]` 清单，预算只有 `steps` / `usd`。每次触发（`preAction` 通过后）运行时会：

1. 以触发时刻生成实例 id：`<事件名>-<YYYYMMDD>-<HHmm>`。同一次触发重放（比如重启后补投递）得到同一个 id，已存在就什么也不做，**不会**重复生成。
2. 如果同一个事件上一次的实例还没结束，**本次不生成**，并直接给频道发一条不经过模型的回执（上一实例的 id、状态与 `/tasks show` 用法）。两个实例并行做同一类工作几乎总是重复劳动，而卡住的实例本身受预算、空转检测和等待票兜底约束，最终一定会结束或停下来告诉你。
3. 否则按模板写出任务文件（`origin` 记录事件名），由 task driver 在任务自己的会话里推进。

模板里写的是每次都要遵守的要求；每个实例独立，不继承上一次的状态，只在首步看到上一实例的收尾记录和最后一次汇报（`<previous_occurrence>`）作为衔接。想改进模板，由 agent 在 `report` 里提出，你确认后用 `event_manage update` 更新。

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

以下 `at` 仅示意带时区偏移的格式；使用时替换为实际未来时刻。手写事件也受 Node.js timer 上限约束，最多约 24.8 天；更远的提醒应临近时创建。

最适合未来某个时间点的一次性提醒。额外字段 `at`（本地时间，必填；建议带偏移如 `+08:00`，省略则按主机时区解释）：

```json
{
  "type": "one-shot",
  "channelId": "dm_your-staff-id",
  "text": "提醒我检查今天的发布结果。",
  "at": "2026-10-03T18:00:00+08:00"
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

**常见 cron 示例**——建议统一使用五段 cron（分钟 小时 日 月 星期）。底层解析器也能处理部分六段格式，但仍需满足触发间隔限制；不要在团队里混用。

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
| `event_manage` 工具 | 主 agent（聊天会话） | list / show / create / update / delete —— 带写入时校验和防自激励闸门 |

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
| `action` | 是 | `list` / `show` / `create` / `update` / `delete` |
| `name` | show/create/update/delete 必填 | 事件名（不含 `.json`），`list` 忽略。只允许字母、数字、`.`、`_`、`-` |
| `definition` | create/update 必填 | 类型化对象，含 `type`、`text` 或 `task`（二选一）、`at` 或 `schedule`，以及可选的 `preAction`；不传 `channelId`，由 runtime 绑定 |

工具调用的 `preAction.timeoutMs` 单位为毫秒；运行时将它转换为事件文件中的 `preAction.timeout`。更新前先用 `action: "show"` 读回完整定义。`label` 已不属于工具参数。

**写入时校验（工具的核心价值）。** 裸用 `write` 写事件 JSON 有个隐患：格式错误的文件会被 watcher **静默删除**，agent 以为安排好了回访，实际什么都没留下。`event_manage` 在**落盘前**就把问题拦下并大声报错：

1. **结构校验**：`definition` 必须能通过与 watcher 相同的 `parseScheduledEventContent`——工具写出的文件必然可被装载；`task` 模板还要通过与 `task_create` 相同的契约校验。
2. **路径安全**：`name` 经 traversal 拦截（拒绝 `../` 等越界），字符集限定 `[A-Za-z0-9._-]`。
3. **channel 所有权**：新定义的 `channelId` 由 runtime 绑定；show/update/delete 前会读取目标文件校验归属，一个 channel 不能操纵或打扰其他 channel 的事件。
4. **`preAction` 安全**：命令写入时即过 `command-guard`，被拦截则整个操作失败（触发时的检查仍保留）。
5. **防自激励闸门**（防止 agent 把自己拖入烧 token 的自唤醒循环）：
   - 禁止 `immediate` 类型（create 与 update 双侧）——当下能做的事就在当前回合做完；
   - `one-shot` 的 `at` 必须至少晚于现在 2 分钟；
   - `periodic` 的 cron 最密每 **30 分钟**一次；**带 `preAction` 门控时放宽到最密每 5 分钟**——传感器条件不成立时静默、零 token，适合调用用户已安装的稳定检测命令；硬下限仍是 5 分钟；
   - `workspace/events/` 内事件文件数达到 50 时拒绝再 create。

> 手工编辑会绕过 `event_manage` 的 channel 所有权、提前量等即时错误提示，但 watcher 仍是最终信任边界：`immediate`、过密 cron、过多事件和被 command guard 拒绝的 `preAction` 仍会被拒绝。`one-shot` 的 2 分钟提前量也用于 watcher 校验进程运行期间新写入的文件；启动前遗留且已经错过的文件按可靠恢复语义补投递一次。
> 注意：第 4 条的两道 guard 检查都以 `security.json` 里 `commandGuard.enabled` 为前提；全局关闭 command guard 时，写入时与触发时的检查都不生效（这是既有安全语义）。

**典型用法。** 安排一个与 task 无关的独立提醒：

```json
{
  "type": "one-shot",
  "text": "提醒我检查季度预算。",
  "at": "2026-10-03T14:00:00+08:00"
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

任务的继续、等待和异常恢复由 task driver 根据等待票驱动，不要为普通 task 轮询另建事件；任务内部等外部条件，用带超时的后台作业当传感器（见下方[等待票](#等待票ticket)）。周期与定时的**工作**用上面的任务模板事件。任务模型见下方[第二部分](#第二部分长程任务tasks)。

## 推荐场景（Recommended Patterns）

**每周记忆整理：**

```json
{
  "type": "periodic",
  "channelId": "dm_your-staff-id",
  "text": "检查本频道的长期记忆，报告过时或冲突条目；修改时使用记忆工具，不直接编辑生成的 MEMORY.md。",
  "schedule": "0 10 * * 1"
}
```

**发布后一次性跟进：**

```json
{
  "type": "one-shot",
  "channelId": "dm_your-staff-id",
  "text": "检查今天发布后的错误反馈和回滚风险。",
  "at": "2026-10-03T21:30:00+08:00"
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

# 第二部分：长程任务（Tasks）

事件解决"什么时候"，任务解决"做什么、做到哪、在等谁"。**一个任务就是一个你交给 Pipiclaw 负责的项目**：它自己拆工作项、给执行者交代清楚上下文、派发给子代理或外部 Agent、等结果、对照验收标准检查、需要时返工，最后向你汇报成果。Task 创建即持续委托：只要任务在活动目录且没有被暂停，runtime 会按它的等待票继续推进。外部动作不产生额外的人工作业流；模型必须遵守任务 Goal、能力配置、真实状态查询和幂等约束。

本节以 **Task v5（spec 052）** 为准。任务只有一次性项目这一种形态：周期与定时的工作由[事件模板](#任务模板事件周期与定时工作)按期生成实例。任务拆成三样东西，各自只做一件事：

| 物件 | 路径 | 是什么 |
|---|---|---|
| **契约** | `tasks/<id>.md` | 目标、验收清单、工作项。人可直接编辑，每一步完整注入；运行时从不改写正文 |
| **循环日志** | `tasks/<id>.jsonl` | append-only：每一步做了什么、每次派发与结算、票据过期、收尾 |
| **等待票** | 契约 frontmatter 的 `ticket` | "什么会叫醒我，最迟什么时候"——由 runtime 校验、由 runtime 兑现 |

v3（0.9.2）的 `status`、`wake`、`control`、`schedule`、`Manual`、`Verification`、`Current Cycle`/`History` 以及 `run`/`job`/`signal`/`schedule` 票全部退役。升级时 daemon 会做一次确定性转换（原件备份到 `tasks/.v3/`），详见[从 v3 转换](#从-v3-转换)。

## 任务模型

### 目录布局

```text
workspace/<channelId>/tasks/
├── export-api.md             契约
├── export-api.jsonl          循环日志
├── weekly-report-20261005-0900.md    事件模板生成的实例
├── .sessions/               每个任务一份任务会话
├── .steer/                  待处理的用户指示与待发送的通知
├── .v3/                     转换前的原件（不会被删）
└── archive/
    ├── released-note.md
    └── released-note.jsonl
```

关闭的任务连同它的日志一起移入 `archive/`，不再进入 driver 扫描。

### 文件格式

```markdown
---
state: parked
ticket: {"kind":"work","refs":["run_k2x9","run_p7q1"],"by":"2026-10-04T18:40:00+08:00"}
usage: {"startedAt":"2026-10-04T14:02:11+08:00","steps":6,"usd":3.4,"usdEstimated":true,"expired":0}
budget: {"usd":30}
---

# 导出接口改造

## Goal
为订单服务新增 CSV 导出接口……（目标、范围、允许的外部动作、关键约束）

## DoD
- [ ] /export 接口返回符合字段规范的 CSV
- [ ] 新增单测覆盖空结果与超大结果
- [ ] npm run check 通过

## Work Items
- [x] W1 调研现有序列化与分页实现
- [ ] W2 实现导出接口与单测
- [ ] W3 独立审查 W2 的实现
```

### Frontmatter 契约

| 字段 | 含义 |
|---|---|
| `state` | `open`（现在有活可干）/ `parked`（在等一张票）/ `done`（已关闭，仅归档文件） |
| `paused` | `{by,reason,at}`。**出现即暂停**，与 `state` 正交；`by` 为 `user` 或 `runtime` |
| `ticket` | `state: parked` 时必需，`open`/`done` 时必须不存在 |
| `usage` | 整个任务的用量：步数、成本、连续过期次数 |
| `budget` | 可选的每任务预算覆盖，只有 `steps` 与 `usd`，见[预算](#预算与停止) |
| `origin` | 仅事件模板生成的实例才有：生成它的事件名 |

**一条不变量**：`state: parked` ⟺ `ticket` 存在。读写两侧都强制，所以"停泊却没有任何东西能叫醒它"在文件格式里不可能被表达出来。

### 正文

| 段 | 内容 |
|---|---|
| `## Goal` | 要成立的结果、范围、允许的外部动作、关键约束 |
| `## DoD` | 客观验收标准，必须是 `- [ ]` 清单。关闭任务要求全部勾选——这是负责人的显式确认 |
| `## Work Items` | 工作项：每项可独立派发、独立检查。四态 `[ ]` todo / `[x]` done / `[!]` blocked / `[~]` dropped；**只有负责人**把项标成 done，运行时从不替它打勾 |

契约控制在约 4 KB 以内；运行时从不改写它，超过时写入照常并告警。

### 等待票（Ticket）

一次停泊必须说清楚**什么会叫醒它**，而且这句话要能被运行时当场验证：

| kind | 载荷 | 谁兑现 |
|---|---|---|
| `time` | `at` | driver 到点 |
| `work` | 无（运行时记录 `refs` 仅作展示） | 本任务绑定的**任一**委派或后台作业结算时 |
| `ask` | `asked` | 用户 `/tasks reply` |

写入时校验：`work` 票要求本任务当前**至少有一个**未结算的委派或运行中的作业，否则拒绝并提示"结果已在看板上，读完继续"。

**每张票都带 `by`（兜底时限），由运行时确定性推导，模型不写也改不了**：`work` 取所有在途项各自截止时刻中最晚的一个再加 10 分钟（委派用自己的墙钟 deadline，作业用自己的 timeout），`ask` 用 24 小时，`time` 就是它自己的时刻。

到点还没兑现时：

1. 第一次——运行时把任务改回 `open`，并在下一步的 brief 开头说明票过期了，让它先确认真实状态。
2. **连续**第二次——任务保持 parked、置 `paused{by:"runtime"}`，并给用户一条零 LLM 的确定性回执。一次正常兑现会把连续计数清零。

> **这是 v4 引入、v5 保留的核心不变量。** 任务曾经停泊后没有任何东西再叫醒它，静默了 9 天和 13 天。现在**任何停泊要么被兑现、要么在兜底时限内告诉用户**。

**等外部条件**（CI 跑完、某个文件出现）：启动一个带足够超时的后台作业当传感器（任务会话里 `bash async:true` 自动绑定到本任务），然后停泊到 `work` 票。条件成立或超时都会让作业结算、叫醒任务，等待期间零 token，也能挺过重启。

## 步骤（step）

一个 step 是任务会话里的一次模型回合，跑在**任务自己的会话**（`tasks/.sessions/<id>.jsonl`）里，不进频道聊天会话。聊天记录不会被任务撑大，任务也不必每次重读整份历史——每一步的 brief 都重新带上契约、团队看板、上一步之后回来的结果、最近日志和用量。

每一步必须以 `task_step_end` 收尾，三选一：

| outcome | 含义 | 运行时动作 |
|---|---|---|
| `continue` | 还能接着干 | **立刻**排下一步，没有 backoff |
| `park` | 在等一个真实来源 | 校验票并补 `by`，转 parked；`ask` 票会自动把问题发给用户 |
| `done` | 项目完成 | 要求 DoD 全部勾选、且没有在途的委派/作业；写 close 记录并归档 |

**任务步骤默认不向用户发言**：只有 `report` 参数、`ask` 提问、或预算耗尽、运行时停止等确定性回执时才会说话。完成任务不会自动把 `note` 交给用户；Goal/DoD 要求交付结果时，必须在 `report` 里提供实际内容（成果、谁检查了什么且结论如何、未决风险、成本）。事件唤醒仍然使用 `[SILENT]`，因为文本事件仍然投递到聊天会话。

step 是频道队列里的普通条目：占用 turn slot、受 `/stop` 管辖、结束就把频道让回去。一个跑三小时的任务不会锁住聊天。

## 团队看板与工作项

负责人最需要的状态是"我的团队现在在做什么、刚刚回来了什么"。在任务会话里：

- **委派和后台作业自动绑定到本任务**；委派带上它对应的工作项 `item`（`subagent {agent, task, item:"W2"}`），运行时校验这个项存在。
- 绑定的委派/作业派发和结算时，运行时在任务的循环日志里写 `dispatch` / `settle` 记录（含状态、耗时、成本、`VERDICT`、输出文件路径），成本计入任务预算。日志与契约一起归档，所以委派记录一周后被回收，任务里的结果仍在。
- 每一步的 brief 里有一块 `<task_board>`：每个工作项对应的委派/作业、状态与输出路径，`★新` 标出上一步结束之后才回来的结果。这些新结果的输出尾部和改动文件另放在 `<task_results>` 里，和聊天里的完成唤醒看到的一样（brief 替换了唤醒文本，所以由它补上）；完整输出仍按路径 `read`。

`purpose: verify` 的委派让执行者按"检查者协议"工作并以 `VERDICT: PASS|FAIL` 收尾，结论显示在看板上。**它是供负责人权衡的信息，不是闸门**：运行时不再校验"检查者有没有改过产物"，也不再把验收通过作为关闭任务的条件。带 `item` 的检查只覆盖该工作项和它引用的 DoD 条目，不带 `item` 才按整个 DoD 验收。检查与返工的裁决在 `task-lead.md`；需要结构性只读，用 `mutates: read` 且不含 `bash` 的内置角色，或由 CLI sandbox 强制只读的外部条目（示例 `codex-review`）。

## 预算与停止

每个任务有两维预算，缺省是代码常量，可以按任务在 `budget` 里覆盖，计的是**整个项目**，并且**包含绑定委派的成本**：

| 键 | 默认 | 含义 |
|---|---|---|
| `steps` | 60 | 任务的模型步数上限 |
| `usd` | 20 | 可归因成本上限 |

任一项到顶，**在派发下一步之前**任务就被停下，并给用户一条带具体命令的回执（`/tasks resume <id> +steps 20`）。另外，连续两步没有任何工具调用也会被停下——那说明循环在自言自语。截止时间属于项目目标，写进 Goal，由负责人掌握。

`usd` 是粗略值，用来大致掌握花费、拦住失控的项目，不是账单：每一步结束时计入这一步自身的模型成本，绑定委派在结算时计入它上报的成本。拿不到成本的执行者（如 `codex-cli`、`exec`）按 0 计入，并把 `usdEstimated` 置为真；显示成本的地方会标注"含估算"。订阅制 CLI 上报的通常是 API 等价价格，而不是实际扣费。

## 周期与定时工作

任务本身没有 `schedule`。周期与定时的工作写成[任务模板事件](#任务模板事件周期与定时工作)：事件按 cron 或 `at` 触发，每次生成一个独立的任务实例。"立刻再跑一次"就让 agent 用同一份内容 `task_create` 一个项目。

## 内建 task driver

driver 是自适应 timer + nudge 的零 token 扫描：

1. **兑现**到期的 `time` 票。
2. **兜底**过期的票（重开或通知）。
3. **停下**已经超预算或在空转的任务。
4. **排队**一个可跑的任务，按频道 round-robin 保证公平。

`work`/`ask` 从不轮询——它们由各自的所有者推过来：`SubAgentRunManager` 与 `JobManager` 的结算、`/tasks reply`。所有推送边都要经过同一个幂等的票据兑现，所以 at-least-once 的重放是安全的 no-op。任务处于 `open`（已有步骤在驱动）时到达的结算唤醒不会再开一个模型回合，结果已经写进日志，下一步的看板会带上。

## 与事件的边界

events 与 tasks 之间只有一条边：**事件按模板生成任务实例**，由 runtime 注入的回调完成；events 子系统不读取、不写入任何任务文件，tasks 也不读取 events 目录。任务内部不再有 `signal` 票和任务专属事件命名；任务会话里没有 `event_manage`。

纯提醒用文本事件；需要积累状态、委派和检查的用任务。

## 可见性与命令

```text
/tasks                                  列表：状态、等待票+兜底时间、工作项进度、用量；实例显示来自哪个事件
/tasks show <id>                        契约 + 团队看板 + 最近日志 + 用量
/tasks log <id>                         翻看循环日志（含派发与结算）
/tasks steer <id> <内容>                 给下一步排一条指示（不打断当前步骤）
/tasks reply <id> <内容>                 回答任务的提问，并让它继续
/tasks pause <id> / resume <id> [+steps N|+usd X]
/tasks archive                          已归档任务
/tasks doctor                           只检查手工编辑或转换未完成造成的问题
```

`resume` 的加码是在**已用量之上**的增量，所以恢复一个撞了上限的任务真的能跑起来；如果任务是在一张已过兜底时限的票上被停下的，`resume` 会把它重开并清掉过期计数，而不是让它在同一张死票上再次暂停。

doctor 只查三类问题：frontmatter 不可读、仍含旧版本字段（转换未执行）、停泊的兜底时限已过去超过 1 小时（driver 可能没有运行）。

模型侧的工具面：

```text
task_list      task_create    task_update    task_close    task_log
task_step_end  （只在任务会话里注册）
```

`task_update` 只改工作项和预算，不再承载进度记录——进度属于 `task_step_end` 的 `note`。`task_close` 只有 `complete`（DoD 全部勾选且没有在途项）和 `cancel`；关闭任务**不会**取消仍在运行的委派或作业，回执会列出来。任务会话的工具集里**没有** `task_create`、`memory_save` 和 `event_manage`：任务不建任务、不写频道记忆、不管事件。

每回合仍注入 `<task_agenda>`，每行含状态、等待票摘要与兜底时间、工作项进度和用量；它是背景参考，不是新指令。

## 从 v3 转换

daemon 首次以 v5 启动时（服务启动之前）执行一次确定性转换（无 LLM，marker 位于 `state/task-migration-v5.done`）。只转换带 v3 frontmatter（`status:`）的文件，已经是 v5 的文件不动；0.9.3 beta 期间写出的 v4 文件不在转换范围内。

1. v3 的所有等待（`wake`、`waitingFor`）都没有对应的 v5 来源，任务一律改回 `open` 并在循环日志留一条说明。`enabled: false` 或 `control.stop` 转成 `paused`，所以升级不会让已停用的任务重新跑起来。
2. `## Plan` 改名 `## Work Items`；`## Current Cycle`、`## History` 删除（这些逐轮记录现在属于循环日志）；`Manual`、`Verification` 保留在正文里。
3. **周期任务变成事件模板**：为带 `schedule` 的任务写出 `workspace/events/<id>.json`（同一个 cron，模板由契约生成，原 Manual/Verification 并入 Goal，勾选全部复位）。两次执行之间休眠（`sleeping`）的任务随即以 `cancelled` 归档；正在执行的那一轮不打断，就地成为该事件的一个实例，下一次由事件生成。无法表达为模板的周期任务会被置 `paused`，等人工处理。
4. 任务专属的 `task.<channelId>.<taskId>.*` 传感器事件移到 `tasks/.v3/events/`。
5. 原件复制到 `tasks/.v3/`，**永不删除**。

转换没有成功、仍带 v3 frontmatter 的文件不会被执行，`/tasks doctor` 会列出它们。

转换代码会在下一个 minor 版本删除。

## 异常恢复

- daemon 重启不会补跑多个 occurrence；at-least-once 下外部动作仍须查询真实状态并保持幂等。
- 运行时停止（预算、空转、票据连续两次过期）之后用 `/tasks resume` 继续，必要时加码；不再需要就让 agent cancel。
- 循环日志是排查第一现场：`/tasks log <id>` 能看到每一步做了什么、每次派发与结算的结论。

## 相关文档

- [runtime-playbooks.md](./runtime-playbooks.md)：随包 playbook 目录（含负责人工作法 `task-lead.md`）。
- [configuration.md](./configuration.md)：tasks、events、web 配置。
- [deployment-and-operations.md](./deployment-and-operations.md)：长期运行与排障。
- [sub-agents.md](./sub-agents.md)：委派角色与检查者协议。
- [spec 052](./specs/052-task-lead/design.md)：当前任务模型的设计记录；[spec 051](./specs/051-long-horizon-task-loop/design.md)：等待票与任务会话的来源。

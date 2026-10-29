# 事件与任务（Events and Tasks）

这份文档讲 Pipiclaw 的两层长程能力，它们合起来让 Pipiclaw 从"被动应答的聊天机器人"变成"能被时间驱动、带着团队把项目做完的负责人"：

- **事件（events）** 回答**"什么时候"**——唯一的时间源：提醒、周期与定时工作、外部条件传感器。
- **任务（tasks）** 回答**"做什么、做到哪、在等谁"**——一个一次性项目：目标、验收清单、工作项，以及每次派发和结算的记录。

两者由 runtime 协调，但职责不重叠：事件决定何时唤醒，周期或定时的工作由事件**按模板生成一个任务实例**；任务只管一个项目从开始到交付；委派与后台作业决定谁来做。

> 一句话记忆：**event 管时间，任务车道在后台带着契约和看板把一个项目做完，频道只是遥控器。**

如果你还没完成钉钉和模型配置，请先看 [README](../README.md) 和 [configuration.md](./configuration.md)。子代理（sub-agents）的角色配置见 [sub-agents.md](./sub-agents.md)。

## 怎么读这份文档（Reading Guide）

| 你想做什么 | 从哪读起 |
|---|---|
| 用 `/events`、`/tasks` 查看和管理已有的事件与任务 | [`/events` 命令](#events-命令人用只读--删除)、[从聊天管理任务](#从聊天管理任务) |
| 安排周报、巡检这类周期工作 | [任务模板事件](#任务模板事件周期与定时工作)、[周期与定时工作](#周期与定时工作) |
| 手写一个事件 JSON，或看懂 agent 建的那个 | [支持的事件类型](#支持的事件类型supported-event-types)、[通用字段](#通用字段common-fields) |
| 看懂任务文件的格式与 frontmatter 契约 | [任务模型](#任务模型)、[Frontmatter 契约](#frontmatter-契约) |
| 搞清楚一个任务在等什么、为什么没动 | [状态与等待](#状态与等待)、[异常恢复](#异常恢复) |
| 排查"没有按时触发 / 任务没被推进" | [调度历史记录](#调度历史记录event-history)、[异常恢复](#异常恢复)、[部署排障](./deployment-and-operations.md#常见运维问题common-operational-issues) |
| 理解任务车道、预算与委派看板 | [执行槽与并发](#执行槽与并发)、[预算与守护](#预算与守护)、[团队看板](#团队看板与工作项) |

agent 侧的操作纪律不在本文，而在随包发布的 runtime playbook 里（负责人的工作法见 `task-lead.md`），见 [runtime-playbooks.md](./runtime-playbooks.md)。

## 心智模型（Mental Model）

| 层 | 载体 | 持有什么 | 谁维护 |
|----|------|----------|--------|
| **events** | `desk-<name>/events/*.json` | 何时唤醒：提醒、周期与定时工作的模板、外部传感器 | 人（手工 / `/events`）或主 agent（`event_manage`） |
| **tasks** | `desk-<name>/tasks/<id>.md` + `<id>.jsonl` | 契约（目标、验收清单、工作项）、状态与用量；任务记录记着每一步、每次派发与结算、你说过的话 | 主 agent 经 `task_create` 建档；契约正文归负责人，文件头归运行时 |
| **任务车道** | runtime | 按事实维护状态、管执行槽、给每个执行中的任务一个 runner | Pipiclaw runtime，维护本身零 token |

事件和任务都属于一个工位，放在 `workspace/desk-<name>/` 下（默认 `~/.pipiclaw/workspace/desk-<name>/`；设置了 `PIPICLAW_HOME` 时以它为根）。每个事件和任务都记着自己的**投递频道**：事件的 `channelId`、任务 frontmatter 的 `channel`，结果只发到那里。投递频道没有绑定在这个工位上时（换绑到了别的工位，或者解绑了），对应的事件和任务**挂起**：事件到点跳过，任务不推进；频道绑回来后自动恢复。工位失去全部绑定时整体休眠，它的事件 watcher 停止。

**为什么需要两层。**只有事件时，每次唤醒都是无状态的：agent 醒来只知道事件文本那一句话，不知道有哪些在途工作、上次做到哪、验收标准是什么。任务补上这块记忆，让工作变成：

> 醒来 → 读契约（首步）或新输入与团队看板 → 推进一个具体步骤（拆分、派发、检查、汇报）→ 在最后一段回复里记下证据 → 运行时按事实决定接着干、等结果、等你回复还是等某个时刻。

下面先讲底层的**事件**，再讲其上的**任务**。

---

# 第一部分：定时事件（Events）

## 它是什么（What It Is）

在工位的 `events/` 目录（`~/.pipiclaw/workspace/desk-<name>/events/`）中放入一个 `.json` 文件，运行中的 Pipiclaw 就会读取它，并把它转成一条发给投递频道 `channelId` 的事件消息。`channelId` 必须是绑定在这个工位上的频道，否则到点时跳过，并在事件历史里记一条 `skipped`（`channel_not_bound`）。

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
    "dod": "- [ ] 覆盖上周全部合并的 PR\n- [ ] 列出未决问题及其负责人\n- [ ] 周报正文已用 task_report 交付",
    "items": [{ "text": "收集上周合并与发布记录" }, { "text": "整理未决问题" }],
    "budget": { "usd": 5 }
  }
}
```

`task` 的形状与 `task_create` 完全一致（只是没有 `id`），用同一个校验器：DoD 必须是 `- [ ]` 清单，预算只有 `steps` / `usd`。每次触发（`preAction` 通过后）运行时会：

1. 以触发时刻生成实例 id：`<事件名>-<YYYYMMDD>-<HHmm>`。同一次触发重放（比如重启后补投递）得到同一个 id，已存在就什么也不做，**不会**重复生成。
2. 如果同一个事件上一次的实例还没结束，**本次不生成**，并直接给频道发一条不经过模型的回执（上一实例的 id、状态与 `/tasks show` 用法）。两个实例并行做同一类工作几乎总是重复劳动，而卡住的实例本身受预算和车道的守护规则约束，最终一定会结束或停下来告诉你。
3. 否则按模板写出任务文件（`origin` 记录事件名），由任务车道在后台、在任务自己的会话里推进，不进聊天也不占用聊天。

模板里写的是每次都要遵守的要求；每个实例独立，不继承上一次的状态，只在首步看到上一实例的收尾记录和最后一次汇报（`<previous_occurrence>`）作为衔接。想改进模板，由 agent 用 `task_report` 提出，你确认后用 `event_manage update` 更新。

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
{"ts":"2026-06-25T10:00:00.123+08:00","eventName":"weekly-review","eventPath":"/Users/me/.pipiclaw/workspace/desk-default/events/weekly-review.json","eventType":"periodic","channelId":"dm_123","action":"enqueued","result":"ok","schedule":"0 10 * * 1","desk":"default","textPreview":"检查共享背景与当前工位记忆...","queue":{"accepted":true}}
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

频道绑定到工位之后，`workspace/CHANNELS.md` 会列出它的 id、名称和所属工位；`desk-bindings.json` 是绑定的原始记录。在频道里让 agent 用 `event_manage` 创建事件时，投递频道自动就是当前频道，不用自己写。

终端和 Web API 的会话与钉钉频道一样进绑定表，也能创建任务和事件。任务驱动器和事件 watcher 跟着运行时：daemon 一直在跑；没有 daemon 时，只有终端打开期间（内嵌运行时）才会运行。投递频道所属的渠道没有启用时（例如钉钉关闭），该频道的任务和事件被跳过，渠道重新启用后恢复。

## 谁来管理事件：三个入口

同一个工位的 `events/` 目录有三个互不冲突的管理入口：

| 入口 | 谁用 | 能做什么 |
|------|------|----------|
| 手工编辑 `*.json` | 人 | 任意增改；最终仍由 watcher 装载校验 |
| `/events` 命令 | 人（钉钉侧） | list / show / delete / history —— 只读 + 删除 |
| `event_manage` 工具 | 主 agent（聊天会话） | list / show / create / update / delete —— 带写入时校验和防自激励闸门 |

### `/events` 命令（人用，只读 + 删除）

在钉钉频道里用 `/events` 查看和删除现有事件。它只管理已有文件，不支持通过命令创建或更新；需要新增或修改时，直接编辑 `desk-<name>/events/*.json` 或让 agent 用 `event_manage`。`/events` 列出本工位的全部事件，投递到别的频道的会标出频道名，投递频道已不在本工位上的标为已暂停。

| 命令 | 说明 |
|------|------|
| `/events list` | 列出事件文件名、类型、`channelId`、`schedule` / `at`（无 timezone 列）和文本预览；定义无效（包括 watcher 会拒绝的过密 cron）时用一句中文说明原因 |
| `/events show <name>` | 展示 `desk-<name>/events/<name>.json` 的完整 JSON |
| `/events delete <name>` | 删除对应事件文件 |
| `/events history [name]` | 读取最近的事件调度历史，一条一行；传入 `name` 时只显示该事件 |

事件名只允许普通文件名字符（字母、数字、`.`、`_`、`-`）。可以写 `weekly-review` 或 `weekly-review.json`，Pipiclaw 会统一归一化。命令不会访问本工位的 `events/` 之外的路径。

### `event_manage` 工具（agent 自调度）

`event_manage` 是给**主 agent** 的一等工具，让它能列出、创建、修改、删除周期节奏、独立提醒和外部传感器。`action=list` 返回本工位的全部事件（每条一行，投递到别的频道的会标出频道，含无法解析的文件），用于在闭环或改期前核对真实事件名；工位内任何频道都可以查看、修改和删除这些事件。它与 `/events`、手工编辑操作**同一个**目录。

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
3. **投递频道**：`channelId` 始终由 runtime 绑定，不接受模型传入：新建的事件投递到当前频道，修改保留事件原来的投递频道（原文件无法解析时先 delete 再 create）。工位内不按频道隔离，同工位的任何频道都能修改和删除；需要隔离就用另一个工位。
4. **`preAction` 安全**：命令写入时即过 `command-guard`，被拦截则整个操作失败（触发时的检查仍保留）。
5. **防自激励闸门**（防止 agent 把自己拖入烧 token 的自唤醒循环）：
   - 禁止 `immediate` 类型（create 与 update 双侧）——当下能做的事就在当前回合做完；
   - `one-shot` 的 `at` 必须至少晚于现在 2 分钟；
   - `periodic` 的 cron 最密每 **30 分钟**一次；**带 `preAction` 门控时放宽到最密每 5 分钟**——传感器条件不成立时静默、零 token，适合调用用户已安装的稳定检测命令；硬下限仍是 5 分钟；
   - 本工位的 `events/` 内事件文件数达到 50 时拒绝再 create。

> 手工编辑会绕过 `event_manage` 的投递频道绑定、提前量等即时错误提示，但 watcher 仍是最终信任边界：`immediate`、过密 cron、过多事件和被 command guard 拒绝的 `preAction` 仍会被拒绝。`one-shot` 的 2 分钟提前量也用于 watcher 校验进程运行期间新写入的文件；启动前遗留且已经错过的文件按可靠恢复语义补投递一次。
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

任务的继续、等待和异常恢复由任务车道根据事实驱动，不要为普通 task 轮询另建事件；任务内部等外部条件，用带超时的后台作业当传感器（负责人的做法见 `task-lead.md` 的"等待"，状态含义见下方[状态与等待](#状态与等待)）。周期与定时的**工作**用上面的任务模板事件。任务模型见下方[第二部分](#第二部分长程任务tasks)。

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

事件解决"什么时候"，任务解决"做什么、做到哪、在等谁"。**一个任务就是一个你交给 Pipiclaw 负责的项目**：它自己拆工作项、给执行者交代清楚上下文、派发给子代理或外部 Agent、等结果、对照验收标准检查、需要时返工，最后向你汇报成果。Task 创建即持续委托：任务在**任务车道**里于后台独立执行，不占用任何聊天；你可以在任意绑定到本工位的频道里查看进度、补充指示、暂停、恢复或取消。外部动作不产生额外的人工作业流；模型必须遵守任务 Goal、能力配置、真实状态查询和幂等约束。

任务只有一次性项目这一种形态：周期与定时的工作由[事件模板](#任务模板事件周期与定时工作)按期生成实例。

## 心智模型

| 物件 | 是什么 |
|---|---|
| **契约** `tasks/<id>.md` | 目标、验收清单、工作项。负责人用 `edit` 维护正文；文件头（frontmatter）归运行时 |
| **任务记录** `tasks/<id>.jsonl` | append-only：每一步的开始与结束、每次派发与结算、卡顿、你说过的话、汇报、暂停与关闭 |
| **任务车道**（runtime） | 唯一执行任务的地方：按事实维护状态、管执行槽、给每个执行中的任务一个自己的 runner 与会话 |
| **频道** | 遥控器与受众：所有管理命令的入口，也是任务汇报的地址；任务步骤从不进入频道队列 |

聊天回合不等任务步骤，任务步骤也不等聊天。一个步骤跑多久，聊天都能立即响应。

## 任务模型

### 目录布局

```text
workspace/desk-<desk>/tasks/
├── export-api.md             契约
├── export-api.jsonl          任务记录
├── weekly-report-20261005-0900.md    事件模板生成的实例
├── .sessions/               每个任务一份任务会话
└── archive/
    ├── released-note.md
    └── released-note.jsonl
```

关闭的任务连同它的记录一起移入 `archive/`，不再被车道扫描。

### 文件格式

```markdown
---
state: waiting
waiting: {"kind":"work","since":"2026-10-04T14:40:00+08:00"}
channel: dingtalk:group:cidXXXX
usage: {"startedAt":"2026-10-04T14:02:11+08:00","steps":6,"usd":3.4,"usdEstimated":true}
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

文件头只由运行时写入；模型的任何工具参数都不能直接改它。

| 字段 | 含义 |
|---|---|
| `state` | `queued` 排队中 / `running` 执行中 / `waiting` 等待中 / `paused` 已暂停 |
| `waiting` | 仅 `state: waiting`。`{"kind":"work"}` 等本任务在途的委派或作业；`{"kind":"user","question"}` 等你回答；`{"kind":"time","until"}` 等到某个时刻（均带 `since`） |
| `paused` | 仅 `state: paused`。`{by,reason,at}`，`by` 为 `user` 或 `runtime` |
| `channel` | 汇报频道：创建时写入（聊天里创建取当前频道，事件实例取事件的 `channelId`），之后不变。它没有绑定在本工位上时任务冻结 |
| `usage` | 整个任务的用量：开始时间、步数、成本 |
| `budget` | 可选的每任务预算覆盖，只有 `steps` 与 `usd` |
| `origin` | 仅事件模板生成的实例才有：生成它的事件名 |

**两条不变量**：`state: waiting` ⟺ `waiting` 存在，`state: paused` ⟺ `paused` 存在。读写两侧都强制。

### 正文

| 段 | 内容 |
|---|---|
| `## Goal` | 要成立的结果、范围、允许的外部动作、关键约束 |
| `## DoD` | 客观验收标准，必须是 `- [ ]` 清单。完成任务要求全部勾选——这是负责人的显式确认 |
| `## Work Items` | 工作项：每项可独立派发、独立检查。四态 `[ ]` todo / `[x]` done / `[!]` blocked / `[~]` dropped；**只有负责人**把项标成 done，运行时从不替它打勾 |

契约控制在约 4 KB 以内；运行时从不改写它，超过时写入照常并告警。

## 状态与等待

状态由运行时按事实写下，**没有任何一项由模型声明**：

| 界面用语 | 含义 | 占执行槽 |
|---|---|---|
| 排队中 | 等车道有空位 | 否 |
| 执行中 | 一个步骤正在跑 | 是 |
| 等结果 | 本任务在途的委派或作业还没有结算 | 是 |
| 等你回复 | 负责人向你提了问题；**不设超时**，问题会一直显示在 `/tasks`、`/status` 和聊天的任务议程里 | 否 |
| 等到 HH:mm | 负责人约了一个时刻 | 否 |
| 已暂停 | 你暂停了，或运行时的守护规则暂停了 | 否 |

"等结果"之所以成立，是因为运行时能看到：本任务在途的委派与作业就在 run / job 管理器里，各有自己的硬截止时间。所以不存在"在等，但没有任何东西能叫醒它"的状态。新输入出现就叫醒等待中的任务：结果回来、外部 run 卡住、你发来消息、约定的时刻到了；唯一的例外是"等你回复"只被你的消息叫醒，期间回来的结果记入任务记录，等你回答后一并看到。问题没有送达时运行时会重试，服务重启后也会补发；发送成功与确认落盘之间中断时可能重复收到同一问题。

## 步骤（step）

一个步骤就是任务会话（`tasks/.sessions/<id>.jsonl`）里的一次模型回合，跑在这个任务自己的 runner 里，不进频道聊天会话。**回合结束这一步就结束，没有必须调用的收尾工具**；负责人用最后一段回复写下这一步做了什么、证据和下一步，运行时把它记为这一步的记录。

步骤结束后，运行时看事实决定下一步：

| 这一步结束时 | 接下来 |
|---|---|
| 调用过 `task_close` | 任务结束并归档 |
| 调用过 `task_ask` | 把问题发给你，等你回答 |
| 调用过 `task_wait` | 等到那个时刻 |
| 本任务还有在途的委派或作业 | 等结果 |
| 以上都不是 | 立刻开下一步 |

每个步骤的 brief：首步（以及会话压缩后、契约改动后）带完整契约和最近记录，之后只带新输入、看板和预算状态；token 的节省来自这里，而不是 runner 对象。

**任务步骤默认不向用户发言**：只有 `task_report`（每步至多 3 条）、`task_ask` 与运行时的确定性回执会发往汇报频道。

## 团队看板与工作项

负责人最需要的状态是"我的团队现在在做什么、刚刚回来了什么"。在任务会话里：

- **委派和后台作业自动绑定到本任务**，聊天里发起的工作不绑定任何任务；委派带上它对应的工作项 `item`（`subagent {agent, task, item:"W2"}`），运行时校验这个项存在。
- 绑定的委派/作业派发和结算时，运行时在任务记录里写 `dispatch` / `settle` 记录（含状态、耗时、成本、`VERDICT`、输出文件路径），成本计入任务预算，并**直接通知车道**——结果不再经过聊天。记录与契约一起归档，所以委派记录一周后被回收，任务里的结果仍在。
- 每一步的 brief 里有 `<task_inputs>`（这一步被叫醒的原因：回来的结果及其输出尾部、卡顿报告、你的消息、恢复、上一步的异常）和 `<task_board>`（每个工作项对应的委派/作业、状态与输出路径）。

外部执行者连续 10 分钟没有任何输出，运行时除了推送提示，还会在任务记录里写一条卡顿报告并叫醒负责人，由它看 stderr 与上次输出时间后决定取消重派还是继续等。

`purpose: verify` 的委派让执行者按"检查者协议"工作并以 `VERDICT: PASS|FAIL` 收尾，结论显示在看板上。**它是供负责人权衡的信息，不是闸门**。检查与返工的裁决在 `task-lead.md`；需要结构性只读，用 `mutates: read` 且不含 `bash` 的内置角色，或由 CLI sandbox 强制只读的外部条目（示例 `codex-review`）。

## 预算与守护

每个任务有两维预算，缺省是代码常量，可以按任务在 `budget` 里覆盖，计的是**整个项目**，并且**包含绑定委派的成本**：

| 键 | 默认 | 含义 |
|---|---|---|
| `steps` | 60 | 任务的模型步数上限 |
| `usd` | 20 | 可归因成本上限 |

运行时守护规则命中后暂停任务（`paused`，`by: runtime`），并给汇报频道一条不经模型的回执（带可直接复制的命令）：

| 规则 | 判定 |
|---|---|
| 预算 | 开新步骤之前检查；任一维到顶就不再开步骤 |
| 空转 | 连续 2 个正常结束的步骤都没有任何工具调用 |
| 单步超时 | 单步 20 分钟后请求中止；正常退出且连续 2 次超时会暂停 |
| 连续出错 | 连续 3 个步骤出错；前两次出错后分别等 1 分钟、5 分钟再重试 |

判定都从任务记录得出，重启后依然成立；你**恢复**任务之后，从恢复那一刻起重新计数。`usd` 是粗略值，用来大致掌握花费、拦住失控的项目，不是账单：每一步结束时计入这一步自身的模型成本，绑定委派在结算时计入它上报的成本。拿不到成本的执行者（如 `codex-cli`、`exec`）按 0 计入，并把 `usdEstimated` 置为真；显示成本的地方会标注"含估算"。

## 执行槽与并发

执行中的任务按"占槽"计：**每个工位最多 3 个，整个运行时最多 5 个**（"执行中"与"等结果"占槽，其余状态不占）。槽满时新任务在车道里排队，同一工位内先开始的项目先执行。一个任务同一时刻最多一个步骤。最多 5 个任务步骤与任意聊天回合同时调用模型供应商；聊天与任务可以同时运行在同一个工作目录上，写类委派仍受 lease 保护，主代理自己的 `write` / `edit` / `bash` 不受保护——任务执行中不要在聊天里改它正在改的目录。

## 周期与定时工作

任务本身没有 `schedule`。周期与定时的工作写成[任务模板事件](#任务模板事件周期与定时工作)：事件按 cron 或 `at` 触发，每次生成一个独立的任务实例，交给任务车道执行。槽满时实例排队，不影响事件触发。"立刻再跑一次"就让 agent 用同一份内容 `task_create` 一个项目。

## 与事件的边界

events 与 tasks 之间只有一条边：**事件按模板生成任务实例**，由 runtime 注入的回调完成；events 子系统不读取、不写入任何任务文件，tasks 也不读取 events 目录。任务会话里没有 `event_manage`。`text` 事件仍是一句对话，进入频道的聊天车道；纯提醒用文本事件，需要积累状态、委派和检查的用任务。

## 从聊天管理任务

```text
/tasks                                  列表：状态、实时活动、等待条件、工作项进度、用量
/tasks show <id>                        状态、当前活动、在途委派、工作项、最近记录、任务说明开头
/tasks log <id>                         最近 15 条任务记录
/tasks msg <id> <内容>                   对任务说话：步骤进行中直接送进当前步骤，否则排给下一步；也是回答提问的方式
/tasks pause <id>                       暂停：中止当前步骤，在途委派继续，结果会记下
/tasks resume <id> [+steps N|+usd X]    恢复，可追加预算（在已用量之上的增量）
/tasks cancel <id>                      取消：中止步骤、取消在途委派与作业、归档
/tasks archive                          已归档任务
/tasks doctor                           检查手工编辑造成的问题
```

这些命令在频道忙时也可用，在任意绑定到本工位的频道里都能用：同一工位内不做隔离，任务的汇报与提问只发往它的汇报频道。`/stop` 只停聊天回合，**不会**暂停任务；聊天空闲时 `/stop` 会提示本工位在后台执行的任务和 `/tasks pause`。`/status` 多一行"后台任务：执行中 N · 排队 N · 等你回复 N"。

也可以直接对聊天说话：让 agent 看进展（它读真实状态再回答）、转达你的补充要求或对任务提问的回答、暂停或取消任务。聊天里的回复使用界面用语（[对照表](interaction-and-commands.md#界面用语对照)）：契约显示为"任务说明"，团队看板为"工作项"，任务记录为"任务记录"。它们和模型看到的 brief 读的是同一份数据，但由两个渲染器分别输出（`renderTaskBoardForUser` / `renderTaskLogLineForUser`）。回复受 1,500 字预算约束，超出时给出 `/tasks log <id>` 和任务文件的绝对路径。

运行时的回执使用四个标记：✅ 完成、⚠️ 需要你的决定、🛑 暂停或取消、⏳ 进行中。提问回执是 `⚠️ 任务 … 需要你的决定：…`，暂停回执带任务 id、原因和可直接复制的命令；预算耗尽时附带对应维度的加码示例（`+steps 10` 或 `+usd 5`）。

doctor 只查三类问题：frontmatter 不可读（任务不会执行）、汇报频道缺失或未绑定到本工位（任务冻结）、"等结果"却超过 1 小时没有任何在途工作（车道可能没在运行）。

模型侧的工具面有两套：

```text
聊天：   task_list  task_create  task_log  task_close  task_message  task_pause  task_resume
任务会话：task_log  task_close   task_report  task_ask  task_wait
```

任务会话的工具集里**没有** `task_create`、`memory_save` 和 `event_manage`：任务不建任务、不写工位记忆、不管事件。每回合仍向聊天注入 `<task_agenda>`，每行含状态、等你回复的问题、工作项进度和用量；它是背景参考，不是新指令。

## 冻结

任务的汇报频道缺失、未绑定到本工位、或其渠道未开启时，任务**冻结**：车道不为它开新步骤，不做调度维护；当前步骤允许收尾和记账，退出前仍计入实际并发，其余冻结任务不占槽；你的消息、结果和卡顿报告照常记入任务记录。频道绑回来后从原来的状态继续。冻结不是状态，而是车道的判断；`/tasks` 会标出"已冻结"。

## 异常恢复

- daemon 重启后，车道对账每个活动任务：执行中的步骤补写"被打断"的结束记录并按事实推导下一状态；等结果却没有任何在途工作的回到排队。对账只写状态与日志，不调用模型。
- 运行时暂停（预算、空转、超时、出错）之后用 `/tasks resume` 继续，必要时加码；不再需要就 `/tasks cancel`。
- 漏掉一次通知不会丢事：车道最长每 15 分钟扫描一次，状态与新输入都从文件和任务记录重算。
- 任务记录是排查第一现场：`/tasks log <id>` 能看到每一步做了什么、每次派发与结算的结论。运行日志里的事件名：`tasks.lane.*`、`tasks.task.*`、`tasks.step.*`。
- 终端内嵌的运行时只在终端打开期间运行车道；下次运行时启动由对账恢复。

## 相关文档

- [runtime-playbooks.md](./runtime-playbooks.md)：随包 playbook 目录（含负责人工作法 `task-lead.md`）。
- [configuration.md](./configuration.md)：tasks、events、web 配置。
- [deployment-and-operations.md](./deployment-and-operations.md)：长期运行与排障。
- [sub-agents.md](./sub-agents.md)：委派角色与检查者协议。
- [task-migration.md](./task-migration.md)：旧任务数据的一次性迁移说明。
- [spec 064](./specs/064-task-lane/design.md)：当前任务模型的设计记录。

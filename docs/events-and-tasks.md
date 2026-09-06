# 事件与任务（Events and Tasks）

这份文档讲 Pipiclaw 的两层长程能力，它们合起来让 Pipiclaw 从"被动应答的聊天机器人"变成"能被时间和台账驱动、带着进度本干活"的助手：

- **定时事件（events）** 回答**"什么时候唤醒 agent"**——一个无状态的时间原语。
- **长程任务（tasks）** 回答**"有哪些在途工作、进展到哪、在等什么、验收标准是什么"**——事件缺失的那块持久记忆。

两者由 runtime 协调，但各自独立：**内建 task driver** 按任务的**等待票**推进工作并开启新周期；事件 watcher 负责与任务无关的提醒和外部传感器。任务不需要配套事件才能继续。

> 一句话记忆：**event 无记忆，只管定时；task 带着契约、循环日志和一张可兑现的等待票干活。**

如果你还没完成钉钉和模型配置，请先看 [README](../README.md) 和 [configuration.md](./configuration.md)。子代理（sub-agents）是另一条正交的**委派**能力，见 [sub-agents.md](./sub-agents.md)。

## 怎么读这份文档（Reading Guide）

本文覆盖三类读者，按需跳读，不必从头到尾：

| 你想做什么 | 从哪读起 |
|---|---|
| 用 `/events`、`/tasks` 查看和管理已有的事件与任务 | [`/events` 命令](#events-命令人用只读--删除)、[任务可见性与命令](#可见性与命令) |
| 手写一个事件 JSON，或看懂 agent 建的那个 | [支持的事件类型](#支持的事件类型supported-event-types)、[通用字段](#通用字段common-fields) |
| 看懂任务文件的格式与 frontmatter 契约 | [任务模型](#任务模型)、[Frontmatter 契约](#frontmatter-契约) |
| 搞清楚一个任务在等什么、为什么没动 | [等待票](#等待票ticket)、[异常恢复](#异常恢复) |
| 排查"没有按时触发 / 任务没被推进" | [调度历史记录](#调度历史记录event-history)、[异常恢复](#异常恢复)、[部署排障](./deployment-and-operations.md#常见运维问题common-operational-issues) |
| 理解 driver 与预算 | [内建 task driver](#内建-task-driver)、[预算与停止](#预算与停止) |

agent 侧的操作纪律不在本文，而在随包发布的 runtime playbook 里，见 [runtime-playbooks.md](./runtime-playbooks.md)。

## 心智模型（Mental Model）

| 层 | 载体 | 持有什么 | 谁维护 |
|----|------|----------|--------|
| **tasks** | `workspace/<channelId>/tasks/<id>.md` + `<id>.jsonl` | 契约（意图、DoD、手册、Plan）、循环日志、等待票、本周期用量 | 主 agent 经 `task_create`/`task_update`/`task_close` 建档，任务循环经 `task_step_end` 推进 |
| **task driver** | runtime 确定性扫描 | 兑现到期的票、兜底过期的票、停下超预算的任务、排下一步 | Pipiclaw runtime，扫描本身零 token |
| **events** | `workspace/events/*.json` | 非 task 的独立提醒、外部传感器 | 人（手工 / `/events`）或主 agent（`event_manage`）维护 |

三层文件都放在 app home 下的 `workspace/` 中。默认路径 `~/.pipiclaw/workspace/`；若设置了 `PIPICLAW_HOME`，则为 `${PIPICLAW_HOME}/workspace/`。

**为什么需要两层。** 只有事件时，每次唤醒都是无状态的：agent 醒来只知道事件文本那一句话，不知道有哪些在途工作、上次做到哪、验收标准是什么——触发一次就归零。任务台账补上这块记忆，让工作变成：

> 醒来 → 读契约和最近几条日志 → 推进一个具体步骤 → 记下证据，并说清楚接下来在等什么 → 睡去。

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

# 第二部分：长程任务（Tasks）

事件解决"什么时候唤醒"，任务解决"为什么做、做到哪、下一步是什么"。Task 创建即持续委托：只要任务在活动目录且没有被暂停，runtime 会按它的等待票继续推进。外部动作不产生额外的人工作业流；模型必须遵守任务 Goal、能力配置、真实状态查询和幂等约束。

本节以 **Task v4（spec 051）** 为准。v4 把任务拆成三样东西，各自只做一件事：

| 物件 | 路径 | 是什么 |
|---|---|---|
| **契约** | `tasks/<id>.md` | 目标、验收标准、手册、计划。人可直接编辑，每一步完整注入；4 KB 预算约束的是运行时写的 `## 上次结果`，不会删你写的段落 |
| **循环日志** | `tasks/<id>.jsonl` | append-only：每一步做了什么、每一轮验收结论、每次票据过期、每个周期的收尾 |
| **等待票** | 契约 frontmatter 的 `ticket` | "什么会叫醒我，最迟什么时候"——由 runtime 校验、由 runtime 兑现 |

v3 的 `status`/`enabled`/`control`/`## Current Cycle`/`## History` 全部退役。升级时 daemon 会做一次确定性迁移（原件备份到 `tasks/.v3/`，历史导入循环日志），详见[从 v3 迁移](#从-v3-迁移)。

## 任务模型

### 目录布局

```text
workspace/<channelId>/tasks/
├── weekly-report.md          契约
├── weekly-report.jsonl       循环日志
├── .sessions/               每个 cycle 一份任务会话
├── .steer/                  待处理的用户指示与待发送的通知
├── .verifications/          验收 attestation
├── .v3/                     迁移前的原件（不会被删）
└── archive/
    ├── released-note.md
    └── released-note.jsonl
```

关闭的任务连同它的日志一起移入 `archive/`，不再进入 driver 扫描。

### 文件格式

```markdown
---
state: parked
schedule: 0 9 * * 1
ticket: {"kind":"run","id":"run_zpy4mq","by":"2026-09-06T12:40:00+08:00"}
cycle: {"id":"c-2026-09-05","startedAt":"2026-09-05T09:00:00+08:00","steps":7,"rounds":2,"usd":3.21,"usdEstimated":false,"expired":0}
budget: {"rounds":3}
verify: required
---

# 周报编写与发布

## Goal
每周一完成周报草稿，收到反馈后发布到指定频道。

## DoD
- [ ] 内容覆盖目标时间段的全部工作
- [ ] 数据已由可复现命令核对

## Manual
1. 收集素材并起草。
2. 发布前查询目标频道真实状态，使用稳定的幂等 id。

## Verification
Independent verification: required

## Plan
- [x] P1 收集素材
- [ ] P2 起草并自查

## 上次结果
- c-2026-08-29 完成：已发布，Sent id=68
- 用量：9 步 / 1 轮 / $2.10
```

### Frontmatter 契约

| 字段 | 含义 |
|---|---|
| `state` | `open`（现在有活可干）/ `parked`（在等一张票）/ `done`（已关闭，仅归档文件） |
| `paused` | `{by,reason,at}`。**出现即暂停**，与 `state` 正交；`by` 为 `user` 或 `runtime` |
| `schedule` | 五字段 cron（主机时区），存在即周期任务，最小间隔 30 分钟 |
| `ticket` | `state: parked` 时必需，`open`/`done` 时必须不存在 |
| `cycle` | 本周期的计数：步数、返工轮次、成本、票据过期次数 |
| `budget` | 可选的每任务预算覆盖，见[预算](#预算与停止) |
| `verify` | `required` 时关闭要求本周期最后一条 round 是 PASS，且其 attestation 在关闭时仍然成立 |

**一条不变量**：`state: parked` ⟺ `ticket` 存在。读写两侧都强制，所以 v3 里那些"`enabled:false` 和 `stop` 对不上""`active` 藏着未来的 wake"的组合在 v4 里不可能被表达出来。

### 等待票（Ticket）

一次停泊必须说清楚**什么会叫醒它**，而且这句话要能被运行时当场验证：

| kind | 载荷 | 谁兑现 |
|---|---|---|
| `time` | `at` | driver 到点 |
| `schedule` | `at`（本次 occurrence） | driver 到点，直接开下一个 cycle |
| `run` | `id` | 该委派结算时 |
| `job` | `id` | 该后台作业结算时 |
| `ask` | `asked` | 用户 `/tasks reply` |
| `signal` | `event` | 该 task-owned 周期事件的 preAction 通过时 |

写入时校验：run/job 必须存在、**还没结束**、而且 `taskId` 指向本任务；signal 的事件必须存在、是 periodic、属于本频道、名字指向本任务。不满足就直接拒绝，并告诉模型该改用什么。

**每张票都带 `by`（兜底时限），由运行时确定性推导，模型不写也改不了**：run 用它自己的墙钟 deadline + 10 分钟，job/ask 用 24 小时，schedule 用"错过一次 occurrence"，signal 用"错过两次"。

到点还没兑现时：

1. 第一次——运行时把任务改回 `open`，并在下一步的 brief 开头说明票过期了，让它先确认真实状态。
2. 同一 cycle 第二次——任务保持 parked、置 `paused{by:"runtime"}`，并给用户一条零 LLM 的确定性回执。

> **这就是 v4 存在的主要理由。** v3 允许一个任务停在 `waiting` 上而没有任何东西能叫醒它；两个真实任务因此分别静默了 9 天和 13 天，运行时每天往日志里写上百条无人查看的警告。v4 里这个状态无法被写出来，而且**任何停泊要么被兑现、要么在兜底时限内告诉用户**。

## 循环：cycle 与 step

- **cycle** 是上下文的单位。一次性任务只有一个；周期任务每个 occurrence 一个。开 cycle 会重置计数，并对周期任务复位 Plan 和 DoD checkbox。
- **step** 是 cycle 里的一次模型回合，跑在**任务自己的会话**（`tasks/.sessions/<id>-<cycle>.jsonl`）里，不进频道聊天会话。这样聊天记录不会被任务撑大，任务也不必每次重读整份历史。
- **round** 是一次"委派 → 验收"往返，由运行时在 `purpose=verify` run 结算时自动记账。

每一步必须以 `task_step_end` 收尾，四选一：

| outcome | 含义 | 运行时动作 |
|---|---|---|
| `continue` | 还能接着干 | **立刻**排下一步，没有 backoff |
| `park` | 在等一个真实来源 | 校验票并补 `by`，转 parked |
| `done` | 本周期完成 | 写 `## 上次结果`、记 close、一次性归档／周期停到下一次 |
| `blocked` | 需要用户决定 | 停泊到 `ask` 票，并**一定**通知用户 |

**任务步骤默认不向用户发言**：只有 `task_step_end` 给了 `notify`、或 cycle 关闭 / 提问 / 预算耗尽 / 运行时停止时才会说话。v3 的 `[SILENT]` 协议（要求模型主动说"我不说话"）在任务侧退役；事件唤醒仍然使用它，因为事件仍然投递到聊天会话。

step 是频道队列里的普通条目：占用 turn slot、受 `/stop` 管辖、结束就把频道让回去。一个跑三小时的任务不会锁住聊天。

## 预算与停止

每个 cycle 有四维预算，缺省是代码常量，可以按任务在 `budget` 里覆盖：

| 键 | 默认 | 含义 |
|---|---|---|
| `steps` | 40 | 本周期的模型步数上限 |
| `wallMin` | 180 | 本周期墙钟分钟（不含停泊时间） |
| `usd` | 8 | 本周期可归因成本上限 |
| `rounds` | 4 | 本周期返工轮次上限 |
| `until` | — | 绝对期限（v3 `deadline` 的新家） |

任一项到顶，**在派发下一步之前**任务就被停下，并给用户一条带具体命令的回执（`/tasks resume <id> +steps 20`）。另外，同一周期内连续两步没有任何工具调用也会被停下——那说明循环在自言自语。

外部 run 拿不到真实用量时按角色模型 × 墙钟估算，并把 `usdEstimated` 置为真；任何显示成本的地方都会标注"含估算"。

> v3 用十字段台账指纹加一份进程内 effect 账本去*猜*一次唤醒有没有干活；那套机制在生产里四个月只触发过两次，而它的源码注释自己承认 `echo x` 就能骗过它。v4 用四个任务自己带着、用户看得见也能加码的数字取代了它。

## 独立验收

需要独立验收的任务设 `verificationRequired: true`（frontmatter 里是 `verify: required`）。验收就是一次普通委派：

1. 完成 DoD checklist 后派发 `purpose=verify`、带 `taskId` 的 sub-agent。
2. 用 `task_step_end` 停泊到那个 run 的票上。
3. checker 只判断、不修复实现，结尾写 `VERDICT: PASS` / `FAIL` 并落 attestation。
4. **结算时运行时自动记账**：校验 attestation（归属、契约 hash、artifact subject 新鲜度），把这一轮写进循环日志和 `cycle.rounds`，再兑现票。校验不通过的 PASS 会被记成 FAIL 并写明原因。
5. 关闭时（`task_step_end outcome=done` 和 `task_close outcome=complete` 两个入口共用一次校验）**重新核验**本周期**最后一条** round：它必须是 PASS，且它的 attestation 此刻仍绑定当前契约和当前产物。校验用的是同一个 `attestationRejectionReason`，不是第二套证明模型；verify run 的 checkout 取自持久化的 run 记录，记录不在就失败关闭。

第 5 步的两条规则各自堵一个洞：**取最后一条**——后来的 FAIL 不会被更早的 PASS 覆盖；**重新核验**——结算时那次校验证明的是验收者当时看到的契约与产物，而这两样在 PASS 之后仍然可写，"先通过验收再改 Goal / 再改代码"必须被拒。

`task_verify` 工具已退役：导入 attestation 是记账，不是判断。模型要做的判断没变——读 FAIL 的具体理由、决定哪几条真要返工。

PASS 绑定 Goal/DoD/Manual/Verification 这段契约，不绑定 Plan 和 `## 上次结果`；改动契约或被验收产物后必须重新验收——包括为了记录教训去改 Manual。

## 内建 task driver

driver 是自适应 timer + nudge 的零 token 扫描：

1. **兑现**到期的 `time`/`schedule` 票（后者直接开下一个 cycle）。
2. **兜底**过期的票（重开或通知）。
3. **停下**已经超预算或在空转的任务。
4. **排队**一个可跑的任务，按频道 round-robin 保证公平。

`run`/`job`/`ask`/`signal` 从不轮询——它们由各自的所有者推过来：`SubAgentRunManager` 的结算、`JobManager` 的结算、`/tasks reply`、`EventsWatcher`。所有推送边都要经过同一个幂等的票据兑现，所以 at-least-once 的重放是安全的 no-op。

## 与事件的边界

events 子系统在 v4 中**保持原样**。两者只有一条边相连：一个 task-owned 周期事件（`task.<channelId>.<taskId>.<use>`）触发、且该任务正停在指向这个事件的 `signal` 票上时，运行时兑现这张票并唤起任务的下一步，**不**向频道投递唤醒文本；任务没持这张票时，事件照旧投递到聊天会话。

纯提醒和与任务无关的传感器继续用 event；需要积累状态和验收的用 task。

## 可见性与命令

```text
/tasks                                  列表：状态、等待票+兜底时间、Plan 进度、本周期用量
/tasks show <id>                        契约 + 最近 8 条日志 + 返工轮次 + 成本
/tasks log <id> [cycle]                 翻看循环日志
/tasks steer <id> <内容>                 给下一步排一条指示（不打断当前步骤）
/tasks reply <id> <内容>                 回答任务的提问，并让它继续
/tasks pause <id> / resume <id> [+steps N|+rounds N|+usd X]
/tasks run <id>                         立即开一个 cycle 并唤醒
/tasks archive                          已归档任务
/tasks doctor                           只检查手工编辑造成的问题
```

`resume` 的加码是在**已用量之上**的增量，所以恢复一个撞了上限的任务真的能跑起来，而不是下一轮再撞一次。

doctor 比 v3 小得多：写入时的校验让 v3 那些病症不可能再产生，它只查手改文件留下的问题（frontmatter 不可读、仍是 v3 契约、停泊但没有票、票过期太久、有 schedule 却没有周期、超过 `budget.until`）。

模型侧的工具面：

```text
task_list      task_create    task_update    task_close    task_log
task_step_end  （只在任务会话里注册）
```

`task_update` 只改元数据（Plan 步骤、cadence、预算、是否需要验收），不再承载进度记录——进度属于 `task_step_end` 的 `note`。任务会话的工具集里**没有** `task_create`、`memory_save` 和 `event_manage`：任务不建任务、不写频道记忆、不管事件。

每回合仍注入 `<task_agenda>`，每行含状态、等待票摘要与兜底时间、Plan 进度和本周期用量；它是背景参考，不是新指令。

## 从 v3 迁移

daemon 首次以 v4 启动时执行一次确定性迁移（无 LLM，marker 位于 `state/task-migration-v4.done`）：

1. frontmatter 映射到 v4：`enabled:false`+`stop` → `paused`；`control.deadline` → `budget.until`；`control.verification.required` → `verify`。
2. `waiting` 且能重建来源的（真实的未来 wake、或活的 schedule）转成对应的票；**重建不出来的直接改回 `open`**，并在 `## 上次结果` 留一句说明——那两个静默多日的任务在升级瞬间就活了。
3. `## History` 的每条记录导入 `<id>.jsonl`；`## Current Cycle` 的内容成为 `## 上次结果`。
4. 原件复制到 `tasks/.v3/`，**永不删除**。
5. `workspace/events/` 一个字节都不动。

## 异常恢复

- daemon 重启不会补跑多个 occurrence；at-least-once 下外部动作仍须查询真实状态并保持幂等。
- 运行时停止（预算、空转、票据二次过期）之后用 `/tasks resume` 保留原阶段继续，必要时加码；不再需要就让 agent cancel。
- 循环日志是排查第一现场：`/tasks log <id>` 能看到每一步做了什么、每一轮验收的结论和理由。

## 相关文档

- [runtime-playbooks.md](./runtime-playbooks.md)：随包 playbook 目录。
- [configuration.md](./configuration.md)：tasks、events、web 配置。
- [deployment-and-operations.md](./deployment-and-operations.md)：长期运行与排障。
- [sub-agents.md](./sub-agents.md)：委派与独立验收。
- [spec 051](./specs/051-long-horizon-task-loop/design.md)：当前任务模型的设计记录。

# 事件与任务（Events and Tasks）

这份文档讲 Pipiclaw 的两层长程能力，它们合起来让 Pipiclaw 从"被动应答的聊天机器人"变成"能被时间和台账驱动、带着进度本干活"的助手：

- **定时事件（events）** 回答**"什么时候唤醒 agent"**——一个无状态的时间原语。
- **任务台账（tasks）** 回答**"有哪些在途工作、进展到哪、验收标准是什么"**——事件缺失的那块持久记忆。

两者由**内建 task driver** 绑在一起：driver 依据任务的 `wake` 时间恢复工作、并按任务的 `schedule` cron 开启新周期；事件则承载与任务无关的独立提醒和外部传感器。

> 一句话记忆：**event 无记忆，只管定时；task 会积累手艺、自带节奏；driver 按 wake / schedule 驱动任务。**

如果你还没完成钉钉和模型配置，请先看 [README](../README.md) 和 [configuration.md](./configuration.md)。子代理（sub-agents）是另一条正交的**委派**能力，见 [sub-agents.md](./sub-agents.md)。

## 怎么读这份文档（Reading Guide）

本文覆盖三类读者，按需跳读，不必从头到尾：

| 你想做什么 | 从哪读起 |
|---|---|
| 用 `/events`、`/tasks` 查看和管理已有的事件与任务 | [`/events` 命令](#events-命令人用只读--删除)、[`/tasks` 命令](#tasks-命令给人看零-llm-成本) |
| 手写一个事件 JSON，或看懂 agent 建的那个 | [支持的事件类型](#支持的事件类型supported-event-types)、[通用字段](#通用字段common-fields) |
| 看懂任务文件的格式与 frontmatter 契约 | [任务模型](#任务模型)、[Frontmatter 契约](#frontmatter-契约单一事实源) |
| 排查"没有按时触发 / 任务没被推进" | [调度历史记录](#调度历史记录event-history)、[异常兜底](#异常兜底)、[deployment-and-operations.md](./deployment-and-operations.md#常见运维问题common-operational-issues) |
| 理解 driver 的调度与治理机制 | [内建 task driver](#内建-task-driver)、[受治理 control](#受治理-control) |

agent 侧的操作纪律不在本文，而在随包发布的 runtime playbook 里，见 [runtime-playbooks.md](./runtime-playbooks.md)。

## 心智模型（Mental Model）

| 层 | 载体 | 持有什么 | 谁维护 |
|----|------|----------|--------|
| **tasks** | `workspace/<channelId>/tasks/*.md` | 意图、DoD、手册、状态、周期日志、下一次 `wake`、周期 `schedule` | 主 agent 经 `task_manage` 维护 |
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
| `immediate` | 进程看到文件后立即触发 | 是 |
| `one-shot` | 在指定时间触发一次 | 是 |
| `periodic` | 按 cron 周期触发 | 否 |

## 通用字段（Common Fields）

三类事件都需要下面几个字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | `immediate`、`one-shot` 或 `periodic` |
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

## 三类事件详解（The Three Event Types）

### 立即事件（Immediate）

最适合手动触发一次任务。

```json
{
  "type": "immediate",
  "channelId": "dm_your-staff-id",
  "text": "整理当前会话的 MEMORY.md，把过时内容删掉。"
}
```

- 文件被检测到后会尽快执行。
- 事件入队成功后，文件会被自动删除。
- 如果这是进程启动前遗留的旧文件，Pipiclaw 会把它当成过期事件并删除。

### 单次事件（One-Shot）

最适合未来某个时间点的一次性提醒。额外字段 `at`（带时区偏移的 ISO 8601 时间，必填）：

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
| 手工编辑 `*.json` | 人 | 任意增改，不受任何闸门限制 |
| `/events` 命令 | 人（钉钉侧） | list / show / delete / history —— 只读 + 删除 |
| `event_manage` 工具 | 主 agent | create / update / delete —— 带写入时校验和防自激励闸门 |

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

`event_manage` 是给**主 agent** 的一等工具，让它能创建、修改、删除周期节奏、独立提醒和外部传感器。它与 `/events`、手工编辑操作**同一个**目录。

**参数：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `label` | 是 | 一句话说明这次调度改动（展示给用户） |
| `action` | 是 | `create` / `update` / `delete` |
| `name` | 是 | 事件名（不含 `.json`）。任务派生事件请用 `task.<channelId>.<taskId>.<用途>` 命名（见[事件命名约定](#事件命名约定)） |
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

> 用户手工编辑 `*.json` 或用 `/events` 不受这些闸门限制——它们只约束 agent 的自调度。
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

任务派生事件的命名约定、以及 agent 何时该调用这个工具，见下方[任务台账](#第二部分任务台账tasks)部分。注意：任务的继续、等待、异常恢复**以及周期节奏**都已由内建 task driver 根据任务文件驱动（`wake` + `schedule` frontmatter），**不再需要**为任务创建任何配套事件——`.schedule` 命名约定已退役。event 层只剩非 task 提醒与外部传感器两种场景。

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

事件解决"什么时候唤醒"，但每次唤醒都无状态。任务台账把在途工作的记忆补上，让 Pipiclaw 从"定时执行器"变成"带着工作手册和进度本的驱动者"。

设计规格见 [`019 Task Ledger`](./specs/019-task-ledger/design.md)、[`022 Native Task Driver`](./specs/022-native-task-driver/design.md)、[`023 Governed Task Loops`](./specs/023-governed-task-loops/design.md) 与 [`024 Task Loop v2`](./specs/024-task-loop-v2/design.md)。

**核心不变式：task 是在途工作的真相；`wake` 本身就是可执行的恢复条件，`schedule` 是周期节奏的唯一真相。** 任务的继续、等待、异常恢复和周期开新一轮都不依赖任何配套事件——一个周期任务就是一个文件。

task driver 默认开启。主 agent 的系统提示只常驻恢复与安全不变量，以及 runtime playbook 的小型索引；任务规划、推进、验收和修复流程由随包 playbook 按需加载（见 [runtime-playbooks.md](./runtime-playbooks.md)）。升级或新安装后无需复制 heartbeat JSON、传感器脚本，也无需把 runtime 模板粘进 workspace `AGENTS.md`。

## 任务模型

### 目录布局

```text
workspace/<channelId>/tasks/
├── weekly-report.md        # 周期性任务（常驻一个文件）
├── fix-voice-typer-ci.md   # 一次性任务（完成后移入 archive/）
└── archive/
    └── fix-login-bug.md     # 已完结的一次性任务 / 已退役的周期性任务
```

- 一个任务 = 一个 kebab-case 命名的 `.md` 文件，文件名即任务 id。
- `archive/` 存放已闭环的任务，是周报素材和复盘依据；不参与任何扫描。

### 文件格式

平铺 frontmatter（机器控制面）+ Markdown 正文（目标、手册与证据）：

```markdown
---
status: active
wake: 2026-07-08T14:00:00+08:00
schedule: 0 9 * * 1
recurrence: 每周一
control: {"version":1,"priority":"high","lastOutcome":"progress","dependsOn":[],"isolation":"shared","sideEffects":"external","externalApproval":"required","budget":{"maxAttempts":12,"maxTokens":120000},"usage":{"attempts":2,"tokens":18420,"costUsd":0.42,"costKnown":true,"wallTimeMinutes":16.3},"lifetimeUsage":{"attempts":8,"tokens":72000,"costUsd":1.84,"costKnown":true,"wallTimeMinutes":61.5},"verification":{"mode":"independent","status":"pending"},"nextAction":"等待确认后发布"}
---

# 周报编写与发布

## 目标
每周一完成上周周报的编写，经师兄确认后发布到 <渠道>。

## DoD
- [ ] 内容覆盖上周全部工作（素材：git log、上周 archive/ 的任务、MEMORY.md）
- [ ] 数据准确（先核对 X 数据源）
- [ ] 待发布内容、目标渠道与发布参数已准备并核对

## 手册
1. 收集素材，起草
2. 发草稿给师兄，安排当天 14:00 回访检查点
3. 确认后发布、验证、复盘

## 验收
Mode: independent
- 逐项核对 DoD
- 核对待发布内容与动作参数；实际发布结果在用户批准后写入 done evidence

## 当前周期（2026-W28）
- 07-08 09:32 草稿 v1 已发师兄，等待反馈

## 历史
### 2026-W27 — done
1 轮返工：数据错误 1 处，原因是没核对 X 数据源 → 已把预检写入手册第 1 步。
```

frontmatter 字段：

| 字段 | 必填 | 取值 | 说明 |
|------|------|------|------|
| `status` | 是 | `active` / `waiting` / `verifying` / `paused` / `done` / `cancelled`（六态，每态唯一 driver 行为） | paused/cancelled 不会被 driver 继续（治理器停止的任务是 `paused` + `control.pausedBy: "governor"`，用户暂停是 `pausedBy: "user"`）；done 一般睡眠，唯有有 `schedule` 的周期任务到点被 driver 开新周期；verifying 进入 checker-only 回合。旧值 `open`/`in-progress`→`active`、`awaiting-user`/`blocked`→`waiting`、`escalated`→`paused(governor)` 在读取层无损映射，写盘即新名 |
| `wake` | 否 | 带时区的 ISO 8601 | 最早值得再看一眼的时间。缺省 = 随时可推进。周期任务 done 后由 driver 写成下一次 occurrence |
| `schedule` | 否 | 五段 cron | 周期节奏的**唯一真相**，按主机时区解释；部署时用 `TZ=<IANA timezone>` 固定。存在 = 周期任务。最密每 30 分钟 |
| `recurrence` | 否 | 自由文本（如 `每周一`） | 仅作标注给人读，无机器语义 |
| `control` | 新任务是 | 单行 JSON，`version: 1` | priority/deadline/nextAction、父子依赖、隔离与副作用策略、预算/用量、独立验收状态 |

旧任务没有 `control` 仍可运行，按 evidence-only 的兼容路径收尾；新任务由 `task_manage create` 自动生成受校验的 control。不要手写或多行格式化这段 JSON，日常修改交给 `task_manage set/progress`。

### 受治理 control

- **调度**：`priority` 决定 ready task 顺序，`deadline` 是硬截止，`nextAction` 是下一步可执行动作。
- **预算**：`maxAttempts` 必有；可追加本周期累计的 `maxTokens`、`maxCostUsd`、`maxWallTimeMinutes`。driver 每次原生唤醒先 claim attempt，回合结束把主代理与子代理的实际 usage 计回 task；预算在回合边界检查，不能中断一个正在运行的回合。模型缺少价格元数据时 cost 显示 unavailable，不能配置有效的 `maxCostUsd`，应使用 `maxTokens`。达到任一可用上限就被治理器暂停（`paused` + `pausedBy: "governor"`）。`lifetimeUsage` 另存不随周期清零的审计累计，不参与本周期 governor。
- **关系**：`parent` 表示父任务，`dependsOn` 中的任务必须 done 才能运行/收尾；创建和 set 会拒绝缺失关系、自依赖和环。父任务也不能在仍有未完成 child 时 done。
- **隔离**：`isolation: worktree` 表示写密集型子任务应交给 `subagent` 的同名隔离模式；runtime 自动把 path/branch 记录到 control，父代理负责 review、merge 与 cleanup（见 [sub-agents.md](./sub-agents.md)）。
- **副作用**：`sideEffects: external` 自动进入 required；agent 不能自授予。用户审阅拟执行动作后，直接发送 `/tasks approve <id>`，runtime 记录 approver/时间与 task body hash 才变为 granted；后续 progress 或正文变化会要求重新授权。
- **验收**：新任务默认 `verification.mode: evidence`，`done` 时把 maker self-check 记为 PASS；有独立可检查产物时显式选择 `independent`，实现者先 `candidate`，checker-only 回合调用 `subagent purpose=verify taskId=<id>`，再用 `task_manage verify` 导入 runId。PASS 绑定 task 的**契约段**（Goal/DoD/Manual/Verification 及勾选状态，不含 Current Cycle/History）：记日志不失效，改契约才失效。

当 independent 与 external 同时存在时，先验收待执行动作得到 PASS，再用 `task_manage set wake=...`（停留在 `verifying` 车道，仅改 wake）等待 `/tasks approve`；只改 wake、不换状态可保留 PASS——**离开 verifying 的 `set` 会作废验收**。获批后执行并直接 done。契约段与 approval 都绑定同一份契约 hash，日志不会误伤；不要把"已经发布"写成 candidate 前必须勾选的 DoD；外部执行结果由 approval audit 和 done evidence 收口。

### Frontmatter 契约（单一事实源）

内建 task driver、任务摘要、`/tasks` 和 `task_manage list` 全部复用 `src/shared/task-ledger.ts` 的同一份解析与判定，不再维护仓库外的镜像传感器实现。

**解析规则**（有意做到极简、可被独立实现逐字复刻）：

1. **frontmatter 块** = 文件必须以 `---` 开头；块的结束是其后第一个 `\n---`。取二者之间的内容为 frontmatter。不满足（无起始 `---` 或找不到结束 `---`）→ **无可读 frontmatter**。
2. **字段提取** = 在块内逐行找 `key: value`：以第一个 `:` 切分，键取左侧 `trim()`，值取右侧 `trim()`。不解析嵌套 YAML；只认 status/wake/schedule/recurrence/control 五个平铺键。control 的值是单行 JSON。
3. **`status`**：`done` / `cancelled` / `paused` 不 actionable；其余状态按 wake 判定。
4. **`wake`**：解析为时间戳。**缺省、为空、或无法解析 → 视为"随时可推进"（不构成推迟）**；能解析且 `wake > now` → 该任务"未到点"。
5. **判定：`actionable`（可推进）** = `status` 未关闭 **且**（无有效 `wake` **或** `wake ≤ now`）。driver 在此之前还会对睡眠任务执行零 token 的 deadline/budget/terminal-dependency 检查。
6. **fail-open**：frontmatter、control 或文件不可读 → 视为 actionable，让 agent/doctor 暴露并修复，而不是静默漏掉。

> 一句话记忆：**先做确定性治理门禁，再对 ready task 唤醒模型；读不懂就暴露并修复。**

### 生命周期：一次性与周期性统一

只有一个状态机：

```text
active ⇄ waiting → (candidate) verifying → done
```

六个状态各自映射唯一 driver 行为，非法转移由一张 `action × fromStatus → toStatus` 转移表统一挡下（`src/tasks/transitions.ts`）。`paused` 永不派发（用户暂停或治理器停止）。

一次性和周期性任务的唯一差别，是 **done 之后文件去哪**：

| | done 之后 | 不变式 |
|---|---|---|
| 一次性任务 | 移入 `archive/`（收尾 SOP 的最后一步） | `tasks/` 根目录下不存在 done 的一次性任务 |
| 周期性任务 | 文件留在原地，done = 睡眠 | done 的周期性任务 = 睡到 `wake`（下一次 occurrence）由 driver 开新周期 |

于是"文件存在 = 未完成"这个直觉被推广为一条统一不变式：

> **`tasks/` 根目录下任何 status ≠ done 的文件，都代表有活要干；有 `schedule` 的 done 文件是睡到下一轮的周期任务。**

周期性任务是**单个文件**：`done` 时"唯一时间规则"用 croner 算出下一次 occurrence 写入 `wake`；到点后 **runtime 直接开新周期**（这是 driver 唯一会唤醒 `status: done` 的场景，没有 `start-cycle` 动作，也不再派发单独的 cycle-start 事件请模型开周期）：

1. `task_manage done` 记录本轮收尾；写盘时唯一时间规则算出下一次 `wake`，状态保持 `done`。
2. `wake` 到点，runtime 在一次原子写里把"当前周期"及其 completion evidence 折进"历史"、只保留最近的有界工作历史、清空本周期 usage/独立验收/外部授权/worktree 元数据（`lifetimeUsage` 保留）、生成具名 cycleId（`cycle-YYYY-MM-DD`，同日重开加序号）、状态置 `active`，随后派发一条**普通驱动唤醒**。agent 醒来面对的就是一个待推进的新周期，与其他唤醒无异。
3. 若上一轮还没 done（过期未完成）：先处置旧周期（补完，或明确放弃并记录原因），再开新周期。

周期预算不会跨周期耗尽（reset 随开周期发生）。这一步是确定性文本变换，LLM 出环——不再有"模型没正确开周期"这一类失败。

**改节奏** = `task_manage set schedule="<新 cron>"`（done 任务写盘时由唯一时间规则重算 `wake`）。**退役** = `task_manage cancel`，归档并清理全部 task-owned events，不再有"记得删事件"这一步。

## 事件命名约定

`workspace/events/` 是**全局单目录**（不按 channel 分），所以任务派生的事件名必须编入 channelId，否则两个 channel 的同名任务会互相覆盖对方的事件：

```text
task.<channelId>.<任务id>.<用途>.json
# 例：task.dm_123.weekly-report.sensor.json（临时外部完成传感器）
```

周期节奏不再走事件——它是任务文件里的 `schedule` frontmatter（`.schedule` 命名约定已退役）。task 派生事件如今只剩一种真正响应式的场景：外部完成探测等临时**传感器**（带 `preAction` 的 periodic）。任务收尾时用 `task.<channelId>.<id>.*` 前缀一把清理，不留孤儿。

## 内建 task driver

task driver 随 DingTalk daemon 启动，做廉价的确定性扫描（零 token）：先拦截超 deadline/budget 或 terminal dependency 的任务并升级，再从 dependency-ready 的 actionable task 中按 priority/deadline 排序、并为到点的周期任务派发 cycle-start，向对应 channel 入队一条唤醒消息。

**唤醒机制是单个自适应 timer + nudge**，不再固定每分钟轮询：每次扫描顺手收集"下一个感兴趣时刻"（最近的未到点 `wake`、退避到期、deadline），睡到那一刻或封顶 `maxSleepMinutes`（默认 15 分钟）为止；回合结束会 nudge 立即重扫，让连续推进的任务链即时衔接。绕过 runtime 的手工编辑最坏等一个封顶周期才被接起，`/tasks run <id>` 兜底。

为避免错误台账或忘记更新状态造成 token 热循环，driver 有多层节流：

- channel 正在运行时不重复入队；
- 上一轮修改了 task 文件，最早 5 分钟后继续下一轮；
- 上一轮没有留下任何台账变化，退避 60 分钟再重试；
- **连续 3 次唤醒都没有可见进展**（fingerprint 未变，含 silent），治理器暂停任务（`paused` + `pausedBy: "governor"`）并通知用户——任何唤醒循环要么推进文件，要么在 3 × 退避间隔内被叫停上报，不会无限烧钱。台账一变即清零；计数在内存，重启后重新累计；
- 每个 tick 全局最多派发 4 个 channel，并轮转起点防止饥饿。

每次受治理唤醒会累计 attempt；回合完成后 runtime 把 token、cost、wall time 回写。等待中的依赖不会触发 agent，也不会消耗 attempt。缺失、cancelled 或被治理器暂停（`paused` + `pausedBy: "governor"`）的依赖属于 terminal failure，依赖方会一起被治理器暂停并给出恢复说明。

这些默认值可在 [`settings.json`](./configuration.md) 的 `taskDriver` 中调整或关闭。进程重启后内存中的退避状态会清空，因此遗留 actionable task 会在下一次扫描被重新接起——这是有意的 fail-open 恢复语义。

### Runtime 知识与内置 playbooks

系统提示只保留每回合不能忘的所有权、安全和 task 恢复纪律。完整 runtime 知识以只读 playbook 随包发布（构建后为 `dist/playbooks/`），**不占用 workspace**。每份文件用 `name` / `description` metadata 描述触发场景，系统提示自动生成小型目录；agent 只在匹配时用 read 加载正文。

与任务生命周期直接相关的有四份——`task-planning.md`（建档与周期 `schedule`）、`task-driving.md`（推进、恢复与修复）、`task-closeout.md`（验收、审批与闭环）、`task-delegation.md`（分解与委派）；事件侧是 `event-scheduling.md`。

**完整目录、门控工具与编写原则见 [runtime-playbooks.md](./runtime-playbooks.md)**，那里是这份清单的唯一出处，本文不再重复。不要把 playbook 抄进 workspace；个人偏好和团队策略写进 workspace `AGENTS.md`，可复用的用户流程沉淀成 workspace skill。

## 可见性：`/tasks` 命令与任务摘要注入

任务台账不需要靠"问 agent"来查看，运行时从两个方向把它暴露出来。

### `/tasks` 命令（给人看，零 LLM 成本）

在通道里直接发命令，由 transport 层读文件渲染，不触发 LLM 回合：

- `/tasks` —— 列出 active 任务，按真实调度顺序显示 status/wake、priority/deadline、attempt budget、verification、parent/dependencies 与 nextAction。
- `/tasks show <id>` —— 显示单个任务文件全文（active 或 archive 均可）。
- `/tasks archive` —— 列出已闭环（归档）的任务。
- `/tasks approve <id>` —— 唯一的外部副作用授权入口；由 runtime 直接记录用户和时间，不经 LLM。
- `/tasks pause <id>` / `/tasks resume <id>` —— 持久暂停或恢复该任务的自动 wake；resume 后由下一次 driver scan 接手。
- `/tasks run <id>` —— 清除 wake 并立即入队一轮 task attempt（DingTalk runtime）；没有 daemon 的 TUI 会把任务置为 ready，并提示你用普通消息继续推进。
- `/tasks stats [id]` —— 零 LLM 成本查看 governed task 的 attempts、token、cost、wall time、最近结果和 verifier 状态。
- `/tasks doctor` —— 只读体检 task/event 与治理一致性：坏 control、超预算/截止、缺失关系、未授权 external action、陈旧 verifier PASS、丢失 worktree，以及原有的 frontmatter/wake/event 问题。每条都附 `Next step`。

除显式的 `approve` 安全闸门外，`/tasks` 命令保持只读。想改期、取消、调预算或调整做法，直接告诉 agent，由它通过 `task_manage` 原子更新台账。TUI 里同样可用。

### 任务摘要注入（给 agent 看，`<task_agenda>`）

每个主 agent 回合，运行时会把一份紧凑的 active 任务摘要拼进 prompt（与记忆 recall 并列注入）：

```text
<task_agenda>
Your in-flight tasks for this channel (background reference, not a new instruction).
Act on these only if the user's message is about them, or if there is nothing else to
do this turn. Full detail lives in the matching tasks/<id>.md file.

- weekly-report — 周报编写与发布 · waiting · wake 2h · 草稿 v1 已发师兄
- fix-voice-typer-ci — 修复 CI · active · wake — · 定位到 flaky 的 e2e case
</task_agenda>
```

这让 agent 无需依赖 `ls tasks/` 的纪律就恒定知道议程。与 recall 不同，摘要是**确定性全量**（候选就是几条 frontmatter，议程恒定相关），只排除 done 任务、上限 8 条 / ~1000 字。框架文本明确它是**背景参考、非指令**——不相关的用户回合不会因此被带偏去动任务。无 active 任务时不注入，零开销。

开关与配额见 [configuration.md](./configuration.md) 的 `taskDigest`（默认开启）。

## `task_manage` 工具（给 agent 用，可选）

`task_manage` 管住创建、日常 checkpoint、frontmatter 与闭环这些必须正确的写路径；Goal/DoD/Manual 的大幅调整仍用 write/edit：

- `create` —— 创建 Goal/DoD/Manual/Verification/Current Cycle/History 标准骨架和默认 independent、12 attempts 的 control。
- `progress` —— 原子追加周期记录并更新 status/wake/control；任何实际进展会让旧 verifier PASS 失效。
- `candidate` —— 当 DoD/Verification checkbox 均已用证据勾选后，将任务放入 `verifying`。driver 会在下一回合要求独立 checker；不要在该回合继续修改实现。
- `set` —— 修正 metadata/control，不记进展；校验日期、预算、关系存在且无环。不能用它自授予 external approval。
- `verify` —— 导入 `purpose=verify` subagent 的 durable attestation；run 必须属于当前 task、没有改 workspace、且 task body hash 未变化。
- `done` —— 门禁 DoD/Verification 中未勾选的 checkbox、dependencies/children、external approval、independent PASS 与 body hash，再记录 summary/evidence、归档/保留周期任务并清事件。
- `cancel` —— 记录原因、取消并归档，同时清理全部 task-owned events。
- `list` —— 返回结构化 active task 与完整 control 摘要。

周期任务的开新周期已收归 runtime（确定性、LLM 出环），不再有 `start-cycle` 动作。

它的价值是"骨架一致 + progress 原子 checkpoint + frontmatter 保真 + 闭环收口"，不是权限收口（agent 仍可用 write/edit 写大段正文）。开关见 [configuration.md](./configuration.md) 的 `tools.tasks.enabled`（默认开启）。

host Git checkout 的 verifier 还会记录 artifact subject（HEAD、working tree 与 staged/unstaged diff）。导入 PASS 和 `done` 都会重新比较 subject；代码或产物改动后必须重跑 verifier。

## 外部 Agent 工具的回访边界

Pipiclaw 不内置 agentmux 或其他第三方 agent 工具的命令、状态协议和检测脚本。这些能力属于用户安装的可执行文件与 workspace skill。

runtime 只提供通用恢复机制：委派时把工具/实例/目录/预期产物写进 task，置 blocked 并设 wake；到点后按用户 skill 检查、取回和验收。如果用户工具提供稳定的完成态检测命令，可以自行用 periodic + preAction 做条件唤醒，但必须保留 wake 兜底，并在闭环时删除临时事件。

---

# 第三部分：事件与任务如何协作

前两部分分别讲了时间原语（事件）和状态层（任务）。这一部分用**一个完整周期**演示两者如何咬合——这也是把它们放进同一份文档的原因。

## 一个周期性任务 = 一个 task 文件

以"每周一完成上周周报"为例（对比：只用事件时，每周一触发一次就归零，不积累任何记忆）：

1. **创建（一次）**：你说"以后每周一帮我写上周周报"。agent 建 `tasks/weekly-report.md`（目标 / DoD / 手册），并在 frontmatter 写 `schedule: 30 9 * * 1`（周一 09:30）。一次写文件，无配套事件。
2. **周一 09:30 到点**：runtime 直接开新周期（把上周期折进历史、清空周期元数据、置 `active`）并派发一条普通驱动唤醒；agent 收集素材（含上周 `archive/` 里已完结的任务）、起草并完成发布前能验证的 DoD。
3. **独立验收**：全部 acceptance checkbox 有证据后 `candidate`；checker-only 回合调 `subagent purpose=verify` 得到 PASS。因为发布还需 external approval，此后不再 progress 或改正文。
4. **请求授权**：用 `task_manage set wake=当天14:00`（停留在 `verifying`，仅改 wake）保留 PASS，发草稿并请你 `/tasks approve <id>`。
5. **回访与闭环**：driver 到点核对 PASS 与授权仍新鲜；获批则发布、验证发布结果并 `task_manage done`——done 顺手把 `wake` 算到下周一。未获批则继续用 set 调整等待 metadata，不改正文。
6. **下周期更聪明**：下周一 driver 照常开新周期，但任务文件里已经积累了你的格式偏好、上次返工原因、新增的预检步骤——**event 无记忆，task 会积累手艺、自带节奏**。

**各层各司其职：** 步骤 2/6 的定时与开新周期、步骤 5 的回访都来自 **driver**（按 `wake` / `schedule` 驱动）；步骤 3–5 的状态、验收、授权记忆来自**任务**，全程不需要任何配套事件。

## 异常兜底

若开周期或推进回合中途失败，任务停在 `done`（未开新周期）或 `active` / `waiting`；driver 根据未到 / 已到的 `wake` 和退避状态把它接回来。`status: done` + 有 `schedule` 但 `wake` 缺失/损坏时，driver 走同一条唯一时间规则（`normalizeTaskFields`）确定性重算 `wake`（零 token 自愈），不误开一轮意外周期。daemon 重启会清空内存退避，遗留 actionable task 在下一次扫描恢复。投递语义是 at-least-once，任务推进应保持幂等、可重试。

---

## 该看哪份文档

- 工作区配置子代理（委派、worktree、独立验收）：[sub-agents.md](./sub-agents.md)
- `tools.events.enabled` / `tools.tasks.enabled` / `taskDriver` / `taskDigest` 等门控开关：[configuration.md](./configuration.md)
- Runtime playbooks 与知识分层：[runtime-playbooks.md](./runtime-playbooks.md)
- 长期运行、日志、升级、排障：[deployment-and-operations.md](./deployment-and-operations.md)
- 设计规格与取舍：[specs/019-task-ledger/design.md](./specs/019-task-ledger/design.md)

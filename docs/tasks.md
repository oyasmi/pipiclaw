# 任务台账（Task Ledger）使用指南

这份文档讲 Pipiclaw 的**任务台账**——一个语义上高于[事件（events）](./events-and-sub-agents.md)的持久任务层。

事件解决"什么时候唤醒 agent"，但每次唤醒都是无状态的：agent 醒来只知道事件文本那一句话，不知道有哪些在途工作、进展到哪、验收标准是什么。任务台账补上这块记忆，让 Pipiclaw 从"定时执行器"变成"带着工作手册和进度本的驱动者"：

> 醒来 → 查看在途工作 → 推进最需要推进的一项 → 记下状态和下次检查点 → 睡去。

设计规格见 [`docs/specs/019-task-ledger`](./specs/019-task-ledger/design.md)。

## 三层职责

| 层 | 载体 | 持有什么 | 谁维护 |
|----|------|----------|--------|
| **tasks** | `workspace/<channelId>/tasks/*.md` | 意图、DoD、状态、手册、周期日志 | 主 agent（用 read/edit/write 工具） |
| **events** | `workspace/events/*.json` | 唤醒时间点，文本退化为指针（"推进任务 X"） | 主 agent 经 [`event_manage`](./events-and-sub-agents.md#event_manage-工具agent-自调度) 工具 |
| **心跳传感器** | `preAction` 脚本 | 确定性判断"有没有活要干" | 脚本，零 token |

核心不变式：**event 无状态、可丢弃；真相永远在 task 文件里。** 事件文件误删、过期、丢失，最坏后果只是"晚一点被心跳捞起来"，不丢工作。

> **注意**：runtime 不解析 task 文件。任务台账是一套**文件约定 + 提示词 SOP**，靠主 agent 的纪律来维护，靠心跳来兜底。下面的 SOP 需要合入你的 workspace `AGENTS.md` 才会生效。

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

YAML frontmatter（机器可读的最小集，**只有三个字段**）+ Markdown 正文（agent 的领地）：

```markdown
---
status: in-progress
wake: 2026-07-08T14:00:00+08:00
recurrence: 每周一
---

# 周报编写与发布

## 目标
每周一完成上周周报的编写，经师兄确认后发布到 <渠道>。

## DoD
- [ ] 内容覆盖上周全部工作（素材：git log、上周 archive/ 的任务、MEMORY.md）
- [ ] 数据准确（先核对 X 数据源）
- [ ] 师兄确认后发布，并验证发布成功

## 手册
1. 收集素材，起草
2. 发草稿给师兄，安排当天 14:00 回访检查点
3. 确认后发布、验证、复盘

## 当前周期（2026-W28）
- 07-08 09:32 草稿 v1 已发师兄，等待反馈

## 历史
### 2026-W27 — done
1 轮返工：数据错误 1 处，原因是没核对 X 数据源 → 已把预检写入手册第 1 步。
```

frontmatter 字段：

| 字段 | 必填 | 取值 | 说明 |
|------|------|------|------|
| `status` | 是 | `open` / `in-progress` / `awaiting-user` / `blocked` / `done` | 机器只区分 done / 非 done；细分状态给人和 agent 看 |
| `wake` | 否 | 带时区的 ISO 8601 | 最早值得再看一眼的时间。缺省 = 随时可推进 |
| `recurrence` | 否 | 自由文本（如 `每周一`） | 仅作标注给人读；**节奏的真相在对应的 periodic 事件里** |

刻意不设 priority / due / owner / cycle-id：优先级和截止时间写在正文里由 agent 判断，避免 frontmatter 膨胀成第二个状态机、也降低 agent 写脏字段的破坏面。

### 生命周期：一次性与周期性统一

只有一个状态机：

```text
open → in-progress ⇄ awaiting-user / blocked → done
```

一次性和周期性任务的唯一差别，是 **done 之后文件去哪**：

| | done 之后 | 不变式 |
|---|---|---|
| 一次性任务 | 移入 `archive/`（收尾 SOP 的最后一步） | `tasks/` 根目录下不存在 done 的一次性任务 |
| 周期性任务 | 文件留在原地，done = 睡眠 | done 的周期性任务 = 等下一次 periodic 事件唤醒 |

于是"文件存在 = 未完成"这个直觉被推广为一条统一不变式：

> **`tasks/` 根目录下任何 status ≠ done 的文件，都代表有活要干。**

周期性任务的新一轮**只由它的 periodic 事件开启**（心跳不开新周期，只推进已开启的工作，避免两个入口竞争）：

1. periodic 事件触发（文本："推进任务 weekly-report"）。
2. agent 打开任务文件。若 `status: done`：把"当前周期"一节折叠进"历史"（历史只保留最近约 5 轮），开一节新的"当前周期"，`status` 置 `in-progress`，开始干活。
3. 若上一轮还没 done（过期未完成）：先处置旧周期（补完，或明确放弃并记录原因），再开新周期。

**退役**周期性任务 = 文件移入 `archive/` + 用 `event_manage` 删除它的 periodic 事件。

### 一个周期性任务 = 一个 task 文件 + 一个 periodic 事件

职责分离：task 文件积累手艺（DoD、手册、返工教训），periodic 事件只管节奏。改节奏改事件，改做法改文件，互不牵连。

任务与事件不是一对一：一个任务生命周期里还会临时消耗多个 one-shot 检查点事件。

### 事件命名约定

`workspace/events/` 是**全局单目录**（不按 channel 分），所以任务派生的事件名必须编入 channelId，否则两个 channel 的同名任务会互相覆盖对方的事件：

```text
task.<channelId>.<任务id>.<用途>.json
# 例：task.dm_123.weekly-report.schedule.json（periodic 节奏）
#     task.dm_123.weekly-report.checkin.json（one-shot 回访）
```

任务收尾时用 `task.<channelId>.<id>.*` 前缀一把清理，不留孤儿。

## Agent 工作 SOP（合入 workspace AGENTS.md）

把下面这段合入你的 `~/.pi/pipiclaw/workspace/AGENTS.md`，任务台账才会真正运转起来。

```markdown
## 任务台账（tasks）

任务存放在 `<当前channel目录>/tasks/*.md`。每个任务文件的 frontmatter 有三个字段：
`status`（open/in-progress/awaiting-user/blocked/done）、`wake`（最早再看的时间，ISO8601）、
`recurrence`（可选标注）。正文写目标、DoD、手册、当前周期日志、历史。

### 唤醒时
- 事件文本指名了任务（"推进任务 X"）→ 直接打开该任务。
- 心跳唤醒（没指名）→ `ls tasks/*.md`，读各文件 frontmatter，挑出可推进的任务
  （status ≠ done 且 wake 已到或未设），按正文里的优先级判断先推进哪个。
- 然后推进：按手册执行 / 检查 agentmux 委派的进展 / 处理用户反馈。

### 回合结束前（雷打不动）
1. 更新任务文件：status、wake、在"当前周期"追加一行（做了什么、卡在哪、下一步）。
2. 若任务仍在途且有明确的下次检查时间：用 event_manage 创建/改期 one-shot 回访事件
   `task.<channelId>.<id>.checkin`，并把任务的 wake 同步到同一时间点——
   wake 与 checkin 事件是对称的一对，一起动、一起清。
3. 任务 done：
   - 一次性任务 → 把文件移入 tasks/archive/；
   - 周期性任务 → 把"当前周期"折叠进"历史"（历史保留最近约 5 轮）；
   - 两种情况都用 event_manage 删除 task.<channelId>.<id>.* 的残留 one-shot 事件。

### 创建任务时
- 从用户指令提炼目标 / DoD / 手册，写入新的 tasks/<id>.md（status: open 或 in-progress）。
- 周期性任务：同时用 event_manage 创建 periodic 事件 task.<channelId>.<id>.schedule，
  文本写"推进任务 <id>"。
- 发布、发消息等外部不可逆动作，仍需先与师兄确认（见安全边界）。

### 阻塞时
- 等用户反馈 → status: awaiting-user，wake 设到下一个回访点，安排 checkin 事件。
- 等外部条件 → status: blocked，在正文写清卡点。
- 阻塞不等于停摆：转去推进台账里别的可推进任务。
```

## 心跳（heartbeat）

心跳是**兜底**，不是主驱动。主驱动是任务自带的事件（periodic 节奏 + one-shot 回访）；心跳只负责捞起漏网的工作：agent 忘了安排回访、one-shot 在进程宕机期间过期被删、回合中途出错任务卡在 in-progress。

心跳 = 一个 periodic 事件 + 一个 `preAction` 传感器脚本，**零代码改动**：

`~/.pi/pipiclaw/workspace/events/heartbeat.json`：

```json
{
  "type": "periodic",
  "channelId": "dm_<staffId>",
  "text": "心跳：扫描 tasks/ 台账，推进最需要推进的一项；若无事可做回 [SILENT]。",
  "schedule": "0 9-19 * * 1-5",
  "timezone": "Asia/Shanghai",
  "preAction": {
    "type": "bash",
    "command": "node \"${PIPICLAW_HOME:-$HOME/.pi/pipiclaw}/workspace/skills/tasks-pending.mjs\" dm_<staffId>"
  }
}
```

`preAction` 脚本先做确定性判断：只有当台账里存在**可推进**的任务（status ≠ done 且 wake 已到或未设）时才退出码 0、唤醒 agent；否则退出码非 0，事件被静默跳过，**不消耗任何 token**。这就是 `wake` 字段的意义：awaiting-user / blocked 的任务把 wake 设到下一个回访点，心跳每小时扫过时因 wake 未到而安静。

每小时一次足够——心跳只是安全网，正常路径的实时性由 one-shot 回访保证。路径用 `${PIPICLAW_HOME:-$HOME/.pi/pipiclaw}` 展开，兼容默认目录与自定义 `PIPICLAW_HOME`。

### 传感器脚本

放到 `~/.pi/pipiclaw/workspace/skills/tasks-pending.mjs`：

```javascript
#!/usr/bin/env node
// tasks-pending.mjs — heartbeat sensor for the task ledger.
//
// Exit 0 (wake the agent) iff at least one task in this channel is actionable:
//   status != done  AND  (no wake, or wake <= now).
// Exit 1 otherwise (nothing to do — the heartbeat stays silent, zero tokens).
// Fail-open: a task file whose frontmatter can't be read counts as actionable,
// so a corrupt ledger wakes the agent to fix it rather than being silently skipped.
//
// Usage: node tasks-pending.mjs <channelId>

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const channelId = process.argv[2];
if (!channelId) {
	// Misconfigured event: better to wake and surface it than to swallow it.
	process.exit(0);
}

const appHome = process.env.PIPICLAW_HOME || join(homedir(), ".pi", "pipiclaw");
const tasksDir = join(appHome, "workspace", channelId, "tasks");

/** Extract a `key: value` line from the first frontmatter block. */
function frontmatterValue(content, key) {
	if (!content.startsWith("---")) return { ok: false };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { ok: false };
	const block = content.slice(3, end);
	for (const line of block.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		if (line.slice(0, idx).trim() === key) {
			return { ok: true, value: line.slice(idx + 1).trim() };
		}
	}
	return { ok: true, value: undefined };
}

function isActionable(content, now) {
	const status = frontmatterValue(content, "status");
	if (!status.ok) return true; // no readable frontmatter → fail-open
	if (status.value === "done") return false;
	const wake = frontmatterValue(content, "wake");
	if (wake.ok && wake.value) {
		const wakeAt = new Date(wake.value).getTime();
		if (Number.isFinite(wakeAt) && wakeAt > now) return false; // not yet due
	}
	return true;
}

let entries;
try {
	entries = readdirSync(tasksDir);
} catch {
	process.exit(1); // no tasks dir yet → nothing to do
}

const now = Date.now();
for (const name of entries) {
	if (!name.endsWith(".md")) continue;
	const path = join(tasksDir, name);
	try {
		if (statSync(path).isDirectory()) continue; // skips archive/
		if (isActionable(readFileSync(path, "utf-8"), now)) process.exit(0);
	} catch {
		process.exit(0); // unreadable task file → fail-open
	}
}

process.exit(1);
```

## 周报任务：一个完整周期的样子

以"每周一完成上周周报"为例，看任务台账下的运转（对比：现在只能配一个每周一触发的 periodic 事件，触发一次就归零）：

1. **创建（一次）**：你说"以后每周一帮我写上周周报"。agent 建 `tasks/weekly-report.md`（目标 / DoD / 手册），并用 `event_manage` 建 periodic 事件 `task.dm_x.weekly-report.schedule`（周一 09:30）。
2. **周一 09:30 触发**：agent 打开任务，收集素材（含上周 `archive/` 里已完结的任务）、起草，自查 DoD 前两条满足，第三条"师兄确认后发布"是外部动作，需确认。
3. **阻塞不傻等**：把草稿发你 → `status: awaiting-user`、`wake` 设到当天 14:00、用 `event_manage` 建 one-shot `task.dm_x.weekly-report.checkin`（14:00）→ 回合结束，期间零 token。
4. **回访**：14:00 one-shot 触发，若你还没回，轻声提醒并改期；若你已确认，agent 发布、**验证发布结果**、DoD 三条打钩。
5. **闭环**：折叠"当前周期"进"历史"（记一行复盘），删除残留的 checkin 事件。
6. **下周期更聪明**：下周一事件照常触发，但任务文件里已经积累了你的格式偏好、上次返工原因、新增的预检步骤——**event 无记忆，task 会积累手艺**。

**异常兜底**：若周一进程宕机，这次 periodic 触发丢了、或 14:00 的 one-shot 过期被删——任务仍停在 `in-progress`/`awaiting-user`，心跳在下一个整点扫到它（wake 已到），把工作接回来继续推。

## 该看哪份文档

- 事件类型、`preAction` 门控、`event_manage` 工具、`/events` 命令：[events-and-sub-agents.md](./events-and-sub-agents.md)
- `tools.events.enabled` 门控开关：[configuration.md](./configuration.md)
- 设计规格与取舍：[specs/019-task-ledger/design.md](./specs/019-task-ledger/design.md)

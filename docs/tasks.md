# 任务台账（Task Ledger）使用指南

这份文档讲 Pipiclaw 的**任务台账**——一个语义上高于[事件（events）](./events-and-sub-agents.md)的持久任务层。

事件解决"什么时候唤醒 agent"，但每次唤醒都是无状态的：agent 醒来只知道事件文本那一句话，不知道有哪些在途工作、进展到哪、验收标准是什么。任务台账补上这块记忆，让 Pipiclaw 从"定时执行器"变成"带着工作手册和进度本的驱动者"：

> 醒来 → 查看在途工作 → 推进最需要推进的一项 → 记下状态和下次检查点 → 睡去。

设计规格见 [`019 Task Ledger`](./specs/019-task-ledger/design.md)、[`022 Native Task Driver`](./specs/022-native-task-driver/design.md)、[`023 Governed Task Loops`](./specs/023-governed-task-loops/design.md) 与 [`024 Task Loop v2`](./specs/024-task-loop-v2/design.md)。

## 三层职责

| 层 | 载体 | 持有什么 | 谁维护 |
|----|------|----------|--------|
| **tasks** | `workspace/<channelId>/tasks/*.md` | 意图、DoD、状态、手册、周期日志、下一次 wake | 主 agent 经 `task_manage` 维护 |
| **内建 task driver** | runtime 确定性扫描 | 找出已到点/可继续的任务并唤醒对应 channel | Pipiclaw runtime，扫描本身零 token |
| **events** | `workspace/events/*.json` | 周期任务的 cron 节奏、非 task 的独立提醒、外部传感器 | 主 agent 经 [`event_manage`](./events-and-sub-agents.md#event_manage-工具agent-自调度) 维护 |

核心不变式：**task 是在途工作的真相；`wake` 本身就是可执行的恢复条件。** 普通任务的继续、等待和异常恢复不再依赖配套 `.checkin` 事件；周期任务只额外保留一个 canonical `.schedule` 事件来开启新周期。

任务生命周期 SOP 已内建进主 agent 的系统提示，driver 也默认开启。升级或新安装后无需复制 heartbeat JSON、传感器脚本，也无需把模板粘进 workspace `AGENTS.md`；后者只保留团队自己的策略和安全边界。

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
status: in-progress
wake: 2026-07-08T14:00:00+08:00
recurrence: 每周一
control: {"version":1,"priority":"high","lastOutcome":"progress","dependsOn":[],"isolation":"shared","sideEffects":"external","externalApproval":"required","budget":{"maxAttempts":12,"maxTokens":120000},"usage":{"attempts":2,"tokens":18420,"costUsd":0.42,"wallTimeMinutes":16.3},"verification":{"mode":"independent","status":"pending"},"nextAction":"等待确认后发布"}
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

## 验收
Mode: independent
- 逐项核对 DoD
- 验证发布后的页面可访问且内容一致

## 当前周期（2026-W28）
- 07-08 09:32 草稿 v1 已发师兄，等待反馈

## 历史
### 2026-W27 — done
1 轮返工：数据错误 1 处，原因是没核对 X 数据源 → 已把预检写入手册第 1 步。
```

frontmatter 字段：

| 字段 | 必填 | 取值 | 说明 |
|------|------|------|------|
| `status` | 是 | `open` / `in-progress` / `awaiting-user` / `blocked` / `verifying` / `paused` / `done` / `cancelled` / `escalated` | paused/done/cancelled/escalated 都不会被 driver 继续执行；verifying 会进入 checker-only 回合 |
| `wake` | 否 | 带时区的 ISO 8601 | 最早值得再看一眼的时间。缺省 = 随时可推进 |
| `recurrence` | 否 | 自由文本（如 `每周一`） | 仅作标注给人读；**节奏的真相在对应的 periodic 事件里** |
| `control` | 新任务是 | 单行 JSON，`version: 1` | priority/deadline/nextAction、父子依赖、隔离与副作用策略、预算/用量、独立验收状态 |

旧任务没有 `control` 仍可运行，按 evidence-only 的兼容路径收尾；新任务由 `task_manage create` 自动生成受校验的 control。不要手写或多行格式化这段 JSON，日常修改交给 `task_manage set/progress`。

### 受治理 control

- **调度**：`priority` 决定 ready task 顺序，`deadline` 是硬截止，`nextAction` 是下一步可执行动作。
- **预算**：`maxAttempts` 必有；可追加累计 `maxTokens`、`maxCostUsd`、`maxWallTimeMinutes`。driver 每次原生唤醒先 claim attempt，回合结束把主代理与子代理的实际 usage 计回 task。达到任一上限就转为 `escalated`，不再继续烧 token。
- **关系**：`parent` 表示父任务，`dependsOn` 中的任务必须 done 才能运行/收尾；创建和 set 会拒绝缺失关系、自依赖和环。父任务也不能在仍有未完成 child 时 done。
- **隔离**：`isolation: worktree` 表示写密集型子任务应交给 `subagent` 的同名隔离模式；runtime 自动把 path/branch 记录到 control，父代理负责 review、merge 与 cleanup。
- **副作用**：`sideEffects: external` 自动进入 required；agent 不能自授予。用户审阅拟执行动作后，直接发送 `/tasks approve <id>`，runtime 记录 approver/时间与 task body hash 才变为 granted；后续 progress、control 修改或正文变化都会要求重新授权。
- **验收**：新任务默认 `verification.mode: independent`。实现者完成后调用 `subagent purpose=verify taskId=<id>`，再用 `task_manage verify` 导入 runId；task 文件一旦继续 progress，PASS 立即失效。

### Frontmatter 契约（单一事实源）

内建 task driver、任务摘要、`/tasks` 和 `task_manage list` 全部复用 `src/shared/task-ledger.ts` 的同一份解析与判定，不再维护仓库外的镜像传感器实现。

**解析规则**（有意做到极简、可被独立实现逐字复刻）：

1. **frontmatter 块** = 文件必须以 `---` 开头；块的结束是其后第一个 `\n---`。取二者之间的内容为 frontmatter。不满足（无起始 `---` 或找不到结束 `---`）→ **无可读 frontmatter**。
2. **字段提取** = 在块内逐行找 `key: value`：以第一个 `:` 切分，键取左侧 `trim()`，值取右侧 `trim()`。不解析嵌套 YAML；只认 status/wake/recurrence/control 四个平铺键。control 的值是单行 JSON。
3. **`status`**：`done` / `cancelled` / `escalated` 不 actionable；其余状态按 wake 判定。
4. **`wake`**：解析为时间戳。**缺省、为空、或无法解析 → 视为"随时可推进"（不构成推迟）**；能解析且 `wake > now` → 该任务"未到点"。
5. **判定：`actionable`（可推进）** = `status` 未关闭 **且**（无有效 `wake` **或** `wake ≤ now`）。driver 在此之前还会对睡眠任务执行零 token 的 deadline/budget/terminal-dependency 检查。
6. **fail-open**：frontmatter、control 或文件不可读 → 视为 actionable，让 agent/doctor 暴露并修复，而不是静默漏掉。

> 一句话记忆：**先做确定性治理门禁，再对 ready task 唤醒模型；读不懂就暴露并修复。**

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

周期性任务的新一轮**只由它的 periodic 事件开启**（driver 不会唤醒 status: done，只推进已开启的工作，避免两个入口竞争）：

1. periodic 事件触发（文本："推进任务 weekly-report"）。
2. agent 打开任务文件。若 `status: done`：把"当前周期"一节折叠进"历史"（历史只保留最近约 5 轮），开一节新的"当前周期"，`status` 置 `in-progress`，开始干活。
3. 若上一轮还没 done（过期未完成）：先处置旧周期（补完，或明确放弃并记录原因），再开新周期。

实现时应使用 `task_manage start-cycle`，而不是手工编辑状态：它会在一次原子写里开启具名 cycle，并清理上一周期累计的 usage、独立验收、外部授权和 worktree 元数据。周期预算不会跨周期耗尽；长期统计将在后续 runtime 观测中单独保存。

**退役**周期性任务 = 文件移入 `archive/` + 用 `event_manage` 删除它的 periodic 事件。

### 一个周期性任务 = 一个 task 文件 + 一个 periodic 事件

职责分离：task 文件积累手艺（DoD、手册、返工教训），periodic 事件只管节奏。改节奏改事件，改做法改文件，互不牵连。

普通任务与 event 不再是一对一：driver 直接依据 `wake` 恢复。只有周期任务需要 canonical `.schedule`，外部完成探测等响应式场景才临时使用带 `preAction` 的传感器事件。

### 事件命名约定

`workspace/events/` 是**全局单目录**（不按 channel 分），所以任务派生的事件名必须编入 channelId，否则两个 channel 的同名任务会互相覆盖对方的事件：

```text
task.<channelId>.<任务id>.<用途>.json
# 例：task.dm_123.weekly-report.schedule.json（periodic 节奏）
#     task.dm_123.weekly-report.agentmux.json（临时外部完成传感器）
```

任务收尾时用 `task.<channelId>.<id>.*` 前缀一把清理，不留孤儿。

## 内建 task driver

task driver 随 DingTalk daemon 启动，默认每分钟做一次廉价扫描。扫描和所有治理门禁都不调用模型：先拦截超 deadline/budget 或 terminal dependency 的任务并升级，再从 dependency-ready 的 actionable task 中按 priority/deadline 排序，向对应 channel 入队一条唤醒消息。

为避免错误台账或忘记更新状态造成 token 热循环，driver 有三层节流：

- channel 正在运行时不重复入队；
- 上一轮修改了 task 文件，最早 5 分钟后继续下一轮；
- 上一轮没有留下任何台账变化，退避 60 分钟再重试；
- 每个 tick 全局最多派发 4 个 channel，并轮转起点防止饥饿。

每次受治理唤醒会累计 attempt；回合完成后 runtime 把 token、cost、wall time 回写。等待中的依赖不会触发 agent，也不会消耗 attempt。缺失、cancelled 或 escalated 的依赖属于 terminal failure，依赖方会一起升级并给出恢复说明。

这些默认值可在 [`settings.json`](./configuration.md) 的 `taskDriver` 中调整或关闭。进程重启后内存中的退避状态会清空，因此遗留 actionable task 会在下一次扫描被重新接起——这是有意的 fail-open 恢复语义。

### 内建 Agent SOP

有 `task_manage` 工具时，runtime 自动注入以下规则，无需写进 workspace `AGENTS.md`：

1. 只有明确需要跨回合继续、等待、委派或周期运行的工作才建 task；当前回合能完成的简单请求不建。
2. driver/event 指名 task 时先读完整文件，再按 Manual 推进并对照 DoD 验证。
3. 每个仍在途的任务回合结束前调用一次 `task_manage progress`，在**同一次原子写**里追加 Current Cycle 记录并更新 status/wake。记录必须包含做了什么、观察到的证据和下一步；本轮直接 `done` 时不再额外 progress。
4. 等用户用 `awaiting-user`，等外部条件用 `blocked`，同时设置合理的未来 `wake`。`wake` 足以恢复，不再创建重复 `.checkin`。
5. 可以继续推进时清空 wake；driver 会在有界冷却后续跑。超预算/截止或 terminal dependency 时停止并升级，不自行绕过。
6. independent 模式由新的只读 verifier subagent 验收并 `task_manage verify`；通过后正文/进展再变化会失效。DoD 与门禁满足后才 `done`。
7. 外部副作用必须等用户 `/tasks approve <id>`；父子依赖和 worktree 子任务必须先汇合验收。
8. 周期任务仍用唯一的 `task.<channelId>.<id>.schedule` periodic event 开新周期；driver 只负责周期内的继续与恢复。

### 内置 playbooks（场景化操作手册，随包发布、按需读取）

系统提示里的 SOP 是每回合的紧凑纪律；四份随包发布的 playbook 补充场景化的完整操作手册。它们在安装目录内（构建后为 `dist/playbooks/`），**不占用 workspace**：系统提示常驻一个极小的索引（`### Task Playbooks`，仅在 `task_manage` 注册时注入），agent 在对应场景用 read 工具按需读取；path-guard 对该目录有专门的只读放行。版本随包走，升级即更新。

| playbook | 场景 |
|---|---|
| `task-recurring.md` | 周期任务的创建（task + `.schedule` 成对）、`start-cycle` 开新周期、调节奏、退役 |
| `task-delegation.md` | 父子分解与依赖、worktree 隔离、agentmux 完成驱动回访（附带 `scripts/agentmux-idle.mjs` 传感器） |
| `task-closeout.md` | candidate → 独立验收 → done/cancel 全流程、外部副作用授权的正确次序 |
| `task-repair.md` | escalated 恢复、孤儿事件、坏 frontmatter/control、stale PASS、driver 行为排查 |

playbook 描述的是 runtime 硬约束与标准做法；个人偏好和团队策略写进 workspace `AGENTS.md`，或由 agent 沉淀成 workspace skill——`workspace/skills/` 完全归用户与 agent 所有，runtime 不会写入。

## 可见性：`/tasks` 命令与任务摘要注入

任务台账不再只能靠“问 agent”来查看，Phase 2 从两个方向把它暴露出来。

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

- weekly-report — 周报编写与发布 · awaiting-user · wake 2h · 草稿 v1 已发师兄
- fix-voice-typer-ci — 修复 CI · in-progress · wake — · 定位到 flaky 的 e2e case
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

它的价值是“骨架一致 + progress 原子 checkpoint + frontmatter 保真 + 闭环收口”，不是权限收口（agent 仍可用 write/edit 写大段正文）。开关见 [configuration.md](./configuration.md) 的 `tools.tasks.enabled`（默认开启）。

host Git checkout 的 verifier 还会记录 artifact subject（HEAD、working tree 与 staged/unstaged diff）。导入 PASS 和 `done` 都会重新比较 subject；代码或产物改动后必须重跑 verifier。

## agentmux 完成驱动回访

委派给 agentmux 实例后，基线方案是把 task 设为 blocked，并把 `wake` 放到合理的下一次检查时间；内建 driver 到点接手。对分钟级响应要求更高时，再加“实例是否空闲”的 preAction 传感器。

**为什么用 periodic + preAction（而非 one-shot）**：传感器只有退出码、不能改期自己。one-shot 到点若对方仍忙、preAction 退 1 静默，但 one-shot 已消耗，不会再探测——卡死。要自主轮询到 idle，只能用 periodic + preAction 门控：忙则静默（零 token），idle 才唤醒。

传感器脚本随包发布在 playbooks 目录的 `scripts/agentmux-idle.mjs`：实例还忙时 exit 1（静默、零 token）；idle / exited / 任何异常时 exit 0（唤醒，fail-open）。首次使用时 agent 会把它拷贝到 `workspace/skills/agentmux-idle.mjs` 再在事件 preAction 中引用——事件需要一个不随版本/Node 环境变动的稳定路径，而 preAction 失败是静默的。

响应式联动约定：

1. 委派时在 task 正文记下实例名（`agentmux 实例：编码助手-A`）。
2. 用 `event_manage` 建 periodic 事件 `task.<channelId>.<id>.agentmux`，preAction 为 `node …/agentmux-idle.mjs 编码助手-A`，task 置 `blocked`、`wake` 设一个远期兜底点。
3. 对方 idle → agent 被唤醒 → `agentmux capture` 取结果 → 验收 → 推进/闭环 → 删除该 agentmux 事件（收尾 SOP 一并清理 `task.<channelId>.<id>.*`）。

**两档节奏**：

- **基线（推荐、零 event）**：task 停在 `blocked`、`wake` 到期，内建 driver 在下一次分钟级扫描中接手 → agent `agentmux inspect`；忙则用 `task_manage progress` 把 wake 推后，闲则验收结果。
- **响应式（分钟级）**：让 agent 自建上面的 agentmux periodic。`event_manage` 的 periodic 最小间隔在**带 preAction 时从 30 分钟放宽到 5 分钟**（传感器是 token 守卫，忙时静默）——正是这类完成驱动检查的正确形态。硬子下限仍是 5 分钟，且 preAction 照过命令守卫。

## 周报任务：一个完整周期的样子

以"每周一完成上周周报"为例，看任务台账下的运转（对比：现在只能配一个每周一触发的 periodic 事件，触发一次就归零）：

1. **创建（一次）**：你说"以后每周一帮我写上周周报"。agent 建 `tasks/weekly-report.md`（目标 / DoD / 手册），并用 `event_manage` 建 periodic 事件 `task.dm_x.weekly-report.schedule`（周一 09:30）。
2. **周一 09:30 触发**：agent 打开任务，收集素材（含上周 `archive/` 里已完结的任务）、起草，自查 DoD 前两条满足，第三条"师兄确认后发布"是外部动作，需确认。
3. **阻塞不傻等**：把草稿发你 → 一次 `task_manage progress` 记录进展、置 `status: awaiting-user`、`wake` 设到当天 14:00 → 回合结束，期间零 token。
4. **回访**：14:00 后 driver 扫描到 wake 已到并触发；若你还没回，轻声提醒并原子改期；若你已确认，agent 发布、**验证发布结果**、DoD 三条打钩。
5. **闭环**：折叠"当前周期"进"历史"（记一行复盘），`task_manage done` 记录证据并收尾。
6. **下周期更聪明**：下周一事件照常触发，但任务文件里已经积累了你的格式偏好、上次返工原因、新增的预检步骤——**event 无记忆，task 会积累手艺**。

**异常兜底**：若周期事件触发后的 agent 回合中途失败，任务仍停在 `in-progress`/`awaiting-user`；driver 根据未到/已到的 wake 和退避状态把它接回来。daemon 重启会清空内存退避，遗留 actionable task 在下一次扫描恢复。

## 该看哪份文档

- 事件类型、`preAction` 门控、`event_manage` 工具、`/events` 命令：[events-and-sub-agents.md](./events-and-sub-agents.md)
- `tools.events.enabled` 门控开关：[configuration.md](./configuration.md)
- 设计规格与取舍：[specs/019-task-ledger/design.md](./specs/019-task-ledger/design.md)

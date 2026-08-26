---
name: task-planning
description: 判断该建长程任务（task）还是事件（event）、写任务契约，或设定周期节奏（schedule）。
requires-tools: task_create, task_update
order: 70
---

# 长程任务（task）规划与建档

## 什么时候创建 task

只有工作需要跨回合恢复时才建：多步骤目标、等待人或外部系统、委派工作、周期性产出。当前回合能完成的请求不建台账；纯提醒或外部条件探测用 event（见 `event-scheduling.md`）；只在当前回合委派 subagent 或外部 Agent 也不需要建 task，通用委派纪律见 `agent-delegation.md`。

## 拆分

只把可独立推进、可独立验收的长期工作拆成多个 task。**任务之间没有依赖字段**：先后条件写进后继任务的 Goal/Manual，或者用 wake 错开。

## 创建内容

调用 `task_create`：

- `id`：稳定的 kebab-case。
- `title`：一句话标题。
- `goal`：最终要成立的结果，不写行动清单。
- `dod`：客观验收标准，每项必须是 `- [ ]` checkbox。
- `manual`：可复用的执行步骤、预检、幂等方法和返工教训。
- `verificationPlan`：独立验收者能执行的确定性检查。

有代码、配置或可复现产物时，显式设置 `control.verificationRequired: true`；纯提醒、沟通和主观写作通常保持默认 false。

Goal / DoD / Manual / Verification 描述**最终结果和检查方法**，不写成行动记录，也不把"查不到状态"写成已完成。

Task 创建即持续委托：能触达什么由可用工具、security 配置和任务 Goal 共同约束，没有按动作逐次授权的字段。所以 Goal 的边界就是授权的边界，宁可写窄。

## Control 决策

- `deadline`：硬期限，表达真实用户意图。不用 `wake` 冒充 deadline。
- `nextAction`：下一条可执行动作，避免抽象愿望；等待时"等什么、条件、下一步"也写在这里，没有单独的 blockedReason 字段。
- `waitingFor`：等待来源的记录性展示（`time` / `user` / `job` / `external-signal`）。它不决定任务能否恢复，语义见 `task-driving.md`。
- `wake`：最早回访时间。带 future wake 的任务应当是 `waiting`；`active` 配 future wake 是非法组合，会被任务体检报出来。
- `schedule`：五字段 cron，存在即 recurring，最小间隔 30 分钟。改动已有任务的 `schedule` 会把 `wake` 重算到新节奏的下一次时间点，除非同一次调用也显式设置了 `wake`。

## Plan：手段层

预计需要多次唤醒时，用 `plan` 创建步骤，或用 `task_update` 的 `planSteps` 更新。`planSteps` 要求任务已有 `## Plan` 小节——首次调用即创建它。Plan 是手段，不是第二份 DoD；每步写可验证产出，可选 `→ dod:1,2` 引用。四态为 `[ ]` todo、`[x]` done、`[!]` blocked、`[~]` dropped。当前步骤由 runtime 从文档顺序推导。

## 三态与周期

- `active`：当前有具体工作可推进。
- `waiting`：等待真实条件，两种形态见 `task-driving.md`。
- `sleeping`：recurring occurrence 已闭环，等 schedule 的下一次 wake。一次性任务不能 sleeping，闭环后归档。
- `enabled: false`：正交停用，保留 status、wake、schedule；恢复只改回 true。

带 `schedule` 创建时，runtime 强制写成 `sleeping + enabled: true + 下一次 wake`，**创建本身不派发首轮**。首轮和续轮都由 runtime 的 cycle-open 操作初始化 Current Cycle。

## 建档后自检

创建后读取落盘文件，确认 Goal、DoD、Manual、Verification、status、enabled、wake 和 control 与真实意图一致；正文要改用 `edit`，不带 `note` 的 `task_update` 只动 frontmatter。后续推进、等待、验收和闭环都按 `task-driving.md`。

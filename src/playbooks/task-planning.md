---
name: task-planning
description: 创建或重构长程任务（task）、选择 task 与事件（event），或设定周期节奏（schedule）。
requires-tools: task_manage
priority: 40
---

# 长程任务（task）规划与建档

## 什么时候创建 task

只有工作需要跨回合恢复时才建：多步骤目标、等待人或外部系统、委派工作、周期性产出。当前回合能完成的简单请求不要建台账；纯提醒或外部条件探测用 event。

## 拆分与委派

只把可独立推进、可独立验收的长期工作拆成多个 task。任务之间没有依赖字段；先后条件写进后继任务的 Goal/Manual，或用 wake 错开。仅在当前回合委派 subagent 或外部 Agent 不需要建 task；通用委派纪律见 `agent-delegation.md`。

## 创建内容

调用 `task_manage create`：

- `id`：稳定的 kebab-case。
- `title`：一句话标题。
- `goal`：最终要成立的结果，不写行动清单。
- `dod`：客观验收标准，每项必须是 `- [ ]` checkbox。
- `manual`：可复用的执行步骤、预检、幂等方法和返工教训。
- `verificationPlan`：独立验收者能执行的确定性检查。

Task 创建即持续委托；是否触达外部系统由可用工具、security 配置、任务 Goal 和幂等检查共同约束。不存在按动作逐次授权字段。

有代码、配置或可复现产物时，显式设置 `control.verificationRequired: true`；纯提醒、沟通和主观写作通常保持默认 false。

## Control 决策

- `priority` / `deadline`：表达调度重要性和硬期限，不用 `wake` 冒充 deadline。
- `nextAction`：下一条可执行动作，避免抽象愿望。
- `maxAttempts`：唯一按任务计数的 attempt stop-loss，默认 12；周期任务每次开新 cycle 清零。
- `waitingFor`：记录恢复源：time、user、job、verification 或 external-signal。
- `blockedReason`：写清楚等待的对象、条件和下一步。
- `wake`：最早回访时间；future wake 会使任务规范为 waiting。
- `schedule`：五字段 cron；存在即 recurring。

Goal/DoD/Manual/Verification 描述最终结果和检查方法，不把“查不到状态”写成已完成。外部动作必须先查询真实状态，携带稳定 request/message id，成功后把结果写入 Current Cycle 或 completion evidence。

## Plan：手段层

预计需要多次唤醒时，用 `plan` 创建步骤，或用 `task_manage progress` 的 `planSteps` 更新。Plan 是手段，不是第二份 DoD；每步写可验证产出，可选 `→ dod:1,2` 引用。四态为 `[ ]` todo、`[x]` done、`[!]` blocked、`[~]` dropped。当前步骤由 runtime 从文档顺序推导。

## 三态与周期

- `active`：当前有具体工作可推进。
- `waiting`：等待真实条件；有 wake 是定时回访，无 wake 是 signal parked，driver 不轮询。
- `sleeping`：recurring occurrence 已闭环，等待 schedule 的下一次 wake。
- `enabled: false`：正交停用，保留 status、wake、schedule；恢复只改回 true。

recurring create 始终写 `sleeping + enabled: true + next wake`，创建不派发首轮。首轮和续轮都由 runtime 的 cycle-open 操作初始化 Current Cycle；首轮不把占位内容写进 History。一次性任务不能 sleeping，闭环后归档。

## 建档后自检

创建后读取落盘文件，确认 Goal、DoD、Manual、Verification、status、enabled、wake 和 control 与真实意图一致。后续推进、等待、验收和闭环都按 `task-driving.md`。

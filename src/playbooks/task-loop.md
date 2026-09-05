---
name: task-loop
description: 判断该不该建长程任务（task）、怎么写任务契约，以及在任务循环里推进、等待、验收和闭环。
requires-tools: task_create, task_step_end
order: 70
---

# 长程任务：建档与循环

任务是**跨回合恢复**的工作单元。运行时负责调度和兜底，你负责判断。每一步的 brief 已经给了契约全文、最近日志和当前预算；这里讲的是这些数字之外需要你判断的部分。

## 什么时候建 task

只有工作需要跨回合恢复时才建：多步骤目标、要等人或外部系统、要委派、周期性产出。当前回合能做完的请求不建台账。纯提醒或外部条件探测用 event（见 `event-scheduling.md`）；只在当前回合委派一次也不需要 task。

只把**可独立推进、可独立验收**的长期工作拆成多个 task。任务之间没有依赖字段：先后条件写进后继任务的 Goal/Manual。

## 写契约

`task_create` 的四段是整个循环唯一的长期真相，每一步都会完整读到它，所以要短、要准：

- `goal`：最终要成立的**结果**，不写行动清单。
- `dod`：客观验收标准，每项必须是 `- [ ]` checkbox。写不出 checkbox 说明目标还没想清楚。
- `manual`：可复用的执行步骤、预检、幂等方法、返工教训。这是任务自己的记忆——学到什么就更新它。
- `verificationPlan`：独立验收者能执行的确定性检查。

有代码、配置或可复现产物时设 `verificationRequired: true`；纯提醒、沟通和主观写作保持默认。

契约有 4 KB 预算，超出会被截断。**每一步的记录不写进契约**，写进 `task_step_end` 的 `note`；历史用 `task_log` 查。

`schedule`（五字段 cron，最小 30 分钟）让任务变成周期性的：每个 occurrence 一个 cycle，闭环后自动停到下一次。

Task 创建即持续委托：能触达什么由可用工具、security 配置和 Goal 共同约束，没有逐次授权的字段。**Goal 的边界就是授权的边界，宁可写窄。**

## Plan：手段层

预计需要多步时用 `plan` 创建步骤，或用 `task_update` 的 `planSteps` 更新。Plan 是手段，不是第二份 DoD；每步写可验证产出，可选 `→ dod:1,2` 引用。四态 `[ ]` todo、`[x]` done、`[!]` blocked、`[~]` dropped。周期任务每个新 cycle 会把 Plan 和 DoD 复位。

## 在循环里推进

每一步先看清 brief 里的 `<task_contract>`、`<task_log>` 和 `<task_state>`，再动手。派发是 at-least-once，**外部动作前先查真实状态**，别重复发送、发布或部署。

只推进一个清晰的下一阶段，然后用 `task_step_end` 收尾：

- 还能接着干 → `continue`。运行时立刻排下一步，没有等待。
- 在等一个真实来源 → `park`，带上对应的票。委派用 `run`、后台作业用 `job`、单纯过一阵再看用 `time`、周期任务闭环用 `schedule`、task-owned 传感器事件用 `signal`。
- 本周期做完了 → `done`，必须给 `summary` 和 `evidence`。
- 需要用户决定 → `blocked`，写清在等什么。

**票必须指向真实存在的东西**：运行时会当场校验，指不到就拒绝。这是设计——一次指不到的等待就是一次永久静默。

**默认不向用户发言。** 确实要说才给 `notify`；`blocked` 一定会说。

## 外部动作的幂等闭环

外部发送、发布、部署或修改前：

1. 读 Goal 和 DoD 确认动作仍在范围内，并查询目标真实状态。
2. 确认此前没有已成功的同一动作；用稳定的 request / message / idempotency key 执行。
3. 查询并记录真实结果、目标标识、时间和证据到 `note`。
4. 只有结果已满足 DoD 才 `done`；失败就 `continue` 或 `park` 并写清恢复来源。

附件交付的 receipt 规则见 `outbound-media.md`。

## 独立验收

1. 只有证据成立后才勾选 DoD / Verification checklist。
2. 像任何委派一样派一个 `purpose: verify`、带 `taskId` 的 sub-agent，然后 `park` 到那个 run 的票上。
3. checker 只判断、不修复被验收实现，结尾返回 `VERDICT: PASS` 或 `VERDICT: FAIL`。
4. **结算时运行时自动记账**：校验 attestation（归属、契约 hash、产物 subject），把这一轮写进返工账本，然后兑现你的票。你不需要导入任何东西——醒来时结论已经在 `<task_log>` 里。
5. attestation 校验不过的 PASS 会被记成 FAIL 并写明原因。标 `advisory` 的结论（带 `bash` 的内置验收者、`mutates: write` 的 verifier、所有外部验收者）只是参考，仍要按风险抽查；强度来源见 `agent-delegation.md`。
6. `verify: required` 的任务，`done` 要求**本周期**有一条真实 PASS。返工轮次有预算，到顶会停下来问用户。

PASS 绑定 Goal/DoD/Manual/Verification 这段契约，不绑定 Plan 和历史。改动契约或被验收产物后必须重新验收。

## 预算与停止

每个 cycle 有四维预算：步数、墙钟、成本、返工轮次（可在 `task_create`/`task_update` 的 `budget` 里按任务调整）。任一项到顶，运行时停掉任务并给用户一条确定性回执，附加预算的命令。连续两步没有任何工具调用也会被停下——那说明循环在自言自语。

**只记录真实工作**：`note` 写做了什么、证据是什么、下一步是什么，不写愿望。

## 等待票过期

票有兜底时限。到点还没兑现，运行时会把任务重新打开，并在 brief 开头告诉你票过期了。这时**先确认真实状态**（那个 run 到底结束没有？那个条件到底成立没有？），再决定继续还是换一张票。同一 cycle 内第二次过期会停掉任务并通知用户。

## 契约损坏

frontmatter 不可读或仍是旧版契约时，唤醒会明确要求**只修元数据、不执行任务目标**。用 `edit` 修好首部后就停下，任务工作留给下一步。

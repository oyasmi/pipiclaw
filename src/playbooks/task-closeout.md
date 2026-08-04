---
name: task-closeout
description: 独立验收（verify）、导入判定，或 complete/skip/cancel 任务前。
requires-tools: task_manage
priority: 42
---

# 验收与闭环

## 独立验收

1. 只有在证据成立后勾选 DoD/Verification checklist。
2. 调用 `task_manage request-verification`；任务进入 `waiting + waitingFor: verification`，runtime 直接入队 checker。
3. checker 使用 `purpose: verify`、`taskId`，只读检查，结尾返回 `VERDICT: PASS` 或 `VERDICT: FAIL`。
4. 主回合用 `task_manage verify` 导入 runId。attestation 必须属于当前 task、未改变 workspace，且 contract body hash 与 artifact subject 新鲜。
5. PASS/FAIL 都恢复 active；PASS 后 complete 仍会重新校验 attestation、contract hash 和 artifact subject。

PASS 绑定 Goal/DoD/Manual/Verification contract segment，不绑定 Current Cycle、History 或 Plan 日志。改动 contract 或被验收的产物后必须重新验收。不要让 verifier 顺手修实现。

## 外部动作的幂等闭环

外部发送、发布、部署或修改前：

1. 读任务 Goal 和 DoD，确认动作仍在范围内。
2. 查询目标真实状态，确认此前没有已经成功的同一动作。
3. 使用稳定 request/message/idempotency key 执行。
4. 查询并记录真实结果、目标标识、时间和证据到 Current Cycle。
5. 只有结果已满足 DoD 才 complete；失败则 progress 为 active 或 waiting 并写 recovery source。

Task 创建即持续委托；能力边界和任务 scope 是 authority。不要扩大目标、渠道、环境或对象范围，也不要把“本次调用返回成功”当成外部状态已落地。

## complete / skip / cancel

- `task_manage complete` 需要 summary、evidence 和已满足的 acceptance checklist；required verification 必须有有效 PASS。one-shot 会写 `outcome: completed`、`closedAt` 并移入 archive。
- recurring complete 写 completion evidence、清理 task-owned events、计算下一 occurrence，回到 sleeping。
- `task_manage skip` 只接受 recurring active/waiting，记录 reason，不伪造 DoD 或 completion evidence，然后 sleeping。
- `task_manage cancel` 从任一 live status 归档为 `outcome: cancelled`，记录 reason 并清理 task-owned events。

如果 occurrence 已被更早的触发完成，使用 skip 写明原因并回复 `[SILENT]`；否则向用户说明结果、风险和下一步。

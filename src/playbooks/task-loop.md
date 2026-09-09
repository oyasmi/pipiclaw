---
name: task-loop
description: 判断是否建长程任务（task）、编写契约，或在 TASK_STEP 中推进、等待、验收、完成和恢复时。
requires-tools: task_create, task_step_end
order: 70
---

# 长程任务：契约与循环

只为需要跨回合恢复、等待外部结果或周期性产出的工作建 task；当前回合可完成的请求、一次临时委派不建。纯提醒或条件传感器用 event，需要创建时读 `event-scheduling.md`。

## 先识别入口

| 当前环境 | 可做什么 |
|---|---|
| 普通聊天 | task_create 建档，task_update 改 Plan/节奏/预算/验收要求，task_close 完成/跳过/取消；传感器在这里用 event_manage 预先创建 |
| `[TASK_STEP:<id>]` / 有 task_step_end | 推进当前契约并用 task_step_end 收尾；没有 task_create、memory_save、event_manage，不绕过这些边界 |

创建后由 runtime 在独立的 cycle 会话推进。带 taskId 的普通聊天仍是聊天，不因此获得 task_step_end。只拆分可独立推进和验收的长期任务；没有任务依赖字段，前置条件写进后继 Goal/Manual。

## 写短而自足的契约

每一步都会得到完整契约，写得越长，每步成本越高。约 4 KB 是作者应控制的目标；代码只裁剪“上次结果”，不会替你压缩 Goal/Manual。

- **goal**：要成立的结果、范围、允许的外部动作。创建即持续委托，Goal 与工具/security 共同限制授权边界，不存在逐次授权字段。
- **dod**：客观验收标准，必须是 `- [ ]` checklist；将适用用户要求变成检查项。
- **manual**：本任务可复用的步骤、预检、幂等办法和已验证的返工教训。
- **verificationPlan**：可执行的检查及证据要求，执行者和验收者拿到同一标准。

用户明确要求、实质实现改动、高后果或难以自查的工作设 `verificationRequired:true`。稳定流程的低风险产物若已有充分确定性检查，可以保留默认；不能通过关闭既定验收要求来绕过失败。

`plan` / `planSteps` 表达手段与可验证产出，不复抄 DoD；四态 todo/done/blocked/dropped，可用 `→ dod:1,2` 指向验收项。改契约正文或勾选 checklist 用 `edit` 打开 brief 中的绝对文件路径；task_update 只改其暴露的字段和 Plan。

schedule 是主机时区的五段 cron，最小 30 分钟。首周期创建后立即就绪；若首次应等待约定时刻，在任务里明确并用 time 票等待。预算含 steps、wallMin、usd、rounds，可按需设 until；**wallMin 是 cycle 开始后的经过时间，包含 park 等待**，建档时计入等待跨度。

## 推进一步并收尾

先看 `<task_contract>`、最近 `<task_log>` 和 `<task_state>`，用已有契约，不再重复打开。历史或证据不够才 task_log；round 摘要只有 verdict/runId/拒绝原因，失败细节在该 run 的 output.md，不能凭一行 FAIL 猜根因。

| 判断 | task_step_end outcome |
|---|---|
| 完成这一阶段，还有可推进工作 | continue，note 留下证据和下一步 |
| 必须等待真实来源 | park，附 run/job/time/signal 票 |
| 本周期达标 | done，必须有 summary 和 evidence；周期任务由 runtime 自动停到下一次 |
| 需要用户决定 | blocked，reason 写清问题；runtime 建 ask 票并通知用户 |

**本周期完成一律 done，不用 park + schedule 代替。** 明确跳过一次用 task_close outcome=skip 并给 reason；放弃整个任务用 cancel。关闭/取消不会代替你取消仍在运行的委派或 job。

任务步骤默认静默；确有交付或需告知的变化才用 notify。note 只写真实做过什么、证据和下一步；不把每步过程追加到契约。Plan 可在 task_step_end 中一并更新。

## 等待与恢复

run/job 派发时即带 taskId；先完成独立工作和必要的并行派发，只剩等待才 park。run 用 `{"kind":"run","id":"<runId>"}`，job 同形；定时复查用 `{"kind":"time","at":"+2h"}`；预置传感器用 `{"kind":"signal","event":"<事件名>"}`。

票只接受真实、未结束且属于本任务的来源。结果同步返回或 park 时已结算，就读结果继续，不等待第二次通知；id/归属错误按工具指引纠正，不能手改 ticket frontmatter。已有 job/run 完成通知，不另建回访事件。

signal 事件必须在聊天侧预建为 task.<channelId>.<taskId>.<use> 的 periodic；循环先检查条件，未满足才等待。缺少事件且不能自主继续时 blocked 说明缺什么，不绕过工具限制。

票自带 runtime 兜底。过期后的 brief 会标明等待来源：先检查真实状态，再继续或换票；同 cycle 第二次过期停止并通知用户。预算任一项耗尽也会停止；这些回执由 runtime 发出，无需再花模型回合解释。用户命令 `/tasks resume <id>` 恢复、`/tasks reply <id> ...` 回答阻塞问题。

## 外部动作

派发是 at-least-once。发送、发布、部署或修改外部对象前，核对 Goal/DoD 与目标真实状态，排除此前已成功的同一动作；能用稳定 request/message/idempotency key 就使用。操作后记录真实结果、目标标识、时间和证据，达标才 done。结果未知先核查，不盲目重放。

交付附件时读 `outbound-media.md`：send_media 成功回执可作证据，但接口没有消息 id 或二次状态查询，不能虚构。

## 独立验收

需要委派但还未准备好执行者、上下文或工作目录时，读 `agent-delegation.md` 对应部分。

1. 实施、正式测试、文档和收尾改动全部完成，自查证据成立后勾选 DoD/Verification。
2. 派 purpose=verify 且带 taskId 的角色，给同一契约、适用要求、最终交付位置与版本。验收者只判断，不修复实现；结尾输出 `VERDICT: PASS` 或 `VERDICT: FAIL`。
3. 同步完成直接处理，异步才 park 到 run。结算自动校验归属、契约 hash 和产物 subject，并写入 round，无需手动导入。
4. 关闭要求本周期最后一条 round 为 PASS，且证明仍绑定当前契约和产物；后来的 FAIL 不会被更早 PASS 覆盖。

证明强度：内置 mutates=read 且无 bash 的 verifier 才是 enforced；带 bash、mutates=write 或任何外部 verifier 都是 advisory，按风险核对关键证据。write verifier 会持有写 lease，能跑生成临时文件的检查；exec 没有协议终态，不支持正式验收。mutates 不是 sandbox。

验收不得修改被验收实现或为了通过而修代码。取证脚本可放 `.run/`、coverage/build/dist 或系统临时目录；往正式源码或测试目录新增文件也会改变 subject，要交回实现者处理并重验。

PASS 绑定 Goal/DoD/Manual/Verification 与实际产物，不绑定 Plan 或历史。修改这些契约段落、补代码/文档/测试、commit hook 改内容都会要求重验；base-relative subject 允许原样提交已验收内容。跨 worktree 整合后，要对最终交付位置重新确认覆盖。

## 先裁决反馈，再返工

违反 DoD/明确约束且有复现证据的才返工；疑似问题先窄范围调查；任务外增强和风格建议不作为失败理由；冲突意见回到契约与实际产物，用有区分力的检查裁决。

返工指令写 **现象 → 证据 → 违反标准 → 修复边界与已通过项 → 重验办法**。同一问题连续两轮失败且无新证据时，缩小复现、换调查方法或执行者。达到约定标准、没有未解决必修项就交付，预算余额不代表需要继续润色。

教训先写 note；影响后续实施的，在最终验收前更新 Manual。PASS 后新教训留日志，真正采纳再改契约并重验。多次验证有效且跨任务复用时，再按 `memory-and-learning.md` 的 skill 晋升规则处理。

frontmatter 损坏或仍是旧契约时只修元数据，修好后停下，工作留给下一步；不要手造等待票或借修复扩大任务范围。

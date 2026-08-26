---
name: task-driving
description: 被 TASK_DRIVER 唤醒推进任务，或处理任务等待、验收（verify）、闭环、停滞、停用及元数据损坏时。
requires-tools: task_update, task_close, task_verify
order: 80
---

# 任务推进、验收、闭环与修复

## 每次唤醒先恢复真相

1. 打开消息指定的 `tasks/<id>.md`，不要只依赖唤醒文本、旧对话或记忆。唤醒里的 capsule 只是摘要，Goal、DoD、Manual、Verification 和 Current Cycle 都只在文件里。
2. 核对 status、enabled/stop、Current Cycle、`nextAction`、wake、deadline、waitingFor 和 verification。
3. 检查上一步产物是否已经存在。派发是 at-least-once，重放可能让同一步再次到达。
4. 只推进一个清晰的下一阶段；外部动作前先查询真实状态，避免重复发送、发布或部署。

## 等待与恢复

本页是 task waiting 两种形态的**唯一真相源**：`waiting + wake` 是定时等待；`waiting` 没有 wake 是**停泊**的信号等待，driver 不会轮询它。

决定任务能否恢复的只有两样东西：一个真实的 wake，或者 runtime 里一条 `taskId` 指向本任务、已经 settle 的 run/job 记录。`waitingFor` 是记录性展示，写什么都不影响恢复。

- **等后台作业、用户或委派**（含 verify sub-agent）：不设 wake，`waitingFor` 写 `job`、`user` 或 `external-signal`。作业或委派结束时 runtime 只恢复所属 task；启动与唤醒细节见 `background-jobs.md` 和 `agent-delegation.md`。
- **只是状态查询**：设置合理 wake，`waitingFor: time`，并在 `nextAction` 记录回访对象、条件和下一步。

## 回合结束必须留下状态

仍需继续时，用带 `note` 的 `task_update` 原子记录发生了什么、证据、下一步、status/wake；Plan 变化放在同一次 `planSteps` 里。`task_close`（complete/skip/cancel）本身就是 checkpoint。

- 当前可继续：`active`，清除 wake。
- 等待真实条件：按上一节设置 `waiting`、wake 和 waitingFor。
- 周期闭环：`complete` 或 `skip` 进入 sleeping，runtime 计算下一 occurrence。
- 一次性放弃：`cancel` 归档。

## 外部动作的幂等闭环

外部发送、发布、部署或修改前：

1. 读 Goal 和 DoD，确认动作仍在范围内，并查询目标真实状态。
2. 确认此前没有已成功的同一动作；使用稳定的 request / message / idempotency key 执行。
3. 查询并记录真实结果、目标标识、时间和证据到 Current Cycle。
4. 只有结果已满足 DoD 才 complete；失败则 progress 为 active 或 waiting 并写恢复来源。

task scope 就是 authority：不要扩大目标、渠道、环境或对象范围，也不要把"本次调用返回成功"当成外部状态已落地。附件交付的 receipt 规则见 `outbound-media.md`。

## 独立验收

1. 只有证据成立后才勾选 DoD / Verification checklist。
2. 像任何其他委派一样，派发一个 `purpose: verify`、带 `taskId` 的 sub-agent，然后用带 `note` 的 `task_update` 把任务停泊为 `waiting`（不设 wake，`waitingFor: external-signal`）——没有单独的 `request-verification` 动作，也没有 `waiting + waitingFor: verification` 这种状态。
3. checker 只读检查，结尾返回 `VERDICT: PASS` 或 `VERDICT: FAIL`；完成后 runtime 通过完成唤醒恢复所属 task，依据是 run 记录里的 `taskId`。
4. 主回合用 `task_verify` 导入 runId；attestation 必须属于当前 task、未改变 workspace，且 contract body hash 与 artifact subject 新鲜。
5. PASS/FAIL 都恢复 active；PASS 后 complete 仍会重新校验 attestation、contract hash 和 artifact subject。
6. attestation 标 `advisory` 时（带 `bash` 的内置验收者，以及所有外部验收者），结论只是参考而非结构性保证，仍要按风险抽查；判定强度的来源见 `agent-delegation.md`。

PASS 绑定 Goal/DoD/Manual/Verification 这段 contract，不绑定 Plan、Current Cycle 或 History。改动 contract 或被验收产物后必须重新验收；不要让 verifier 顺手修实现。

## complete / skip / cancel

- `complete` 需要 summary、evidence 和已满足的 acceptance checklist；required verification 必须有有效 PASS。one-shot 写 `outcome: completed`、`closedAt` 并归档；recurring 写证据、清理 task-owned events、计算下一 occurrence 后回到 sleeping。
- `skip` 只接受 recurring 的 active/waiting，记录 reason，不伪造 DoD 或 completion evidence，然后进入 sleeping。
- `cancel` 从任一 live status 归档为 `outcome: cancelled`，记录 reason 并清理 task-owned events。

occurrence 已被更早的触发完成时，用 `skip` 写明原因并回复 `[SILENT]`；否则向用户说明结果、风险和下一步。

## Driver 语义

driver 只派发 enabled 且 active 的任务。waiting 到 wake 时 runtime 先原子写 active、清掉 wake，再派发；sleeping 到 wake 时先打开 cycle、重置周期数据，再按普通 active wake 派发。`enabled: false` 的任务零 dispatch。

任务被唤醒后按真实 effect、台账 fingerprint 和 backoff 继续。只记录真实工作：为了拿一次短延迟而伪造 progress 或跑无意义命令，会被 effect 记账看穿。普通用户闲聊不会批量点燃 waiting task。

## 治理器停止

deadline 超期，或连续三次 wake 没有可见 effect 时，runtime 停掉这个任务：`enabled: false`、`status: active`，并在 control 里写一条 stop 记录——`by: governor`、确定性的 `reason`、以及时间戳 `at`。任务文件里的 `control` 是**一行 JSON**，stop 的三个字段缺一就会变成不可解析的 control：

```text
control: {"version":3,...,"stop":{"by":"governor","reason":"<确定性原因>","at":"2026-07-12T10:00:00+08:00"}}
```

治理器直接发送确定性 receipt，不开启诊断回合。先检查 Current Cycle 和真实产物，再修正范围或 deadline；保留原阶段继续需要用户命令 `/tasks resume <id>`，或者由你 cancel 掉这个任务。

## 体检与损坏文件

任务体检（用户命令：`/tasks doctor`）的每条问题都带 Next step。重点检查：

- active 隐藏 future wake；
- waiting 停泊是否有真实可恢复的来源（有效 wake，或一条正在跑、`taskId` 指向本任务的 job/委派记录）；
- sleeping 的 schedule、wake 和 occurrence 是否自洽；
- enabled 与 stop 是否一致；
- required verification 的 attestation、contract hash、artifact subject；
- 不可读 frontmatter 或不可解析的 control（旧版本的 control 直接判为不可读）。

修 metadata 不执行外部动作。坏 frontmatter 会 fail-open 让问题显现；坏 control 用不带 `note` 的 `task_update` 传结构化的 `control` 重写，不要手工拼 JSON 字符串。要改的是正文契约（Goal/DoD/Manual/Verification）时才用 `edit`——不带 `note` 的 `task_update` 原样保留正文，改完记得重新验收。daemon 重启后按任务文件重新恢复，仍须遵守幂等检查。

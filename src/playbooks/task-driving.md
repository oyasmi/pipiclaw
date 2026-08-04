---
name: task-driving
description: 被 TASK_DRIVER 唤醒推进任务、留检查点，或任务等待、停滞、停用、元数据损坏时。
requires-tools: task_manage
priority: 41
---

# 任务推进、断点恢复与修复

等待来源与 `waiting` 两种形态的唯一真相源见 `task-delegation.md`；后台作业恢复细节见 `background-jobs.md`。

## 每次唤醒先恢复真相

1. 打开消息指定的 `tasks/<id>.md`，不要只依赖唤醒文本、旧对话或记忆。
2. 核对 status、enabled/stop、Current Cycle、`nextAction`、wake、deadline、attempt budget、waitingFor 和 verification。
3. 检查上一步产物是否已经存在。派发是 at-least-once，重放可能让同一步再次到达。
4. 只推进一个清晰的下一阶段；外部动作前先查询真实状态，避免重复发送、发布或部署。

## 回合结束必须留下状态

仍需继续时，用 `task_manage progress` 原子记录发生了什么、证据、下一步、status/wake；Plan 变化放在同一次 `planSteps` 中。生命周期动作 `request-verification`、`complete`、`skip`、`cancel` 本身就是 checkpoint。

- 当前可继续：`active`，清除 wake。
- 等外部 job/user/verifier：`waiting`，无 wake 并写 waitingFor；driver 不会轮询 parked task。
- 等未来时间：`waiting + wake)，waitingFor=time。
- 周期闭环：`complete` 或 `skip` 进入 sleeping，runtime 计算下一 occurrence。
- 一次性放弃：`cancel` 归档。

## Driver 语义

driver 只派发 enabled 且 active 的任务。waiting 到 wake 时 runtime 先原子写 active/clear wake，再派发；sleeping 到 wake 时先打开 cycle、重置周期数据，再按普通 active wake 派发。enabled=false 的 active/waiting/sleeping 都零 dispatch。

任务被唤醒后会按真实 effect、台账 fingerprint 和 backoff 继续。不要为了获得短延迟伪造 progress 或运行无意义命令；只记录真实工作。普通用户闲聊不会批量点燃 waiting task。

## 治理器停止

deadline、active attempt budget 或连续三次 active wake 没有可见进展时，runtime 写：

```text
enabled: false
status: active
control.stop.by: governor
control.stop.reason: <确定性原因>
```

治理器直接发送确定性 receipt，不开启诊断回合。先检查 Current Cycle、真实产物和 `/tasks stats <id>`；修正范围、deadline 或 budget 后用 `/tasks resume <id>` 保留原阶段，或让 Agent cancel。

## Doctor 与损坏文件

`/tasks doctor` 的每条问题都带 Next step。重点检查：

- active 隐藏 future wake；
- waitingFor 与 wake 组合；
- waiting parked 是否有明确 user/job/verification 来源；
- sleeping 的 schedule、wake 和 occurrence；
- enabled 与 stop 是否一致；
- required verification 的 attestation、contract hash、artifact subject；
- retired control keys 和不可读 frontmatter。

修复 metadata 不执行外部动作。坏 frontmatter 会 fail-open 让问题显现；坏 control 先修 JSON，再用 task_manage set。daemon restart 后按任务文件重新恢复，仍须遵守幂等检查。

---
name: task-recurring
description: Read before creating, starting, rescheduling, pausing, completing a cycle of, or retiring a recurring task and its canonical schedule event.
requires-tools: task_manage
priority: 43
---

# 周期性任务

一个周期任务由两份真相组成：

- `tasks/<id>.md`：目标、DoD、Manual、验收与跨周期经验。
- `task.<channelId>.<id>.schedule`：唯一 canonical periodic cadence。

节奏在 event，做法在 task。`recurrence` 只是可读标注。

## 创建

先按 `task-planning.md` 创建 task，必须填写 recurrence；再用 `event_manage create` 建 `.schedule`：

```json
{"type":"periodic","channelId":"<当前channel>","text":"推进任务 weekly-report：读取任务文件，必要时 start-cycle","schedule":"30 9 * * 1","timezone":"Asia/Shanghai"}
```

纯提醒没有产出和验收，不建 task，使用普通 periodic event。

## 周期运行

done 的周期任务留在原地睡眠，driver 不唤醒；只有 `.schedule` 开启新周期。

- 上周期 done：调用 `task_manage start-cycle`，给稳定 cycleId。它原子折叠上一周期日志、清空本周期用量/验收/授权/worktree 元数据并置 in-progress。
- 上周期未完成：不要覆盖或虚勾 DoD。先完成、如实缩小本轮范围并验收，或与用户确认后 cancel 整项任务。

周期内继续、等待和恢复只使用 task wake，不建 `.checkin`。

## 复盘、调整和退役

每轮闭环前把返工原因、预检步骤和格式偏好写回 Manual；跨任务才沉淀 workspace skill。

- 改节奏：整体 update `.schedule`，并用 task_manage set 同步 recurrence 标注。
- 暂停：pause task；若要完全安静也删除 schedule，恢复时重建。
- 退役：`task_manage cancel`，它归档任务并删除全部 task-owned events，包括 schedule。

不要手工改 status 开周期，也不要只删 schedule 留下永远不会再开始的活任务。

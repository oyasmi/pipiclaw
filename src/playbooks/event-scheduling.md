---
name: event-scheduling
description: 周期 cron、先 show 后整体改期/删除，或区分 text 与 task 事件。
requires-tools: event_manage
order: 40
---

# 事件正常流程

仅普通聊天侧使用 event_manage；任务步骤没有该工具，不改文件绕过。事件属于当前工位，同工位各频道可管理；创建投递当前频道，更新保留原投递频道。改绑定不改变事件收件目标。

## 先选消息还是项目

当前能做就做。definition 的 text/task 二选一：

| 目标 | 选择 |
|---|---|
| 提醒、回访或一次小检查 | text，触发消息进入聊天 |
| 定时/周期周报、巡检、整理等有状态的工作 | task 模板，每次在独立后台会话创建并推进新任务；创建前读 [任务模板](event-task-template.md) |
| 外部条件满足才触发 | 读 [传感器](event-sensors.md)，用 preAction 门控 |

后台 job 和委派已有完成唤醒，不建事件等待它们。任务内部等外部条件用 task-lead 的作业传感器。

## 创建或更新

definition 是类型化对象，不是 JSON 字符串，不写 channelId。时间和时区偏移已明确的单次文本提醒可直接用 create、one-shot + at，提前 2 分钟至约 24.8 天；示例时间须换成真实未来时间：

```json
{"type":"one-shot","text":"检查处理结果","at":"2026-12-01T10:00:00+08:00"}
```

将对象传给 event_manage 的 definition。periodic 使用宿主时区五段 cron；普通事件最小间隔 30 分钟，带 preAction 为 5 分钟，每工位最多 50 份。immediate 不允许，当前工作直接做。

名字未知先 list，已知名字可 show；更新前先 show 读取完整定义，再 update **整体替换**，保留仍需生效的字段。参数被拒按报错修正；无法解析的旧文件会列出，用途不清先问，确认无用再删除重建。

## 确认与退役

以成功工具结果确认创建/修改/删除，再告知事件名；不因写下计划就声称安排成功。停用或闭环时清理临时事件；超出 one-shot 范围的提醒处理见传感器指南的“远期提醒”。触发和 gate 结果用用户命令 `/events history` 查看。

投递频道换绑期间 text 事件跳过，task 实例继续运行但报告暂存。periodic 文本唤醒无新结果按要求回复 `[SILENT]`；task 模板不产生聊天回合，不适用。

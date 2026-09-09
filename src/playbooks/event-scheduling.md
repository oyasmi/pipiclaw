---
name: event-scheduling
description: 创建、调整或退役提醒、定时调度（cron）、preAction 传感器门控，或跨回合的回访事件（event）。
requires-tools: event_manage
order: 40
---

# 事件与调度

event 负责何时唤醒，task 承载可验收工作的状态。当前能做就直接做；单次提醒或外部条件探测用 event，周期性产出用带 schedule 的 task。需要写任务契约时才读 `task-loop.md`。

## 创建合法事件

在**普通聊天侧**使用 `event_manage`；task 步骤没有该工具。它验证频道、时间、command guard 和总量，`definition` 是完整 JSON 字符串；省略 channelId 默认当前频道。更新时整体替换 definition。

一次提醒用 one-shot，至少提前 2 分钟、最多约 24.8 天；下面的 at 是示意，调用时换成未来的真实时间：

```json
{"type":"one-shot","text":"检查处理结果","at":"2026-12-01T10:00:00+08:00"}
```

periodic 使用主机时区的五段 cron，没有 timezone 字段。普通事件最小间隔 30 分钟，带 preAction 时 5 分钟，全 workspace 最多 50 份事件文件。

## preAction：外部条件传感器

```json
{"type":"periodic","text":"条件满足后检查并处理结果","schedule":"*/5 * * * *","preAction":{"type":"bash","command":"test -f /absolute/path/ready.flag","timeout":10000}}
```

把示例命令和路径换成真实条件。`preAction.type` 必须是 bash，`timeout` 单位是**毫秒**，与 bash 工具的秒不同。退出 0 才唤醒，非 0 静默跳过；不要用总是成功的命令假装门控。传感器用 periodic：one-shot 即使条件未满足也会被消费。

传感器只检查条件，不承载实施步骤。第三方工具的命令和状态语义来自已安装工具或对应 skill，不复制来源不明的脚本。频率、退出条件和退役时机要明确。

## 与 task 组合

聊天侧先建 task，再创建命名为 `task.<channelId>.<taskId>.<use>` 的 periodic sensor，并把事件名与条件写进任务契约。任务步骤先查真实条件，未满足才 park 到 `{"kind":"signal","event":"<事件名>"}`。

门控通过后，runtime 兑现匹配的 signal 票并推进任务；没有匹配票时仍会投递聊天唤醒，因此唤醒文本不能自行扩大任务范围。票有 runtime 派生的兜底，不需另建回访事件。循环中缺少 sensor 时说明缺什么，不能用文件工具绕过被移除的 event_manage。

后台 job 和委派已有完成唤醒，不建 event 等它们。没有 task、也没有内置完成通知的外部等待，才建一次性回访；需按条件触发则用 periodic + preAction。

## 维护

事件名字不确定时先 list；已知名字直接操作。列表包含本频道可解析事件及无法解析的文件提示，后者归属未必可确认，不凭猜测删除。停用、闭环或改期时及时清理临时事件；task 完成/取消会清理归属事件，周期任务要保留仍需复用的 sensor。

超出 one-shot 范围的一次提醒可用 periodic 表达未来日期，但首次成功后必须删除，不能默认为永久重复。工具不可用且没有合法文件访问入口时告知用户，不绕过守卫。

periodic 无新结果按唤醒要求回复 `[SILENT]`。检查触发与 gate 结果由用户命令 `/events history` 查看。

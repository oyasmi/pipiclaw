---
name: event-scheduling
description: 创建、调整或退役提醒、定时调度（cron）、preAction 传感器门控，或跨回合的回访事件（event）。
requires-tools: event_manage
order: 40
---

# 事件与调度

event 负责何时唤醒，task 承载有状态的项目。当前能做就直接做；提醒或外部条件探测用文本事件，**定时或周期的工作用任务模板事件**。写任务契约和带队方法读 `task-lead.md`。

## 文本还是任务模板

事件的 `definition` 里 `text` 与 `task` **二选一**：

| 选哪个 | 适用 | 触发时发生什么 |
|---|---|---|
| `text` | 简短提醒、回访、一次小检查 | 一条消息进入聊天会话，由聊天里的你处理 |
| `task` | 周报、巡检、定期整理等需要拆工作项、委派、检查、汇报的工作 | 运行时按模板创建一个新任务实例，在它自己的任务会话里推进，不进聊天会话 |

`task` 的形状与 `task_create` 一致（`title`、`goal`、`dod`，可选 `items`、`budget`），把这类工作每次都要遵守的要求写进 goal 和 dod。上一个实例还没结束时，本次触发会被跳过并通知用户；每次实例独立，不继承上次的状态。模板要改进（目标、检查项、工作项），在聊天侧用户确认后 `event_manage update`，不要指望实例自己改。

## 创建合法事件

在**普通聊天侧**使用 `event_manage`；task 步骤没有该工具。它验证频道、时间、command guard 和总量。`definition` 是**类型化对象**（不是 JSON 字符串），频道由 runtime 绑定，不要写 channelId。改期前先 `action:"show"` 读回完整定义，`action:"update"` 整体替换。

一次提醒用 `type:"one-shot"` + `at`，至少提前 2 分钟、最多约 24.8 天；下面的 at 是示意，调用时换成未来的真实时间。`definition` 传下面这个对象（`event_manage {action:"create", name:"check-result", definition:<对象>}`）：

```json
{"type":"one-shot","text":"检查处理结果","at":"2026-12-01T10:00:00+08:00"}
```

每周一次的周报任务模板：

```json
{"type":"periodic","schedule":"0 9 * * 1","task":{"title":"周报","goal":"汇总上周仓库的合并与未决问题，生成周报发给用户。只读，不做写操作。","dod":"- [ ] 覆盖上周全部合并的 PR\n- [ ] 列出未决问题及负责人\n- [ ] 周报正文已在 report 中交付","items":[{"text":"收集上周合并记录"},{"text":"整理未决问题"}]}}
```

`type:"periodic"` + `schedule` 用主机时区的五段 cron。普通事件最小间隔 30 分钟，带 preAction 时 5 分钟，全 workspace 最多 50 份事件文件。

## preAction：外部条件传感器

```json
{"type":"periodic","text":"条件满足后检查并处理结果","schedule":"*/5 * * * *","preAction":{"type":"bash","command":"test -f /absolute/path/ready.flag","timeoutMs":10000}}
```

把示例命令和路径换成真实条件。`preAction.type` 必须是 bash，`timeoutMs` 单位是**毫秒**，与 bash 工具的秒不同。退出 0 才唤醒，非 0 静默跳过；不要用总是成功的命令假装门控。传感器用 periodic：one-shot 即使条件未满足也会被消费。`preAction` 对文本事件和任务模板同样有效。

传感器只检查条件，不承载实施步骤。第三方工具的命令和状态语义来自已安装工具或对应 skill，不复制来源不明的脚本。频率、退出条件和退役时机要明确。**任务内部**等外部条件，不用事件：在任务步骤里启动带超时的后台作业当传感器（见 `task-lead.md`）。

## 维护

事件名字不确定时先 list；已知名字直接操作。列表包含本频道可解析事件及无法解析的文件提示，后者归属未必可确认，不凭猜测删除。停用、闭环或改期时及时清理临时事件。

超出 one-shot 范围的一次提醒可用 periodic 表达未来日期，但首次成功后必须删除，不能默认为永久重复。工具不可用且没有合法文件访问入口时告知用户，不绕过守卫。

periodic 文本事件无新结果按唤醒要求回复 `[SILENT]`（任务模板没有聊天回合，不适用）。后台 job 和委派已有完成唤醒，不建 event 等它们。检查触发与 gate 结果由用户命令 `/events history` 查看。

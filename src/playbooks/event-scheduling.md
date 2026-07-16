---
name: event-scheduling
description: Creating, updating, or retiring reminders, schedules, preAction gates, or background-job check-ins.
requires-tools: event_manage
priority: 30
---

# 事件与调度

事件负责“什么时候唤醒”，不是长程工作的完整状态。可验收、需积累步骤的工作用 task；纯提醒或外部条件探测才单独用 event。

## 选择类型

- 当前回合立即能做：直接做，不建 immediate。`event_manage` 会拒绝 immediate，防止自触发循环。
- 将来某时只提醒一次：one-shot，至少提前 2 分钟。
- 固定节奏重复提醒/检查：periodic，五段 cron + timezone。
- 周期性产出任务：task + canonical `.schedule`，见 `task-recurring.md`。

优先使用 `event_manage`，它会验证 JSON、channel、时间间隔、preAction command guard 和总量。工具不可用时才直接维护 `events/*.json`；无效文件可能被 scheduler 忽略。

## 基本定义

```json
{"type":"one-shot","channelId":"<当前channel>","text":"检查处理结果","at":"2026-07-12T10:00:00+08:00"}
```

```json
{"type":"periodic","channelId":"<当前channel>","text":"执行工作日巡检","schedule":"0 9 * * 1-5","timezone":"Asia/Shanghai"}
```

普通 periodic 最小间隔 30 分钟；带 preAction gate 时最小 5 分钟；事件总数上限 50。任务拥有的事件使用 `task.<channelId>.<taskId>.<use>`，便于闭环清理。

## preAction 是传感器，不是工作流

preAction 的 bash 命令退出 0 才唤醒 agent，非 0 静默跳过。它适合调用用户已经安装、稳定可执行的工具来检测外部条件。不要在 runtime playbook 中捆绑第三方工具脚本，也不要把来源不明的脚本复制进 workspace。

如果某个工具（例如 agentmux）需要完成态检测，由用户层对应 skill/可执行文件定义命令和状态语义；Pipiclaw 只负责运行经过 command guard 的 preAction。

传感器应使用 periodic：one-shot 即使 gate 未通过也会被消费。任何传感器都要有退出条件和合理频率；task-owned 传感器还要保留任务 `wake` 兜底，避免永久静默或空转。

## 后台 job 的回访

短等待直接 `job poll`。不能在当前回合等待时，按预计完成时间建 one-shot 回访；需要条件检测时才用 periodic + preAction。回访后删除临时事件。

周期事件无新结果时只回复 `[SILENT]`，避免发送空状态卡。更新事件时整体替换 definition；不再需要时及时删除，并用 `/events history` 排查触发与 gate 结果。

---
name: event-scheduling
description: 创建、调整或退役提醒、定时调度（cron）、preAction 传感器门控，或跨回合的回访事件（event）。
requires-tools: event_manage
order: 40
---

# 事件与调度

事件只负责"什么时候唤醒"，不承载长程工作的状态。可验收、需要积累步骤的工作用 task（见 `task-planning.md`）；纯提醒或外部条件探测才单独用 event。

## 选择类型

- **当前回合就能做**：直接做。`event_manage` 会拒绝 immediate 类型，防止自触发循环。
- **将来某时提醒一次**：one-shot，至少提前 2 分钟、最多约 24.8 天；更远的时间用 periodic。
- **固定节奏重复提醒或检查**：periodic，五段 cron，按主机时区解释（没有 timezone 字段）。
- **周期性产出任务**：不是 event，是一个 task 文件，节奏写在 frontmatter 的 `schedule`。

优先用 `event_manage`：它会校验 JSON、channel、时间间隔、preAction command guard 和总量。工具不可用时才直接维护 `events/*.json`，无效文件会被 scheduler 静默忽略。

## 基本定义

```json
{"type":"one-shot","channelId":"<当前channel>","text":"检查处理结果","at":"2026-07-12T10:00:00+08:00"}
```

```json
{"type":"periodic","channelId":"<当前channel>","text":"执行工作日巡检","schedule":"0 9 * * 1-5"}
```

普通 periodic 最小间隔 30 分钟，带 preAction gate 时 5 分钟，事件总数上限 50。任务拥有的事件命名为 `task.<channelId>.<taskId>.<use>`，便于闭环时清理。

## preAction 是传感器，不是工作流

preAction 的 bash 命令退出 0 才唤醒 agent，非 0 静默跳过。它用来调用用户已经安装、稳定可执行的工具检测外部条件。Pipiclaw 只负责运行经过 command guard 的命令，不捆绑第三方工具的脚本或状态语义——那属于用户层的 skill / 可执行文件；来源不明的脚本也不要复制进 workspace。

传感器必须用 periodic：one-shot 即使 gate 没通过也会被消费掉。每个传感器都要有退出条件和合理频率；task-owned 传感器还要保留任务 `wake` 兜底，避免永久静默或空转。

## 回访事件

当前回合等不到结果、又没有 task 可以承载这次等待时，按预计完成时间建一条 one-shot 回访；只有需要按外部条件触发时才用 periodic + preAction。回访完成后删掉这条临时事件。

**后台作业和 Agent 委派不需要回访事件**：它们结束时 runtime 会自己唤醒你，见 `background-jobs.md` 和 `agent-delegation.md`。

## 维护纪律

闭环或改期之前先 `event_manage action=list` 确认本频道事件的真实名字，不要凭 `task.<channelId>.<taskId>.<use>` 约定拼。`list` 只返回当前 channel 的事件，无法解析的文件也会列出并标记，便于清理。名字确定时直接 create / update / delete，不必每次先 list。

更新事件时整体替换 definition，不再需要就及时删除。周期事件跑完没有新结果时按唤醒文本的要求回复 `[SILENT]`，不发空状态卡。排查触发与 gate 结果要看事件历史（用户命令：`/events history`）。

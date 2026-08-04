---
name: task-delegation
description: 拆分任务（task）、委派子代理（subagent），或等待外部 agent/job 的恢复信号时。
requires-tools: task_manage, subagent
priority: 45
---

# 任务分解与委派

只拆真正可分离、可独立验收的工作。任务之间没有依赖字段；先后条件写进后继任务 Goal/Manual 或由 wake 错开。

## 子代理

委派说明必须包含目标、范围、路径、约束、验收方法和返回格式。独立验收使用 `purpose: verify` + `taskId`，verifier 不能 write/edit，结果写 durable attestation。主 Agent 负责 review、验证和台账闭环。

## 外部 agent 与等待

本页是 waiting 两种形态的唯一真相源；`waiting + wake` 是定时等待，`waiting` 无 wake 是停泊信号等待。后台作业的实现细节见 `background-jobs.md`。

runtime 不假设第三方工具的命令、状态协议或检测脚本。优先使用用户提供的 skill；等待形态按恢复能力选择：

1. 有阻塞等待命令：用 `bash async` + `taskId`，progress 为 `waiting`、`waitingFor: job`、不设 wake。job 完成时 runtime 只恢复所属 task。
2. 只有状态查询：用 event sensor 或 `waiting + wake`，把回访条件写进 blockedReason。
3. 没有可用信号：等待用户时 `waitingFor: user`、无 wake，或让用户用 `/tasks run <id>`。

普通 driver 不轮询 `waiting` 无 wake。所有外部动作都要写任务 scope、实例标识、工作目录、预期产物、验收方法、幂等 request id 和 recovery plan。

## 产物与闭环

重要产物写入目标 checkout，不只留在 stdout 或 subagent 返回文本。取回后核对真实文件和测试结果，再 progress/verify/complete。task cancel/complete 会清理 task-owned events；不要遗留一个会继续唤醒已归档任务的事件。

# 一次性迁移说明：由 AI agent 将任务数据整理到任务车道格式

本文用于一次具体部署的离线迁移，不是产品运行协议，也不是可直接照抄执行的通用脚本。

**目标是 spec 064 的任务车道版本。先确认实际安装的代码已实现任务车道（存在 `runtime/task-lane.ts`，任务文件头使用 `queued` / `running` / `waiting` / `paused`，没有 `task_step_end`），再转换数据。不要把转换后的 home 交给仍认识等待票（`ticket`）的旧版本启动，也不要让新版本读取未转换的任务：运行时只读取当前格式，没有兼容读取，也不会自己迁移。**

审查后版本的日志为每条记录写稳定 `id`，状态提交携带 `checkpoint`，任务文件用 `revision` 标记已应用版本。迁移日志时为保留的记录分配稳定身份，初始快照从版本 0 开始，由目标版本的正常提交建立后续版本。若源数据已是初版 064，也需要离线核对日志身份与会话消费：仅根据持久化任务会话确认已经投递的输入；不能把 `step` 已开始或旧 `injected` 标记当成消费证据。无法确认的输入保留待投递，允许恢复后重复看到，不直接丢弃。

可以直接让有服务器文件访问能力的 AI agent 阅读本文、目标版本源码与现有 home，完成迁移。迁移只改任务数据和与任务相关的运行状态；契约正文、委派与作业的结果、记忆和其他数据保持原样。

## 1. 给执行 agent 的任务约定

先确认实际 app home、源版本、目标版本、当前进程、数据规模和可用备份。读取目标版本的任务文件头解析（`src/tasks/frontmatter.ts`）、任务记录类型（`src/tasks/loop-log.ts`）、状态推导（`src/tasks/state.ts`）以及 run / job 记录的读取实现，以它们为准。列出本次实际需要处理的数据：每个工位 `tasks/` 下的活动任务、`archive/` 下的归档任务及其日志、`tasks/.steer/`、`state/dispatch/`、`state/subagent-runs/`、`state/jobs/`，以及工位 `AGENTS.md` 和 workspace `skills/` 中镜像的旧用法。没有出现的数据就不处理。

允许为本次明确的数据写临时命令、查询或小工具，但不要将它们加入产品源码、打包文件或长期测试，不重新建设一个通用迁移器。无法判断的归属（例如一个等待票对应的委派是否仍在运行）只问那一项，不要猜。

## 2. 停机与备份

- 停止 daemon、TUI 和服务管理器的自动重启，确认所有可能写入本次 home 的进程都已退出。
- 在旧版本仍能管理时，先让在途的委派与作业结束，或按授权取消；daemon 停止后 detached 进程仍可能继续写旧路径。
- 对整个 app home 做可恢复的完整备份，保留权限与时间，并记录源程序版本。备份放在工作区外，不在聊天或报告里输出密钥。
- 优先在备份的独立副本上整理。副本不得连接钉钉、运行定时工作或产生真实外部委派。

## 3. 转换

按实际数据逐项转换，转换后的结果以目标版本的读取函数为准：

| 数据 | 转换 |
|---|---|
| 活动任务 `state: open` | `state: queued` |
| `state: parked` + `work` 票 | 本任务仍有在途委派或作业 → `state: waiting`、`waiting: {"kind":"work","since":<停泊时刻>}`；否则 → `queued` |
| `state: parked` + `time` 票 | `state: waiting`、`waiting: {"kind":"time","until":<票的 at>,"since":…}` |
| `state: parked` + `ask` 票 | `state: waiting`、`waiting: {"kind":"user","question":<票的 asked>,"since":…}` |
| 与 `state` 并存的 `paused` | `state: paused`，`paused` 字段保持不变；原来的等待条件不保留（恢复后任务回到排队，由负责人按真实状态重新判断） |
| `ticket`、`usage.expired` | 删除 |
| 其余字段（`channel`、`origin`、`usage`、`budget`） | 保持不变 |
| `tasks/.steer/<id>.md` 待处理的指示 / 回答 | 逐条改写为任务记录里的 `message` 记录（`from` 填 `migration`，`channel` 填任务的 `channel`，`text` 为原文）；文件删除 |
| `tasks/.steer/<id>.out.md` 待发的通知 | 能补发则补发，否则在迁移记录中注明丢弃 |
| 活动与归档日志中旧形状的 `step`（`outcome: continue\|park\|done`） | 转为一对 `step`（`reason: continue`，`brief: delta`）+ `step_end`（`result: ok`；`next` 映射：`continue`→`continue`，`park`→按当时的票 `work` / `user` / `time`，`done`→`closed`；`note`、`tools`、`usd`、`usdEstimated` 沿用）；`report` 字段非空时另写一条 `report` 记录（`delivered: true`） |
| 日志中的 `expired` 记录 | 删除，在迁移记录中注明数量 |
| 日志中的 `close` 记录 | 补 `by`（无法判断时填 `leader`） |
| `state/dispatch/` 中 `producer: TASK_DRIVER` 的记录 | 删除（新车道自行接纳任务） |
| `state/dispatch/` 中带 `internalWake` 的完成唤醒 | 确认对应 `settle` 记录已在任务日志中后删除；若没有，先补写 `settle` 记录再删除 |
| `state/subagent-runs/`、`state/jobs/` 记录中的 `wakeClaimDispatchId`、`wakeConsumedAt` | 可保留（读取器忽略未知字段），或在核验后删除；不得改动其他幂等标记（`wakeEnqueued`、`taskAccounted`、`taskLogged`、`notified` 等） |
| 工位 `AGENTS.md`、workspace `skills/` 中镜像的 `task_step_end` / 票据用法 | 删除镜像内容，改为引用 `task-lead.md` |

任务文件头的字段顺序和 JSON 形状以目标版本的写入结果为准（`renderTaskFrontmatter`）。已归档任务的契约文件（`outcome`、`closedAt`）不需要转换；`state: done` 的归档文件头可保留，读取器看到 `outcome` 就把它当归档。

## 4. 核验后再切换

- 用目标版本的读取函数在副本上读取每个活动任务：`state` 与是否有在途工作一致（`waiting: work` 的任务必须仍有在途的委派或作业，否则应是 `queued`），`/tasks doctor` 无问题，`/tasks log <id>` 可读，归档任务的日志可读。
- 在副本上用 mock 模型启动内嵌运行时验证：`/tasks` 正确列出状态；`waiting: work` 的任务在其 run 结算后醒来；`waiting: user` 的任务在 `/tasks msg` 后继续。
- 校验通过后再把转换后的 home 交给新版本；失败则从同一备份快照恢复，不在两份数据间混用。

## 5. 本次操作留下什么

在部署者约定的位置留下一份迁移记录（不进产品仓库）：源 / 目标版本、home 路径、备份位置、各类转换的数量（含删除的 `expired` 记录数、丢弃的通知）、核验结果和未决事项。不要在记录里输出密钥或任务正文。

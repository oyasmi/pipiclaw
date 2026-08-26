---
name: background-jobs
description: 用 bash async 启动长跑命令、轮询后台作业（job），或作业跨回合仍未完成时。
requires-tools: job
order: 50
---

# 后台作业（background jobs）

`bash` 传 `async: true` 会把命令放到后台并立刻返回一个 job id；`job` 工具负责之后的查看、等待和取消。适用于构建、测试套件、大文件下载、批量处理这类**明显超过前台超时**的命令。短命令直接同步等，多一次 poll 往返比同步更慢。

## 三个动作

- `job op=list`：当前作业快照，含状态与已运行时长。
- `job op=poll ids=[...]`：等待作业结束并取回输出；省略 `ids` 表示等所有运行中的作业。
- `job op=cancel ids=[...]`：按 id 终止，必须显式给 id。

`poll` **最多等约 30 秒**就返回，未完成时返回的是"仍在运行"，不是失败。它只适合"几乎肯定马上就好"的短等待。

## 作业结束会自动叫醒你

作业进入终态时，runtime 会给这个 channel 发一条唤醒，带上退出码、耗时、输出尾部和完整输出的路径。所以启动 async 作业后**直接结束回合**：不必预约回访事件，不必猜一个 `wake` 时间，也不必连续 poll 空转。

只有一种情况要自己收尾：`notify: false` 的 fire-and-forget 作业结束时不会叫你，得自己 `job op=list`。

作业属于某项长程任务时，启动就传 `taskId`，唤醒文本会点明归属；再用带 `note` 的 `task_update` 把任务停泊为 `waiting`（不设 wake，见 `task-driving.md`）。

## 硬约束

每个 channel 最多 5 个同时运行的作业。达到上限后 `async` 会直接被拒绝，提示先 poll 或 cancel；终态作业自动释放名额。

作业记录跨重启存活：daemon 重启后仍在跑的作业会被重新认领，重启期间结束的作业会补发唤醒。即便如此，**真正重要的产物要让命令自己写进文件**，而不是只留在 stdout 里——作业输出保留 24 小时后清理。

---
name: background-jobs
description: 用 bash async 启动长跑命令、轮询后台作业（job），或作业跨回合仍未完成时。
requires-tools: job
priority: 35
---

# 后台作业（background jobs）

`bash` 传 `async: true` 会把命令放到后台并立刻返回一个 job id；`job` 工具负责之后的查看、等待和取消。适用于构建、测试套件、大文件下载、批量处理这类**明显超过前台超时**的命令。

短命令不要 async——多一次 poll 往返比直接同步等更慢。

## 三个动作

- `job op=list`：当前作业快照，含状态与已运行时长。
- `job op=poll ids=[...]`：等待作业结束并取回输出；省略 `ids` 表示等所有运行中的作业。
- `job op=cancel ids=[...]`：按 id 终止，必须显式给 id。

`poll` **最多等约 30 秒**就返回，未完成时返回的是"仍在运行"，不是失败。它适合"几乎肯定马上就好"的短等待；等不到就结束回合，作业结束时自会叫醒你。

## 作业结束会自动叫醒你

**不需要预约回访。** 作业进入终态时，runtime 会给这个 channel 发一条唤醒，带上退出码、耗时、输出尾部和完整输出的路径。所以：

- 不要为等作业而建 one-shot event；
- 不要为等作业去猜一个 `wake` 时间；
- 不要靠连续 poll 空转烧 token。

启动 async 作业后**直接结束回合**即可。醒来时你会拿到结果。

只有一种情况需要自己收尾：`notify: false`（明确不需要结果的 fire-and-forget）。那时作业结束不会叫你，得自己 `job op=list`。

如果这个作业属于某项长程任务，启动时传 `taskId`，唤醒文本会点明归属；再用 `task_manage progress` 置 `waiting` 把等待写进任务状态即可，**不必设 `wake`**。

## 硬约束

每个 channel 最多 5 个同时运行的作业。达到上限后 `bash async` 会直接被拒绝，提示你先 poll 或 cancel。终态作业会自动释放名额，不再依赖你去查。

作业记录跨重启存活：daemon 重启后仍在跑的作业会被重新认领，重启期间结束的作业会补发唤醒。即便如此，**真正重要的产物应让命令自己写进 workspace 文件**，而不是只留在作业的 stdout 里——输出保留 24 小时后会被清理。

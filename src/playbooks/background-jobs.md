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

`poll` **最多等约 30 秒**就返回，未完成时返回的是"仍在运行"，不是失败。这是设计好的：它让你在一个回合内既能等一会儿，又不会把回合卡死。

## 硬约束

每个 channel 最多 5 个同时运行的作业。达到上限后 `bash async` 会直接被拒绝，提示你先 poll 或 cancel。

**作业完成不会主动通知你。** 已结束的作业只在你调用 `list` / `poll` / `cancel` 时才被回收并释放名额。所以一个启动后再没被查过的作业会一直占着名额，最终把 async 全部堵死。谁启动谁负责收尾。

## 跨回合的等待

一个回合内等不到结果时，不要靠连续 poll 空转消耗 token。按等待时长选：

- **秒到分钟级**：本回合 `poll` 一到两次，拿到结果再继续。
- **分钟到小时级、且属于某项长程任务（task）**：用 `task_manage progress` 置 `waiting`，把 job id、命令、预期产物和判断成功的方法写进 `blockedReason`，设一个贴合预计完成时间的 `wake`。醒来后先 `job op=list` 核对。
- **与任务无关的独立等待**：按 `event-scheduling.md` 建一条 one-shot 回访事件；需要按外部条件触发才用 periodic + preAction。

无论走哪条，**恢复线索必须落盘**。作业本身不跨进程存活：daemon 重启后内存中的作业记录消失，重启前未取回的输出就拿不回来了。真正重要的产物应让命令自己写进 workspace 文件，而不是只留在作业的 stdout 里。

## 回合结束前自检

- 还在跑的作业：是否已有 task `wake` 或 event 能把我叫回来？
- 已经结束的作业：输出取回了吗？名额释放了吗？
- 不再需要的作业：`cancel` 掉，不要留着占名额。

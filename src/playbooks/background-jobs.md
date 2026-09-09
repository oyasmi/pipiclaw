---
name: background-jobs
description: 长跑命令需要 bash async、设置超时（timeout），或处理后台作业（job）的结果、取消与恢复时。
requires-tools: job
order: 50
---

# 后台作业

短命令同步执行；长构建、测试、下载和批处理用 `bash async:true` 释放聊天回合。**async 不延长 timeout**：默认仍是 300 秒，预计更久就显式传足够的秒数。

```json
{"command":"npm run test","async":true,"timeout":1800}
```

命令和时限按实际工作调整。需要结果就保留默认通知；`notify:false` 只用于以后不需要结果的 fire-and-forget 工作，不能同时带 taskId。

## 派发与收尾

启动后先完成互不依赖的工作或派发；只剩等待时结束回合，不连续 poll 或建回访事件。作业终态会带回退出码、耗时、输出尾部和完整输出路径。

属于 task 的作业启动时传 `taskId`；**当前是 task 步骤时**用 `task_step_end` park 到 `{"kind":"job","id":"<jobId>"}`。若已结束、票被拒，读取输出并继续，不重跑命令。票过期等恢复问题才读 `task-loop.md` 的“等待与恢复”。

`job op=list` 用于需要当前状态的判断；`poll ids=[...]` 只适合一次短等待或取回结果，最多约 30 秒，仍在运行不代表失败。明确取消用 `cancel ids=[...]`，取消由你发起，不再发送完成唤醒。

## 容量与持久性

每频道最多 5 个运行中作业；满额先等待已有结果，只有工作已不需要才取消。daemon 重启后会恢复跟踪并补发完成通知。

重要产物让命令写入目标文件。stdout 保留 24 小时后清理；收到失败或 lost 时先查真实产物和错误，再决定是否重跑。

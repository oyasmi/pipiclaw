# 长任务分解与委派回访手册

> Pipiclaw 内置手册，随版本发布，只读。这里写的是 runtime 的硬约束与标准做法；个人化的偏好和团队策略写进 workspace `AGENTS.md`，或沉淀成 workspace skill。

## 分解：父子任务与依赖

只有**真正可分离**的长工作才拆分；能一个任务顺序推进的不要拆。

- 子任务用 `task_manage create`，`control.parent` 指向父任务 id；执行顺序用 `control.dependsOn` 表达（被依赖任务必须先 done，driver 才会运行依赖方）。
- 父任务可以 `dependsOn` 自己的 child——这是正常的 join 语义（父任务等所有子产出汇合后做集成/验收）。
- 创建与 `set` 会校验：相关任务必须存在、parent 链和 dependsOn 图不允许自指和环。
- 门禁语义（driver 与 `done` 强制执行，不要试图绕过）：
  - dependsOn 未全部 done → 依赖方被跳过，**零 attempt、零 token**；
  - 依赖缺失 / cancelled / escalated → 依赖方一起升级为 escalated，附恢复说明；
  - 父任务在还有未闭环 child 时不能 done。

## worktree 隔离（写密集型子工作）

不想让子工作直接改动共享 checkout 时：

1. 给子任务设 `control.isolation: worktree`；
2. 委派时 `subagent` 带 `isolation: "worktree"` 和 `taskId: <子任务id>`——runtime 从指定 host checkout 的 committed HEAD 建分支 `pipiclaw-task/<task>/<run>`，worktree 固定放在 channel 的 `tasks/worktrees/` 下，并把 path/branch 原子写回该任务的 control；
3. 复用已有 worktree 传 `worktreePath`（必须在 `tasks/worktrees/` 下）；
4. 子代理结束后 worktree **不会自动删除**（防丢成果）。父代理负责 review → merge → 清理 worktree 与分支。

## 委派 subagent（进程内）

`subagent` 工具：`task` 写完整任务描述，配合 `agent`（预定义子代理）或内联 `systemPrompt`；可用 `maxTurns` / `maxToolCalls` / `maxWallTimeSec` 限幅。子代理同回合内同步返回，所以**不需要回访事件**——拿到结果就验收并 `task_manage progress` 记录。子代理不该驱动台账（task_manage/event_manage 不进子代理工具集），验收与记账永远在主回合做。

## 委派 agentmux（外部长进程）：回访两档

委派出去的工作会死在两次触发之间，除非安排回访。委派时先在 task 正文记下实例名（如 `agentmux 实例：编码助手-A`），然后二选一：

**基线档（推荐，零新事件）**：

- `task_manage progress`：note 记录“已委派给 <实例>，预计 <时长>”，`status: blocked`，`wake` 设到合理的下次检查时间；
- 内建 driver 在 wake 到期后的分钟级扫描接手 → 醒来 `agentmux inspect` 探状态：还忙就再 progress 把 wake 推后；空闲就 `agentmux capture` 取结果、验收、推进或闭环。

**响应式档（分钟级感知“做完了才叫我”）**：

1. 传感器脚本随本手册发布在同目录的 `scripts/agentmux-idle.mjs`（实例还忙时 exit 1，事件静默跳过、零 token；idle/exited/异常时 exit 0 唤醒，fail-open）。**首次使用时把它拷贝到 `workspace/skills/agentmux-idle.mjs`**——事件要引用一个稳定路径，安装目录会随版本或 Node 环境变动，而 preAction 失败是静默的，路径失效等于传感器悄悄失灵；workspace 里的副本是你的运营资产，不受升级影响。
2. 用 `event_manage create` 建 periodic 传感器事件，name 为 `task.<channelId>.<id>.agentmux`：

   ```json
   {"type": "periodic", "channelId": "<当前channel>", "text": "推进任务 <id>：agentmux 实例可能已空闲，capture 结果并验收", "schedule": "*/5 * * * *", "timezone": "Asia/Shanghai", "preAction": {"type": "bash", "command": "node \"${PIPICLAW_HOME:-$HOME/.pi/pipiclaw}/workspace/skills/agentmux-idle.mjs\" <实例名>"}}
   ```

3. **为什么必须 periodic 而非 one-shot**：传感器只有退出码、不能给自己改期。one-shot 到点若对方仍忙，preAction 静默但 one-shot 已消耗，不会再探测——卡死。periodic + preAction 才能轮询到 idle。
4. 带 preAction 的 periodic 最小间隔放宽到 5 分钟（无 preAction 是 30 分钟）。
5. 同时把 task 置 `blocked`、`wake` 设一个远期兜底点——传感器和实例双双失灵时，driver 仍会在 wake 到期把任务捞起。
6. 取回结果并验收后，**删除该 agentmux 事件**（`event_manage delete`）。任务闭环时 `task_manage done/cancel` 也会顺带清理 `task.<channelId>.<id>.*` 残留事件。

## 常见错误

- 委派后既不设 wake 也不建传感器 → 工作凭空消失，只能靠用户想起来问。
- 为分解而分解：拆出一堆两行的子任务 → 徒增 attempt 和调度开销。
- worktree 子任务的成果没有 review/merge 就 done 父任务 → 成果留在孤儿分支里。
- 在 task 正文里忘记记实例名/worktree 位置 → 下一回合醒来不知道去哪收结果（task 文件是唯一真相，别依赖上一回合的记忆）。

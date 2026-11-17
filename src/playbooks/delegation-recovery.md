---
name: delegation-recovery
description: 委派失败、卡顿、lost、续接或清理。
requires-tools: subagent_run
order: 62
---

# 委派恢复与生命周期

仅在失败、卡顿、lost、续接或清理时读取。先 subagent_run op=show 查真实 argv、警告、版本、stderr 和产物，再判断；不要把所有异常都变成重派。

| 现象 | 下一步 |
|---|---|
| 外部连续 10 分钟无输出 | 运行时报告可能卡住，task 也收到输入；正常长测试可继续等，确实卡死再 cancel，缩小范围/换方法/换执行者。耗时长本身不是取消理由 |
| 供应商瞬时错误 | 内置 worker 自动重试、可切备用模型，不为此另开重复 run |
| daemon 重启后 lost | 内置 run 判 lost；外部通常继续，但启动信息未落盘也可能 lost。lost 表示结局未知，先查产物和目标状态再重派；≈ 重连耗时为估算 |
| 需要取消 | subagent_run op=cancel，之后无完成唤醒。用户 /stop 和 task_pause 不取消已派发工作；取消任务会取消其在途工作 |
| 要继续已结束外部工作 | follow_up 仅支持有 session id 的 claude-code/codex-cli/cursor-cli/antigravity-cli，生成新 runId，归发起续接频道 |

目标未变、反馈局部且旧上下文可靠时续接只给增量；换方向、反复陷于错误假设或要独立判断就重开，带上仍有效证据。内置/exec 不支持续接，角色 command/model/shell 改过也须重开。

## 容量、结果与工作树

subagent_list 是整个工位快照，其他频道标 started in <频道>。每工位最多 6、宿主共 20 个运行中 run；满额等已有结果，不取消有用工作腾位。频道忙时结果可合并唤醒，逐条处理，全部无需跟进才回 [SILENT]。

运行时 worktree 位于 .git/pipiclaw-worktrees/<runId>，分支 pipiclaw/<runId>。无改动立即回收；合并后干净工作树在父任务关闭或到期时回收，未合并改动保留并提示。手工建的工作树自行清理；不为解除租约删别人的工作树，先按 runId 查状态。

重要产物留目标 checkout。run 与运行时产物结算满 30 天按日清理，长期证据另存。文件存在、状态 completed、执行者声明都不是最终检查证据，按原始要求核实后交付。

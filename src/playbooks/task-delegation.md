---
name: task-delegation
description: 把工作拆成多个任务（task）、委派子代理（subagent），或交给外部 agent 工具之前。
requires-tools: task_manage, subagent
priority: 45
---

# 任务分解与委派

只拆真正可分离、可独立验收的工作。两三步顺序操作留在一个 task，避免调度和 attempt 开销。

## 拆分任务

任务之间没有父子或依赖字段，每个任务独立按自己的 DoD 收尾。需要表达先后次序时，把它写进后继任务的 `goal`/`manual`（"在 <前置任务> 完成后再开始"），或用 `wake` 把它排到前置任务预计完成之后。

## 配置 subagent

不需要预先配置：不传 `agent` 时给 `systemPrompt` 即可发起委派，`workspaceDir/sub-agents/` 为空不影响这条路径。若需要可复用角色，把 Markdown 配置放入该目录；runtime 只加载实际存在的配置。仓库提供 explorer、researcher、reviewer、verifier、git-committer 五份可复制模板，见 `examples/sub-agents/`。选择明确适合的配置 agent；没有时使用聚焦的 inline `systemPrompt`。task 描述必须包含目标、范围、相关路径、约束、验收方法和返回格式，因为子代理看不到主对话。

执行预算用 `effort` 三档:`quick`(窄查找)、`standard`(默认)、`deep`(长程分析);精确的轮数/调用数/墙钟数值只在 workspace 配置的 frontmatter 里调,调用时不必给。上下文注入用 `context`:`none`(默认,完全隔离)、`session`、`relevant`。进程内 subagent 同回合同步返回,不需要回访事件；主 agent 负责验收结果和更新台账,子代理不驱动 task/event 台账。触顶时子代理会收敛输出已完成的结论而不是整段丢弃,但预算仍然是真实上限,不要依赖它兜底过大的任务。

独立验收必须 `purpose: verify` + `taskId`,见 `task-closeout.md`。

## 产物契约与回传预算

每次委派都会在 `channelDir/subagent-artifacts/<runId>/` 下建产物目录,子代理的完整输出总会落盘到该目录的 `output.md`,与 `returns` 无关。回传给父代理的文本超过大小预算时会被截断,附上 `output.md` 的绝对路径——父代理判断值得保留的内容,按需 `read` 全文,再决定是否经 `memory_manage` 提炼为记忆。产物目录不自动清理,由父代理负责闭环:任务收尾时决定保留还是删除。

需要子代理把主产出写成文件而不是回传整段文本时传 `returns: "artifact"`,子代理需以 `ARTIFACT: <filename>` 结尾；忘记该标记时会自动降级为纯文本模式。

## 文件系统隔离

没有。子代理默认与主代理共享同一个 checkout，只隔离对话上下文。需要在独立检出上作业时，在宿主侧自行 `git worktree add`，把该路径作为 `workingDirectory` 传给子代理（它是子代理的 shell cwd 与相对路径根，必须已存在），并自己负责 review、merge 与清理。`purpose: verify` 的 attestation 会绑定该目录的 git 产物状态，后续 `task_manage verify` / `done` 也在同一目录复算。

## 外部 agent 工具

Pipiclaw 不内置或假设第三方 agent 工具的命令、状态 JSON、检测脚本。如何启动、inspect、capture、steer 由用户安装的可执行文件和 workspace skill 决定。

runtime 只规定长程委派的恢复纪律：

1. 在 task 正文记录工具、实例标识、工作目录/分支、预期产物和验收方法。
2. `progress` 置 blocked，并设置合理 wake。
3. wake 后按用户 skill 检查状态；未完成则更新证据和 wake，完成则取回、review、验证并推进。
4. 如确需条件触发，按 `event-scheduling.md` 使用用户提供的稳定检测命令；不要临时复制未知脚本，也不要把第三方协议写进 runtime playbook。
5. task 闭环前清理临时事件和外部实例。

任何委派都不能转移最终交付责任。父代理必须确认成果已进入目标 checkout，而不是只停留在外部实例或口头报告中。

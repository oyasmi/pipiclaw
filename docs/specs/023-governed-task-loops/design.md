# 023 — Governed Task Loops

## 目标与范围

在 022 的原生 task driver 之上完成四项能力：P1.5 结构化验收与独立 verifier、P1.6 丰富 control/state、P1.7 预算/升级/副作用门禁，以及 P2.8 父子依赖与 worktree 隔离。本轮明确不实现 P2.9 自动运营/可观测控制台和 P2.10 skill promotion。

设计目标不是让模型记住更多 SOP，而是把“能否继续、能否完成、是否获准做外部动作”尽量变成 deterministic gate；模型只在门禁允许后承担需要判断与创造力的工作。

## 数据模型

task 仍是一个 Markdown 文件，status/wake/recurrence 继续兼容；新增单行 `control` JSON v1：

- dispatch：priority、deadline、nextAction、lastOutcome、blockedReason；
- graph：parent、dependsOn；
- execution：isolation、worktree path/branch；
- effects：sideEffects、externalApproval、approvalBy/approvedAt；
- budget/usage：attempts、tokens、costUsd、wallTimeMinutes；
- verification：mode/status/runId/evidence/bodyHash/checkedAt。

旧 task 没有 control 时继续按 legacy/evidence-only 行为工作。control 存在但不可解析时 fail-open，让 driver 唤醒修复，`task_manage` 则 fail-closed，避免覆盖坏数据。

## 驱动与治理顺序

```text
scan (zero token)
  → closed? skip
  → deadline/budget exceeded? enqueue escalation → status=escalated
  → dependency missing/cancelled/escalated? enqueue escalation
  → dependency unfinished? skip (zero attempt/token)
  → wake not due? skip
  → priority/deadline ordering + cooldown
  → atomically claim attempt
  → enqueue TASK_DRIVER run
  → account actual run tokens/cost/wall time (active or just-archived task)
```

队列拒绝时回滚 attempt claim。driver event 明确告诉 agent 遵守 control、外部授权和 verifier 协议。硬门禁失败不会用另一个普通工作回合“再试试看”。

## 验收协议

新 task 默认 independent：

1. 正文 Verification 写可执行检查，DoD 写结果标准。
2. maker 完成后调用 `subagent(purpose=verify, taskId=...)`。
3. verifier 不获得 write/edit，运行前后比较 git status，并必须最后输出 `VERDICT: PASS|FAIL`。
4. runtime 直接写 `<channel>/tasks/.verifications/<hash(runId)>.json`，包含 task body hash、输出 hash、模型、证据与 workspaceChanged。
5. 主代理调用 `task_manage verify` 导入。taskId/bodyHash/workspaceChanged 任一不符即拒绝。
6. 后续 progress 会把 PASS 置回 pending；`done` 再检查 DoD/Verification 中未勾选的 acceptance checkbox、PASS 与当前 body hash。

这提供的是独立上下文、独立角色和可审计 attestation，不声称达到密码学意义上的进程隔离。bash 仍可运行测试，因此用 workspace snapshot 检测 verifier 修改。

## 副作用授权

`sideEffects=external` 自动变为 `externalApproval=required`。agent tool schema 不暴露 granted，内部 API 也拒绝自授予。只有用户直接发送 `/tasks approve <id>`，runtime 才记录 granted、approver、timestamp 与当前 task body hash。后续 progress/control/body 变化会失效或在 done 时判 stale，避免一次授权跨动作/周期复用。`done` 是最后一道门禁；system prompt 同时要求实际外部动作本身也必须在授权之后。

## 分解与隔离

- 创建/set 时相关 task 必须存在；parent ancestry 与 dependsOn execution graph 分别做可达性检查，拒绝自指和各自的 cycle。父任务可以依赖自己的 child，这是正常的 join 语义。
- driver 只运行 dependencies 全 done 的 task；done 同时门禁 dependencies 和 unfinished children。
- `subagent isolation=worktree taskId=...` 仅支持 host sandbox，从指定 host checkout 的 committed HEAD 创建 `pipiclaw-task/<task>/<run>` 分支，目录固定在 channel task-owned `tasks/worktrees/` 下。
- 可显式复用 task-owned worktree；路径逃逸被拒绝。runtime 原子写回 path/branch，父代理负责 review、merge、cleanup；不在子代理结束时自动删除，以免丢失成果。
- Docker 模式明确报错并给出 `isolation=shared` / host 的下一步，不做表面隔离。

## 可见性与诊断

`/tasks` 与 `<task_agenda>` 展示 priority/deadline/attempt/verification/relations/nextAction。doctor 增加 invalid control、预算/截止、缺失关系、external approval、stale verification 和 missing worktree 检查。这里是已有视图的增强，不是 P2.9 的自动运营系统。

## 不变式

1. 等待 dependency/wake 不消耗 LLM 或 attempt。
2. 超硬预算、过期 deadline、terminal dependency 不进入普通工作循环。
3. independent task 没有 current PASS 不能 done。
4. agent 不能自行授予 external action。
5. parent 不在 child 未闭环时完成；dependency 不在 prerequisite 未 done 时执行/完成。
6. worktree 创建失败时不退化成未经声明的 shared write。

## 测试

- control parse/patch/budget 与跨 archive usage accounting；
- driver dependency wait/ready、attempt claim、budget/deadline escalation；
- verifier attestation、independent done gate、relation cycle/child gate、external self-grant rejection；
- runtime `/tasks approve` 审计；
- 真实临时 git 仓库的 worktree 创建与返回 metadata；
- 全量 typecheck/lint/deadcode/test/build。

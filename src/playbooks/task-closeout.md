# 任务验收与闭环手册

> Pipiclaw 内置手册，随版本发布，只读。这里写的是 runtime 的硬约束与标准做法；个人化的偏好和团队策略写进 workspace `AGENTS.md`，或沉淀成 workspace skill。

闭环不是“把 status 改成 done”，而是走一串确定性门禁。runtime 会拒绝任何抄近路；理解每道门在防什么，就不会和它对抗。

## 生命周期（验收段）

```text
in-progress → candidate → verifying → PASS → done
                              └────→ FAIL → in-progress（修复后重新 candidate）
```

## 第一步：勾选 DoD / Verification

- 只有证据支撑的项才打钩（在正文里勾 `- [x]`，证据写进 Current Cycle note 或该项后面）。
- `candidate` 和 `done` 都会拒绝存在未勾选 checkbox 的任务，并列出未勾项。
- **不要虚勾**：独立 verifier 会逐项核对，虚勾只会浪费一轮验收。

## 第二步：candidate（申请独立验收）

全部 checkbox 勾完后调用 `task_manage candidate`（`note` 写候选理由与证据摘要）。它把任务置为 `verifying`、清空 wake；driver 的**下一次唤醒是 checker-only 回合**——那个回合只做验收，不要继续修改实现。

## 第三步：checker-only 回合（验收怎么做）

1. 委派全新的验收子代理：`subagent` 带 `purpose: "verify"` 和 `taskId: <id>`（purpose=verify 必须带 taskId）。`task` 里写清要核对的 DoD/Verification 各项与检查方法。
2. verifier 的硬约束（runtime 强制）：没有 write/edit 工具；可以用 bash 跑测试和检查；运行前后 runtime 对比 workspace——**只要改了工作区，attestation 作废**；输出最后必须是 `VERDICT: PASS` 或 `VERDICT: FAIL`。
3. runtime 把 attestation 落到 `tasks/.verifications/`，绑定 task body hash；在 host Git checkout 上还绑定 artifact subject（HEAD、staged/unstaged diff）。
4. 主回合用返回的 runId 调 `task_manage verify`。它会拒绝：runId 不属于该任务、verifier 改过 workspace、task 正文在验收后变过、代码/产物在验收后变过（subject 不符）。被拒 = 重跑 verifier，而不是想办法绕。

**FAIL 之后**：用 `task_manage progress` 记录失败原因、status 置回 `in-progress`，修复，重新走 candidate。任何 progress 或正文变化都会让旧 PASS 失效——这是特性，不是 bug。

## 外部副作用授权（sideEffects=external）

发布、发消息给第三方、改外部系统等动作走单独的闸门：

1. `sideEffects: external` 自动要求 `externalApproval: required`。**agent 无法自授予**——`task_manage set` 传 `externalApproval: granted` 会被直接拒绝。
2. 先把拟执行的动作准备好、描述清楚发给用户，`progress` 置 `awaiting-user` + 合理 wake。
3. 用户亲自发 `/tasks approve <id>`（唯一入口，runtime 记录审批人/时间/当时的正文 hash）。
4. **获批后：先执行动作，然后直接 `done`。中间不要再 progress**——progress 会改正文、使授权失效（approval 绑定正文 hash），届时 done 会要求用户重新 approve。执行结果写进 done 的 `summary`/`evidence` 即可（done 本身不需要先 progress）。

## done / cancel

- `task_manage done` 需要 `summary` + `evidence`（可选 `residualRisk`）。它一次完成：门禁校验（checkbox 全勾、dependsOn 全 done、无未闭环 child、外部授权新鲜、independent 模式有当前有效 PASS）→ 记录收尾 → 一次性任务移入 `archive/`、周期任务留原地 → 清理任务名下残留事件（周期任务保留 canonical `.schedule`）。
- `evidence` 写具体可查证的事实（跑了什么命令、看到什么输出、谁确认的）；“应该没问题”不是证据。
- 放弃的任务用 `task_manage cancel`（带 `reason`），不要伪装成 done。cancel 会归档并清掉**全部** `task.<channelId>.<id>.*` 事件（含 `.schedule`，即周期任务退役）。
- 闭环回合顺手做复盘：本轮返工教训写回任务 Manual（周期任务下一轮直接受益）。

## 验收模式的选择

新任务默认 `verification.mode: independent`。确实不值得独立验收的轻量任务（如纯记录性工作），create 时设 `control.verificationMode: "evidence"`，则跳过 candidate/verify，凭 done 的 evidence 收尾。拿不准就保持 independent——它防的正是“做的人自己给自己打分”。

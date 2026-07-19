---
name: task-closeout
description: Before verification, importing a verdict, external approval, or completing/cancelling a task.
requires-tools: task_manage
priority: 42
---

# 验收、外部审批与闭环

## 独立验收

1. 只在证据成立后勾选 DoD / Verification checkbox。
2. 全部勾完，调用 `task_manage candidate`；该动作追加候选 note、置 verifying、清 wake，本身就是本回合 checkpoint。
3. checker-only 回合委派全新 subagent：`purpose: verify`、`taskId: <id>`，明确逐项检查方法。
4. verifier 没有 write/edit；bash 只运行明确的非变更检查。Git checkout 上 runtime 会比较前后状态，变化会使 attestation 无效；非 Git 目录没有完整变更检测，不能把 bash 当成结构性只读沙箱。结尾必须是 `VERDICT: PASS` 或 `VERDICT: FAIL`。
5. 主回合以 runId 调 `task_manage verify`。attestation 绑定 task body hash；Git checkout 上还绑定 HEAD/staged/unstaged/untracked artifact subject。

FAIL 后用 progress 记录失败证据、status 回 active，修复后重新 candidate。不要让 verifier 顺手修实现。

## 外部副作用

`sideEffects: external` 要求用户通过 `/tasks approve <id>` 授权；agent 不能自授予。授权绑定 task body hash，批准后不要再 progress 或编辑正文。

只做 external、无需 independent verification 时：准备动作 → progress 置 waiting 并请求审批 → 用户 approve → 执行动作 → 直接 done。

## independent + external 的正确组合

这两个门都存在时，严格按以下顺序，避免 hash 相互失效：

1. 完成实现、预演外部动作、勾选 acceptance items。
2. candidate → verifier → `task_manage verify` 得到 PASS。
3. 不改正文；用 `task_manage set status=waiting wake=<合理时间>` 等待，并请求用户 `/tasks approve <id>`。这里不能 progress。
4. 用户批准后，driver 在 wake 到期接续；再次确认 PASS、approvalBodyHash 和当前产物仍新鲜。
5. 执行已批准的外部动作，然后直接 done；结果写入 done 的 summary/evidence。

不要在 candidate 前审批（candidate 会改正文），也不要 PASS 后 progress（会使 PASS 失效）。批准范围或实现改变时，诚实重走相应门禁。
如果 wake 到期但用户尚未批准，只用 set 调整 waiting/wake 并提醒，不写 progress note。

建档时 acceptance items 应描述外部动作的**准备质量**（内容、目标、参数、预演、回滚方案），而不是要求在 candidate 前已经发布/发送。最终外部结果由审批记录和 done evidence 证明；否则“先执行才能勾选”会与“先验收、审批才能执行”形成循环。

## done / cancel

`task_manage done` 需要 summary 和可查证 evidence，可附 residualRisk。它检查 checkbox、依赖、child、外部授权、独立 PASS，再记录收尾、清理临时 task events；一次性任务归档，有 `schedule` frontmatter 的周期任务算出下一次 `wake` 并原地睡眠。

放弃用 `cancel` + reason，不伪装 done。cancel 要求先处理 child，随后归档并删除全部 task-owned events。

完成结论必须来自证据：具体命令、测试结果、review、外部确认或明确的未运行理由。“看起来可以”不是 evidence。

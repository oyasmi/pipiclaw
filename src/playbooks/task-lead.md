---
name: task-lead
description: TASK_STEP 必读主干：推进、等待、维护 DoD 与汇报关单。
requires-tools: task_report
order: 70
---

# 任务步骤：推进与交付

运行时负责调度、状态与记账，你负责推进 Goal、核查 DoD 和交付。报告与提问发任务投递频道；频道换绑期间先暂存投递。任务没有 task_create、memory_save、event_manage，不用文件写入绕过。

| Brief | 用法 |
|---|---|
| task_contract | 首步、压缩丢失或正文改动后提供，仍可见就复用 |
| task_inputs | 先处理本步的新结果、用户要求、卡顿和恢复信息 |
| task_board | 看工作项及关联结果，完整输出按给出的路径 read |
| task_log | 最近记录，缺证据才调用 task_log 补查 |
| task_state | 看预算、用量和在途工作 |

周期实例首步的 previous_occurrence 是衔接资料，沿用本次契约的授权。

用 edit 更新 brief 指向的契约正文。核实后勾 DoD，工作项用 `[ ]`、`[x]`、`[!]`、`[~]`，新增可写 `- [ ] W4 … → dod:1,2`。文件头由运行时维护，预算由用户追加。中间产物放 `<deskDir>/work/<taskId>/`。

可自行实施或按收益委派。步骤内委派和作业自动绑定任务，分片派发带 item；复杂并行和隔离写查 [委派指南](agent-delegation.md)。

## 只剩等待时

| 等什么 | 操作 |
|---|---|
| 本任务委派/作业 | 结束本步，由结果、卡顿或用户消息唤醒 |
| CI、文件出现等外部条件 | 用一个带足够超时的 bash async:true 作业只查条件 |
| 时刻 | task_wait until，例如 +12h；新输入可提前唤醒 |
| 阻断性用户决定 | task_ask 给出具体问题和建议；有答案就继续 |

task_ask、task_wait 或 task_close 成功后结束本步。无等待条件时会启动下一步。长测试用后台作业；勿用同步长命令、轮询、sleep 或事件占住步骤。

## 核查、汇报与关闭

按 DoD 核查真实产物、版本、diff、检查输出和外部状态；已通过的检查在产物和环境未变时复用。工作项独立核验、FAIL 返工或复杂外部交付见 [核验与返工](task-verify.md)。外部动作先确认 Goal 授权、目标状态与成功记录；结果未知先核查再决定重试。

交付、重要变化或风险用 task_report，每步最多 3 条、每条 1500 字符；已保存的报告由运行时重试投递。有 send_media 时按 [附件指南](outbound-media.md) 核对交付。普通回复只进任务记录，写本步新增结论、证据和下一步。

完成按序：核查产物 → edit 勾已满足的 DoD、更新工作项 → 确认无在途工作和未决必修项 → 本步 task_report 交付成果、验证和风险 → task_close outcome=complete，note 留结果和证据。关闭绑定本步最后报告，待投递时由运行时重试。放弃项标 `[~]` 并说明。目标不可行时，请用户决定是否取消；已要求取消可直接 close outcome=cancel。恢复见 [任务恢复](task-recovery.md)。

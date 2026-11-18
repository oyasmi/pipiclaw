# Playbook 短路径改进方案

接续[提示词与缓存评审](2026-11-18-prompt-playbook-cache-review.md)的第 3 项。把低成本、有确定契约的操作交给现有工具；当机制知识会改变下一步、授权判断或验收时读对应指南。保留 Pipiclaw 的工程习惯：行动前定位真实范围，交付前核实证据，只问会阻止进展的缺项，达到验收就收尾。

## 改动顺序

| 批次 | 实施位置与改法 | 验收重点 |
| --- | --- | --- |
| A. 一次提醒 | `Working Contract` 把「非平凡操作」换成明确读点。`event_manage` 工具说明就地给一次提醒的最短调用。`event-scheduling.md` 的目录描述聚焦周期、改期与条件，正文照常保留一次提醒、更新和退役说明。 | 创建定义和真实收件频道正确，时区明确，成功后确认。周期、删除及整体更新的既有入口可发现。 |
| B. 普通委派 | 在 `subagent` 说明与角色目录集中给自足的交接顺序。把角色目录中笼统的「非平凡先读」换为具体触发词；更新普通和 inline 指南的互相链接。 | 选到了可执行且匹配权限、输入和成本的配置角色；交接足以独立执行，必要时先读隔离或核验说明。 |
| C. 任务步骤 | 新增由 `task_report` 门控的短任务执行段，并把 brief 里的固定步骤纪律移入这一段。保留 `TaskBrief` 的契约、状态、输入回执和恢复路径；把 task-lead 的强制首读改成按当前动作选择。 | 首步、压缩、恢复都具备必要约定。日常等待、提问、汇报和关闭走原有工具，未知外部结果先核对，复杂任务照常读指南。 |

每批独立验证并保留可单独回退的变更。先做 A，目标是把成功的一次提醒由「读 → 调用 → 确认」缩到「调用 → 确认」。用事件的完整定义和投递状态判断完成。调整 `immediate` 枚举和 `timeoutMs` 告示可紧随 A 单独做，保留运行时现有校验和磁盘数据契约。

## 建议给模型的指令

**常驻执行约定**

> Use the tool contract directly for familiar operations with clear inputs and a checkable result. Read the matching runtime guide before unfamiliar mechanisms, cross-turn work, complex external effects, or recovery. Reuse guidance still visible in context.

为一次性工作加一个收尾条件。用户指定的验证已通过、目标产物和输入没有变化时，交付现有结果。只有出现失败、新改动或明确缺口才增加验证。工位目录与 cwd 不同时，先用回合的两个绝对路径；归档任务按已知 ID 走支持归档的查询入口，取得正文路径后直接读取。

**`event_manage` 的直接入口**

> For a one-time text reminder with a resolved time and timezone, create a `one-shot` with `text` and an offset-bearing `at`. Confirm only after creation succeeds. Read `event-scheduling.md` for recurring events or updates. Read the matching guide for a condition (`preAction`) or task template.

常见反例包括「每周一」需要周期分支、「等 CI 通过」需要区分条件门控与已有完成唤醒、「把原提醒延后」需要先 `show` 并整体更新。若日期或时区可从用户指定值和当前上下文确定，直接执行。调用只剩无法推知的关键字段时再问。

**`subagent` 交接入口**

> For a known eligible role, pass a self-contained task: result → verified evidence → constraints → paths → acceptance. Check returned artifacts against the goal. Read the delegation guide for parallel writes, worktrees, independent verification, or uncertain authority. Use the recovery guide for failed, lost, or resumed runs.

保留角色目录的名称、用途、读写范围和可用性。目录提示够用时直接选角色。涉及仓库隔离、附件支持不明、关键结果需独立核验，或 fallback 到 inline 时按现有指南读到足以决策。让 `delegation-inline.md` 单独说明必要的默认上下文、白名单、写入声明和验收，读到普通指南仍可复用已知道的内容。

**仅任务会话可见的最短约定**

> Work within the current Goal and DoD. Resolve new inputs first, then make verified progress. If only bound work remains, end the step and let settlement wake it. Use `task_wait` for a time and `task_ask` for a blocking user decision. Report material results through `task_report`. Complete only after verifying acceptance, updating the contract, checking pending work, and reporting delivery. Record the evidence and next action in the final step note. Check real state and prior receipts before retrying an external effect with an unknown outcome.

附一行 `task-lead.md` 的具体入口，用于多工作项、独立验收和多步外部交付。暂停、预算和重启继续由 `task-recovery.md` 解释。任务工具和现有运行时门禁照常执行。避免在 system、brief 和手册入口全文重复步骤规则。任务的 `task_contract`、工作目录和恢复指针属于每个任务的事实，继续由运行时提供。

## 验证和停止条件

- A 用 `E-schedule-01` 配对看首次正确 `create`、真实投递和模型请求数，同时复用事件模板或传感器场景检查该读的指南仍能发现。B 用 `A-route-01`、`D-verify-01` 对照常规派发和核验分支。C 用 `T-ask-01`、`T-horizon-01`、`T-job-01` 核对唤醒、用户答复、验收和交付。以实际操作和证据评分，读取哪份指南仅作诊断。先过现有正、负与等价控制。 [评测指南](../evals.md)
- 短路径的一个有效标准是常用场景少一次模型请求，首次有效操作、权限与目标完成率保持稳定。额外重试、投递错误、漏读授权或验收标准均为退回信号。任务侧还要统计系统约定对多轮输入的占用，判断省下的阅读和往返能否覆盖常驻开销。
- 加入 `U-desk-cwd-01` 和 `M-compaction-01` 作为收尾对照。在本轮抽查中两例都已写出合格产物，后续定位或重复验证耗尽回合。新文案先验证是否能在默认预算内完成最终回复，保留当前路径既有的正确性断言。[本轮证据](2026-11-18-prompt-playbook-cache-review.md#前两项实施与验证)
- 固定工具集与前缀测冷启动、暖会话和压缩后恢复。保留 `read` 和现有目录门控，暂缓工具发现接线、分类器、跨会话加载标记与 Codemode。需要试验低频工具的延迟声明时，从 `subagent_inline` 单独比较，观察激活前后前缀、预算和下一步操作是否正常。[OpenAI 缓存实践](https://developers.openai.com/api/docs/guides/keep-prefix-unchanged) · [OpenAI 的渐进加载实践](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)

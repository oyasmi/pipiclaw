# 设计记录

这里保存 spec 050–067 的设计取舍和实施证据，供修改源码、追溯决策时参考。当前用法见[专题手册](../README.md)，编号 050 之前的设计见[历史归档](../archive/README.md)。设计中的旧字段、路径和未采用方案不代表当前功能。

## 保留的设计

| 编号 | 设计 |
|---|---|
| `050` | [记忆 v2](./050-memory-v2/design.md)：一事一文件、生成索引、按天日志与单一反思 pass |
| `051` | [长程任务循环](./051-long-horizon-task-loop/design.md)：契约、循环日志、等待票、任务会话与预算（cycle、`schedule`、验收门禁等部分已被 052 取代；等待票与 `task_step_end` 已被 064 取代） |
| `052` | [任务 v5：负责人模式](./052-task-lead/design.md)：一次性项目、工作项与委派、事件模板承载周期，已实施（等待票、`task_step_end`、`task_update` 与借用频道队列的执行方式已被 064 取代） |
| `053` | [对外文案](./053-user-facing-copy/design.md)：按受众分渠道、统一界面术语、错误必带下一步；已实施（[实施计划](./053-user-facing-copy/plan.md)） |
| `054` | [代码组织重构](./054-code-organization/design.md)：单向分层、模块归位、`npm run arch` 机器检查与大文件拆分；无行为变化，已实施（[实施计划](./054-code-organization/plan.md)） |
| `055` | [pi 1.2.0 升级](./055-pi-1.2-upgrade/design.md)：持久化上下文、工具装配、安全备用重试、OAuth 安装身份与迁移/回退；离线实施完成（[实施计划](./055-pi-1.2-upgrade/plan.md)、[验收记录](./055-pi-1.2-upgrade/acceptance.md)），真实发布验收待执行 |
| `056` | [评测日常工作流](./056-eval-workflow/design.md)：小集合快速检查、摘要与明细、评分边界及场景契约维护；已实施（[验收记录](./056-eval-workflow/acceptance.md)） |
| `057` | [无人参与评测闭环](./057-autonomous-evals/design.md)：评分器正反例校验、客观验收、封存证据重放和兼容参照；已实施（[验收记录](./057-autonomous-evals/acceptance.md)） |
| `058` | [Dot](./058-dots/design.md)：把助手个体从频道中独立出来，频道通过绑定指向 dot；删除 project 与频道 id 路径转义；原迁移脚本已退役，参见 060；已实施（[实施计划](./058-dots/plan.md)，实施记录在设计文档末尾） |
| `059` | [默认个人助手](./059-default-assistant/design.md)：默认接入已实施；dot 布局与脚本方案由 060 接续 |
| `060` | [Desk：一个助手，多个工位](./060-desk/design.md)：工位目录直接位于 workspace，统一默认初始化，无运行时迁移兼容；已实施（[验收记录](./060-desk/acceptance.md)）；[追加修复](./060-desk/followup.md)已实施 |
| `061` | [渠道层与 Web API](./061-channel-plane/design.md)：钉钉与遵循 OpenAI Responses API 的 Web API 并列为两个渠道，`Transport` / `Ingress` 契约与结构化回合输出，`channel.json` 分段与开关，TUI 改为 Web API 客户端；已实施，真实部署上线待执行（[实施计划](./061-channel-plane/plan.md)、[验收记录](./061-channel-plane/acceptance.md)） |
| `062` | [Responses 上下文与响应保存](./062-responses-context/design.md)：请求历史、响应链与服务端会话，响应保存独立于上下文选择 |
| `063` | [共享技能目录](./063-shared-skills/design.md)：工作区与用户共享来源、同名优先级；已实施（[验收记录](./063-shared-skills/acceptance.md)） |
| `064` | [任务车道](./064-task-lane/design.md)：独立任务执行、运行时推导状态与聊天控制；已实施（[计划](./064-task-lane/plan.md)、[验收](./064-task-lane/acceptance.md)、[修复记录](../reviews/2026-10-29-spec-064-task-lane-fixes.md)），迁移演练与真实部署验收待执行 |
| `065` | [个人交付聚焦与结果保留](./065-personal-delivery-focus/design.md)：产品范围、作业 7 天与委派 30 天保留期；已实施 |
| `066` | [Cursor CLI harness](./066-cursor-cli-harness/design.md)：外部委派、协议解析与续接；已实施（[计划](./066-cursor-cli-harness/plan.md)、[验收](./066-cursor-cli-harness/acceptance.md)），真实 CLI smoke 与流协议核对待执行 |
| `067` | [工具执行与委派结果回收提速](./067-execution-latency/design.md)：完成观察、结果回流与共享快速窗口；范围内实现、离线门禁与定向真实模型验收已完成（[计划](./067-execution-latency/plan.md)、[验收](./067-execution-latency/acceptance.md)），使用官方 SDK，分段调度未采用 |

050、051 已完成的实施清单也保存在归档中（[050](../archive/specs/050-memory-v2/plan.md)、[051](../archive/specs/051-long-horizon-task-loop/plan.md)）。

## 如何判断当前行为

遇到描述冲突时，按以下顺序判断：

1. 当前代码和测试
2. `README.md` 与 `docs/` 顶层专题手册
3. 当前版本的 `src/playbooks/`
4. spec 与历史归档

设计记录解释当时的问题、约束与方案取舍，可能包含旧路径、已删除字段和被取代的机制。实现落地后的准确用法应写进顶层手册，不要把历史方案当成待办继续实施。

## 维护规则

- 新机制先在 spec 中记录问题、原则和取舍，实现后同步更新对应顶层手册。
- 过时的 spec 移到 `docs/archive/specs/`，不删除；保留原编号目录和文件名，编号不复用。
- 同步更新归档索引及引用链接；仍影响当前实现的取舍应保留在对应设计中。
- Spec 中的完成状态不证明当前代码仍保持该行为，重大版本变更后以测试和当前架构文档复核。
- 不从 spec 直接链接用户 Quickstart；用户路径必须经过 `README.md` 或 `docs/README.md`。

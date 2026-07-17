# 遗留问题清单（整理自 0.8.0～0.8.5 历史评审，核对基线 0.8.7）

本文档取代 `docs/refer/` 下此前 9 份评审文档（slash-commands-review-0.8.1、autonomy-review-0.8.0、autonomy-test-report-0.8.0、autonomy-fixes-and-test-overhaul-0.8.0、autonomy-blindspots-0.8.0-round2、architecture-review-0.8.3、memory-management-review-0.8.5、hermes-learning-insights、pipiclaw-vs-hermes）。这些评审在当时都经过 triage，只处理了性价比最高的问题；本文档是对剩余问题的一次重新核对——逐条确认在当前 HEAD（0.8.7）是否仍然成立，过滤掉已修复和已过时的部分，只保留仍然重要且有修复价值的。

核对方法：读代码确认具体断言（函数、文件路径、行为）在当前 HEAD 是否依然真实，不重新做设计评审。

## 建议保留处理的问题（按优先级）

### 1. 独立验收可被伪造证据绕过（严重，安全/信任链）

`task_manage done`/`candidate`（`src/tools/task-manage.ts:670-688`）和 `/tasks doctor`（`src/runtime/task-commands.ts:534-543`）只核对任务文件里 `control.verification` 的 JSON 字段是否自洽，从不反查 `.verifications/<hash>.json` attestation 文件是否真实存在。agent 自己持有 `write`/`edit` 权限，可以手写一段"已通过验证"的 JSON 直接闯关，doctor 事后巡检也查不出来。

建议：`done`/`candidate`/`doctor` 复用 `verify` 路径里现成的 `readVerificationAttestation`，成本很低。

来源：autonomy-blindspots-0.8.0-round2 发现1。

### 2. 周期任务开新周期后验收门形同虚设

`startTaskCycle`（`src/shared/task-ledger.ts:308`）清空 control 但不重置 DoD/Verification 里上一轮留下的 `- [x]`。新周期一开局，"未勾选拦截"这道最基础的门看到的就是 0 个未完成项，`candidate` 直接放行——哪怕这一轮什么都没做。

建议：`startTaskCycle` 顺手把新 Current Cycle 里的勾选框机械转回 `- [ ]`。

来源：autonomy-blindspots-0.8.0-round2 发现2。

### 3. 单 channel 内任务调度无轮转，活跃任务可饿死其它任务

`TaskDriver.runOnce()`（`src/runtime/task-driver.ts:182-276`）只有跨 channel 的 round-robin，同一 channel 内部永远取排序靠前的第一个 ready 任务。一个"每轮都有新进展"的任务会一直重新赢得该 channel 唯一名额，同 channel 其它任务（包括已解锁的下游依赖）可能长期排不上号。

建议：加一个"上次唤醒的 taskId"记忆，下次跳过它优先找排序在它之后的 ready 任务。

来源：autonomy-blindspots-0.8.0-round2 发现3。

### 4. independent 验收作为所有任务的默认档，对调研/文书类任务是纯税负

`createDefaultTaskControl`（`src/tasks/control.ts:145`）默认 `mode: "independent"`，且未按任务是否产出可执行工件区分。一个"调研 X 并总结"的任务也要走完整的 candidate→子代理验证→verify→done 流程，多花至少一轮子代理调用和数分钟。

建议：产出代码/可执行工件时用 independent，其余默认 evidence（maker 自查 DoD），可在 create 时按 Verification 节内容判断或提示模型选择。

来源：autonomy-review-0.8.0 发现3。

### 5. 周期任务"一个文件 + 一个 canonical schedule 事件"双载体仍未合并

`recurrence` 字段目前只是给人看的字符串（`task-driver.ts:68`），没有真正的 cron 解析或 driver 原生周期触发。忘建/忘删配套事件、事件文本写错任务 id，仍是一类需要靠纪律和 doctor 才能压住的漂移故障源。

建议：让 `recurrence` 支持真 cron，driver 每分钟扫描时原生判断到点开新周期，退役 canonical schedule 事件整套机制。

来源：autonomy-review-0.8.0 发现2。

### 6. control JSON 损坏没有修复出口

`task-manage.ts` 里没有任何 `repair`/`reset` 类 action（已 grep 确认），control 一旦损坏，agent 只能手工重写这段人不可读的 20+ 字段 JSON，危险且易错。

建议：加一个显式 `task_manage repair`：保留正文与 status/wake，按默认值重建 control（用量归零、验收置 pending）。

来源：autonomy-review-0.8.0 发现4。

### 7. 记忆召回粒度仍是 section 级，不是 entry/bullet 级

`candidates.ts` 仍用 `splitH2Sections`/`splitH1Sections` 构造候选。一个关键词命中就把整个 section 拉进上下文；单条内容超预算时甚至整段都不注入，只提示"有 N 条被省略"。

建议：channel-memory candidate 细化到已有的 `m-*` bullet id 级别。

来源：memory-management-review-0.8.5 P1-1。

## 已确认修复（核对时在当前 HEAD 已验证不再成立）

- attempt 预算不再对"纯等待轮"计费——`finishTaskAttempt`（`src/tasks/store.ts:144-152`）对 silent 结果执行 `control.usage.attempts--`。（autonomy-review-0.8.0 发现1）
- 记忆维护调度器不再为历史频道复活完整 Runner——`bootstrap.ts:919-940` 已改为 `loadDetachedMaintenanceContext` 轻量磁盘加载。（architecture-review-0.8.3 发现2）
- `hasLiveLegacyCheckin` 兼容路径已全仓库删除。（architecture-review-0.8.3 发现5）
- 记忆维护的增量窗口问题已修复——`MemorySourceWindow`/`buildIncrementalMemorySourceWindow` 已实现，durable consolidation / growth review 都严格消费按 `lastConsolidatedEntryId`/`lastReviewedEntryId` 裁剪的窗口。（memory-management-review-0.8.5 P0-1）
- `forget` 已有 tombstone 机制（`src/memory/tombstones.ts`），不再是"从当前文件隐藏、原文仍可复活"。（memory-management-review-0.8.5 P0-2）
- growth review 失败不再被误记为成功 checkpoint——`PostTurnReviewRunResult` 判别联合类型已实现，`failed` 不推进 cursor。（memory-management-review-0.8.5 P0-5）
- `--print` 模式下内建斜杠命令静默喂给模型、DoD 无 checkbox 时验收闸门可绕过、TUI 下 approve 审批人恒为 unknown-user、IPv6 括号字面量绕过网络防护快速路径——4 项均已在 0.8.0 修复并有回归测试。（autonomy-test-report-0.8.0 发现 A/B/C/D，见 autonomy-fixes-and-test-overhaul-0.8.0）

## 判断为设计取舍/维护税，不建议列入修复清单

- ChannelQueue 住在传输层（`src/runtime/dingtalk.ts`）、`tools.json`/`security.json`/`settings.json` 三个配置文件未合并——纯架构收敛建议，不修不影响正确性，改动面较大，性价比上属于"有空再做"而非"该修的 bug"。（architecture-review-0.8.3 发现1、3）
- memory-management-review-0.8.5 里剩余的 P0-3（外部内容治理，已部分修复：`suppressAutomaticWrites` 已接入 growth review，但 secret/PII 扫描等更完整的 policy 尚未做）、P0-4（growth review 双写协议）、P1-2~P1-7、P2 系列（rerank 阈值、跨进程锁、metadata schema 等）——多为渐进式质量提升，没有具体故障场景支撑，工作量普遍偏大，本轮未逐条深挖，暂不纳入。
- hermes-learning-insights.md、pipiclaw-vs-hermes.md 是纯调研/对比文档，不含具体 bug 或修复项，其中"procedural skill 闭环""冷路径 session search""post-turn reviewer"等产品方向性建议如仍有价值，应作为独立的产品讨论重新发起，不适合放在遗留问题清单里跟踪。
- slash-commands-review-0.8.1.md 的发现（命令元数据收敛、忙时死代码、CLI 入口容错）未在本轮核对范围内，均为纯代码质量/一致性问题，无安全或数据风险，建议后续如需处理时单独评估，不纳入本次清单。

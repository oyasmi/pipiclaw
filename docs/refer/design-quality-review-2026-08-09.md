# 0.9.0 设计与代码质量维护评审

日期：2026-08-09
基线：`a695412`（0.9.0-beta.6），`npm run typecheck` / `knip` / 1096 tests 全绿
范围：全仓库设计方向、实现复杂度、技术债、架构承载力

---

## 结论

**方向没有偏。** `docs/design-philosophy.md` 的七条与实现是对得上的：真相在文件里、runtime 守不变量、自主有边界、记忆分层可遗忘、能力走显式契约、传输是端口。抽查 prompt manifest、memory gates、subagent lease、durable dispatch，都能看到设计意图被代码兑现，而不是只写在文档里。这一轮不需要重新标定目标。

**债集中在三处，全部可以靠删除和合并解决，不需要新增任何机制。**

1. 同一个"异步工作 + 完成唤醒"的语义被实现了两遍（job / subagent run），其中三块是逐行同构的重复；
2. 一个单用户自托管产品扛着 8 层永久执行的向后兼容，其中两处的注释自己写着 `FIXME(0.9.0)`；
3. 记忆元数据里有 7 个字段从来没有被任何代码读过，是按多租户形状建的模。

五条建议净减约 **700–900 行**，不引入新抽象层，不改变任何对外行为。按 F1 → F3 → F4 → F2 → F5 的顺序做，前三条互不阻塞。

各子系统当前体量（供判断投入产出）：

| 子系统 | 行数 | 说明 |
|---|---|---|
| memory | 6517 | 最大，但分层清晰、单元职责明确 |
| runtime | 6331 | `bootstrap.ts` 1569 + `dingtalk.ts` 1525 是两个体积失控点 |
| agent | 5461 | `channel-runner.ts` 1493 / 49 方法 |
| tasks（含 driver/commands/tool） | 5345 | 已经过 029/036/038 三轮瘦身 |
| tools | 4341 | 14 个 leaf tool + 2 个委派 tool |
| subagents | 4316 | 最新加入（spec 040） |
| security | 1783 | |
| tui | 1240 | |

---

## F1. 两套等价的 detached-work 生命周期 —— 合并重复的三块

**问题.** 后台 bash job 和 sub-agent run 是两个独立机制，这没问题；但它们各自实现了同一份"唤醒认领"协议，而且形状还不一样，读代码的人必须两边都读完才能确认语义一致。

证据：

- `src/agent/job-manager.ts:517-555` 与 `src/subagents/runs.ts:416-455`：`beginWakeConsumption` / `finishWakeConsumption` 逐行同构 —— 同样的 per-id serial queue、同样的 claim-persist-rollback、同样的 `wakeClaimDispatchId` / `wakeConsumedAt` 字段对。约 80 行纯重复。
- `src/runtime/bootstrap.ts:609-622`：`isVerifiedJobWake` 和 `isVerifiedDelegationWake` 是同一句话的两个写法（"这个 id 存在、已终结、且确实属于这个 taskId"）。
- `src/runtime/bootstrap.ts:1135-1208`：job 分支内联展开 74 行，delegation 分支走 `claimVerifiedDelegationWake()` 封装。**同一个问题，两种形状。** 这是最贵的部分 —— 不是行数，是每次读 `handleEvent` 都要重新确认"这两条路是不是真的等价"。
- `src/runtime/bootstrap.ts:1212-1232`：三段几乎相同的 `noteTaskEffects` 调用。

更外层的同构（不建议动，见下）：两者都有 per-channel manager map、`state/<kind>/<channelId>/<id>.json`、`sweep()`、`restore()`、`configureXRuntime()`、`runningTaskIds()`、终结记录保留期回收。

**修法（三步，全部是收敛，不加抽象层）.**

1. 把 claim 协议提成 `src/shared/wake-claim.ts` 里的一对纯函数 + 一个 `WakeClaimFields` 接口（`wakeClaimDispatchId?` / `wakeConsumedAt?`）。两个 manager 各自持有记录和自己的 serial queue，只把判定与字段写入交给共享实现。**约 -60 行。**
2. `bootstrap.ts` 的 job 分支照 `claimVerifiedDelegationWake` 改写成 `claimVerifiedJobWake`，两条分支变成同形；随后两段可以合成一次遍历。**约 -50 行。**
3. `noteTaskEffects` 三连折成一句：

   ```ts
   if (taskAttemptId) {
       noteTaskEffects(event.channelId, taskAttemptId, channelEffectCount(event.channelId) - effectsBefore);
   }
   ```

   语义等价 —— `[TASK_DRIVER:` / `[JOB:` / `[SUBAGENT:` 三个正则都是 `^` 锚定的，三个 id 互斥，而 `taskAttemptId` 已经是它们的 `??` 链。**约 -15 行。**

**明确不建议做的.** 不要把 job 和 subagent run 合并成统一的 "detached work" 抽象。它们的 settle 语义差异是真实的（job 靠 `kill -0` 探活，run 要结算 usage / 释放 lease / 归档产物 / 幂等标记），强合会造出一个比现在两份代码更难读的中间层。只合并上面这三块确凿重复的。

---

## F3. 记忆元数据里从未被读的 7 个字段 —— 直接删

**问题.** `src/memory/metadata.ts:14-56` 的 `MemoryEntryMetadata` 有 20 个字段。全仓检索后：

| 字段 | 生产者 | 消费者 |
|---|---|---|
| `subjectId` | 无 | 无 |
| `ownerId` | 无 | 无 |
| `sensitivity` | 无 | 无 |
| `validFrom` | 无 | 无 |
| `expiresAt` | **无** | `probation.ts:35`（永远读到 `undefined`） |
| `trust` | `memory-manage.ts:150` = `"explicit"`；`extraction.ts:178` = `"inferred"` | 无判断读它 |
| `scope` | `files.ts:287` / `tombstones.ts:10`，恒为 `"channel"` | 单值联合 |

全仓只有两个 metadata 生产点（`memory-manage.ts:147` 和 `extraction.ts:175`），两者都只写 `kind` / `sourceType` / `trust` / `sourceCorrelationId` / `probationUntil`。其余字段只在 `metadata.ts:137-155` 做 `hint ?? previous ?? default` 的透传。

这是按多租户 / 合规形状建的模。README 自己写着定位是"个人与小团队、自托管、单实例运行"——`ownerId`、`sensitivity: secret` 不会有第二个值。

**修法.** 删掉 `subjectId`、`ownerId`、`sensitivity`、`validFrom`、`expiresAt`、`trust`、`scope` 七个字段及其类型（`MemorySourceType` 保留，`recordMemoryRecall` 用得到）；`probation.ts` 的 `expiresAt` 分支一并删，只留 `probationUntil`——两者本来就注释说"语义不同但共用一条驱逐路径"，现在只剩一条。**约 -80 行**，`MemoryEntryMetadata` 从 20 字段降到 13。

如果确实想保留 TTL 能力，那就把 `expiresAt` 补上写入口（`memory_manage` 的 remember 加一个可选到期），否则 `probation.ts` 里那半个分支是永远走不到的死代码——两条路选一条，不要维持现状。

---

## F4. 单用户产品扛着 8 层永久执行的向后兼容 —— 部分是债，部分是设计

**原始判断（有误，已在实现阶段修正）.** 本节最初把 8 个"legacy"命名的分支一并列为迁移债务，建议直接删除后五项。实现时逐项深挖调用路径后发现：只有第一项是真正跑完即废的一次性迁移，其余大多是 AGENTS.md 明文要求的"task/event 文件可手改，必须优雅降级"契约的一部分——名字里带 legacy，但角色是永久的容错解析，不是可以清算的债。下面是逐项实际结论和已完成的改动。

**已执行.**

| 项 | 位置 | 结论 | 处理 |
|---|---|---|---|
| `~/.pi/pipiclaw` → `~/.pipiclaw` 家目录迁移 | `bootstrap.ts`、`paths.ts` | 真正的一次性债：CHANGELOG 明确写着"will be removed in 0.9.0"，两处 `FIXME(0.9.0)` 也是同一个人为这个版本埋的标记 | **已删除** `migrateLegacyAppHome`、`LEGACY_APP_HOME_DIR`；`bootstrapAppHome` 顺带去掉不再使用的 `io` 参数（3 个调用点同步更新） |
| 遗留 `.schedule` 事件折叠 + task v1→v2 状态迁移 | `task-migration.ts`，经 `bootstrap.ts` 的 `void` 调用 | 迁移函数本身是一次性的，但过去每次启动都无条件全量重扫一遍 workspace 的 events/ 和每个 channel 的 tasks/ 目录 | **已加一次性标记门控**：`bootstrap.ts` 在 `state/task-migration.done` 不存在时才跑这两个迁移，跑完写标记；后续启动直接跳过整个扫描，`task-migration.ts` 本身的两个导出函数保持不变（单元测试不受影响） |

**审计后判定为负重设计、不删.**

| 项 | 位置 | 为什么不是债 |
|---|---|---|
| v1 status 词表归一 | `transitions.ts:normalizeStoredStatus`，`ledger.ts` 每次任务读都调用 | 不只是"翻译旧文件"：`awaiting-user`/`blocked` 显式映射到 `waiting` 而非通用兜底的 `active`。删掉具体映射、只留兜底会让这类文件被误判为可执行的 active 任务——这是正确性回归，不是代码整理 |
| `stripLegacyCompletionEvidence` | `ledger.ts:843`，被 `startTaskCycle`（周期任务每次开新周期都调用）和 `upsertCurrentCycleCompletionEvidence` 调用 | 处理的是"没有标准 `## Current Cycle` 骨架的任务"，注释原文承认这类任务"historically completable"——只要用户还能手写不带骨架的任务文件，这条路径就不是历史遗留，是常驻分支 |
| `normalizeLegacyOutcome` | `control.ts:98`，每次解析 control 块调用 | 把废弃枚举值 `verified`/`skipped` 映射到 `progress`；删掉后这类文件会静默落到兜底值 `pending`，语义从"进行中"退化成"未开始"，会误导 governor 的升级判断 |
| 事件 `legacyTimezone` | `events.ts`、`event-manage.ts` | 纯诊断容忍：不参与调度（cron 总是按 host 时区），只在旧字段与 host 时区不一致时打一行警告。事件文件不像任务文件那样会被自动重写，一个 pre-027 的周期事件文件可以无限期带着这个字段存在；删掉只是让这唯一的错位提醒消失，没有对应的正确性收益 |
| memory `sourceType:"legacy"` 默认值、`stableMemoryEntryId`、maintenance-state 旧字段折叠 | `metadata.ts`、`files.ts`、`maintenance-state.ts` | 前两者是"用户手写 MEMORY.md 条目、还没被任何一次 consolidation 摸过"时的永久兜底，不是版本迁移；后者是运行时内部状态文件的一次性字段改名折叠，代价是每次读一次 `??` 链，收益是现有 channel 不会因为还没跑过一次新版 checkpoint 就丢失 cadence 游标——保留的成本远低于删除的风险 |

**结论.** F4 的真实收益集中在"消除每次启动的全量重扫"，已经拿到；"删除散落的兼容分支"这个子目标在审计后不成立——那些分支就是 AGENTS.md 第 3 条工程规则要求的容错读，删除属于引入正确性回归，而非做减法。

---

## F2. 运行时命令登记在 7 个地方 —— 收敛成一张表

**问题.** 新增一个 `/xxx` 运行时命令，要改：

1. `agent/commands.ts` 的 `BuiltInCommandName` 联合
2. `agent/commands.ts` 的 `BUILT_IN_COMMANDS` 表
3. `runtime/dingtalk.ts:163-168` 的 `DingTalkHandler` 接口
4. `runtime/dingtalk.ts:1396-1413` 的 busy 路径 switch
5. `runtime/bootstrap.ts:899-972` 的 6 个 handler 实现
6. `runtime/bootstrap.ts:1080-1099` 的 idle 路径 switch
7. `tui/app.ts:146-155` 的第三份分派

第 4 和第 6 是同一张表的两次手抄。另外 `/context` 有两条实现路径：busy 走 `handler.handleContextCommand`（`bootstrap.ts:951`），idle 走 `runner.handleBuiltinCommand`（`channel-runner.ts:701`），输出相同、投递方式不同。

`BUILT_IN_COMMANDS` 的注释说"`/help`、TUI 补全、忙时提示、已知命令集都从这张表派生——不要并行手维护"。这条纪律在**元数据**上守住了，在**分派**上没有。

**修法.** 把 `DingTalkHandler` 的 6 个 `handleXxxCommand` 换成一个：

```ts
runRuntimeCommand(event: DingTalkEvent, name: BuiltInCommandName, args: string): Promise<string>;
```

返回纯文本，投递交给调用方（`bot.sendPlain` / TUI 渲染各自决定）。dingtalk 的 busy switch 和 bootstrap 的 idle switch 都退化成一次 `runRuntimeCommand` 调用；`/context` 只保留 runner 那一条，busy 路径也走它。**约 -120 行**，此后加命令只需改 `commands.ts` 一张表 + `runRuntimeCommand` 一个 case。

这条排在 F1/F3/F4 之后：它是"下次改动更便宜"，不是当下的正确性问题。

---

## F5. 两个体积失控点 —— 按已有边界切开，零行为变更

**已执行，范围比最初设想窄一些（原因见下）。**

`runtime/bootstrap.ts`（原 1569 行）拆出两个自包含模块：

- `runtime/app-home.ts`（440 行）：app home 脚手架、配置模板、`channel.json` 校验、CLI 参数解析（`bootstrapAppHome`/`loadConfig`/`parseArgs`/`printBootstrapSummary`/`readCliVersion`/`BootstrapExitError`）。全部是只接受显式 `paths`/`io` 参数的纯函数，零依赖 `createRuntimeContext` 的闭包状态。
- `runtime/task-wake.ts`（152 行）：job/delegation 完成唤醒的校验与认领（`isVerifiedJobWake`/`isVerifiedDelegationWake`/`isTrustedInternalWake`/`claimVerifiedJobWake`/`claimVerifiedDelegationWake`）。同样只接受显式参数（`event`/`workspaceDir`/`executor`），与 F1 新增的 `shared/wake-claim.ts`（底层 claim/consume 字段原语）不是同一层——这里是"这条唤醒是否该被信任并激活任务"的业务判定，那里是"claim 字段怎么读写"的共享原语。

`bootstrap.ts` 降到 983 行。原方案还设想把 `DingTalkHandler` 的实现和关停编排也各自拆出 `handler.ts`/`shutdown.ts`——写代码时发现这两块其实是 `createRuntimeContext` 一个大函数内部靠闭包共享 `channelRunners`/`durableDispatch`/`store`/`bot` 等本地状态的，不是相互独立的纯函数。真要拆分需要把闭包状态收进一个类或显式 context 对象，这是一次实质的结构调整，不是"零行为变更的纯搬运"——与本条目的前提矛盾，所以没有做。`bootstrap.ts` 保留为运行时装配 + handler 实现的单一文件；已经拆出的两块是可以在不改变任何语义的前提下真正安全分离的部分。

`agent/channel-runner.ts`：`run()` 原本 370 行，`finally` 块（150 行）揉合 debug dump、未提交队列丢弃、delivery 收尾四分支、usage 记账、memory flush、状态清理六件事。已抽成 `private async finishTurn(input)`，`run()` 主干回到"装配 prompt → 跑（带 fallback）→ 收尾"三段，`finishTurn` 的输入是显式参数对象（不是新增实例字段——这些值本就是单次 `run()` 调用的局部状态，不应该提升为跨调用共享的实例状态）。

验收：`npm run check`（lint + typecheck + deadcode + test，1093 tests）全绿；`src/index.ts` 的公开导出、`main.ts`/`tui/*`/`models/auth-cli.ts` 等约 10 个调用点的 import 路径已同步更新。

---

## 明确不建议动的（免得下一轮再翻出来）

- **记忆维护四件套**（`scheduler` / `maintenance-gates` / `maintenance-jobs` / `maintenance-state`）：职责单一、各有专属测试，注释解释了为什么不能合并——gate 用 thunk 延迟物料读取是实打实的性能设计（避免空闲 daemon 每分钟扫全量 transcript）。保持现状。
- **tasks 子系统 5345 行**：已经过 029（生命周期简化）、036（治理瘦身）、038（自主状态 v2）三轮减法，剩下的体量主要是 `ledger.ts` 的 Markdown 契约解析——任务文件手可编辑、必须 fail-open，这是本质复杂度。除 F4 列出的遗留层外，不建议再切。
- **prompt 架构**（`agent/prompt/*` + `playbooks/*`）：manifest / budget / cacheClass 的设计是这个仓库里质量最高的部分，`/context` 报告让每一分 token 都可归因。不动。
- **`security/command-guard.ts` 711 行**：唯一可议的是 `container-escape` / `privilege-escalation` 这两类企业形状的规则分类，对"个人 Mac 上以本人账号运行"没有实际意义（真正的边界是 CLI sandbox + 宿主账号，AGENTS.md 已经写明）。但它不在热路径也不在长，删了争议比留着大。若一定要减，只删这两类，约 -40 行。

## 顺手的整理

- `docs/subagent-chain-review-2026-08-09.md` 落在 `docs/` 顶层，按本仓惯例评审报告应放 `docs/refer/`（对应的修复方案 `subagent-chain-fixes-2026-08-09.md` 已经在那里）。移过去。
- `docs/configuration-reference.md` 1194 行，是文档里唯一有漂移风险的一份——它记录字段默认值，而 spec 035 之后大量数值阈值已经变成代码常量。建议在 F4 清算时顺带核一遍，确认它没有还在描述 `RETIRED_SETTINGS_KEYS` 里的键。

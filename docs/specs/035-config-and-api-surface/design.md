# 配置面与公共 API 收缩：把算法阈值收回代码，把库入口收回嵌入场景

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED |
| 日期 | 2026-07-25 |
| 前置 | 010 memory-maintenance-scheduler、016 structured-logging、022 native-task-driver、026 system-prompt-slimming |
| 关联实现 | `src/settings.ts`、`src/memory/maintenance-tuning.ts`、`src/index.ts`、`src/runtime/bootstrap.ts`、`docs/configuration.md`、`docs/deployment-and-operations.md` |

## 背景

`docs/refer/pipiclaw-slimming-review-2026-07-24.md` 第 5.10 节提出两条意见：settings 暴露了大量内部运行阈值（维护间隔、置信阈值、失败退避、任务驱动延迟、单 tick 派发上限），应尽量成为代码常量；`src/index.ts` 暴露了大量内部实现，如果主要产品是 CLI/runtime 而不是第三方 SDK，公共入口应缩到少数稳定 API。

核实结论：**两条都成立，但成本不在审查描述的位置。**

settings 的每一段都是 `Partial<>` 叠在代码默认值之上，零配置即可运行——没有人"被迫承担调参责任"。真实成本在 `docs/configuration.md`：1399 行里用一张 40 行的表把每个阈值都文档化了，**每一行都是一份兼容性承诺**。改一个常量要同步改文档、要考虑存量用户是否调过、要在 CHANGELOG 里解释。

barrel 的成本也比"美观"更实：`src/index.ts` 约 90 个导出名覆盖 20 个模块，而**仓库内零消费者**（`src/`、`test/`、`evals/`、`examples/` 无一从它导入，README 完全没有 SDK 用法）。更关键的是 `knip.json` 把它列为 entry，于是**任何走 barrel 的导出都被排除在死代码检测之外**——barrel 越大，`npm run deadcode` 这道门越失效。

## 病根的准确表述

不是"配置项太多"，而是**两条界线画错了**。

1. **settings 没有区分"产品意图"与"算法参数"。** 用户能判断的是"要不要开后台记忆维护"，判断不了"checkpoint 间隔该是 20 分钟还是 25 分钟"、"自动写入置信度该是 0.85 还是 0.8"。后者没有用户可依据的信息，把它放进配置文件等于把调参责任转嫁给不掌握依据的人。可观察的分界线恰好是类型：**布尔与枚举表达意图，数值表达算法**。
2. **barrel 没有区分"公共契约"与"内部实现"。** `RUNTIME_PROMPT_HARD_UNITS`、`runSidecarTask`、`buildMemoryCandidates`、`createMemoryCandidateStore` 这类名字进入公共 API 没有任何使用场景支撑，只是"顺手导出"的累积。

核实还暴露三处死配置——文档承诺了但代码根本不读：`sessionMemory.failureBackoffTurns`（无读取者，文档已标 Legacy）、`sessionSearch.enabled`（无读取者，`session_search` 在 `tools/registry.ts` 无条件注册，文档却标"Yes"）、`getCompactionReserveTokens`/`getCompactionKeepRecentTokens`（含 pi SDK dist 在内全仓库无调用者）。这类"文档在说谎"的条目正是配置面过宽的直接产物：面越大，越没人核对每一项是否还活着。

## 设计

### D1 分层规则：布尔/枚举留，数值全变常量

`settings.json` 保留 15 个键，全部是布尔、枚举或模型引用：

| 段 | 保留 |
|---|---|
| 模型 | `defaultProvider`、`defaultModel`、`defaultThinkingLevel`、`fallbackModel`、`subagentModel` |
| 模块开关 | `compaction.enabled`、`retry.enabled`、`memoryRecall.enabled`、`sessionMemory.enabled`、`memoryMaintenance.enabled` |
| 成本相关枚举 | `memoryRecall.rerankWithModel`、`sessionSearch.summarizeWithModel` |
| 输出与观测 | `logging.level`、`logging.file.enabled`、`tui.responseMode` |

其余全部下沉为常量：`compaction` 的两个 token 预算、`retry` 的两个退避数值、`memoryRecall` 的三个尺寸、`sessionMemory` 的两个阈值 + `timeoutMs` + 两个 `forceRefreshBefore*`、`memoryMaintenance` 的全部 9 个数值、`sessionSearch` 的四个尺寸/超时、`taskDigest` 与 `taskDriver` 两个段整体、`logging.file` 的轮转参数。

`memoryRecall.rerankWithModel` 与 `sessionSearch.summarizeWithModel` 是唯二保留的非开关项：它们直接决定要不要额外发起一次 LLM 调用，是用户能凭"我的 token 预算"判断的成本意图，不是算法参数。

### D2 用户输入类型收缩，运行时类型不动

关键手法。`PipiclawMemoryMaintenanceSettings` 这类接口是**内部 DI 契约**——`maintenance-gates.ts`、`scheduler.ts`、`maintenance-jobs.ts`、`recall.ts`、`session-search.ts` 都按完整对象消费，且这条路径正是常量下发的通道。因此运行时接口保持字段完整，只把 `PipiclawSettings`（用户输入类型）窄化成保留键：

```ts
memoryMaintenance?: { enabled?: boolean };   // 曾经是 Partial<PipiclawMemoryMaintenanceSettings>
sessionSearch?: { summarizeWithModel?: boolean };
// taskDigest / taskDriver 整段删除
```

getter 不再 `...this.settings.X` 整体展开，改为常量基底 + 逐个保留键合并。收益是 consumer 一行不用改，常量仍只定义一处；代价是运行时类型比用户可写字段宽——这是有意的，类型注释里写明了。

`getTaskDriverSettings()` 原有的 clamp 逻辑（1..60 / 1..1440 / 1..20 / 1..60）随之整体删除：常量不需要防御用户输入。

### D3 退役键给一次性 warning，而不是静默忽略

存量 `settings.json` 里的数值键会失效。0.8.10 处理 `memoryGrowth` 时用的是"静默忽略"，这次改用显式诊断：`RETIRED_SETTINGS_KEYS` 列出已知退役键，`load()` 命中即产出 `severity: "warning"` 的 `ConfigDiagnostic`，沿用 `tools/config.ts` 的 `pushInvalidValueDiagnostic` 形状。

**不做通用 unknown-key 枚举**：仓库内没有任何 loader 这么做，而且 `settings.json` 的形状源自上游 pi-mono，通用枚举会对一堆合法上游字段误报。只匹配已知退役键，精确且便宜。

顺带修一处死代码：`getDiagnostics()` 此前没有任何调用者（`prepareAppServices` 只调 `drainErrors()`），现在接进同一条日志路径，与 tools/security 诊断并列。

### D4 barrel 收缩到嵌入 daemon 所需的最小集

`src/index.ts` 保留 21 个名字（含类型），围绕唯一承诺的用法——"把 pipiclaw daemon 嵌进别的进程"：`bootstrap` 及其选项/结果类型、`DingTalkBot` 及其配置类型、`ChannelContext` 投递契约、`paths.ts` 的路径常量、`PipiclawSettings` 类型。

prompt 内部常量、memory 的 sidecar/candidates/consolidation/recall/session、subagent discovery 与 tool、usage ledger、tools 配置、executor、command extension、workspace resources 全部退出公共面。

同时删除已标 deprecated 的 `DingTalkContext` 别名：本次 barrel 本就是破坏性变更，一次断干净好过分两次。（决策矩阵原本把它排进 0.9，提前到这里的理由仅是"合并破坏性变更窗口"。）

收缩后 knip 会浮出此前被 barrel 掩护的真死代码，**逐条删除而非加忽略项**——这是本次改动的主要工程收益。

### D5 测试可调性用单一环境变量钩子

`test/support/setup.ts` 靠写入 `minIdleMinutesBeforeLlmWork: 0` / `sessionRefreshIntervalMinutes: 0` 让维护立即触发，`test/e2e/session-memory.test.ts` 在 45s 内断言 `SESSION.md` 被刷新。这两个值变常量后 e2e 与 behavior-eval 必然超时。

逐层注入被否决：`getOrCreateRunner(channelId, channelDir, paths)` 签名太窄，而 `channel-runner.ts` 又直接走 `this.settingsManager.getMemoryMaintenanceSettings()`，把 tuning 覆盖穿过工厂需要改四处签名。改用 `src/memory/maintenance-tuning.ts` 内读取一次的 `PIPICLAW_TEST_FAST_MAINTENANCE=1`，命中则把 idle/interval 类常量归零，并把 scheduled session refresh 的 turn/tool 阈值降到 1/1——旧 fixture 正是靠 `minTurnsBetweenUpdate: 1` 让单条消息的 E2E 回合触发刷新，这两处必须一起下调，否则单消息回合永远够不到 `turns>=2 || toolCalls>=4` 的闸门。

这确实是一个新的环境变量，但它是**一个测试钩子**换掉了一整排文档化的生产旋钮，且刻意不写进 `docs/configuration.md`。

## 兼容性

- **磁盘格式**：零变更。退役键留在 `settings.json` 里不会导致启动失败，只产生一条 warning 并按常量运行。
- **保留键行为**：逐字节不变——常量取自原 `DEFAULT_*` 字面量。
- **公共 API**：破坏性变更。barrel 从约 90 个名字降到 21 个，`DingTalkContext` 别名移除。仓库内零消费者，README 无 SDK 用法，版本仍是 0.8.x-beta，窗口合适。已按 `Beta API note:` / `**Breaking (beta API):**` 体例记入 `CHANGELOG.md` 与 `CHANGELOG.zh-CN.md`。
- **SDK 反射调用面不动**：`getCompactionSettings`/`getRetrySettings`/`getBranchSummarySettings`/`setDefaultModelAndProvider`/`setDefaultThinkingLevel` 在 `src/` 内无调用者，但被 `pi-coding-agent` 的 `agent-session.js` 通过 `asSdkSettingsManager()` 反射调用，全部保留。只删除真正无人调用的 `getCompactionReserveTokens`/`getCompactionKeepRecentTokens`/`applyOverrides`。

## 被否决的替代方案

- **`autonomy: off | reminders | full` 粗粒度档位**（审查建议）：`tools.tasks.enabled` 已经是自治总开关，`task_manage` 工具、TaskDriver、task digest 三者同开同关。再加一层档位就是第二套重叠控制，与本 spec 目标自相矛盾。模块级开关已经够用，正如审查自己所说"不建议为了支持档位再引入复杂插件框架"。
- **保留 advanced 档（数值仍可读，只是移出文档正表）**：线上排障能热调节奏确实有运维价值，但接口没有真正收窄——未文档化的键照样会被人从源码里翻出来用，然后变成事实承诺。要么收，要么不收。
- **彻底删除库入口（只留 bin）**：knip 检测最彻底，但会一次性暴露大量待清理导出，把本次改动的范围撑到不可控。保留最小嵌入面已经把 knip 盲区从 ~90 个名字压到 21 个。
- **把数值搬进新的 `advanced.json`**：只是换了个文件名，承诺一分没少。
- **删掉 `sessionSearch.enabled` 而不是把它接上**：`session_search` 与 `grep`、`memory_manage`、`event_manage` 一样属于恒开工具，补一个开关是新增配置面，与本 spec 反向。文档改为"恒开"即可。

## 测试重点

- **D1**：写入被退役的数值键（如 `compaction.reserveTokens: 4096`、`memoryMaintenance.checkpointIntervalMinutes: 45`）后 getter 仍返回常量——把"数值不可配"固化成回归测试，而不只是删掉旧断言。
- **D1**：保留键仍然生效（`compaction.enabled: false`、`memoryRecall.rerankWithModel: false`、`logging.level`、`tui.responseMode`）。
- **D3**：含退役键的 `settings.json` 产出 warning 诊断且键名出现在消息里；干净配置不产出诊断；JSON 解析失败仍是 error 且优先。
- **D4**：`dist/index.d.ts` 只剩预期名字；`npm run deadcode` 无新增未清理项。
- **D5**：`PIPICLAW_TEST_FAST_MAINTENANCE=1` 下 idle/interval 常量归零，未设时取生产值。
- **回归**：`taskDriver` clamp 测试删除（clamp 逻辑已随常量化消失）；maintenance gates/jobs/scheduler 的既有用例构造内存对象字面量，运行时类型不变故行为不变。

## 后续边界

不在本 spec 内：`docs/configuration.md` 仍有 1000+ 行，主体是 `models.json`/`auth.json` 的模型接入说明，那部分是真实的用户配置面，不属于本次收缩对象。`PipiclawSettingsManager` 里约 60 个满足 pi SDK 接口形状的 no-op 桩（`getTheme`、`setShellPath`、`getEditorPaddingX` 等）本次只是不再被导出，拆成独立 adapter 留待后续。

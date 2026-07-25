# Pipiclaw 瘦身第二轮评估：增长归因、结构性优先级与执行顺序

| 字段 | 值 |
|---|---|
| 日期 | 2026-07-25（修订版，基于全量代码核对与历史度量重写） |
| 代码基线 | `spec-035-config-api-surface@3ae00bb`，生产 TypeScript **32,499 行** |
| 包版本 | `0.8.10-beta.1` |
| 验证状态 | `npm run check` **通过（exit 0）**，110 测试文件 / 882 测试全绿 |
| 报告性质 | 承接 `pipiclaw-slimming-review-2026-07-24.md` 的**进度盘点 + 增长归因 + 执行顺序裁决** |
| 关系 | 更新 07-24 slimming review 的执行状态；裁决它与 07-18 deep review 的方向冲突 |
| **定位裁决** | **已拍板：无人值守模式**（2026-07-25）。连带结论见第 5 节末与第 6 节 R2 行 |
| **已立项 spec** | R3a/b/c → [`036-task-governance-slimming`](../specs/036-task-governance-slimming/design.md) |

## 0. 本次修订说明

初版报告的核心论点（「第一轮只瘦了表面，状态机没动」）方向正确，但**论据不足且有两处实质性错误**。本次用完整历史度量和逐字段消费链核对后重写，修正如下：

| 初版说法 | 核对结果 | 影响 |
|---|---|---|
| 「33,000 → 32,500，净减 500 行」 | 口径太窄。真实曲线是 **07-03 的 18,609 → 07-25 的 32,499（22 天 +75%）**，峰值 07-23 的 33,061 | 结论从「瘦身收益小」升级为「**瘦身速度远低于增长速度**」，这是完全不同的问题 |
| 暗示 `dependsOn`/`parent` 只是被解析 | 错。它们被**深度消费**：环检测、死锁图检测、依赖门控（`task-manage/shared.ts:203-245`、`task-commands.ts:623-638`、`task-driver.ts:388`） | 删除收益更大，但**代价和风险也更高**，不能当作顺手删的字段 |
| F1 作为一个整体动作排期 | 过粗。F1 内部各字段的**消费面差异极大**：预算是收敛的，验证/依赖是发散的 | 得出了新的「F1 内部由易到难」次序，见第 6 节 |

此外新增了四项初版没有的关键证据：增长归因（第 2 节）、治理状态不持久（4.1）、`tasks.enabled` 主开关已存在（4.2）、项目已有大规模删除的成功先例（2.3）。

## 1. 执行摘要

- 第一轮瘦身（spec 035 config、记忆 checkpoint 合并、子代理 20→15、任务枚举折叠）**方向正确、执行克制、质量高**：没有删可靠性底座，`check` 全绿。
- 但**它没有跑赢增长**。22 天内代码从 18,609 涨到 32,499（+13,890 行），而全部瘦身动作合计回收约 560 行——**约为同期增量的 4%**。更值得注意的是：07-23 还在给任务子系统**加**代码（`3e6a5e3`），次日的审查就把同一子系统列为最大删除目标。
- 真正的成本集中在**任务治理域**：4,229 行、17 个文件、跨 6 个目录，另有 28 个文件引用它、619 行文档描述它。这是单一最大杠杆。
- 一个此前未被记录的关键事实：**任务治理的守护状态是内存态**（`task-driver.ts:235` 的 `attempts` Map、`effect-ledger.ts` 的 `counts` Map），重启即失效。也就是说，系统付出了完整的治理代码成本，却没有换到跨重启的治理保证。
- 好消息：`tools.json` 里 **`tasks.enabled` 已经是一个把 `task_manage` + TaskDriver + task digest 一起关掉的主开关**。这意味着「先观察不用它会怎样」是一次配置修改，不是一次重构——决策成本极低。
- 07-24 与 07-18 两份报告在任务审批上的方向冲突依然存在且必须先裁决，否则会一边删一边建。裁决见第 5 节（结论：两者兼容，删的是「任务作为治理容器」，不是「安全作为能力」）。

一句话结论：

> 问题不是「瘦身没效果」，而是**瘦身在表面推进、增长在结构层发生**。下一轮必须把手术刀对准任务治理域，并且先用主开关做一次低成本的必要性验证。

## 2. 增长归因：这 22 天发生了什么

### 2.1 真实曲线

| 日期 | 行数 | 里程碑 |
|---|---:|---|
| 2026-07-03 | 18,609 | 0.6.10-beta.1 |
| 2026-07-05 | 20,731 | `refactor: drop Windows support` |
| 2026-07-09 | 24,438 | 工具 Wave 1（grep + error navigation） |
| **2026-07-10** | **27,103** | **`feat(tasks): governed task loops and native task driver`（单次 +2,665）** |
| 2026-07-11 | 27,522 | `refactor: remove sandbox support and collapse workspace` |
| 2026-07-12 | 28,735 | `feat(prompt): own the system prompt pipeline`（+1,213） |
| 2026-07-17 | 30,859 | spec 027 native recurrence |
| **2026-07-20** | **32,636** | **`feat(subagents): inline-delegation defaults`（+1,507）** |
| **2026-07-23** | **33,061** | **`feat(tasks): bound cycle evidence, migrate legacy ledgers`（峰值）** |
| 2026-07-24 | 32,455 | 记忆 checkpoint 合并（瘦身开始） |
| 2026-07-25 | 32,499 | spec 035 config/barrel |

### 2.2 归因结论

- **+75% / 22 天**。增长不是均匀累积，而是由**三次大功能注入**主导：治理任务循环（+2,665）、子代理默认化（+1,507）、系统提示词管线（+1,213）。仅这三笔就是 5,385 行，占总增量的 39%。
- 增长最猛的两个方向——**任务治理**和**子代理**——恰好是 07-24 报告点名要削减的两个方向。
- **07-23 的 `3e6a5e3` 值得单独标注**：它在瘦身审查前一天，仍在给任务子系统增加 cycle evidence 边界、遗留账本迁移和成本核算。这说明团队目前**缺少一道「该子系统正在收缩，不再接受加法」的闸门**——07-24 报告第 8 节「阶段 0：冻结」提出过，但未落实。

### 2.3 一个正面先例（重要）

项目**已经成功做过两次大规模能力删除**：

- `6c08e95 refactor: drop Windows support and its complexity`（07-05）
- `13c5449 refactor: remove sandbox support and collapse workspace`（07-11）

这两次都是「删一整块能力」而非「优化实现」，且之后代码保持健康。**这说明结构性删除在本项目是文化上可行、工程上已被验证的**——F1 不是没有先例的冒险动作。这是本轮最重要的信心依据。

## 3. 进度盘点：以 07-24 决策矩阵逐项核对

| 07-24 建议 | 状态 | 证据 |
|---|---|---|
| 配置只表达产品意图 | ✅ 完成 | `PipiclawSettings` 只剩 bool/enum/model 引用；`RETIRED_SETTINGS_KEYS` 列 34 键并在加载时告警（`settings.ts:278-314`） |
| 公共 barrel 收缩 | ✅ 完成 | `src/index.ts` 仅剩 bootstrap/DingTalkBot/ChannelContext/路径常量/PipiclawSettings |
| 自动写 workspace skill 删除 | ✅ 完成 | `src/memory/` 全域已无 skill 候选/写入代码 |
| 合并记忆 LLM 维护周期 | 🟡 部分 | job 从 4 → 3（session-refresh / memory-checkpoint / structural-maintenance）；但 `src/memory/` 仍 6,036 行 / 28 文件 |
| 子代理收缩到 task/role/tools/model | 🟡 部分 | 参数 20 → 15，但 `taskId`/`worktree` 相关引用仍有 **57 处**（`subagents/tool.ts`），任务耦合语义未拆 |
| 任务模型收缩为轻量待办 | ❌ 未动 | `3c36928` 仅折叠两个枚举；`TaskControl` 仍是 ~20 字段全量治理对象 |
| 统一 Wake，收敛三套唤醒 | ❌ 未动 | `events.ts`(906)、`task-driver.ts`(526)、`job-manager.ts`(585) **各自独立持久化**（job-manager 自写 JSON 记录、events 自写 history），`durable-dispatch.ts` 只在 bootstrap 层统一 |
| 删 `_baseToolsOverride` 与 SettingsManager 空实现 | ❌ 未动 | `channel-runner.ts:1263` 仍强转私有字段并自带「SDK change?」告警；`settings.ts:548-844` 约 300 行 no-op stub |
| 删 RTK / bash interceptor | 🟡 部分 | **RTK 默认已是 `enabled: false`**（`tools/config.ts:92`）——已是休眠死重；`bashInterceptor` 默认 `true`，仍在主路径 |
| 到期迁移 / deprecated alias | 🟡 部分 | `src/runtime/task-migration.ts`(69) 仍在；任务枚举改为读时归一化（良性） |

**盘点结论：已完成项 100% 落在「入口/配置」象限；未动项 100% 落在「状态机/唤醒/耦合」象限。**

## 4. 本轮新增的关键发现

### 4.1 任务治理的守护状态是内存态——付了代码成本，没买到保证

`task-driver.ts:235` 的 `private readonly attempts = new Map<string, DispatchAttempt>()` 持有 `futileCount`（连续无进展唤醒计数），`FUTILE_WAKE_LIMIT` 触发 governor 暂停任务。`effect-ledger.ts` 的 `counts` Map 同样是纯内存，其注释明确写道：

> "The tally lives in process memory... a restart resets both, which costs at most one extra round of patience before the governor intervenes."

含义很重要：**这套「受治理的自治循环」在重启后会丢失它的刹车状态。** 于是我们同时承担了：

- 治理逻辑的全部实现与测试成本；
- 治理语义带来的用户理解成本（governor/futile/escalation 概念）；
- 却**没有**得到「跨重启不会重复空转」的实际保证。

这不是 bug——注释显示是有意的成本权衡。但它极大削弱了「保留完整治理机器」的论证：**如果治理本来就只是尽力而为，那么用更简单的固定策略（如固定重试上限 + 到点转人工）几乎可以等价，而代码量是零头。**

### 4.2 `tasks.enabled` 主开关已存在——必要性验证是免费的

`tools/config.ts:39-46` 明确写道，`tasks.enabled` 一个开关同时 gate 了 `task_manage` 工具、原生 TaskDriver 和每轮 task digest。

这带来一个此前被忽略的、极高性价比的动作：**不需要写任何埋点或计数器，就可以直接做必要性验证**——把 `tasks.enabled` 设为 `false` 运行一段时间，观察是否真的影响日常使用。07-24 报告「阶段 0：冻结和量化」建议增加本地使用计数（需要开发工作），而这里**开关已经现成**。

### 4.3 F1 内部的消费面差异极大——决定了删除次序

逐字段核对消费链，结果分化明显：

| 字段族 | 消费面 | 删除难度 |
|---|---|---|
| `maxTokens` / `maxCostUsd` / `maxWallTimeMinutes` | **收敛**：仅 schema(2 处) + 一个定价前置检查 + `taskBudgetViolation` 集中判定 | **低**——几乎是局部删除 |
| `lifetimeUsage` | 中等：`store.ts` 6 处累加 + `task-commands.ts` 3 处展示 | 低-中 |
| `worktree` | 中等：control + subagent 集成 | 中 |
| `verification` | **发散：横跨 16 个文件**（含独立的 `tasks/verification.ts`、`task-manage/verification.ts`、`artifact-subject.ts`、subagent verify 路径） | **高** |
| `parent` / `dependsOn` | **发散**：环检测（`task-manage/shared.ts:203-245`）、死锁图检测（`task-commands.ts:623-638`）、依赖门控（`task-driver.ts:388,422`）、digest 展示 | **高** |

初版报告把 F1 当作一个原子动作，是错的。正确做法是**由收敛到发散逐步剥离**，每步都能独立通过 `check`。

### 4.4 任务域的真实体量

| 组成 | 行数 |
|---|---:|
| `src/tasks/*`（control 442 / store 278 / transitions 120 / verification 101 / artifact-subject 34） | 975 |
| `src/tools/task-manage*`（含 6 个子模块） | 989 |
| `src/runtime/task-commands.ts` | 721 |
| `src/runtime/task-driver.ts` | 526 |
| `src/shared/task-ledger.ts` | 742 |
| `src/memory/task-digest.ts` | 107 |
| `src/runtime/task-migration.ts` | 69 |
| **合计（核心）** | **4,229** |
| 另有引用该域的文件 | 28 个 |
| 相关文档 | `docs/events-and-tasks.md` 619 行 |

分布在 **6 个目录**——这正是 07-24 报告所说「中央编排器需要理解过多领域语义」的具体形态。

### 4.5 SDK 耦合的真实成本在 stub，不在 cast

`asSdkSettingsManager`（`channel-runner.ts:108-110`）只是一个 3 行的 `as unknown as` 包装，耦合点**已经被很好地隔离**（4 处调用同一个 helper）。真正的成本是 `settings.ts:548-844` 约 300 行 no-op / 常量 stub（`getShellPath`、`getThemePaths`、`getTreeFilterMode`、`getEditorPaddingX`…），即 pipiclaw 被迫扮演一个它完全不使用的 TUI 配置管理器。

`_baseToolsOverride`（`channel-runner.ts:1263`）是另一个独立问题：为了让工具在当前 session 内热替换而写入 SDK 私有字段，代码自带「SDK change?」降级告警。

## 5. 裁决：瘦身 vs 可信自主的方向冲突

这一节结论与初版一致，经复核仍然成立，是 F1 的前置条件。

两份前序报告方向相反：

- **07-18 deep review（P0-1/P0-2）**：任务审批是「任务能否收尾」的门，太弱；应**新建**执行前 tool middleware 授权边界 + 动作级幂等 journal。这是「**加**机制」。
- **07-24 slimming review（5.1/5.6）**：任务里的 `externalApproval`/`verification`/`worktree`/依赖图/多维预算是团队级治理，个人 Agent 不需要，应**删**。这是「**减**机制」。

裁决——**两者兼容，因为指的不是同一个东西**：

> 二者都认同「任务完成时才检查」是错误的位置。deep review 说把安全边界移到工具执行边界；slimming review 说把它从任务状态机里拿走。合起来正是同一个动作——**从 `TaskControl` 删除 approval/verification，把（若确需的）安全不变量下沉到与任务解耦的、极薄的 executor 边界。**

因此：

1. **F1 的删除部分照常执行**：`verification`、`worktree`、`dependsOn/parent`、三维扩展预算、`lifetimeUsage`、cycle 独立核算，全部从任务模型移除。
2. **`externalApproval` 单独处理**——它是 `TaskControl` 里唯一带真实安全含义的字段。要么摘出为独立的、默认关闭的 executor 边界能力（deep review P0-1 的最小实现），要么在确认「可信个人模式」后明确降级为「宿主执行 + 误操作保护」（07-24 报告 5.6 模式一）。**这是产品定位选择，需要拍板，不应由某一轮瘦身默默决定。**
3. **不要顺手删掉 deep review 的三个 P0**（授权、幂等、行为评测）。它们是可信自主的地基，与「个人瑞士军刀」定位不矛盾；矛盾的只是它们**当前寄生在任务状态机里**的实现位置。

补充一条新证据支持该裁决：4.1 显示当前治理状态本就不持久。所以「保留现状 = 保留了安全保证」是错觉——**现状既不省代码，也没给出强保证**，正是最该被替换的中间态。

一句话：**删的是「任务作为治理容器」，不是「安全作为能力」。**

### 5.1 裁决结果（2026-07-25 已拍板）

**定位选定：无人值守模式。** 连带结论：

| 议题 | 结论 |
|---|---|
| `externalApproval` | **保留，一个字段都不动**。执行前授权边界（P0-1）另立 spec，本轮不预支 |
| `verification` | **保留但简化**——无人值守下没有人复核产出，防自证比有人值守时更重要 |
| `parent` / `dependsOn` | **删除**（用户判定过度复杂） |
| R3a 预算 / `lifetimeUsage` | **按提案删除** |
| R3b worktree | **按提案删除**；git worktree 不是安全边界，删它不违反无人值守定位 |
| R3b 的 `purpose: verify` | **撤销删除**——原提案建立在「verification 一并删除」的前提上，前提已变 |
| 新增必要配套 | **全局支出闸**：删掉三维预算后 per-task 只剩 `maxAttempts`，而 `src/usage/` 无任何 cap。这是无人值守的真实敞口，应紧随 036 立项 |

以上已落成 [`docs/specs/036-task-governance-slimming/design.md`](../specs/036-task-governance-slimming/design.md)。

## 6. 执行顺序（可直接排期）

相比初版，本表依据 4.3 的消费面分析把 F1 拆成三小步，并把「免费删除」和「必要性验证」提到最前。

| 轮次 | 目标 | 依赖 | 预计 | 风险 | 前置动作 |
|---|---|---|---|---|---|
| **R0** | **立即冻结**：任务/子代理域停止接受加法（针对 2.2 的 `3e6a5e3` 现象） | 无 | 0 行 | 无 | 团队约定；写入 AGENTS.md |
| **R1** | **免费删除**：RTK（默认已 off，纯死重）、`task-migration.ts`(69)、SettingsManager 约 300 行 stub | 无 | ~450 行 | **极低**（RTK 零行为变更） | 确认 SDK 是否需要完整接口；stub 可否用最小实现替代 |
| ~~R2~~ | ~~必要性验证 + 定位拍板~~ → **已完成（2026-07-25）**：选定无人值守模式，见 5.1 | 无 | 0 行 | —— | —— |
| **R3a** | **F1-易**：删多维预算（`maxTokens`/`maxCostUsd`/`maxWallTimeMinutes`）+ `lifetimeUsage` | R2 ✅ | ~300–500 行 | 低（消费面收敛） | 保留 `maxAttempts` 作为唯一止损 → spec 036 D1/D2 |
| **R3b** | **F1-中**：删 `worktree` 所有权 + 子代理 `isolation` 参数（**`purpose:verify`/`taskId` 改为保留**） | R3a | ~400–600 行 | 中 | 子代理 15 → 14 参数 → spec 036 D3 |
| **R3c** | **F1-难**：删 `parent`/`dependsOn` 关系图（4 套环检测归零）；**`verification` 保留并简化**（二元 mode → 布尔、删自证分支、删只写不读字段） | R3b | ~1,200–1,500 行 | **中高**（改持久格式） | 读时忽略退役键 + `/tasks doctor` 报告 → spec 036 D4–D8 |
| **R3d** | **配套（无人值守必需）**：全局支出闸——按天/月的 token 与成本上限，触顶暂停 TaskDriver 派发并通知 | R3a | **+150–250 行（净增）** | 低 | 删掉 per-task 预算后的正确落点；`src/usage/` 现无任何 cap |
| **R4** | **F2 统一 Wake**：task 降级后收敛 event + job 到单一 Durable Wake | R3c | ~800–1,500 行 | 中 | 保持 at-least-once 与幂等键 |
| **R5** | **删热替换**：`_baseToolsOverride` 私有访问；资源在 runner 创建时加载，`/new`、`/reload` 重建 session | 无（可并行） | ~150–300 行 | 低-中 | 确认无公开 setter 后再决定是否推动上游 |
| **R6** | **拆大文件**：`dingtalk`(1451)、`channel-runner`(1335)、`bootstrap`(1186)、`events`(906) | R3c–R4 | 净零 | 中 | **必须在能力删除之后**，否则重拆 |

排序逻辑：**先冻结止血 → 免费删除建立节奏 → 用现成开关做必要性验证并拍板 → 由易到难剥离任务域 → 补上无人值守的成本闸 → 收敛唤醒 → 最后才拆文件。**

累计预期：R1–R4 净减约 **3,000–4,300 行**（R3d 净增 150–250 已计入），且删除的是**带恢复语义的持久状态与跨域耦合**，不是纯 UI。

不在前六轮的：

- **记忆子系统**（6,036 行 / 28 文件）：已部分收敛，改动风险高、收益被摊薄。建议 task/wake 结构稳定后单独立项评估。
- **Web**（1,119 行 + axios/jsdom/readability）：默认关闭，对「瑞士军刀」定位有直接价值。维持 07-24 判断，按使用数据收缩 provider，本轮不动。
- **TUI**（1,232 行）：符合定位，且是 DingTalk 不可用时的恢复入口。保留。
- **`bashInterceptor`**（默认 on）：需先确认其拦截命中率再决定，不与 RTK 同批处理。
- **`preAction` sensor**（`events.ts`，deep review P1-1）：仍是宿主 shell 执行入口，属安全议题而非瘦身议题，随第 5 节定位一并处理。

## 7. 验收指标

07-24 报告第 9 节的体系完整，此处只锁定**本阶段必须移动的四个**——它们正是第一轮没有移动的：

| 指标 | 当前 | 目标 |
|---|---|---|
| 任务持久状态字段数（`TaskControl`） | ~20 | 个位数 |
| 任务域代码 / 文件 / 目录 | 4,229 / 17 / 6 | < 1,500 / < 8 / ≤ 2 |
| 独立唤醒源（各自持久化） | 3 | 1（Wake）+ 2 语义 |
| SDK 私有字段耦合点 | 1 + ~300 行 stub | 0 |

辅助门槛：**每一轮结束时 `npm run check` 必须保持 exit 0**（当前基线：110 文件 / 882 测试）。

若某一轮行数降了但上表四项没动，应判定为「又在瘦表面」，视为未达标。

## 8. 每轮自检清单

动手删任何一块前逐条问：

1. 它是否引入需要跨重启恢复的持久状态？（是 → 高价值目标）
2. 它的守护/治理状态**是否真的持久**？（否 → 说明现状并未兑现其承诺，见 4.1，应优先替换为固定策略）
3. 删它是否破坏消息不丢 / 任务不重 / 进程可恢复的底座？（是 → 停手重设计）
4. 它的消费面是**收敛还是发散**？（收敛先删，发散排后，见 4.3）
5. 是否已有现成开关可以先验证必要性？（有 → 先关掉观察，别直接删，见 4.2）
6. 它是「治理容器」还是「真实安全边界」？（前者删，后者下沉解耦，见第 5 节）
7. 删它是否依赖尚未拍板的产品定位？（是 → 先走决策轮）
8. 这个子系统当前是否处于「冻结」状态？（否 → 先冻结，避免边删边加，见 2.2）

## 9. 最终建议

第一轮瘦身证明了两件事：**方法是对的**（收窄语义宽度、不碰可靠性底座、全程保持 `check` 绿）；**但速度不对**——回收 560 行，同期增长 13,890 行。

而 2.3 的两次成功先例（删 Windows 支持、删 sandbox）证明：**这个项目有能力做整块能力删除，并在删完后保持健康。** 缺的不是能力，是把手术刀从配置面移到状态机的决心，以及一道「正在收缩的子系统不再接受加法」的闸门。

下一阶段的关键不是「再删多少行」，而是一个产品定位决定：

> Pipiclaw 的任务系统，是要继续做「受治理的自治工作单元」，还是收回到「可被重新唤醒的轻量待办 + 解耦的安全边界」？

4.1 已经给出了一个很强的暗示：**当前的治理连自己的守护状态都不持久化**，处在「代码成本已付、保证尚未兑现」的中间态。这种中间态既不该保留，也不值得补全——对个人 Agent，正确的方向是收回到简单确定的固定策略。

一旦拍板，R1 → R2 → R3a/b/c → R4 会自然连成一条线，砍掉 3,400～5,150 行**带恢复语义**的复杂度。那才是这轮瘦身的真正目标：不是让代码更短，而是**让每个还活着的机制只有一种清晰、可预测、容易恢复的工作方式**。

---

### 附：与前序报告的关系

- 本文**不替代** `pipiclaw-slimming-review-2026-07-24.md`——那份的能力目录、删除原则、风险迁移原则仍然有效。本文是它的**执行状态层、增长归因层和排期层**。
- 本文**协调** `pipiclaw-deep-review-2026-07.md` 的三个 P0（授权/幂等/评测）与瘦身目标：见第 5 节。deep review 的安全地基不应被瘦身误伤，只应被从任务状态机中解耦出来。
- 建议每完成一轮，在第 6 节表格更新状态、在第 7 节表格更新指标，使三份文档构成一条可追溯的瘦身轨迹。

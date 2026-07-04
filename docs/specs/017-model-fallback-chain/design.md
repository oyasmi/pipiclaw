# 备用模型（Model Fallback）设计方案

| 字段 | 值 |
|------|------|
| 分支 | `model-fallback`（建议） |
| 状态 | DRAFT |
| 日期 | 2026-07-04 |
| 关联实现 | `src/agent/channel-runner.ts`, `src/settings.ts`, `src/models/utils.ts`（复用）, `src/agent/session-events.ts` |
| 前置 | 无硬前置；与 spec 016 有联动点（切换事件入结构化日志、账本按实际成交模型归因） |

> 本版是对早先"fallback 链"草案的简化重写：**只有一个备用模型，没有链**。设计目标从"通用的多级容灾路由"收敛为"主模型不可用的那几个小时里，agent 还能正常干活"。配置一行，规则一句话。

---

## 一句话模型

> **主模型这一轮失败了（不是用户主动停止、也不是上下文超限），就换备用模型把这一轮重跑一次。之后 5 分钟内的新轮次直接用备用模型，5 分钟后自动试回主模型。**

用户需要理解的就是这一段。下面全部是实现细节。

## 背景（SDK 事实）

以下语义已从 `@earendil-works/pi-coding-agent` / `pi-ai` 源码验证：

1. **SDK 已有同模型 auto-retry**：`AgentSession` 读 `settingsManager.getRetrySettings()`（pipiclaw 默认 `enabled: true, maxRetries: 3, baseDelayMs: 2000` 指数退避）。429 / overloaded / 5xx / 网络中断这类瞬态错误会先在**同模型上**被重试。
2. **重试耗尽后**：turn 以 `stopReason: "error"` 结束，error assistant 消息留在 `agent.state.messages` 尾部；`session.prompt()` 正常 resolve（错误经消息状态而非异常传播）。
3. quota/billing/auth 类错误（`insufficient_quota`、401 等）SDK 判定为不可重试，**直接**以 error 结束 turn——不经过同模型重试。
4. context overflow 单独处理（交给 compaction），aborted 是独立的 stopReason。
5. `session.prompt()` 在发送前校验模型与 API key，无 key 直接抛错。

现状问题：turn 失败后用户只收到 "Sorry, something went wrong"。单模型单点——provider 故障或限流时整个 agent 不可用，直到人工 `/model` 切换。

**429 说明**（实际使用中最常见的失败）：429 → SDK 同模型退避重试 3 次（约 2+4+8 秒）→ 仍失败 → turn 以 error 结束 → **触发 fallback**。也就是说短暂限流由 SDK 原地消化，持续限流自动切备用模型。这是本设计的主场景。

## 目标

主 channel 轮次失败时，自动切到**唯一的备用模型**重跑本轮；主模型恢复后自动切回；用户全程可感知（切换提示、`/status` 可见）。

## 非目标

- **fallback 链 / 多级候选**：一个备用模型覆盖了"主模型不可用"的绝大多数场景；主备同时挂的概率不值得为之付出链路由、逐项冷却、逐项解析的复杂度。真有需要时本设计可平滑扩展（`fallbackModel` 字符串 → 数组），不留技术债。
- **子代理 fallback**：模型是 subagent 工具的显式参数，失败结果本就返回主 agent 由其决策。
- **sidecar 记忆任务 fallback**：已有 2 次内建重试。
- 负载均衡、成本路由、按任务类型选模型。

---

## 设计

### 1. 配置：一个键

`settings.json` 顶层新增（沿 `Partial<> + DEFAULT` 惯例接入 `PipiclawSettingsManager`）：

```json
"fallbackModel": "provider/model-b"
```

- 未配置（默认 `null`）＝功能关闭，`run()` 行为与现状完全一致。
- 启动/使用时用 `findExactModelReferenceMatch`（`src/models/utils.ts`）解析；解析失败或无 API key → logWarning 并视同未配置。
- **不引入** `enabled` / `chain` / `cooldownMinutes` / `maxAttemptsPerTurn` 等配置项。冷却时长为内部常量 `PRIMARY_COOLDOWN_MS = 5 * 60_000`，写死并在文档注明；需要调节时再提升为配置。

### 2. 触发规则：黑名单，不是分类器

turn 以 `stopReason: "error"` 结束即触发 fallback，**仅排除两类**：

| 排除 | 原因 |
|------|------|
| aborted（用户 `/stop`） | 用户意图，不该被"救" |
| context overflow | 归 compaction 管，换模型无意义 |

429、overloaded、5xx、quota/billing、401、网络错误——全部触发。连 400 invalid-request 也触发：备用模型上大概率同样失败，代价是多烧一次尝试，然后走正常错误路径——**为了规则可被一句话说清，这个代价可以接受**。相比早先草案的三分类白名单（transient-exhausted / provider-limit / auth），这里不需要维护任何错误模式表，也没有"未知错误算什么"的边界问题。

实现为一个小函数（与状态手术、补跑编排一起放 `src/agent/model-fallback.ts`——见 plan.md，为可测试性把这三样纯函数化集中在一个小文件）：

```ts
function shouldFallback(msg: AssistantMessage): boolean; // 非 overflow 即 true
```

（aborted 有独立 stopReason，不进这个判断。）

### 3. 执行机制：一次补跑

`ChannelRunner.run()` 中，现有的「prompt 一次」变成「最多两次」：

```
1. 保存本轮最终 promptText（含 recall / memory bootstrap 前缀，原样复用）
2. await session.prompt(promptText)
3. 若 stopReason === "error" 且 shouldFallback 且 备用模型可用 且 当前模型 ≠ 备用模型：
     a. 状态手术（见下）
     b. primaryFailedAt = now；await session.setModel(备用模型)
     c. 进度提示用户：`⚠️ 模型 X 出错（<原因摘要>），切换到 Y 重试…`
     d. 重置 runState.stopReason / errorMessage / finalOutcome → 回到 2（仅此一次）
4. 备用也失败或不满足条件 → 走现有错误路径；若补跑过，错误文案追加「备用模型 Y 也失败」
```

**状态手术**：从 `agent.state.messages` 尾部移除 `[user 消息, assistant(error) 消息]` 两条，然后在新模型上重新 `session.prompt()`（以获得完整 session 机制——auto-retry、compaction、扩展）。

- session 历史 / `context.jsonl` **保留**失败记录（审计友好）；重新 prompt 产生一条重复 user 条目，接受（见风险）。
- **防御断言**：手术前校验尾部两条确实是 `[user, assistant(stopReason=error)]`；不符则放弃 fallback、走原错误路径并 logWarning——**宁可不救，不弄脏上下文**。手术封装为单一私有方法，作为对 SDK state 形态的唯一耦合点（与 `_baseToolsOverride` 的既有模式一致：单点、有守卫、SDK 升级时大声失败）。

**其他要点**：

- 备用模型上的尝试同样获得 SDK 完整 auto-retry。最坏延迟 ≈ 两轮 SDK 退避（2+4+8s）× 2 ≈ 30s，可接受。
- `session.prompt()` 对无 key 的备用模型前置抛错 → 捕获后视同备用失败，走错误路径。
- **abort 交互**：`/stop` → `stopReason: "aborted"` → 不触发 → 自然退出。
- **steer/followup 交互**：失败轮中已排队的 steer 消息仍在 SDK 队列，重新 prompt 后由 SDK 正常 drain，不丢失。

### 4. 恢复：一个时间戳

`ChannelRunner` 内存态只有一个字段：`primaryFailedAt: number | null`。

- fallback 触发时记 `now`。
- 每次 `run()` 开始：若 `session.model ≠ activeModel`（用户首选）——
  - `now - primaryFailedAt > PRIMARY_COOLDOWN_MS` → `session.setModel(activeModel)`，回主模型；
  - 否则新轮次直接从备用模型开始（不必每轮都先撞一次主模型的失败）。
- fallback 切换**不写 settings、不改 `activeModel`**——`/model` 命令语义完全不受影响；进程重启即回主模型（内存态丢失，代价只是可能再撞一次错然后重新 fallback，可接受）。

### 5. 用户可感知

- 每次切换（去和回都算去向备用的切换；回主模型静默即可）发一条进度：full/rolling 模式走 progress queue；`final_card_only` 模式走 `respondInThread`。
- `/status`（批次 C 已实现，显示 `session.model`）追加一行：当 `session.model ≠ activeModel` 时显示 `Fallback: active（主模型 provider/x 冷却至 HH:MM）`。

### 6. 与 spec 016 的联动

- 切换写结构化日志：`event: "model_fallback", fields: { from, to, error }`。
- 账本 turn 条目的 `model` 字段取实际成交模型（`session.model`）→ 成本归因到真实提供方。

### 上游后续（fork 可改时）

最优形态是 SDK `_prepareRetry` 暴露 `onRetryModel?: (attempt, error) => Model | null` 钩子——mid-turn 换模型、无需状态手术。届时删除 run 中的补跑与手术，`fallbackModel` 配置与冷却逻辑原样保留。

## 测试

- **shouldFallback**：429 / 5xx / quota / 401 / 400 → true；context overflow → false。
- **run 补跑**（mock session）：
  - 主模型 error → 断言手术（尾部两条移除）、`setModel(备用)`、二次 prompt 文本与首轮一致；
  - 备用也失败 → 错误文案含「备用模型也失败」，只补跑一次；
  - 手术断言不满足（尾部形态异常）→ 不 fallback、原错误路径；
  - abort 不触发；备用无 key → 直接错误路径。
- **恢复**：冷却期内新轮次直接用备用；出冷却后 `setModel(primary)`。
- **默认关闭回归**：未配置 `fallbackModel` 时 `run()` 行为与现状完全一致。

## 落地

规模已小到不必分阶段：settings 一个键 + `shouldFallback` + run() 补跑与恢复 + 通知与 `/status` 行，一个 PR 合入（016 日志/账本联动可随 PR 或紧随其后）。

## 风险与权衡

- **状态手术依赖 agent.state.messages 尾部形态**：防御断言 + 单点封装 + 形态契约测试；SDK 升级时测试先红。
- **context.jsonl 重复 user 条目**：接受——"失败了一次、换模型重试了一次"本就是事实；对 session_search 的影响可忽略。
- **400 类请求错误也会烧一次备用尝试**：接受，换取触发规则零维护、零歧义。若实践中发现明显浪费，再加排除项。
- **中途换模型的语义差异**（长对话下半场换了"脑子"）：`/model` 手动切换本就允许同样的事，且有用户可见提示。
- **fallback 掩盖配置错误**（如主模型 key 填错，长期静默跑在备用上）：`/status` 的 Fallback 行 + 每轮切换提示保证不静默。

# 备用模型（Model Fallback）实施计划

| 字段 | 值 |
|------|------|
| 分支 | `model-fallback` |
| 状态 | DRAFT |
| 日期 | 2026-07-04 |
| 设计文档 | [design.md](./design.md) |

---

## 实施原则

1. 未配置 `fallbackModel` 时，`run()` 的行为与现状**逐字节一致**——不新增分支开销之外的任何可见差异。
2. 状态手术是对 SDK `agent.state.messages` 形态的唯一新耦合点，必须：纯函数化、防御断言、宁可不救不弄脏上下文（与 `_baseToolsOverride` 助手的既有模式一致，见 `channel-runner.ts` 中带告警的单点封装）。
3. 补跑循环的**决策逻辑全部放进可注入依赖的函数**，`ChannelRunner.run()` 只做接线——仓库没有 ChannelRunner 的 mock 测试座（session 在构造器内直接 `new AgentSession`），不为此引入重型 module mock。
4. 只补跑一次；只有一个内存态时间戳；不写 settings、不改 `activeModel`。

## 代码锚点（现状事实）

| 锚点 | 位置 |
|------|------|
| promptText 组装（recall 前缀 + memory bootstrap 前缀） | `src/agent/channel-runner.ts` `run()` 内局部变量 `promptText`（~253–288 行） |
| prompt 提交 | `sessionResourceGate.runPrompt(() => session.prompt(promptText))`（~302–305 行）；`promptSubmitted` 标志区分「抛错未入列」与「正常 resolve」 |
| stopReason/errorMessage 回填 | 两条路径：① session-events 从尾部 assistant 消息回填（`session-events.ts` ~255–259 行）；② `run()` catch 块（prompt 抛错时，~306–309 行） |
| 错误文案投递 | `run()` finally 中 `detailLines` 分支（~344 行，"Sorry, something went wrong"） |
| 进度通知既有模式 | compaction 失败通知：`queue.enqueue(() => ctx.respond(formatProgressEntry("error", …)))`（`session-events.ts` ~357–366 行） |
| `/status` 渲染 | `renderStatus()`（`src/runtime/bootstrap.ts` ~596 行），数据来自 `runner.getStatusSnapshot()` |
| `/model` 切换 | command-extension 回调里 `session.setModel(model)` + `this.activeModel = model`（`channel-runner.ts` ~726–727 行） |
| 账本模型归因 | 已取 `responseModel ?? formatModelReference(currentRunModel)`（`channel-runner.ts` ~397–403 行）——fallback 后自动归因到实际成交模型，**预期无需改动** |
| 模型解析 | `findExactModelReferenceMatch`（`src/models/utils.ts`） |

## 文件清单

新增：

| 文件 | 作用 |
|------|------|
| `src/agent/model-fallback.ts` | `PRIMARY_COOLDOWN_MS`、`shouldFallback`、`takeFailedTurn`（手术）、`runPromptWithFallback`（可注入依赖的补跑编排） |
| `test/model-fallback.test.ts` | 上述全部单测 |

修改：

| 文件 | 改动 |
|------|------|
| `src/settings.ts` | `Settings` 顶层新增 `fallbackModel?: string \| null`；manager 新增 getter |
| `src/agent/channel-runner.ts` | `run()` 接线补跑；`primaryFailedAt` 字段与恢复检查；错误文案追加；`getStatusSnapshot()` 增 fallback 字段 |
| `src/runtime/bootstrap.ts` | `renderStatus()` 增 Fallback 行 |
| `docs/configuration.md` | `fallbackModel` 配置说明 |

## Task 1：settings

- `Settings` 接口顶层加 `fallbackModel?: string | null`（一个字符串键，**不是**嵌套对象——见 design）。
- `PipiclawSettingsManager` 加 `getFallbackModelReference(): string | null`：trim 后空串/缺失/null 均返回 `null`。
- `applyOverrides` 走既有 `Partial<Settings>` 通道，无需特殊处理。

验收：未配置返回 `null`；配置返回原串；`settings.json` 中写入后重载生效（沿既有 settings 测试文件补用例）。

## Task 2：`src/agent/model-fallback.ts` 纯函数层

```ts
export const PRIMARY_COOLDOWN_MS = 5 * 60_000;

/** turn 以 error 结束时是否值得换备用模型重试。黑名单：仅 context overflow 返回 false。 */
export function shouldFallback(errorMessage: string | undefined): boolean;

/**
 * 状态手术：校验 messages 尾部为 [user, assistant(stopReason="error")]，
 * 符合则原地移除两条并返回 true；不符合则不动返回 false（调用方放弃 fallback）。
 */
export function takeFailedTurn(messages: Message[]): boolean;
```

- `shouldFallback` 的 overflow 判定：先核对 `@earendil-works/pi-ai` 是否导出 overflow 判定助手（设计核验时确认 context overflow 在 SDK 侧单独分类）；有则复用，没有则维护最小模式表（`context length` / `maximum context` / `prompt is too long` 等）并注明来源。**除 overflow 外一律 true**——429、5xx、quota、401、400 全部触发，无三分类、无白名单（design 第 2 节）。
- aborted 有独立 stopReason，不进 `shouldFallback`，由调用方分支排除。

验收：表驱动测试——429 / overloaded / 5xx / `insufficient_quota` / 401 / 400 → true；overflow 样本 → false；`takeFailedTurn` 对正确形态移除两条、对异常形态（尾部非 user/assistant、assistant 非 error、消息不足两条）原样返回 false 且数组不变。

## Task 3：补跑编排 `runPromptWithFallback`

依赖注入接口（名字可在实现时微调，保持这个粒度）：

```ts
export interface FallbackRunDeps {
	prompt(text: string): Promise<void>;          // 包含 sessionResourceGate 包装
	getRunError(): { stopReason: string; errorMessage?: string };
	resetRunError(): void;                        // 清 stopReason/errorMessage/finalOutcome/lastCompactionError
	getMessages(): Message[];                     // agent.state.messages（活引用，手术原地改）
	promptWasSubmitted(): boolean;                // 复用 run() 的 promptSubmitted 语义
	getCurrentModelRef(): string;
	resolveFallbackModel(): Model<Api> | null;    // 解析 + API key 检查失败返回 null（内部 logWarning）
	setModel(model: Model<Api>): Promise<void>;
	notifySwitch(from: string, to: string, errorSummary: string): void;
	markPrimaryFailed(): void;                    // primaryFailedAt = now
}

/** 返回是否补跑过（供错误文案与日志使用）。 */
export async function runPromptWithFallback(promptText: string, deps: FallbackRunDeps): Promise<boolean>;
```

流程（design 第 3 节的直译）：

1. `await deps.prompt(promptText)`（抛错由调用方 catch 回填 runError，与现状一致——编排函数内部 try/catch 后继续判断）。
2. 若 `stopReason !== "error"` → 返回 false。
3. 若 `!shouldFallback(errorMessage)` 或 `resolveFallbackModel()` 为 null 或 候选 === 当前模型 → 返回 false（走原错误路径）。
4. 手术：
   - prompt 正常 resolve（`promptWasSubmitted()`）→ `takeFailedTurn(getMessages())`；失败 → logWarning、返回 false（**宁可不救**）。
   - prompt 抛错未入列（如主模型无 API key 的前置抛错）→ 无消息可移，跳过手术直接切换。这一分支让"主模型 key 配错"也被备用模型兜住。
5. `markPrimaryFailed()`；`await setModel(候选)`；`notifySwitch(...)`；`resetRunError()`；再 `prompt(promptText)` 一次（同文本）。第二次无论成败都返回 true——不再循环。
6. 第二次 prompt 抛错同样由 catch 回填 runError，落入原错误路径。

`ChannelRunner.run()` 侧接线：

- 现有 `sessionResourceGate.runPrompt(...)` 调用替换为 `runPromptWithFallback(promptText, deps)`，deps 全部由 run() 现场闭包提供；未配置 `fallbackModel` 时 `resolveFallbackModel` 恒 null，流程退化为单次 prompt。
- **通知**：`notifySwitch` 复用 compaction 失败通知的模式——runQueue `enqueue(() => ctx.respond(formatProgressEntry("error", "⚠️ 模型 X 出错（…），切换到 Y 重试…")))`；`final_card_only`（不显示 progress）时改走 `ctx.respondInThread`，与 design 第 5 节一致。
- **错误文案**：run() 记住编排返回值 `fallbackAttempted`；finally 错误分支的 `detailLines` 当其为 true 时追加一行 `已切换备用模型 <ref> 重试，仍失败`。
- **abort**：`stopReason === "aborted"` 在第 2 步即返回 false，`/stop` 语义不变。
- **steer/followup**：SDK 队列中的消息在第二次 prompt 后正常 drain（design 已论证），不需要额外代码；用集成断言覆盖（见测试）。

验收见「测试策略」。

## Task 4：恢复（primary-first with cooldown）

- `ChannelRunner` 新增字段 `private primaryFailedAt: number | null = null`（`markPrimaryFailed` 写它）。
- `run()` 开头、`ensureSessionReady()` 之后：若 `session.model` 与 `activeModel` 不同——
  - `primaryFailedAt` 为 null 或 `now - primaryFailedAt > PRIMARY_COOLDOWN_MS` → `await session.setModel(this.activeModel)`，`primaryFailedAt = null`（静默，不发通知，design 第 5 节）；
  - 否则保持备用模型开跑。
- `/model` 命令回调（既有 `setModel` + `activeModel` 赋值处）追加 `primaryFailedAt = null`——用户手动切换即清除 fallback 状态。
- 进程重启丢内存态：接受，design 已注明。

## Task 5：可感知（/status + 结构化日志）

- `getStatusSnapshot()` 返回值增加：

  ```ts
  fallback?: { primary: string; cooldownUntilMs: number };  // 仅 session.model ≠ activeModel 时存在
  ```

- `renderStatus()`（bootstrap.ts）在 Model 行后追加：`- Fallback: active（主模型 <primary> 冷却至 HH:MM）`。
- 切换时写结构化日志：`event: "model_fallback"`，fields `{ channelId, from, to, error }`，沿 spec 016 的结构化字段通道（实现时核对 `src/log.ts` 现有 event 写法）。
- 账本：**核对即可**——现有 turn 条目已用 `responseModel ?? formatModelReference(currentRunModel)`，fallback 后自动归因到实际模型；补一条断言进现有 ledger 测试或在验证阶段人工确认，不预期改代码。

## Task 6：文档

`docs/configuration.md` 新增 `fallbackModel` 小节：

1. design 的"一句话模型"原文；
2. 429 行为说明（SDK 同模型退避重试 → 耗尽后切备用）；
3. 冷却为内部常量 5 分钟、重启回主模型；
4. 与 `/model` 的关系（fallback 不改首选，手动 `/model` 清除 fallback 状态）。

## 测试策略

全部进 `test/model-fallback.test.ts`（纯函数 + 注入 deps，无 module mock、无真实 SDK）：

1. **shouldFallback**：Task 2 的表驱动用例。
2. **takeFailedTurn**：正确形态移除、异常形态拒绝且不变。
3. **runPromptWithFallback**（fake deps 记录调用序列）：
   - 首次 error + 可 fallback → 断言顺序：手术 → markPrimaryFailed → setModel(候选) → notifySwitch → resetRunError → 第二次 prompt（文本与首轮**全等**）；返回 true。
   - 首次成功 → 单次 prompt，返回 false。
   - `resolveFallbackModel` 返回 null / 候选 === 当前模型 / shouldFallback false / stopReason "aborted" → 均单次 prompt、无 setModel。
   - 手术失败（takeFailedTurn false）→ 不切换、返回 false。
   - 首次 prompt 抛错（promptWasSubmitted false）→ 跳过手术、正常切换补跑。
   - 第二次也 error → 返回 true 且只 prompt 两次。
4. **恢复**：冷却判定逻辑若内联在 run() 中不便直测，则把「是否该回主模型」提成 `shouldRestorePrimary(primaryFailedAt, now)` 纯函数一并放 `model-fallback.ts` 测试。
5. **settings**：Task 1 验收用例。
6. **默认关闭回归**：fake deps 下 `resolveFallbackModel` 恒 null 时调用序列与现状单次 prompt 等价；另跑一遍现有 `bootstrap.test.ts` / e2e 确认无行为漂移。

## 验证

```bash
npx vitest run test/model-fallback.test.ts
npx vitest run test/model-utils.test.ts test/bootstrap.test.ts
npm run check        # lint + typecheck + knip + 全量测试
```

手动验证（可选，需要真实环境）：主模型 key 改错 → 发消息 → 观察切换提示与 `/status` Fallback 行 → 改回 key 等 5 分钟 → 下一轮回主模型。

## 完成定义

1. 未配置 `fallbackModel` 时行为与 master 无差异（回归测试通过）。
2. 配置后：主模型 error turn（含 429 重试耗尽、quota、401、主模型无 key 前置抛错）自动切备用补跑一次，用户收到切换提示。
3. 备用也失败时错误文案包含「备用模型也失败」。
4. 冷却期内新轮次直接用备用；出冷却自动回主模型；`/model` 手动切换清除 fallback 状态。
5. `/status` 在 fallback 生效时显示 Fallback 行；结构化日志有 `model_fallback` 事件；账本归因到实际成交模型。
6. `/stop`、steer/followup、compaction、context overflow 路径行为不变。
7. `npm run check` 通过。

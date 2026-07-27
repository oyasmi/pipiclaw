# Pipiclaw 杠杆效果 / 性能 / 体验 / 复杂度 评审（第二轮）

日期：2026-07-27
评审基线：`0.8.10-beta.3`（`master` @ 5521eed）
前一份：`docs/refer/leverage-and-experience-review-2026-07-27.md`（第一份报告 + 其上三轮修复记录）
评审方式：只读代码审查，从装配根沿真实调用链追踪；对关键结论用一次性 vitest 探针或实测脚本落到数字，不按注释推断

> **修复状态（2026-07-27，第一批）**：**E-6 ✅ / E-7 ✅ / E-8 ✅ 部分（拒绝死循环 + 口径写清；滚动窗口不做）/ E-9 ✅**（连带 U-5 ✅、U-6 ✅、C-5 在 `task_manage` 上 ✅）。逐项说明写在各条目末尾的引用块里。改动量：src 14 文件 +155/−101，test 6 文件 +181/−3；`npm run check`（lint + typecheck + knip + 912 tests）全绿。未动：E-8 的滚动窗口、P-6/P-7/P-8、U-7、C-1/C-2/C-3、C-5 对其它工具的抽查。

> **与前一份的关系**：那份报告的 E-1~E-5 / P-1~P-5 / U-1~U-4 / C-4 已落地，E-4 已撤销，剩 C-1 / C-2 / C-3 未动。本轮**不重复**那些结论，只在相关处引用。本轮的重点是：**上一轮的三次修复本身引入了什么新问题**，以及此前没被审到的面（工具 schema 成本、后台唤醒的前台开销、`task_manage` 的 schema 漂移）。

---

## 0. 一句话结论

上一轮把"节奏"修对了（E-2 的三档接续、E-3 的 effect 定义、E-4 的零轮询 playbook），但**这三处修复共同依赖一个 runtime 里并不存在的概念：可以"停泊"的任务状态**。结果是：文档教出来的那条最佳路径（`bash async` 等外部 agent + `waiting` 不设 wake），在代码里会被立刻叫醒、反复空转，三次之后被治理器暂停 —— 也就是说，**本项目最核心的用法，现在是被 runtime 主动惩罚的那一条**。

这是本轮唯一的红色项（E-6），其余是它的邻居（E-7 effect 归因、E-8 attempt 预算与 resume 死循环）和三条独立的性能/体验项。**修 E-6 是一行判断加一个测试**；不修的话，上一轮 E-2/E-3/E-4 的收益基本兑现不了。

---

## 1. 效果（Leverage）

### E-6 🔴 `waiting` 不是停泊态：零轮询委派的首选路径会被 driver 立刻叫醒，三次后被治理器暂停

**事实（已实测验证）。** 可推进判定只看两件事：状态是否终态、`wake` 是否到期：

```ts
export function isTaskActionable(frontmatter: TaskFrontmatter, now: number): boolean {
	if (!frontmatter.readable) return true;
	if (frontmatter.controlReadable === false) return true;
	if (TERMINAL_TASK_STATUSES.has(frontmatter.status ?? "")) return false;
	const wakeAt = parseWakeMs(frontmatter);
	if (wakeAt !== undefined && wakeAt > now) return false;
	return true;
}
```
（`src/shared/task-ledger.ts:179-187`；`TERMINAL_TASK_STATUSES` = done/cancelled/paused，`src/tasks/transitions.ts:27`）

我用一次性探针跑了这个函数：`{ readable: true, status: "waiting" }`（无 wake）返回 **`true`**；加上未来的 `wake` 才返回 `false`。也就是说 **`waiting` 且不设 wake ≡ 立即可推进**。

**这与三处文档同时矛盾，而且矛盾的方向不一致：**

| 出处 | 说法 |
|---|---|
| `src/tasks/transitions.ts:12` | `waiting → sleep until wake, then dispatch`（**代码没实现**） |
| `src/playbooks/task-delegation.md:40` | 首选路径：`progress` 置 `waiting` 且**不设 wake**，结束回合等 runtime 叫 |
| `src/playbooks/background-jobs.md:34` | 同上：置 `waiting`，**不必设 `wake`** |
| `src/playbooks/task-driving.md:29` | `waiting` + **合理 `wake`** |
| `src/playbooks/task-driving.md:58` | "可推进 = 非 done/cancelled/paused，且 `wake` 缺失、无效或已到期" ← 唯一说对了代码的一句 |

上一轮 C-4 刚把**门禁规则**收敛成单一真相源，紧接着第三轮的 E-4 修复又让**等待语义**分裂成三份，其中两份指向一个不存在的机制。

**完整后果链（每一环都在代码里可查）：**

1. 模型按 playbook 起等待作业：`bash async=true taskId=...` → `details.async !== undefined` ⇒ 计一次 effect（`src/agent/effect-ledger.ts:56`）。
2. `task_manage progress` 置 `waiting`、不设 wake、写 `blockedReason`。返回 `[SILENT]` 或一句话，回合结束。
3. `bootstrap.ts:924-927` 的 `finally`：先 `endTurn()` 再 `taskDriver.nudge?.()` —— 频道已不忙，50ms 后开扫。
4. 该任务 `actionable = true`（第 1 条）。上一次 attempt 是这轮的 dispatch，基线 `effects = E₀`；现在 `effects = E₀+1`。`attemptDelayMs`：`accepted=true`、fingerprint 变了、`effects > attempt.effects` ⇒ **返回 0**（`src/runtime/task-driver.ts:136-141`）。
5. **立刻重新派发。** 模型醒来发现作业还在跑，无事可做，返回 `[SILENT]`。
6. `[SILENT]` 不计 effect（`session-events.ts:344-347` 直接 return），fingerprint 不再变 ⇒ 落到 `stalledRetryMinutes`（60 分钟）档，且 `futileCount++`（`task-driver.ts:483-484`）。
7. 60 分钟后重复，再 60 分钟后重复。第 3 次 ⇒ `FUTILE_WAKE_LIMIT` 命中 ⇒ `escalateTask` 把任务置 `paused + pausedBy=governor`，并额外派发一个 `[TASK_ESCALATION]` 回合让模型去向用户解释"治理器停了你的任务"（`task-driver.ts:485-498`）。

**代价盘点。** silent 回合会退款 attempt（`src/tasks/store.ts:156-164`），所以不烧预算 —— 但**每一次都是一个完整的 LLM 回合**：1 次立刻重唤醒 + 2 次一小时档 + 1 次升级回合 ≈ 4 个白跑的回合，外加一条让用户以为出事了的告警。外部 agent 干活超过 2 小时（这恰恰是"值得委派"的门槛），必然踩满。

**判断。** 这不是 playbook 写错了，是**代码缺一个状态**。`transitions.ts:12` 那行注释描述的语义才是对的：`waiting` 的含义是"这件事要等外部信号"，而"外部信号"可以是 `wake` 到期、可以是 job 唤醒、可以是用户说话 —— 但绝不该是"driver 觉得该问问了"。现在 driver 无法区分"等着"和"闲着"。

**建议（优先级最高，改动最小）。**

1. `isTaskActionable` 增加一条：`status === "waiting"` 且无有效 `wake` ⇒ 返回 `false`（停泊，等外部唤醒）。这正是注释已经承诺、playbook 已经依赖的语义。
2. `task-driving.md:29` 与 `:58` 改口径，与 `task-delegation.md` / `background-jobs.md` 对齐：`waiting` + wake = 定时回访；`waiting` 无 wake = 停泊等唤醒。让 `task-delegation.md` 成为"等待形态"的唯一真相源（照 C-4 对门禁规则做过的那样）。
3. 补一条回归测试钉住"waiting 无 wake 不被 driver 派发"，以及一条钉住"job 唤醒后该任务能被继续推进"。
4. `/tasks doctor` 增加一项：`waiting` + 无 wake + 该 channel 没有携带此 `taskId` 的运行中 job ⇒ 提示"这个任务没有任何人会叫醒它"。这是让停泊不至于变成永久失联的兜底 —— 而且 doctor 本来就该管这类"没人会来"的一致性（它已经管了非法 wake、不可读 frontmatter、退休 control 键，唯独漏了这条）。

**为什么不是"给 waiting 自动补一个远期 wake"**：那等于用轮询模拟停泊，正是 E-4 第三轮明确要去掉的东西，而且 `task-driving.md:31` 自己写着"不要用极远的 `wake` 模拟暂停"。

---

> **✅ 已修复（2026-07-27，第一批）。** 按建议 1~3 实施，建议 4 顺延到 U-7（理由见下）。
>
> - **代码**：`isTaskActionable` 增加一条 —— `status === "waiting"` 且 frontmatter 无 `wake` 键 ⇒ 不可推进（`src/shared/task-ledger.ts`）。`wake` 存在但无法解析仍然 fail-open（手改坏的文件要暴露，不能永久停泊）。`transitions.ts:12` 的注释改成代码实际做的事。
> - **文档**：`task-delegation.md` 成为"等待形态"的唯一真相源（新增一句：`waiting` 无 wake = 停泊，`waiting` + wake = 定时回访）；`task-driving.md` 的两处（等待与继续、可推进定义）改口径并指回 delegation；`docs/events-and-tasks.md` 的 frontmatter 契约（第 3/5 条与 `wake` 行）同步——那份契约是单一事实源，不改它等于留下第四个版本。
> - **兜底**：`task_manage progress/set` 把任务置为停泊时，回执直接写明"driver 不会再叫你，等后台作业结束、用户消息或 `/tasks run`"（`describeTaskSchedule`）。停泊任务仍然进 task digest、仍然受 deadline/预算治理（已加测试）。
> - **测试**：`task-ledger.test.ts` 三条（无 wake 停泊 / 有到期 wake 仍回访 / 坏 wake 仍 fail-open）；`task-driver.test.ts` 两条（停泊任务 6 小时不被派发，改回 active 后立刻接续；停泊任务超 deadline 仍被治理器拦下）；`playbooks.test.ts` 一条钉住 delegation 是唯一真相源。
> - **未做（建议 4，doctor 补检）**：有价值的版本要"该 channel 没有携带此 taskId 的运行中 job"这一判据，而 job 记录归 `job-manager` 的 per-channel 管理器所有（需要 `Executor`），doctor 只是个纯读命令。要么给 doctor 注入 executor，要么在 doctor 里复刻 job 记录格式——两条都超出"加一条规则"的成本。只判 `waiting` 无 wake 会对每个健康的停泊任务报警，反而毁掉 doctor 的信噪比。留给 U-7 一起做。
> - **注意（行为变化）**：旧值 `blocked` / `awaiting-user` 在读取层映射为 `waiting`，所以历史上"blocked 且无 wake"的任务升级后会停泊而不是被轮询。这与这些状态的字面含义一致，且 `/tasks run` 一句话可解。

---

### E-7 🟠 effect 计数是 channel 级的，却被当成单个任务的进展证据

**事实。** 计数器按 channel 聚合：

```ts
const counts = new Map<string, number>();   // src/agent/effect-ledger.ts:20
```

driver 取的是 `getEffectCount(channelId)`（`bootstrap.ts:1005` 注入 `channelEffectCount`，`task-driver.ts:474` 调用），并把它同时写进 **fingerprint**（`task-driver.ts:109`，`effects:${effects}`）和**快档判据**（`:139`）。而 `noteChannelEffect` 的触发点里有一条是"给用户的最终回复"（`src/agent/session-events.ts:356`）。

**后果 A（多花钱）。** 用户在频道里随便说一句话 → 模型回一句 → `noteChannelEffect` → 该频道**每一个**任务的 fingerprint 都变了、且都满足 `effects > attempt.effects` ⇒ 全部进快档。回合结束 `nudge` ⇒ 立刻唤醒其中一个后台任务；那个任务的回合如果也产生 effect，结束时再 `nudge` ⇒ 再唤醒下一个（driver 每 channel 每 tick 派一个，且 `lastDispatchedTaskId` 做轮转）。**闲聊会点燃后台任务链。**

**后果 B（少管事）。** 反向同样成立：真正空转的任务，只要频道里还有别的活动，`fingerprint` 就一直在变，`futileCount` 永远归零（`task-driver.ts:484` 要求 `previous.fingerprint === fingerprint`）。空转检测在"频道活跃"时形同虚设 —— 而频道活跃恰恰是任务多、最需要检测的时候。

**判断。** spec 031 D7 用 effect 替代"模型自述"是对的判断，但**归因粒度错了一级**：证据要回答的是"**这个任务的这一次唤醒**做了什么"，计数器回答的却是"这个频道到目前为止一共发生过多少事"。上一轮 E-2/E-3 把这个计数器提升成了接续节奏的主判据，于是粒度错误从"轻微不公"变成了"直接决定花钱速度"。

**建议。** 把 effect 归因到回合：

- 最小改法：`counts` 的 key 从 `channelId` 改成 `channelId + 当前 dispatchId`（driver 派发时已经生成了稳定的 dispatchId，`task-driver.ts:162-165`），turn 结束时读该 key 的值 —— `bootstrap.ts:922` 的 `finally` 已经拿得到 `event.dispatchId`。
- 或者保留全局计数器，但 driver 只比较"**这一个任务的上一次 attempt 之后**该任务自己的回合产生了多少 effect"，由 `finishTaskAttempt` 顺路记进 control 的 telemetry（那里已经在记 tokens/cost/wallTime，多一个 `effects` 是同一类字段）。
- 无论哪种，`taskFingerprint` 里的 `effects:` 分量应该跟着换成同一口径，否则 fingerprint 依旧被邻居污染。

---

> **✅ 已修复（2026-07-27，第一批）。** 取第一条的**内存版**，不落盘：
>
> - `effect-ledger.ts` 保留 channel 计数器（它是测量点），新增一张按 `channelId+taskId` 的表和 `noteTaskEffects` / `taskEffectCount`。
> - `bootstrap.ts` 在 `runner.run` 前后各读一次 channel 计数器，把**这一个回合**的差值记到该回合所属的 task（回合在 channel 内本来就是串行的，差值就是这一回合干了什么）。`[TASK_DRIVER:<id>]` 的匹配结果已经在那儿，无需新增 dispatchId 管道。
> - driver 的 `getEffectCount` 签名变成 `(channelId, taskId)`，fingerprint 的 `effects:` 分量与快档判据自动同口径，两处不会再分叉。
> - 为什么不落盘到 `control.usage`：那要动 `TaskUsage` 结构、parse、三处 usage 字面量和一批固定了 control JSON 的测试夹具，换来的只是"重启后保留"——而 driver 的 attempt / futile 计数本来就是进程内的，重启后一起清零是既有的、有意的语义。
> - **测试**：`effect-ledger.test.ts` 两条（按任务分账、忽略非正差值）；`task-driver.test.ts` 一条钉住"邻居任务产生 effect 不会让本任务进快档，本任务自己的 effect 才会"——把 driver 那行改回按 channel 取数，这条测试立刻失败（已实测）。
> - **已知局限**：只有 TASK_DRIVER 回合会记账。作业完成唤醒（JOB 事件）里做的事不计入该 task 的 effect，所以停泊任务被唤醒后如果距上次派发不足 continuation delay，会多等一档。委派场景的等待通常远长于这个窗口，暂不为此再拉一条管道。

---

### E-8 🟠 `maxAttempts=12` 是一次性任务的**终身**上限；且 `/tasks resume` 在最常见的暂停原因下是个花钱的死循环

**事实一：预算是终身的。** `createDefaultTaskControl` 给 `budget: { maxAttempts: 12 }`（`src/tasks/control.ts:227`）。清零只发生在**周期任务**开新 cycle 时（`resetTaskControlForCycle`，`:326`）。一次性任务从创建到关闭，总共只有 12 次 driver 发起的非静默回合。

上一轮 E-2 的快档把这 12 次的墙钟从"1 小时/步"压到"秒级/步"。好处是不再空等，代价是**一个 20 步的长任务现在可以在几分钟内撞上治理器**，而不是半天。第一轮报告里"快档同样消耗一次 attempt，耗尽即被暂停"这句是准确的，只是当时没往下推一步：12 步就是这个 runtime 事实上的"长程"上限。

**事实二：resume 解不开。** `resumeTask` 把 status 设回 `active`、清 `wake` / `pausedBy` / `blockedReason`，**但不动 `usage.attempts`**（`src/runtime/task-commands.ts:324-339`）。于是：

1. attempts 耗尽 ⇒ `taskBudgetViolation` 返回 `attempt budget exhausted (12/12)`（`control.ts:402-404`）⇒ 治理器暂停 + 一个升级回合。
2. 用户按提示（U-1 修复后的 `/stop` 回执、`task-driving.md:60`、`/tasks` 的用法文本都在教这句）执行 `/tasks resume <id>`。
3. 下一个 tick：`taskBudgetViolation` **仍然成立** ⇒ 再派一个升级回合 ⇒ 再次 paused。

升级事件的 dispatchId 按 reason 哈希（`task-driver.ts:236`），第一次的记录在回合结束时已被 `markCompleted` 删除，所以第二次不会被去重挡下 —— **每按一次 resume 就白烧一个 LLM 回合，且永远回不去**。唯一出口是 `/tasks set <id> attempts <n>`（上一轮 U-4 加的）或让模型 `task_manage set maxAttempts`。`task-driving.md:52` 对**模型**讲了这条，但用户侧的三处入口一句都没提。

**建议（三条独立，可分别取）。**

1. **`resumeTask` 感知原因**：`pausedBy === "governor"` 且当前仍有 `taskBudgetViolation` 时，要么直接拒绝并把 `/tasks set <id> attempts <n>` 原话给出来，要么按显式确认把 attempts 清零。现在这样"看起来成功、实际立刻回退"是最差的一档。
2. **把 attempt 预算从"终身"改成"滚动窗口"**：例如 24 小时内 12 次。这样长程任务的横轴变成天而不是步数，而失控保护（短时间内疯狂重试）反而更强 —— 这正是快档需要的那种闸。
3. 若不想改语义，至少把默认值和"这是终身上限"写进 `task_manage` 的 schema 描述与 `task-planning.md`，让模型在创建长任务时主动调高。

---

> **✅ 部分修复（2026-07-27，第一批）：取建议 1 与 3；建议 2（滚动窗口）本轮不做。**
>
> - **建议 1（死循环）**：新增 `restartBlockedMessage`——`/tasks resume` 与 `/tasks run` 在写盘前跑一次 `taskBudgetViolation`，仍然违规就**不改状态**，直接返回诊断 + 精确修复命令（`/tasks set <id> attempts <n>`，带当前上限；有 deadline 时一并给出 deadline 命令），并提示"不该继续就 cancel"。一次判断、一段文案，两个入口共用。这条同时兑现了 U-5。
> - **建议 3（口径写清楚）**：`maxAttempts` 的 schema 描述改成"默认 12，一次性任务是终身额度（周期任务每周期清零）——长程任务创建时就调高"；`task-planning.md` 同步。
> - **建议 2（滚动窗口）不做**：把预算从"终身"改成"24 小时内 N 次"要引入时间窗口状态（窗口起点、窗口内计数、跨重启如何算、周期任务与窗口如何叠加），并把 `/tasks stats`、doctor、escalation 文案里"12/12"的语义一并改掉。这是新增一套机制，不是收紧一处判断——超出本轮"不显著增加复杂度"的边界。现在的出口（`/tasks set attempts`，且系统会主动告诉用户这条命令）已经把"死循环 + 无提示"降级成"一次明确的手动放宽"。真要做，应该单开一份 spec，连同"全局 spend guard"（spec 036 D1 已经指出成本闸应当是全局的）一起设计。
> - **测试**：`task-commands.test.ts` 一条走完整链路——治理器暂停的 spent 任务 → resume 被拒并给出命令（且磁盘上仍是 paused）→ run 同样被拒 → `/tasks set spent attempts 20` → resume 成功。

---

### E-9 🟠 `task_manage` schema 宣传了三个 runtime 已经不认的字段，而真正能开启独立验收的字段没有暴露

**事实。** `src/tools/task-manage/schema.ts` 的 `taskControlSchema` 仍然声明：

- `parent`（:15）、`dependsOn`（:16）—— 两者都在 `RETIRED_TASK_CONTROL_KEYS`（`src/tasks/control.ts:198-207`），写进去会被静默丢弃。
- `verificationMode: "evidence" | "independent"`（:31），描述里还写着"On create, defaults to evidence" —— 而 spec 036 D5 已经把 `mode` 塌缩成 `verification.required` 布尔（`control.ts:41-67`）。

反向的缺口更要命：实现读的是 `request.control?.verificationRequired`（`src/tools/task-manage/shared.ts:76`），而 **`verificationRequired` 根本不在 schema 里**。

**为什么类型检查抓不到。** `TaskManageRequest.control` 是手写成 `TaskControlPatch` 的（`src/tools/task-manage/types.ts:45`），与 typebox schema 之间没有任何类型联系。schema 和实现各写各的，`tsc` 两边都满意。

**后果。**

- **模型无法显式要求独立验收。** 它按 schema 会写 `verificationMode: "independent"`，被丢弃；能触发 `verification.required = true` 的只剩 `sideEffects: "external"` 的副作用规则（`control.ts:374-381`）。而"独立验收"是这个项目自主性的核心保险，现在只能靠侧门打开。
- **schema 主动鼓励模型表达依赖顺序，然后静默丢弃。** `control.ts:172` 的注释自己写着"dropping `parent`/`dependsOn` silently discards an ordering intent... which is exactly why it must be reported rather than only ignored" —— 报告做了（`/tasks doctor`），但**入口没关**，等于一边挖坑一边在坑边立牌子。
- 约 500 字符的 schema 描述纯浪费，且落在每回合都要付的那段（见 P-6）。

**建议。** schema 删 `parent` / `dependsOn` / `verificationMode`，加 `verificationRequired: Type.Optional(Type.Boolean(...))`；同时把 `TaskManageRequest` 改成从 schema 推导（`Static<typeof taskManageSchema>`），让这类漂移变成编译错误而不是运行时惊喜。这是一次纯减法 + 一次类型收紧。

---

> **✅ 已修复（2026-07-27，第一批），含 C-5 在 `task_manage` 上的落地。**
>
> - **schema**：删 `parent` / `dependsOn` / `verificationMode`；加 `verificationRequired`（布尔，描述吸收了原 verificationMode 里仍然有效的那半句"只在产物可被只读验收者检查时才开"）。模型现在可以显式要求独立验收，不必再走 `sideEffects: external` 的侧门。
> - **类型**：`TaskManageRequest = Omit<Static<typeof taskManageSchema>, "label" | "status">`，工具 `execute` 的第三份手写 args 类型整段删除（`AgentTool<S>` 本来就按 schema 给 args）。schema 与实现之间从此有类型桥：再删一个实现要读的字段就是编译错误。
> - **两处例外，都是有意的**：(a) `status` 保留 `string`——它在代码里按转换表校验，好让 `"open"` / `"done"` 拿到一句能改对的错误，而不是一条 schema 拒绝；顺带绕开 typebox 对 `SETTABLE_TASK_STATUSES.map(...)`（数组而非元组）推不出字面量联合的问题。(b) `applySet` 里"agent 不能自授予 approval"的守卫保留：schema 根本不提供 `"granted"`，但这条守卫是最后一道防线，改为经 `TaskControlPatch` 视图判断，测试用一次显式 cast 模拟绕过 schema 的调用方。
> - **顺带收益（P-6）**：`JSON.stringify(taskManageSchema)` 从 4,978 → 4,694 字符（−284，−5.7%）。P-6 建议里"把九个 action 的长描述挪进 playbook"没做——那是 P-6 自己的工作项，且要重新校准模型对 action 的选择，不该混进这次减法。
> - **测试**：`task-manage.test.ts` 新增 schema 形状两条（不得出现任何 `RETIRED_TASK_CONTROL_KEYS` 与 `verificationMode`；必须出现 `verificationRequired`）。`verificationRequired` 的功能路径本来就有测试覆盖——这恰好说明问题只在"模型看得见的那一面"。

---

## 2. 性能

### P-6 🟠 工具 schema 是每回合固定成本的大头，也是唯一没有预算的一段

**实测数字**（默认 security/tools 配置 + mediaSender，13 个工具；用一次性 vitest 探针构造真实工具集并按 `/context` 的口径统计 `name + description + JSON.stringify(parameters)`）：

| 项 | 字符 |
|---|---|
| **工具 schema 合计** | **19,225** |
| `task_manage` | 5,337（28%） |
| `subagent` | 3,351（17%） |
| `memory_manage` | 1,566 |
| `bash` | 1,323 |
| `skill_manage` | 1,216 |
| `event_manage` | 1,066 |
| `grep` / `session_search` / `job` / `edit` / `send_media` / `read` / `write` | 1,001 / 907 / 845 / 738 / 730 / 681 / 464 |
| **runtime-authored system prompt 合计** | **2,541 字符 / ~798 est tokens** |

**判断。** spec 026 给 runtime 自撰的 prompt 段落定了 700 / 1200 unit 的软硬两档预算，超标产 diagnostic，`/context` 能只读地看分解 —— 这套东西做得很好（第一轮"值得保持的"第 1 条）。但**被严格看管的那一段只有 2.5k 字符，旁边 7.5 倍大的工具 schema 一个字节都没管**。`/context` 的注释已经承认它"often the larger half"，只是承认了没有闸。

这段在 provider 的 cache prefix 里，稳态是 cache-read 价（约 1/10），所以不是灾难；但 **每次 `rebuildSessionTools`（`skill_manage` 写入、`/reload`、任何 resource reload）都会换掉 prefix，触发一次全额 cache-write**。

**建议。**

1. 给工具 schema 一个和 prompt 段落同规格的预算 + diagnostic（复用 `countPromptUnits` 与现有的 diagnostic 管道，`/context` 已经在算这个和了，只差一条阈值）。
2. 先砍 `task_manage`：E-9 的三个退休字段先删；九个 action 的长描述（单条就 400+ 字符）挪进 `task-planning.md` / `task-closeout.md`，schema 里只留"读哪份 playbook"。这两个工具占 45%，动它们收益最直接 —— 而且这是全项目唯一一处"删字面量就直接省钱"的地方。

### P-7 🟡 后台唤醒默认走完整 progress 卡，长程自主的常态成了前台噪音的常态

**事实。** `responseMode` 默认 `full_progress_then_plain_final`（`src/settings.ts:200`、`src/runtime/bootstrap.ts:173`）⇒ `progressStyle = "full"`（`dingtalk.ts:41-45`）。合成事件（TASK_DRIVER / JOB / EVENT）走的是同一条 `createDingTalkContext`，`handleEvent` 只对它们跳过卡片**预热**（`bootstrap.ts:893-895`），progress 条目照样会懒建卡片。

于是每一次后台唤醒都会：在钉钉会话里建一张卡 → 逐条推工具标签和 **thinking**（`session-events.ts:310-313` 对每个 thinking part 都 enqueue 一条，默认 thinking level 是 `medium`）→ 若最终 `[SILENT]` 再把卡删掉（`channel-runner.ts:519-526`）。每条 progress 还会顺带落一次盘（`delivery.ts:118-122, 152-154` 的 `archiveBotResponse`）。

**判断。** 上一轮 U-3 给 rolling 模式加了常驻计时表头，是对的；但**默认不是 rolling**。对一个以"后台自主推进"为核心用法的项目，默认配置让每次自主推进都在人的会话里闪一次卡、并把模型的思考流推到对话里 —— 这既是钉钉侧的 API 调用，也是人的注意力成本。

**建议。** 按事件来源分档：用户消息保持 `full`；合成事件（`_isEvent === true`）默认降到 `rolling` 或 `none`，把"后台在忙什么"留给 `/status` 和 `/tasks` 去回答。这不需要新配置项 —— `handleEvent` 已经有 `_isEvent` 这个参数，只是目前只用来决定要不要预热卡片。

### P-8 🟡 driver 每次 tick 重读 `settings.json` + `tools.json`

`bootstrap.ts:1006-1010`：`getSettings` 每 tick `reload()`，`isEnabled` 每 tick `loadToolsConfig(appHomeDir)`。而 tick 由 `nudge()` 驱动 —— **每个回合结束都会触发一次**（`bootstrap.ts:927`）。所以每回合至少两次同步读盘 + JSON 解析 + retired-key 扫描。

量级不大（两个几 KB 的文件），但它和第一轮 P-1（维护 tick 在 gate 之前就读 settings）是同一形状的问题，只是当时只审了维护路径。E-2 落地后 tick 频率显著上升，这条跟着被放大。可与 P-4 的任务缓存用同一套 `(mtimeMs, ctimeMs, size)` 指纹解决。

---

## 3. 体验

### U-5 🟠 用户被三处入口教去按一个在最常见场景下无效的按钮

这是 E-8 的体验面，单列因为它触及的是"用户对系统的信任"：

- `/stop` 的回执（上一轮 U-1 的修复）："任务 `<id>` 已暂停，用 `/tasks resume <id>` 继续。"
- `/tasks` 的用法文本（`task-commands.ts:79`）："`/tasks resume <id>` — 让暂停的任务在下一轮扫描中恢复"
- `task-driving.md:60`："`paused`：用户 `/tasks resume <id>`。"

三处都对**用户 pause** 的场景成立。但用户实际最常遇到的暂停原因是**治理器暂停**（attempts 耗尽或连续 3 次空转），而 resume 对前者无效（E-8）、对后者也只是让它立刻再空转三次（E-6 / E-7）。回执说"已恢复任务 X，任务驱动器下一轮扫描会接上"，几分钟后任务又躺回 paused，中间还多花了一个回合 —— 用户看到的是"这系统在骗我"。

**建议。** `resumeTask` 在写盘前先跑一次 `taskBudgetViolation`：仍然违规就不改状态，直接返回诊断 + 精确的修复命令。一次判断，一段文案。

> **✅ 已修复（随 E-8 建议 1）。** `/tasks resume` 与 `/tasks run` 共用同一条判断，被拒时给出当前上限与确切命令。三处入口的文案没有改：它们对用户 pause 的场景仍然成立，而治理器暂停的场景现在由系统在用户按下按钮的那一刻当场解释——比在三处入口各加一段免责声明更省字、也更难过期。

### U-6 🟡 "等待"的做法在 playbook 里有三个版本

见 E-6 的表格。C-4 刚把**门禁规则**收敛到 `task-closeout.md` 作为单一真相源，第三轮的 E-4 修复紧接着让**等待语义**分裂成三份。修 E-6 时应当顺手把这条一起收敛，并像 C-4 那样补一条测试钉住"delegation playbook 是等待形态的唯一真相源"（第三轮已经有一条类似的测试钉住它必须提到 `bash async`，扩一条即可）。

> **✅ 已修复（随 E-6）。** 四处（两份 playbook + `transitions.ts` 注释 + `events-and-tasks.md` 的 frontmatter 契约）统一到同一句话，`playbooks.test.ts` 按建议扩了一条测试。

### U-7 🟡 `/tasks doctor` 不检查"没人会来叫醒它"

doctor 已经覆盖不可读 frontmatter、非法 `wake`、退休 control 键、孤儿事件。缺的恰好是停泊类的一致性：`waiting` 无 wake 且无关联 job（E-6 的建议 4）、attempts 已耗尽却还是 `active`、`verification.required` 但从没有过 attestation。这三条都是"任务安静地死掉"的形状，而 doctor 存在的意义就是让安静的失败变响。

---

## 4. 复杂度可控性

上一轮的 C-1（维护面比例）、C-2（0.9.0 砍兼容层）、C-3（唤醒模板集中）**本轮全部仍然成立且未动**，不重复论证。复核数字：

- src 仍是 ~150 文件 / 32.1k 行；`memory/` 27 文件 / 6076 行仍是最大域，`tasks/` 920 行 + `job-manager` 620 行 + `subagents/` 1549 行 ≈ 3.1k 行仍是撬动杠杆的三块。比例没变。
- docs 61 个 md / 21.7k 行（36 个 spec 目录），与源码之比 ~0.67:1。
- C-2 的兼容包袱都还在：`RETIRED_SETTINGS_KEYS` 45 项、`migrateLegacyAppHome`（`bootstrap.ts:305, 332` 两处 `FIXME(0.9.0)`）、`paths.ts:19` 的同名 FIXME、`migrateLegacyTaskScheduleEvents`（`bootstrap.ts:1114`，每次启动都跑）。

**本轮新增一条：**

### C-5 🟡 手写请求类型与 typebox schema 并行，是这一类"文档说有、代码没有"漂移的结构性原因

E-9 不是孤例，而是一种模式：工具的**对外契约**（typebox schema，模型看得见）和**对内契约**（手写 interface，实现看得见）是两份独立维护的东西，中间没有类型桥。`task_manage` 上已经漂了三个字段进、一个字段出，而 `tsc --noEmit`、knip、893+ 项单测全部通过 —— 因为没有任何一层同时看得到这两份。

对一个个人项目，这类漂移的成本不是"用户报 bug"，而是**模型按不存在的能力行动，失败得很安静**，恰恰是最难自查的一类。

**建议。** 凡是 schema 与实现之间需要对齐的工具，请求类型统一改为 `Static<typeof xxxSchema>`，让 schema 成为单一真相源。`task_manage` 是最该先做的（字段最多、漂移已经发生）；`subagent`、`event_manage`、`memory_manage` 值得同时抽查一遍是否有同样的问题（本轮未逐一核对，见第 6 节盲区）。

> **✅ 部分修复（随 E-9）：`task_manage` 已改为从 schema 推导，工具里第三份手写 args 类型一并删除。** `subagent` / `event_manage` / `memory_manage` 未动 —— 那是一次独立的抽查，而不是这次减法的一部分；做的时候注意 typebox 对"用 `.map()` 生成的字面量联合"推不出类型（`status` 就是踩到这个才保留 `string`），逐个工具都可能遇到。

---

## 5. 优先级建议

按「对核心用途的收益 ÷ 改动成本」排序：

| # | 项 | 类型 | 为什么排这里 |
|---|---|---|---|
| 1 ✅ | **E-6 `waiting` 停泊语义** | 效果 🔴 | 一行判断 + 一条测试 + playbook 对齐。不修的话，上一轮 E-2/E-3/E-4 三次修复的收益基本兑现不了 —— 最推荐的用法恰好是被惩罚得最狠的那条。 |
| 2 ✅ | **E-8 resume 死循环**（做了"拒绝并给出正确命令"那一半） | 效果/体验 🟠 | 一次判断 + 一段文案。当前状态会主动消耗用户的信任和 token。 |
| 3 ✅ | **E-9 + C-5 `task_manage` schema 对齐** | 效果/复杂度 🟠 | 纯减法（删三个字段）+ 一次类型收紧。同时解锁"模型可以显式要求独立验收"，并直接砍掉 P-6 的一部分。 |
| 4 ✅ | **E-7 effect 归因到回合**（按任务，内存版） | 效果 🟠 | 改动集中在 `effect-ledger` 的 key 与 driver 的读取点。它是 E-2 快档的判据，粒度错一级就直接体现在花钱速度上。 |
| 5 ⏸ | **E-8 attempt 预算改滚动窗口**（本轮不做：新增机制，超出"不显著增加复杂度"边界） | 效果 🟠 | 比 #2 大一些，但这是"长程"这个词能不能兑现的分水岭：12 步 vs 12 步/天。 |
| 6 | **P-7 合成事件降级 progress** | 性能/体验 🟡 | 用已有的 `_isEvent` 参数，几行。后台自主是常态，前台安静就该是常态。 |
| 7 | **C-2 0.9.0 砍兼容层**（沿用上一轮结论） | 复杂度 | 纯减法，几百行 + 对应测试。 |
| 8 | **P-6 工具 schema 预算** / **U-7 doctor 补检** | 性能/体验 🟡 | 都是"给已有管道加一条阈值/规则"，可与 #3 合并做。 |
| 9 | **P-8 driver tick 配置缓存** / **C-3 唤醒模板**（沿用上一轮） | 性能/复杂度 🟡 | 与上一轮 P-08 合并做更便宜。 |

**已执行的第一批 = #1 + #2 + #3 + #4。** 原建议是 #1+#2+#3；#4 一并做了，因为 E-6 修好之后 effect 归因就是快档唯一的判据，两条分开做会留下一个"停泊修好了、但闲聊仍然点燃后台任务链"的中间态。

**建议的第一批**：#1 + #2 + #3 是一个自洽的小包 —— 它们共同回答同一个问题："当模型把工作交给外部执行体之后，这个 runtime 应该做什么、不该做什么"。三条一起做完，那条零轮询路径才第一次真正跑得通。

---

## 6. 本轮盲区

- **未跑 `npm run check` / `npm run eval`。** 除下述实测项外，结论来自静态追踪。
- **实测了什么**：(a) `isTaskActionable` 对 `waiting` 无 wake / 有未来 wake 的返回值（一次性 vitest 探针，跑完即删）；(b) 工具 schema 与 system prompt 的字符/token 分布（用真实 `createPipiclawTools` + `buildPipiclawSystemPrompt` 构造后统计，同样跑完即删）。**没有实测的是 E-6 的完整后果链** —— 第 1~7 步是从代码逐环推出来的，每一环都有 file:line 依据，但没有端到端跑一次"起 job → 置 waiting → 观察 driver 行为 → 三次后 escalate"。这条链值得用 `TaskDriver.runOnce` + `onTaskDriverDispatch` 观察点写一个集成测试实证（`bootstrap.ts:592-593` 已经为此暴露了钩子），也正好是修复后的回归测试。
- **未逐一核对其它工具的 schema/实现漂移**（C-5 只确证了 `task_manage`）。`subagent`（3.4k 字符 schema）、`event_manage`、`memory_manage` 值得同样抽查一遍。
- **未审 `src/web/`（1119 行）与 `src/tui/`（1232 行）**。前者本轮完全没进；后者与上一轮一样只从 `ChannelContext` 第二实现的角度确认没破坏抽象，没有单独审它的体验，也没有核对它是否复现了 E-6/E-7 的行为（TUI 没有 daemon，driver 语义本就不同）。
- **未连真实钉钉**，P-7 的噪音判断来自代码路径与默认值，不是真人回归。
- **未审上游 `@earendil-works/pi-coding-agent` 0.80.10**：`AgentSession` 的 compaction、steer 队列、resource reload 行为按其公开契约理解。特别地，`systemPromptOverride` 的调用频率没有实测，P-6 里"每次 rebuild 触发一次全额 cache-write"是按 prefix 语义推的。

---

## 7. 值得保持的（本轮新增，不要在优化中弄坏）

上一轮列的六条依然成立。本轮补两条：

1. **`DurableDispatchService` 的租约续期语义。** `running` 集合表达"持有者还活着"而不是"一个回合最多 N 分钟"（`durable-dispatch.ts:94-102, 201-207`），长回合因此不会自己重投自己，进程死掉的回合又能在租约到期后被正确重投。这是"至少一次"投递里最容易做错的一处，这里做对了。它也是 E-6 修复之后那条零轮询路径能可靠闭环的前提 —— 修 E-6 时不要碰它。
2. **`finishTaskAttempt` 对 silent 回合的退款。** `store.ts:156-164`：静默回合保留成本审计但退还 attempt 名额。这条设计正确地把"没做事"和"花了钱"分开记账 —— 它也是 E-6 那条错误路径**没有**演变成"12 次预算几分钟烧光"的唯一原因。修 E-6 时它同样是安全网，别顺手删掉。

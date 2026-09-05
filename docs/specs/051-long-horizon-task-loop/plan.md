# 051 实施计划

设计见 [design.md](./design.md)。**四个阶段**，每个阶段结束时 `npm run check` 与 `npm run test:e2e` 必须绿，且每个阶段都能独立发布。

顺序的原则是**先修真实故障、再降成本、最后收文档**：P1 结束时 F1（停泊即失踪）已经修好，P2/P3 是让它更便宜、更可见。

> **本轮不做 events 退役。** 原 P4（提醒任务 + `gate` + events 迁移）按用户决定取消；`events` 子系统保留原样，只在 `EventsWatcher.execute` 里加一个 `signal` 票兑现分支（design D8），随 P1 一起落地。

## 阶段总览

| 阶段 | 交付 | 可独立发布 | 主要删除 |
|---|---|---|---|
| P1 契约与票据 | v4 frontmatter + 票据写入校验 + `by` 兜底 + 二次过期 receipt + `signal` 兑现分支 + v3→v4 迁移 | 是（step 仍跑在频道会话，仍有 backoff） | `control` 的 v1/v2/v3 解析、`waitingFor`、`transitions.ts` 的 action×status 矩阵 |
| P2 日志与账本 | `<id>.jsonl` + `task_log` + `## History` 退役 + 返工账本 + 验收自动导入 + 成本归因 | 是 | `task_verify`、`MAX_INLINE_TASK_HISTORY_*`、`## History` 折叠 |
| P3 任务会话与循环 | 任务会话 + `task_step_end` + 零延迟续跑 + 预算 + 空转检测 | 是 | `effect-ledger.ts`、指纹、futile/wake 计数、三档 backoff、`[SILENT]`（任务侧） |
| P4 文档与质量证据 | `task-loop.md` playbook、顶层手册重写、evals 集 | — | `task-driving.md`、`task-planning.md`（合并） |

---

## 给实施 agent 的总纲

**先读，按这个顺序：**

1. `docs/specs/051-long-horizon-task-loop/design.md` 的 **§12 实施契约**（规范性；类型和不变量以它为准）
2. design.md 的 §3（对象模型）与 §4（D1–D14）
3. `AGENTS.md` 的「Test Layering」与 e2e 六条硬规则
4. 本阶段小节的「前置阅读」列出的现有文件

**七条不变量**（design §12.5）是本 spec 的验收标准，每条至少一个测试：INV-1 `parked ⟺ ticket`、INV-2 票只能由 `resolveTicket` 产生且必有 `by`、INV-3 停泊必有结局、INV-4 兑现幂等、INV-5 任务 step 不进频道会话、INV-6 契约 ≤ 4 KB、INV-7 只有 `signal` 票能被事件兑现。

**不许碰的东西**（design §12.6）：`events.ts` 除一个 `signal` 分支外零改动；其余三个 event 文件完全不动；`SubAgentRunManager` 的 settlement 唯一所有权与幂等标记；`internalWake` 信任链；`workingDirectory`/`mutates`/lease；`verification.ts`/`artifact-subject.ts` 的算法；`settings.json` 不加数值键；迁移不删原件。

**工作方式：**

- 一个阶段一个分支（`feat/051-p1-tickets` 等），阶段内可以多次提交，提交信息用 conventional commit 并注明 `(spec 051, P<n>)`。
- 每个阶段结束跑 `npm run check` + `npm run test:e2e`；触及 runtime/委派/命令面时两个都必须跑。
- **每个新增的确定性 e2e 用例，合并前做一次破坏性检查**：把它守的代码改回旧行为，确认用例变红，把这句话写进用例注释（`AGENTS.md` e2e 规则 4/6）。
- 与计划的偏离**写进本文件对应阶段的「实施记录」小节**（照 050 的做法），不要偷偷改设计。
- 拿不准时优先保守：多留一个兼容读取器，好过让一个真实任务文件读不出来。

---

## P1 契约与票据

**目标：** INV-1 / INV-2 / INV-3 / INV-4 / INV-7 成立。本机那两个死任务在升级后自己活过来。

**完成定义：** 升级本机 `~/.pipiclaw` 后，`fix-tui-typecheck` 变成 `open` 并被排上；`/tasks` 每行显示票据摘要与兜底时间；一张永不兑现的票在 `by` 之后必然导致重开或 receipt。

### 前置阅读

`src/tasks/{control,ledger,store,transitions,task-schedule,task-events}.ts`、`src/runtime/{task-driver,task-wake,task-migration,task-commands}.ts`、`src/tools/task-manage/**`、`src/shared/wake-claim.ts`、`src/runtime/events.ts:660-720`（`orphanedOwnerReason` / `execute`）。

### 新文件

| 文件 | 职责 | 参考现有 |
|---|---|---|
| `src/tasks/ticket.ts` | design §12.1 的类型与 `resolveTicket` / `ticketExpired` / `describeTicket`；`by` 推导表；**依赖用注入的 `TicketContext`**，不 import run/job/event 管理器（可单测） | `control.ts` 的解析与枚举风格；`task-wake.ts` 的 `isVerifiedJobWake` / `isVerifiedDelegationWake` 是校验语义的来源 |
| `src/tasks/frontmatter.ts` | design §12.2 的 v4 读写；固定渲染顺序；对象值一行 JSON | `ledger.ts:parseTaskFrontmatter` / `renderTaskDocument` |
| `src/tasks/cycle.ts` | 开/关 cycle：cycleId 生成、`TaskCycle` 复位、Plan 复位、`## 上次结果` 写入（P2 才接日志） | `store.ts:openRecurringTaskCycle` / `nextCycleId`；`ledger.ts:startTaskCycle` |

### 改动

| 文件 | 改动 |
|---|---|
| `src/tasks/control.ts` | 删除。v3 读取器（`parseTaskControl` 的 v3 分支 + `parseLegacyTaskControl`）搬到 `src/runtime/task-migration.ts` 内部，**只有迁移器可以调用** |
| `src/tasks/transitions.ts` | 删除。合法性由 `state` + `outcome` 推导 |
| `src/tasks/store.ts` | `activateWaitingTask` / `rollbackWaitingTask` / `escalateTask` → `redeemTicket(channelDir, id, expected, dispatchId)`（幂等，按 `dispatchId` 去重，复用 `shared/wake-claim.ts`）+ `pauseTask(channelDir, id, paused)`。`redeemTicket` 校验「当前票是否就是要兑现的那张」，不匹配即 no-op |
| `src/tasks/ledger.ts` | `TaskLedgerEntry`：去掉 `actionable`，改为 `dueAt?: number` + `expiredAt?: number`；`recurringTaskMissedOccurrence` 删除（并入 `schedule` 票的过期路径）；frontmatter 解析委托给 `frontmatter.ts` |
| `src/runtime/task-driver.ts` | 扫描改为「收集到期票 / 过期票 / `open` 任务」三类；实现 design D2 的兜底两步（重开 → 二次过期 receipt）。**本阶段暂留** fingerprint / backoff / futile（P3 删），但它们只作用于 `open` 任务的重复派发 |
| `src/runtime/task-wake.ts` | `claimVerified*Wake` 改为兑现 `run`/`job` 票（调用 `redeemTicket`）；`isTrustedInternalWake` 与 `beginWakeConsumption` 的信任链**一字不改** |
| `src/runtime/events.ts` | **唯一改动**：`execute()` 里 `orphanedOwnerReason` 之后插入 `signal` 分支——`parseTaskEventName` 命中、且该任务正停在 `event` 等于本事件名的 `signal` 票上 → `redeemTicket` 并 `return`，不投递唤醒文本；否则原路径不变。写一条 `pre_action_passed` 之后的历史记录说明兑现了哪个任务 |
| `src/tools/task-manage/schema.ts` + `lifecycle.ts` | `task_update` 的 `status` / `wake` / `control` 参数 → `park: {ticket}` / `open: true`；`task_close` 的 `skip` 语义改为「关闭本 cycle 并停到 `schedule` 票」 |
| `src/runtime/task-migration.ts` | 重写为 v3→v4（design D14 的五条）。**关键一条**：`waiting` 且推不出恢复源 → `open` + 在 `## 上次结果` 留一句「迁移时等待无可兑现来源，请先确认真实状态」。写 `state/task-migration-v4.done` |
| `src/runtime/task-commands.ts` | `/tasks` 与 `/tasks show` 显示 `describeTicket(ticket)` + 兜底时间；`doctor` 删掉已被 INV-1/2 消灭的检查项，只留手改文件的检查 |
| `src/memory/task-digest.ts` | agenda 行改为 design D11 形态（含票据摘要），保持 `TASK_AGENDA_MAX_UNITS = 600` 预算不变 |

### 删除

`src/tasks/control.ts`、`src/tasks/transitions.ts`、`test/task-control.test.ts` 的 v1/v2 兼容用例（迁移相关的搬到 `task-migration.test.ts`）。

### 测试

**单元**

- `test/task-ticket.test.ts`：六种票 × 校验矩阵（design D2 表格逐行），含四种拒绝文案；`by` 推导表六行；`ticketExpired` 边界。
- `test/task-frontmatter.test.ts`：v4 往返、渲染顺序、INV-1、手改文件的降级读取。
- `test/task-migration.test.ts` 重写：fixture `test/fixtures/tasks-v3/`，放三份脱敏真实文件——`fix-tui-typecheck.md`（waiting 无来源）、`daily-pipiclaw-dev-review.md`（sleeping + schedule + 24 KB History）、一份 archived。
- `test/task-events.test.ts` 扩展：`signal` 票与事件名的匹配/不匹配。

**e2e**（`test/e2e/deterministic/tasks.test.ts` 内新增）

| 用例 | 断言（只看副作用） | 破坏性检查 |
|---|---|---|
| **E1** | 任务停在 `run` 票，run 永不结算；推时钟过 `by` → 任务变 `open` 且被派发；再停再过期 → 收到 receipt，**模型请求数为 0** | 把 `by` 过期分支改成只写日志（今天的行为），E1 必须红 |
| **E2** | `schedule` 票错过一次 → 自愈开新 cycle 并在派发文本里说明；错过两次 → receipt | 恢复 `recurringTaskMissedOccurrence` 的只 log 行为，E2 必须红 |
| **E6a** | task-owned periodic 事件 preAction 通过、任务持匹配 `signal` 票 → 任务被派发且**频道未收到事件唤醒文本**；任务不持票时 → 照旧投递唤醒文本 | 去掉 `signal` 分支的票匹配判断（变成只要 task-owned 就吞），E6a 的第二半必须红 |
| **E8** | v3 fixture 目录启动后：v4 契约就位、`tasks/.v3/` 有原件、`workspace/events/` 逐字节未变 | 让迁移器顺手改事件文件，E8 必须红 |

### 验收

```bash
npm run check && npm run test:e2e
# 本机演练（先备份）
cp -a ~/.pipiclaw ~/.pipiclaw.bak-051p1
npm run build && node dist/main.js   # 观察迁移日志
```

- `fix-tui-typecheck` 变成 `open`，`## 上次结果` 里有那句迁移提示。
- `/tasks` 显示两个 daily 任务的票据与兜底时间。
- `workspace/events/daily-workspace-git-save.json` 的 mtime 与内容未变。

### 委派契约（可直接粘给 builder）

```text
在 ~/projects/pipiclaw 实施 spec 051 的 P1。

先读：docs/specs/051-long-horizon-task-loop/design.md 的 §12（规范性）、§3、§4 的 D1/D2/D8/D9/D14，
以及 plan.md 的「给实施 agent 的总纲」和「P1」小节。

范围：只做 P1 小节列出的新文件、改动、删除和测试。不要提前做 P2/P3 的日志、任务会话、预算。
不要碰 design §12.6 的「不许碰」清单——特别是 src/runtime/events.ts 只允许在 execute() 里加一个
signal 分支，其余三个 event 文件一行都不能动。

完成标准：
- npm run check 与 npm run test:e2e 全绿
- INV-1/2/3/4/7 各有测试；E1/E2/E6a/E8 四个 e2e 按 plan 的「破坏性检查」列做过一次，
  并把「它拦住什么」写进用例注释
- 迁移器对 test/fixtures/tasks-v3/ 的三份文件产出正确结果
- 不提交、不推送；返回真实 diff 范围、测试输出和你做破坏性检查时看到的失败信息
```

### 实施记录（2026-09-05）

P1–P4 在同一轮里实施并合并；`npm run check` 与 `npm run test:e2e` 全绿。**偏离与新增判断如下。**

- **P1/P2 合并落地。** 原计划让 P2 才引入 `<id>.jsonl`。实测不行：迁移必须在同一次写入里把 `## History` 搬走，否则 P1 结束时那 24 KB 历史无处可去。`src/tasks/log.ts` 因此提前到 P1，`task_log` 工具仍按计划在 P2 注册。
- **`signal` 票的兑现分支随 P1 落地**（原计划如此），并且写入侧校验（事件必须存在、periodic、同频道、名字指向本任务）也在 P1，所以两侧从不脱节。
- **`schedule` 票增加了 `at` 字段**（design §12.1 原本只有 `by`）。第一版按"读的时候现算下一次 occurrence"实现，结果是这张票永远算不到到期——cron 一直往前滚。票必须命名一个固定时刻，`at` 就是它等的那次 occurrence。设计文档已同步。
- **`task_create` 立刻开第一个 cycle。** 原设计只说"创建即 open"，没说 cycle。但步数、返工轮次和成本都累加在 cycle 上，没有 cycle 的任务无处记账——验收轮次会被静默丢弃。周期任务的首轮因此也在创建时开始，而不是等到下一个 cron 点。
- **`done` 的验收门禁改为"本周期存在一条真实 PASS"**，不是 `cycle.rounds > 0`。按轮次计数会让一串 FAIL 读成已验收，这是实现期间由测试发现的真实缺陷。
- **attestation 校验搬进了结算路径**（`src/tasks/verification.ts` 的 `attestationRejectionReason`，由 `SubAgentRunManager.settle` 调用）。校验不通过的 PASS 记成 FAIL 并在 round 记录里写明原因——`TaskRoundRecord` 因此比 design §12.3 多了一个可选 `reason`。
- **任务会话用 runner 内的 session 切换实现，不是第二个 runner 实例。** design D3 只要求"任务 step 跑在自己的会话里"。真去建第二个 `ChannelRunner` 会把 `beginTurn`/`endTurn`、`/stop` 和回合恢复劈成两个所有者——正是 spec 反复要求不要动的东西。改为给 `ChannelRunner` 加 `bindTaskSession`/`bindChatSession`，用 SDK 已有的 `switchSession` 换绑，busy 状态与 `/stop` 语义一行没动。`commitActiveSessionRef` 对任务会话路径短路，否则 `/new` 会把任务的 transcript 当成对话。
- **任务循环用的是频道系统提示 + 独立的 step brief，没有做 D12 说的"独立系统提示"。** 上下文隔离（D3 的真实价值）已经由任务会话拿到；再拆一套系统提示会牵动 `/context`、预算清单和 manifest，收益远小于风险。brief（`src/tasks/brief.ts`）注入契约全文、最近 8 条日志、状态与预算，以及待处理的 `/tasks steer`。**这是本轮最明确的一处降范围，记在这里以免被当成遗漏。**
- **"默认不发言"用静音的 `ChannelContext` + 一个通知 outbox 实现**（`muteChannelContext` + `src/tasks/steer.ts` 的 `queueTaskNotice`/`consumeTaskNotice`）。`task_step_end` 的 `notify` 写进 outbox，运行时在 step 结束后投递一次。事件唤醒与聊天会话的 `[SILENT]` 协议保持不变。
- **空转检测读的是循环日志里真实的工具名**，为此 `RunState` 增加 `toolsUsed`（`task_step_end` 自己不计入）。design D6 只说"没有工具调用"，没说这个事实从哪来。
- **`/tasks set` 退役**，换成 `/tasks steer` / `reply` / `log`，以及 `resume` 的 `+steps|+rounds|+usd` 加码。加码是在**已用量之上**的增量，否则恢复一个撞了上限的任务会在下一次扫描立刻再撞一次。
- **P4（events 退役）按用户决定取消**，`workspace/events/` 与四个 event 文件全程未改（`events.ts` 只多了那一个 `signal` 分支）；迁移测试专门守住这一点。
- **run 记录的 `channelDir` 改为在 `register()` 时写入**（此前只有外部启动路径的 `setLaunched` 写它）。内部委派因此从来没有 `channelDir`，结算时无法定位任务目录——验收轮次会被静默丢弃。由 e2e verify-chain 发现。
- **一处顺带修复（与本 spec 无关）**：`test/e2e/deterministic/memory.test.ts` 用 `toISOString()` 推导 journal 文件名，而实现按本地日历天写。两者在 UTC 与本地日期不同的那几个小时里不一致，M3 因此每天有 8 小时必红（2026-09-05 的每日审查已记录过这个现象）。改用 `localDayKey()`。

### 破坏性检查（2026-09-05）

按 `AGENTS.md` 的规则，四条核心不变量各做过一次，确认对应用例会变红：

| 不变量 | 把什么改回旧行为 | 变红的用例 |
|---|---|---|
| INV-3（D2-INV） | 让 `expireTicket` 只写日志（v3 的 `missed recurring occurrence`） | `task-store.test.ts` 的兜底用例、`task-driver.test.ts` 的二次过期用例 |
| INV-7 | 从事件兑现的匹配器里去掉 `&& ticket.event === name` | `events.test.ts` 的 signal 桥接用例 |
| INV-1 | 删掉 `normalizeTaskFrontmatter` 里 parked/ticket 的两行联动 | `task-frontmatter.test.ts` 的 lockstep 用例 |
| D7 的 PASS 门禁 | 把门禁改回 `cycle.rounds === 0` | `task-manage.test.ts` 的 verify-required 用例 |

### 尚未验证

- **本机 `~/.pipiclaw` 的真实迁移演练没有跑**（会改动用户的活数据）。迁移器有 fixture 覆盖，包含 `fix-tui-typecheck` 形态的脱敏副本，但真实目录的首次升级仍应在备份后手动观察一次。
- **evals 没有跑**（要花真钱，且不是门禁）。`evals/cases/task-loop-quality.ts` 三个用例已写好并注册。
- `npm run test:e2e:live` 未跑。


---

## P2 日志与账本

**目标：** INV-6 成立；契约恒 ≤ 4 KB；7 轮返工在状态里留下 7 条记录；成本能归到任务。

**完成定义：** 本机两个 daily 任务的 `.md` 落到 4 KB 以内，历史逐条在 `.jsonl` 里可查；用 08-31 那条 run 链的脱敏副本重放能还原出 6 fail + 1 pass 的轮次表。

### 前置阅读

`src/tasks/{verification,artifact-subject}.ts`、`src/subagents/runs.ts` 的结算路径、`src/subagents/external/settlement.ts`、`src/usage/ledger.ts`、`src/shared/jsonl-appender.ts`、`src/tools/task-manage/verification.ts`。

### 新文件

| 文件 | 职责 |
|---|---|
| `src/tasks/log.ts` | design §12.3 的记录类型；append（`shared/jsonl-appender.ts`）、按 cycle 读取、渲染成 brief 行；轮转策略与 `log.jsonl` 一致 |
| `src/tasks/rounds.ts` | 从日志推导轮次表；`workRunId` 配对规则 = **同任务、同 cycle、时间上最近的一条 `purpose=work` run**；无法配对时 `workRunId` 留空而不是猜 |
| `src/tools/task-log.ts` | 只读工具 `task_log({id, cycle?, limit?})` |

### 改动

| 文件 | 改动 |
|---|---|
| `src/tasks/ledger.ts` | 删除 `## History` 解析、`MAX_INLINE_TASK_HISTORY_ENTRIES/CHARS`、折叠与省略注记；新增 `## 上次结果` 的写入与截断（INV-6：超出即截断并留 `task_log` 指针） |
| `src/tasks/cycle.ts` | 关 cycle 时追加 `kind:"close"`、写 `## 上次结果`、向 050 的 `journal/YYYY-MM-DD.md` 追加一行 |
| `src/subagents/runs.ts` | 结算路径：`purpose === "verify" && taskId` → 调 `src/tasks/verification.ts` 校验 attestation → `log.append({kind:"round"})` → `cycle.rounds++` → `redeemTicket`。**必须落在现有幂等标记之内**，重放不得写出第二条 round |
| `src/tools/task-manage/verification.ts` | 删除（`task_verify` 工具退役）；其中 `complete` 前的重校验逻辑移进 `src/tasks/verification.ts`，供 P3 的 `outcome:"done"` 调用 |
| `src/usage/ledger.ts` | 记账增加可选 `taskId`；新增 `costKnown: boolean` |
| `src/subagents/external/settlement.ts` | 无真实用量时写 `costKnown:false` + 按角色 `model` × 墙钟的估算下界，**明确标记为估算**（`cycle.usdEstimated = true`） |
| `src/runtime/task-commands.ts` | `/tasks show` 改为「契约 + 最近 8 条日志 + 轮次表 + 成本」，遵守 `reply-limits.ts` 的 20 行 / 1,500 字预算；新增 `/tasks log <id> [cycle]` |
| `src/tools/registry.ts`、`src/tools/index.ts` | 注册 `task_log`，注销 `task_verify` |
| `src/commands/catalog.ts` | 新增 `/tasks log` 子命令条目 |

### 测试

**单元**：`test/task-log.test.ts`（追加、按 cycle 读、轮转）、`test/task-rounds.test.ts`（配对边界：同 cycle 无 work run、两个 work run 交错、verify 早于任何 work）、`test/task-ledger.test.ts` 补 INV-6 截断。

**e2e**

| 用例 | 断言 | 破坏性检查 |
|---|---|---|
| **E4** | `purpose=verify` run 结算 → jsonl 出现 `kind:"round"`、`cycle.rounds` 自增、票被兑现；**模型没有调用任何导入工具**；同一结算重放不产生第二条 round | 去掉幂等标记内的位置（把 round 写在标记外），重放断言必须红 |
| **E5** | `rounds` 到顶 → `paused{by:"runtime"}` + receipt；`/tasks resume <id> +rounds 2` 后可继续 | 去掉 rounds 上限判断，E5 必须红 |

（E5 的预算判定在 P3 才完整；P2 先只实现 `rounds` 这一维，其余三维 P3 补。）

### 验收

- 本机 `daily-pipiclaw-dev-review.md` 从 30,293 字符降到 ≤ 4 KB，`daily-pipiclaw-dev-review.jsonl` 里有 8 个 cycle 的历史。
- `/tasks show daily-pipiclaw-dev-review` 输出在 20 行 / 1,500 字以内。

### 委派契约

```text
在 ~/projects/pipiclaw 实施 spec 051 的 P2（P1 已合并到当前分支）。

先读：design.md 的 §12.3/§12.5/§12.6 与 D5/D7/D10，plan.md 的「总纲」和「P2」小节。

范围：只做 P2 的新文件、改动和测试。不做任务会话、task_step_end、预算的其余三维。
硬约束：SubAgentRunManager 仍是 settlement 的唯一 owner，round 记账必须落在它现有的幂等标记之内；
verification.ts / artifact-subject.ts 的算法不改，只换调用点。

完成标准：npm run check + npm run test:e2e 全绿；E4/E5 做过破坏性检查并写进注释；
用 test/fixtures/ 里 08-31 run 链的脱敏副本重放能还原 6 fail + 1 pass。
不提交、不推送；返回 diff 范围、测试输出和破坏性检查的失败信息。
```

### 实施记录

见 P1 小节的合并记录。

---

## P3 任务会话与循环

**目标：** INV-5 成立。step 便宜、能连着跑、跑在自己的上下文里；治理器换成预算。这是本 spec 实现面最大的一段，单独一个分支、单独评审。

**完成定义：** 一个 3 步的任务在一个 tick 内连跑完，`context.jsonl` 条目数不变，`tasks/.sessions/` 出现一份会话；期间用户在频道发消息能被正常处理。

### 前置阅读

`src/agent/channel-runner.ts`（重点：`initializeSession`、`SessionManager.open`、首轮记忆注入、`sessionResourceGate`）、`src/agent/runner-factory.ts`、`src/channel/active-session-store.ts`、`src/agent/prompt/{builder,manifest,sections}.ts`、`src/agent/{turn-prompt,session-events,turn-state}.ts`、`src/runtime/{bootstrap,channel-queue,delivery}.ts`、`src/agent/effect-ledger.ts`。

### 新文件

| 文件 | 职责 |
|---|---|
| `src/agent/task-runner.ts` | 任务会话 runner：按 `tasks/.sessions/<id>-<cycle>.jsonl` 开 `SessionManager`（**不经过 `active-session-store`**——那是聊天会话的指针，任务会话不参与 `/new`/fork）；装配 brief；跑一个 step；落 `task_step_end` 的结果；cycle 关闭时封存并释放 |
| ~~`src/agent/prompt/task-loop.ts`~~ | **未落地**（见实施记录）。改为 `src/tasks/brief.ts`：每一步的 turn input，含契约全文、最近 8 条日志、状态与预算、待处理的 steer，以及循环协议的收尾说明 |
| `src/tools/task-step-end.ts` | design §12.4 的工具；**只在任务会话的工具集中注册** |
| `src/tasks/budget.ts` | `DEFAULT_TASK_BUDGET`；四维累加与到顶判定；空转检测（连续 2 个零工具调用的 step） |

### 改动

| 文件 | 改动 |
|---|---|
| `src/agent/runner-factory.ts` | 新增 `createTaskRunner(channelId, channelDir, taskId, cycleId, paths)`，与 `createRunner` 并列、共用 `RunnerDeps` |
| `src/runtime/bootstrap.ts` | 任务 step 走 task runner；缓存与频道 runner 的 LRU 对齐，**cycle 关闭即释放**；`/stop` 打断当前 step → `pauseTask(by:"user")`，已派发的委派不受影响（沿用今天语义） |
| `src/runtime/task-driver.ts` | 删除 `taskFingerprint` / `attemptDelayMs` / `isEligible` / `futileCount` / `wakeCount` / `MAX_WAKES_PER_CYCLE` / `FUTILE_WAKE_LIMIT` / `getEffectCount` 选项；`continue` 直接排队；预算到顶走 receipt。目标 ~260 行 |
| `src/agent/effect-ledger.ts` | 删除；清理 `channel-runner.ts` / `bootstrap.ts` 里的调用点与 `isEffectfulTool` |
| `src/agent/session-events.ts` | 任务 step 不走 `[SILENT]` 分支：默认不投递，`notify` 才投递。**聊天会话与事件唤醒的 `[SILENT]` 保留** |
| `src/agent/job-manager.ts`、`src/subagents/runs.ts` | 唤醒文本里给任务的那一份不再写 `[SILENT]` 指令（非任务的保留） |
| `src/settings.ts` | `TASK_DRIVER_SETTINGS` 收缩为 `maxDispatchesPerTick` + `maxSleepMinutes`；预算默认值移入 `src/tasks/budget.ts`。**不新增 settings.json 键** |
| `src/runtime/task-commands.ts` | `/tasks steer <id> <text>`（注入下一个 step 的 brief，不打断当前 step）、`/tasks reply <id> <text>`（兑现 `ask` 票）、`/tasks resume <id> [+steps N\|+rounds N\|+usd X]`；`ask` 票的普通消息路由**仅在无歧义时**（频道里恰好一张 `ask` 票且用户消息紧跟提问），回执第一行点名任务 |
| `src/commands/catalog.ts` | 三个新子命令条目 |
| `src/memory/{reflect-job,lifecycle}.ts` | 明确只读聊天会话——任务会话不进反思语料（修 050 F1） |
| `src/memory/session-corpus.ts` | `session_search` 的语料加入 `tasks/.sessions/`，让封存的 cycle 可搜 |

### 任务会话工具集（8 个）

`read`、`edit`、`write`、`bash`、`grep`/`glob`、`subagent`（+`subagent_inline` 视 `tools.subagentInline.enabled`）、`job`、`task_step_end`、`task_update`、`task_log`、`send_media`。**不含** `task_create`、`memory_save`、`event_manage`——任务不建任务、不写频道记忆、不管事件。最终清单以实施时的实际工具名为准，但这三条排除是规范性的。

### 测试

**单元**：`test/task-budget.test.ts`（四维到顶、`until` 与 `wallMin` 取先到、空转检测）、`test/task-runner.test.ts`（brief 装配的五个块、预算累加、cycle 关闭释放）。

**e2e**

| 用例 | 断言 | 破坏性检查 |
|---|---|---|
| **E3** | `outcome:"continue"` 后下一个 step 在同一 tick 排队，且跑在同一个 `.sessions/` 文件里；期间插入的用户消息被正常处理 | 把 `continue` 改回走 `continuationDelayMinutes`，E3 必须红 |
| **E7** | 一个 cycle 的 step 全部写进 `tasks/.sessions/`，频道 `context.jsonl` 条目数不变（INV-5） | 让 task runner 复用频道 SessionManager，E7 必须红 |
| **E5**（补全） | `steps`/`wallMin`/`usd` 三维各自到顶 → `paused{by:"runtime"}` + receipt | 去掉任一维判定，对应断言必须红 |
| **E6b** | P1 的 E6a 加强：`signal` 兑现后 step 跑在任务会话里，频道会话条目数不变 | — |

`test/e2e/deterministic/tasks.test.ts` 里 backoff / futile / effect 相关的旧用例删除或改写；`test/effect-ledger.test.ts` 删除。

### 验收

- E3/E7 绿；`/stop` 打断一个 step 后任务是 `paused{by:"user"}`，在跑的委派仍在跑。
- 本机跑一个真实的多步任务，观察 `tasks/.sessions/` 与 `context.jsonl` 的增量。

### 委派契约

```text
在 ~/projects/pipiclaw 实施 spec 051 的 P3（P1/P2 已合并）。这是本 spec 实现面最大的一段。

先读：design.md 的 §12 全部、D3/D4/D6/D9/D11，plan.md 的「总纲」和「P3」小节，
以及 src/agent/channel-runner.ts 的 initializeSession 与 src/channel/active-session-store.ts。

关键约束：
- 任务 step 仍是频道队列里的普通条目，仍走 beginTurn/endTurn，仍用同一个 ChannelContext；
  变的只有 SessionManager 指向哪个文件。不要引入并发执行，不要改 /stop 语义。
- 任务会话不经过 active-session-store（那是聊天会话的指针）。
- INV-5 是这一段的核心：任务 step 的会话条目一条都不能进 context.jsonl。
- 事件唤醒与聊天会话的 [SILENT] 协议保留，只有任务 step 侧改成「默认不发言」。

完成标准：npm run check + npm run test:e2e 全绿；E3/E7/E5/E6b 做过破坏性检查并写进注释；
effect-ledger.ts 及其所有调用点删干净（rg -n "effectCount|isEffectfulTool" src/ 无命中）。
不提交、不推送；返回 diff 范围、测试输出和破坏性检查的失败信息。
```

### 实施记录

见 P1 小节的合并记录。

---

## P4 文档与质量证据

| 交付 | 内容 |
|---|---|
| `src/playbooks/task-loop.md` | 合并 `task-planning.md` + `task-driving.md`（~330 行 → 88 行）。循环协议进每一步的 brief，playbook 只留判断：什么时候建任务、契约怎么写、外部动作的幂等闭环、验收纪律 |
| `src/playbooks/event-scheduling.md` | **保留**。删掉与 task `waitingFor` / 回访事件相关的过时说明；加一段「task-owned 传感器改用 `signal` 票」的写法 |
| `src/playbooks/agent-delegation.md`、`background-jobs.md` | 删除 `waitingFor`、`[SILENT]`、回访事件相关段落；改为「派发即写票」 |
| `src/playbooks/catalog.ts` | 同步条目与 `order` |
| `docs/events-and-tasks.md` | 拆成 `docs/tasks.md`（任务、循环、预算、票据、返工）+ 保留的事件章节；`docs/README.md`、`docs/architecture.md`、`docs/runtime-playbooks.md` 同步 |
| `docs/sub-agents.md` | 更新协作面：自动记账、成本、`taskId` 自动填充 |
| `docs/configuration-reference.md` | frontmatter v4 契约、`budget` 字段、`ticket` 六种形态 |
| `test/evals/` | `task-loop-quality` 集：三个真实形态场景（每日审查 / builder↔reviewer 返工 / 等外部条件），测票选得对不对、`note` 是否写了证据而非愿望、预算到顶时的下一步是否可执行。**非门禁** |
| `AGENTS.md`、`CLAUDE.md` | 域边界更新：tasks 的三件事（契约 / 循环日志 / 票）；events 仍在，边界是一张 `signal` 票 |

---

## 跨阶段的硬约束

1. `SubAgentRunManager` 仍是 settlement、usage、lease、完成唤醒的唯一 owner，其幂等标记不得被 P2 的记账破坏。
2. `internalWake` 的信任链（spec 040 D7/T9）只换消费者，不换校验。
3. 票据兑现幂等：同一 `dispatchId` 重放是 no-op（`shared/wake-claim.ts`，at-least-once 假设不变）。
4. 每个新增的确定性 e2e 用例合并前做破坏性检查，并把「拦住什么」写进注释。
5. 迁移永不删除原件（`tasks/.v3/`）；`workspace/events/` 全程不改。
6. 任何阶段都不引入 `settings.json` 的新数值键。
7. `src/runtime/events.ts` 全程只有 P1 的那一个 `signal` 分支；其余三个 event 文件零改动。

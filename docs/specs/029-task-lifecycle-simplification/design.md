# Task 生命周期简化:状态收敛、唯一时间规则、LLM 出环

| 字段 | 值 |
|------|------|
| 状态 | DRAFT |
| 日期 | 2026-07-19 |
| 前置 | 022 native task driver、024 task loop v2、027 native task recurrence |
| 关联实现 | `src/tools/task-manage.ts`、`src/runtime/task-driver.ts`、`src/shared/task-ledger.ts`、`src/tasks/control.ts`、`src/tasks/store.ts`、`src/runtime/task-commands.ts`、`src/shared/task-events.ts`、`src/playbooks/task-*.md` |

## 背景:一次真实事故

2026-07-18,用户创建了一个周期任务(`schedule: 41 2 * * *`,每天凌晨 02:41)。预期行为:任务在 02:41 首次执行。实际行为(runtime 日志还原):

| 时间(本地) | 事件 |
|---|---|
| 23:43 | 任务创建后 driver **立刻**派发第一次唤醒 |
| 23:49–04:49 每小时 | fingerprint 未变,按 `stalledRetryMinutes` 每 60 分钟重复派发 |
| 05:49 | agent 才意识到"永远等不到 cycle-start",手工用 `set status=in-progress` 兜底开跑 |

02:41 从头到尾没有任何机制去实现;7 个 LLM 回合被烧掉,却没有任何告警。事后 agent 对用户的解释("croner never kicked in")与真实原因(driver 派发得太早太频繁)**恰好相反**——连排查者都被机制绕晕了。

第一刀修复(已落地,commit `e9685d1`):`create` 对带 `schedule` 且未显式给 `wake` 的任务,用 croner 预约首轮 `wake` 到下一次 occurrence。但这只堵住了一个入口。本 spec 处理病根。

## 病根分析

事故不是孤例,是四个结构性问题的合流:

1. **存在"无定义语义"的合法状态。** `status: open` + `schedule` + 无 `wake`,三个字段各自合法,组合起来没人定义过含义:driver 理解为"立刻跑",`task-recurring.md` 暗示"等 cycle-start"(而 cycle-start 只对 `done` 派发,首轮永远不来),agent 只能猜。`create` 修复后,`set` 仍能造出同一状态。**只要状态可表示,就总有一层会解释错。**

2. **同一件事有多个写入者。** recurring 的 `wake` 由 4 处代码分别计算:`doneTask`、`applySet` 的 done+schedule 特判、`create` 的首轮 seed、driver 的 `needsWakeHeal` 自愈。加上 legacy `.schedule`/`.checkin` 事件双读横穿 driver / task-manage / doctor 三个文件,时间语义共 4 套机制 + 1 套兼容层。

3. **确定性工作交给了 LLM。** cycle-start 派发一整个 LLM 回合,只为让模型调一次 `task_manage start-cycle`——而 `startTaskCycle()` 本身是纯确定性文本变换。LLM 在环引入一整类"模型没照做"的失败(事故当晚 agent 正是对非 done 任务调 start-cycle 被拒后开始乱兜底)。

4. **无效唤醒不收敛。** silent 回合退还 attempt(`finishTaskAttempt`),budget 永远不会因空转触发;文件未变则 fingerprint 退避固定 60 分钟。合流结果:**永不终止、永不上报的静默烧钱循环。**

复杂度审计佐证(为什么说"太复杂"不是感觉):

- status 有 **9 个值**,driver 实际只区分 3 种行为(可派发 / 睡到 wake / 永不派发);`open` 与 `in-progress`、`awaiting-user` 与 `blocked` 机器语义完全相同,纯冗余。
- `control.lastOutcome` 是第二台平行状态机(6 个值),与 status 重叠,各 action 手工维护一致性。
- `task_manage` 9 个 action、1000+ 行,每个 action 各写状态守卫,**没有统一转移表**(外部评审同样指出:`set` 可从 `verifying` 任意跳转且不作废 verification)。
- body hash 绑定 verification PASS 与 approval,routine 的 `progress` 会静默作废 PASS;`task-closeout.md` 为此专门写了一节"正确顺序"仪式来绕地雷。

## 目标与非目标

**目标**:task 机制健壮、易理解、行为可预期——主路径和边界情况都由**少数几条规则**推导得出,而不是由散落各处的特判拼出来。用户不被意外;排查者不需要读六个文件才能回答"这个任务下一次什么时候醒"。

**非目标**:

- 不动 maker-checker 验收链(candidate → verifier attestation → verify → done 的 runId/hash 校验)和外部审批门的安全语义,那是买来的复杂度;只切掉它的误伤半径(见 D4)。
- 不动 `wake`/`schedule`/`deadline` 三个字段本身——它们语义正交,问题在组合无定义,不在字段。
- 不加新配置项、新 frontmatter 字段(`pausedBy` 例外,见 D3)。
- 不做多 occurrence 补跑、条件周期等语义扩展(延续 027 边界)。

## 设计

六项改动按依赖排序;D1–D3 是语义核心,D4–D6 是随之解锁的删除。

### D1 唯一时间规则:`nextWake(task)` 是全函数,在写路径上强制

一条规则回答"任务下一次什么时候醒",取代所有散落逻辑:

```text
paused / cancelled / 已归档          → 永不
done 且有 schedule                   → cron 下一次 occurrence
wake 已设                            → wake
其他                                 → 立刻
```

实现:task 的全部写入已汇聚于 `renderTaskDocument`/`writeStoredTask` 一条通路。在该通路加一步 `normalizeTaskFields()`:凡 `done + schedule` 而 `wake` 缺失/不可解析,写盘前用 croner 补算。**"idle 的周期任务必有 wake"从运行时检查变成构造上不可违反的不变量。**

由此吸收(删除)的机制:

- `applySet` 内的 done+schedule 重算特判;
- `doneTask` 内的重算(自然经过 normalize);
- driver 的 `needsWakeHeal` 分支——绕过 runtime 的手工编辑由 driver 读到时调同一个 `normalizeTaskFields` 修复,不再是一套独立的"自愈"逻辑。

`create` 的首轮 seed(已落地)保持:它处理的是 `open + schedule` 的**首轮**语义("创建 ≠ 立刻跑"),normalize 处理的是 `done + schedule` 的**续轮**不变量,两者共用 `nextTaskWake`。

### D2 cycle-start 收归 runtime,LLM 出环

driver 检测到 cycle-start ready(`done + schedule + wake ≤ now`)时,不再派发 `[TASK_CYCLE]` 事件请模型调 `start-cycle`,而是**runtime 直接执行**:

1. 调 `startTaskCycle(body, cycleId)` 折叠上一周期(确定性变换,已有完整测试);cycleId 由 runtime 生成(`cycle-<YYYY-MM-DD>`,同日重开加序号)。
2. 调 `resetTaskControlForCycle` 清周期元数据,置 `active`(见 D3),清 `wake`。
3. 原子写盘,然后派发一条**普通驱动唤醒**(`[TASK_DRIVER]`),模型醒来面对的就是一个待推进的任务,与其他唤醒无异。

这与既有先例完全同构:`escalateTask`、attempt claim、wake 自愈都是 runtime 直接写。删除项:

- `createCycleStartEvent`、`[TASK_CYCLE]` 标签、driver 的 `isCycleStart` 分支与"cycle-start 不 claim attempt"特例(普通唤醒照常 claim,attempt 刚被 reset,语义等价);
- `task_manage` 的 `start-cycle` action(9 → 8;人工修复场景用 `set` 足够);
- `task-recurring.md` 中"收到 cycle-start 该怎么做"的整节指令,以及"模型没正确开周期"这一整类失败模式。

### D3 状态收敛 9 → 6,一张转移表

**合并原则:机器语义相同的状态只留一个,人读的差异放进自由文本。**

| 旧 | 新 | 说明 |
|---|---|---|
| `open`、`in-progress` | `active` | 今天两者在 `isTaskActionable`、driver、所有 action 守卫里完全等价 |
| `awaiting-user`、`blocked` | `waiting` | 同上;等谁/等什么写进 `control.blockedReason` |
| `escalated` | `paused` + `control.pausedBy: "governor"` | escalated 本质是"治理器暂停";用户暂停记 `pausedBy: "user"` |
| `verifying`、`done`、`cancelled`、`paused` | 不变 | |

每个状态映射到唯一 driver 行为:

```text
active     → 立刻可派发(受 wake 门控:wake 未到则睡到 wake)
waiting    → 睡到 wake,到点派发
verifying  → 派发 checker-only 回合
paused     → 永不派发(driver 扫描层排除,零 token)
done       → 有 schedule 则到 wake 做 D2 cycle-start;否则已归档
cancelled  → 已归档,永不
```

**转移表**:新增 `src/tasks/transitions.ts`,一张 `action × fromStatus → toStatus` 常量表;每个 `task_manage` action 与 `/tasks pause|resume|run` 入口统一查表,非法转移抛同一种错误("Task X is S; action A allows: ...")。取代 9 个 action 各自的手写守卫,并顺手堵住已知漏洞:

- `set` 离开 `verifying` 时强制 `invalidateTaskVerification`(现在只有 `progress` 做);
- `set` 降级 `verificationMode: independent → evidence` 视为契约变更,作废现有 verification 状态(现有 `applyTaskControlPatch` 已重置 verification,转移表层面再挡住 `verifying` 状态下的降级)。

**`lastOutcome` 降级为纯遥测**:仅由 runtime(claim/finish/escalate)写入,展示于 `/tasks stats` 与 capsule;任何判定逻辑禁止引用。各 action 里手工同步 lastOutcome/blockedReason 的代码删除。

**兼容**:旧状态在读取层做无损映射(`parseTaskFrontmatter` 归一),写盘即新值;`escalated` 文件读为 `paused + pausedBy: governor`。磁盘上无需迁移脚本,doctor 不需要新检查。对外文案(`/tasks list`、通知)展示新状态名。

### D4 hash 绑定"契约"而非"日志"

`taskBodyHash` 改为只覆盖任务的**契约段**:Goal、DoD(含勾选状态)、Manual、Verification——排除 Current Cycle 与 History。

效果:`progress` 记日志不再作废 independent PASS 与外部 approval。删除项:

- `task-closeout.md` 整节"independent + external 的正确组合"顺序仪式;
- "PASS 后不能 progress、只能 set"的例外规则及其在 `task-driving.md` 的重复告诫;
- `progress` 里的 `invalidateTaskVerification`/`invalidateTaskApproval` 调用(改为:仅当本次写入改变契约段 hash 时才失效——由 store 层统一判断,而不是按 action 类型猜)。

安全性不降:被验收/被批准的是契约(做什么、验什么、勾了什么),契约变化照样失效;日志本来就不是验收对象。attestation 的 `bodyHash` 语义随之变更,旧 attestation 文件在升级后自然失效(verification.status 回 pending),重新验收即可——验收本就应基于当前内容,无兼容负担。

### D5 无效唤醒收敛到治理器

silent 回合继续退还 attempt(成本公平不变),但 driver 在内存 attempt 记录上增加 `futileCount`:派发被接受、回合结束后 fingerprint 未变(含 silent),计一次;文件一变即清零。连续 **3** 次 → 走既有 escalation 路径(`paused + pausedBy: governor`,reason: "task made no visible progress in 3 consecutive wakes"),用户收到一条通知。

保证:**任何唤醒循环要么推进文件,要么在 3 × stalledRetry 内被叫停并上报。** 事故当晚的静默循环在 ~3 小时处终止并通知,而不是无限烧钱。计数在内存,daemon 重启清零——代价是重启后重新累计 3 次,可接受,不为它加持久化状态。

### D6 删除 legacy 事件双读(027 迁移窗口关闭)

`.checkin`/`.schedule` 兼容路径整体移除:

- driver:`hasLiveScheduleEvent` 及 cycle-start 前的双触发规避;
- task-manage:`hasLegacyScheduleEvent`、`cleanupTaskEvents` 的 `preserveSchedule` 分支(收窄为"close-out 删除全部 task-owned events");
- doctor:legacy `.schedule` 迁移提示、`.checkin` 冗余提示、checkin/wake 同步检查等 ~6 段;
- `task-events.ts`:`isTaskScheduleEvent`/`isTaskCheckinEvent` 等 helper 随调用点删除(保留 `taskEventPrefix` 供 close-out 清理临时 sensor 事件)。

一次性迁移兜底:daemon 启动扫描 events 目录,发现残留 canonical `.schedule` 事件时自动把 cron 折入对应任务的 `schedule` frontmatter(frontmatter 已有值则 frontmatter 优先)并删除事件文件,记一条日志。此后代码里不再有"两处真相"。

### D7 机械拆分 `task-manage.ts`(尾随)

语义收敛后按职责拆为 `create`/`lifecycle`(progress/set/done/cancel)/`verification`(candidate/verify)三个模块 + 一个薄 tool 入口,转移表独立成文件。纯移动,不改行为;放最后避免在旧语义上白拆。

## 兼容性与迁移

- **磁盘格式**:frontmatter 键不增不减(`control.pausedBy` 在 control JSON 内,parse 容忍缺失)。旧 status 读取层映射,首次写盘归一。
- **attestation**:D4 改 hash 语义,已有 pending/passed 的 verification 在下次校验时失效,重新验收。发布说明明确提示。
- **playbooks**:`task-recurring.md`(删 cycle-start 指令)、`task-driving.md`(状态表更新、删 hash 告诫)、`task-closeout.md`(删顺序仪式)、`task-planning.md`(状态枚举更新)同步改写,预期显著变薄。
- **`/tasks` 命令**:`pause`/`resume`/`run`/`approve` 查转移表;`escalated` 相关文案改为 `paused (governor)`。
- 预期净删 500–700 行实现 + 大幅缩减 playbook;不新增任何配置项。

## 测试重点

- **D1**:normalize 在 store 写路径生效——`set` 造出 `done+schedule` 无 wake 被自动补;driver 读到手工编辑的坏 wake 走同一函数;`create` 首轮 seed 回归(已有);`nextWake` 全函数覆盖四分支。
- **D2**:到点后 driver 原子完成折叠+reset+置 active,随后派发普通唤醒;同日重开 cycleId 不冲突;写盘失败不派发;不再存在 `[TASK_CYCLE]` 文本;usage 按周期清零(e2e 两轮跑通,沿用 027 用例改断言)。
- **D3**:转移表穷举测试(6 状态 × 全部 action);旧 status 读取映射;`set` 离开 verifying 作废 verification;paused(governor) 与 paused(user) 的 resume 路径;driver 对 6 状态的行为各一例。
- **D4**:progress 后 PASS/approval 存活;改 Goal/DoD/Manual/Verification 任一段即失效;勾选 checkbox 计入契约;旧 attestation 升级后判失效。
- **D5**:连续 3 次无进展 → paused(governor) + 通知;中途文件变化清零;silent 仍退 attempt;重启后计数重置。
- **D6**:启动折叠残留 `.schedule` 并删文件;frontmatter 优先;close-out 清理全部 task-owned events;doctor 不再报 legacy 项。

## 落地顺序

D1 → D2 → D6 → D3 → D4 → D5 → D7。每步独立可验证、可单独提交;D1/D2/D6 互不依赖但按风险递增排;D3 是最大改动,放在删完兼容层之后做,转移表不必覆盖 legacy 路径;D4/D5 依赖 D3 的状态定义;D7 纯机械收尾。

## 后续边界

- 不引入 per-task timer、持久化退避状态、futileCount 持久化——单 timer + 文件真相的 027 架构不变。
- `waiting` 是否需要机器可读的"等谁"枚举(user/external/delegate),等真实需求;现在 blockedReason 自由文本够用。
- 条件周期、错过策略(skip-if-stale)延续 027 的搁置。

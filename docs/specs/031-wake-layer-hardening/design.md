# 唤醒层加固:投递幂等、准入下沉、作业持久化

| 字段 | 值 |
|------|------|
| 状态 | 已落地（D1–D7 全部实现） |
| 日期 | 2026-07-20 |
| 前置 | 007 event-action、022 native task driver、027 native task recurrence、029 task lifecycle simplification |
| 关联实现 | `src/runtime/durable-dispatch.ts`、`src/runtime/events.ts`、`src/runtime/task-driver.ts`、`src/agent/job-manager.ts`、`src/tools/event-manage.ts`、`src/tools/bash.ts`、`src/agent/session-events.ts`、`src/playbooks/background-jobs.md`、`src/playbooks/event-scheduling.md` |

## 背景:三个机制,一个没人负责的汇流点

Pipiclaw 有三套让 agent "在未来某刻醒来"的机制:

| | 触发源 | 真相载体 | 持久性 | 成本门控 |
|---|---|---|---|---|
| **events** | croner / setTimeout,fs.watch 驱动 | `workspace/events/*.json` | 文件即真相,重启可恢复 | ✅ `preAction`(零 token) |
| **tasks** | 单个轮询 driver loop + horizon 计算 | `tasks/*.md` frontmatter | 文件即真相,`normalizeTaskFields` 保不变量 | ❌ 只有退避与 futile 计数 |
| **jobs** | 无触发源 | 内存 Map + 主机进程 | ❌ 全丢 | ❌ |

三者最终都收敛到同一个出口:合成一条 `DingTalkEvent` → `DurableDispatchService.dispatch` → channel queue → 一个完整 agent 回合。

**`durable-dispatch.ts` 已经是三个机制唯一的汇流点,但它今天只被当作"发件箱"用(at-least-once 投递),不承担任何策略。** 准入、去重、可观测都散在三个上游各写一遍,且各自写得不一样。本 spec 不合并三个机制——它们的定位正交、应当保留——而是把本该属于汇流点的语义收回汇流点,并把三者中最弱的一环(jobs)补齐到与另外两者同一水位。

## 病根分析

### 1. 去重键含时间戳,恰好在需要去重的路径上失效

`dispatchId` = hash(channelId, user, **ts**, text, conversationId)(`durable-dispatch.ts:36`),而 `ts` 是 `execute()` 时的 `Date.now()`(`events.ts:699`)。

one-shot 遇到 channel queue 满(上限仅 5,`dingtalk.ts:718`)时:`enqueued=false` → `markInvalid` 保留文件(`events.ts:726`),而 durable 记录仍是 `pending`,30 秒后会重投;同时文件还在,daemon 重启扫到 `at <= now` → "recovering past one-shot" → 再次 `execute`,拿到**新的 ts、新的 dispatchId**。

于是两套独立的重试系统(文件恢复 + 发件箱)叠在一起,而唯一能把它们粘合起来的去重键被时间戳打碎了。同一次 occurrence 被投递两次。

### 2. lease 不续期 → 长回合自我重复投递

`markStarted` 在回合开始打 15 分钟 lease(`bootstrap.ts:810`),`markCompleted` 在回合结束删记录(`:898`),中间**没有任何续期**。`drainOnce` 每 30 秒扫一次,看到 lease 过期就重新 `enqueueEvent`(`durable-dispatch.ts:167`)。

超过 15 分钟的回合(构建、多轮 task 推进、web 抓取重试)会把自己的唤醒事件再投递一次,排在当前回合后面重跑。at-least-once 在这里退化成"长回合必然 at-least-twice"。根因是把 lease 当成了**对回合时长的猜测**,而它本该表达的是**持有者是否还活着**。

### 3. 重放对模型不可见

`deliveries` 计数存在记录里(`durable-dispatch.ts:169`)却从不暴露。模型无从判断"这是重放还是新唤醒",对 `[EVENT:...] 发布上线` 这类文本,重放即重复副作用。

### 4. 校验写在工具层,而 watcher 才是信任边界

`event_manage` 强制了:拒绝 `immediate`(防自触发循环)、one-shot 至少提前 2 分钟、periodic 最小 30 分钟(带 preAction 5 分钟)、总量 50(`event-manage.ts:16-28,151`)。

`EventsWatcher` 这些**一条都不校验**。它照常支持 `immediate`(`events.ts:490`),照常接受 `* * * * *`,照常无视文件总数。而 events 目录在 workspace 内(`path-guard.ts:180`),agent 用 `write`/`bash` 就能直接写——`event-scheduling.md` 甚至明文授权了这条路。

**防自触发循环的护栏因此是建议性的,不是强制性的。** 对比同一文件里 preAction 的 command guard 是在 watcher 执行时**重新**校验的(`events.ts:738`):一个规则下沉了,其余全没有。这不是遗漏,是分层没想清楚——工具是便利层,watcher 是执行层,安全语义必须在执行层。

### 5. jobs:最贵的在途工作,最弱的持久性

`ChannelJobManager` 状态纯内存(`job-manager.ts:84`),但进程是 `nohup` 派生的(`:120`)——**进程活过重启,记录活不过**:

- 孤儿进程继续跑、继续写 `/tmp/pipiclaw-job-*.log`,无人回收;
- `MAX_RUNNING_JOBS=5` 的名额记账归零,实际并发可突破上限;
- 重启前未取回的输出永久丢失(playbook 用"重要产物请自己写进 workspace"打补丁——用提示词补运行时的洞)。

spill 文件走 shell 重定向创建,默认 umask,无 `chmod 0600`、无清理。对比 event history 是显式 `mode: 0o600` + `chmodSync`(`events.ts:323`):同一 codebase 对"可能含密钥的输出"存在两种态度。

更结构性的是:**jobs 是唯一不能唤醒 channel 的机制**("作业完成不会主动通知你",`job-manager.ts:48`)。于是"等一个后台作业"没有正确编码方式,只有三个都不对的近似:本回合空转 poll、猜一个 `wake` 挂到 task 上、猜一个时间建 one-shot event。三条路都要求 LLM **预测一个它无法预测的完成时间**,而选错的表现("该醒时没醒")与"任务本来就没进展"在日志里无法区分。这正是 029 病根 3(确定性工作交给 LLM)在另一处的复发。

### 6. futile 检测的保证不成立

029 D5 承诺"任何唤醒循环要么推进文件,要么在 3×stalledRetry 内被叫停"。实现依赖 `taskFingerprint`(`task-driver.ts:78-95`),取的是 status/wake/schedule/**latestNote**/nextAction/blockedReason/verification/cycleId。两个方向都破:

- **可绕过**:`latestNote` 在指纹里。模型每次唤醒写一条进度 note,指纹就变,`futileCount` 永远清零——而"每次唤醒记录进度"正是 playbook 教它做的事。**最可能的模型行为恰好使 governor 失效。**
- **会误伤**:真正干了活但没写 note(改了代码、发了消息、跑了脚本)→ 指纹不变 → 三次后被暂停并告警。

根因是把"是否有进展"定义成了"任务元数据是否变化",而任务的价值产出几乎全部在元数据之外。代理指标选错了。

### 7. 孤儿 task-owned event

`task.<channelId>.<taskId>.<use>` 靠 close-out 清理(`task-manage/shared.ts:244`)。手工删任务、或 close-out 失败,事件就永久触发到一个不存在的任务上,触发时不做任何 owner 反查。50 文件上限是唯一backstop。

## 目标与非目标

**目标**:合成唤醒这条链路上,"同一件事只发生一次"、"该醒的时候一定醒"、"不该醒的时候不烧 token"三条保证由**运行时**给出,而不是由模型的判断力和 playbook 的措辞给出。

**非目标**:

- 不合并 events / tasks / jobs 三个机制,不引入统一的 WakeGate 抽象层。本 spec 只做"把已属于汇流点的语义收回汇流点",per-channel 唤醒预算、task 侧的 `preAction` 泛化、统一 wake history 留待真实痛感出现后再评估。
- 不改 channel queue 的容量与调度策略。
- 不改 task 状态机、验收链、审批门(029 边界)。
- 不新增配置项(`bash async` 的 `notify` 是工具入参,不是 settings)。

## 设计

七项改动。D1–D3 是投递层语义,D4–D5 是准入层下沉,D6 是 jobs 补齐,D7 是 governor 的指标纠正。

### D1 稳定去重键:由 provenance 派生

`DingTalkEvent.dispatchId` 已是可选字段且 `dispatch()` 优先采用(`durable-dispatch.ts:92`)。让**每个生产者显式提供**由来源而非时刻派生的键:

```text
event(periodic)   → event:<eventName>:<occurrenceIso>   // occurrence = cron 本次触发时刻
event(one-shot)   → event:<eventName>:<at>              // at = 定义里的 at,恢复路径同值
task(driver wake) → task:<channelId>:<taskId>:<wakeIso | "now">
task(escalation)  → task:<channelId>:<taskId>:escalation:<reasonHash>
task(/tasks run)  → task:<channelId>:<taskId>:manual:<nowIso>   // 人为触发,本就应每次都算新的
job(completion)   → job:<channelId>:<jobId>:done        // D6 引入
```

关键在 one-shot:`at` 来自文件定义,与"何时被执行"无关,所以**文件恢复路径与发件箱重试路径落在同一个 id 上**,`dispatch()` 的 `if (existing) return`(`:95`)自然吃掉重复。病根 1 消失。

periodic 用 occurrence 而非 `Date.now()`:croner 回调可拿到本次触发时刻;同一 occurrence 无论重试几次都是一条记录,而下一个 occurrence 是新记录。

`dispatchId(event)` 哈希兜底保留,但仅供未提供 provenance 的调用方使用;`ts` 从哈希中**保留**(兜底路径需要区分不同时刻的同文本唤醒)。真正的修复是让所有生产者都不再走兜底。

### D2 lease 表达"持有者活着",不表达"回合多长"

`DurableDispatchService` 内部维护 `running: Set<string>`:

- `markStarted(id)` 把 id 加入集合并打 lease;
- `drainOnce` 遇到 `status === "running"` 且 `running.has(id)` 时**续期并跳过**,而不是判断 lease 是否过期;
- `markCompleted(id)` 从集合移除并删记录。

于是 lease 不再是对回合时长的猜测:只要本进程还持有该回合,就一直续;进程死了集合自然为空,记录在 lease 到期后被正确重投。这不需要额外定时器(复用已有的 30 秒 drain),也不需要 bootstrap 侧任何改动。

`cancelChannel` 同步清理集合中对应 channel 的 id,否则 `/stop` 后的记录会被本进程一直续期而永不重投。

### D3 重放对模型可见

`drainOnce` 在 `deliveries > 1` 时,给**投递出去的**事件文本加一行前缀(记录里保存的原文不变,dispatchId 因此也不变):

```text
[REDELIVERY:<n>] This wake is delivery #<n>; a previous delivery may have partially run.
Before acting, check whether its side effects (files, messages, external calls) already exist, and do not repeat them.
```

不引入新协议、不要求模型回什么特殊标记——只把运行时已知的事实交给它,让幂等检查成为可能。

### D4 准入校验下沉到 watcher

新增 `src/runtime/event-validation.ts`,承载今天散在 `event-manage.ts` 里的全部规则:one-shot 最小提前量、periodic 最小间隔(含 preAction 放宽档)、preAction command guard、事件总数上限。`event-manage.ts` 与 `EventsWatcher` 共用同一个函数,**watcher 是最终裁决者**。

watcher 侧:`handleFile` 解析成功后立刻校验,不通过则走既有失败通路——`markInvalid` 写 `.error.txt` + history 记 `invalid`,不进入调度。总数上限在 `scanExisting` 按文件名排序后判定,超额文件标记 invalid 而不是静默调度。

**`immediate` 从代码里彻底删除**:`ImmediateEvent` 类型、`handleImmediate`、stale 判定分支全部移除;`parseScheduledEventContent` 遇到 `type: "immediate"` 抛出指向 `event_manage` 的明确错误。生产代码中没有任何 immediate 事件的生产者(仅测试构造),bootstrap 需要立即触发时走内部 API 而非事件文件,因此这是无损删除。删掉它,"写一个文件就能造出无限自唤醒循环"这条路径不复存在。

### D5 触发前反查 owner

`execute()` 派发前(以及 `handleFile` 调度前),若文件名以 `task.${event.channelId}.` 开头——channelId 由事件 JSON 自带,反解无歧义——取其后到下一个 `.` 为 taskId,读 `workspace/<channelId>/tasks/<taskId>.md`:

- 文件缺失,或 status ∈ `TERMINAL_TASK_STATUSES` → 跳过派发、删除事件文件、history 记 `skipped`,reason 为 `owning task <id> is gone/terminal`。

十几行,消掉一整类幽灵唤醒;也让 close-out 清理失败从"永久噪声"降级为"下一次触发时自愈"。

### D6 jobs 落盘 + 完成即唤醒

这是 029 D2「确定性工作出环」的同构推广:**"等作业完成"从一道 LLM 判断题变成运行时保证。**

**持久化**。作业记录写 `state/jobs/<channelId>/<jobId>.json`(`writeFileAtomically`,mode 0600):id、channelId、label、command、pid、spillFile、exitFile、timeoutSeconds、startedAt、status、exitCode、durationMs,以及唤醒契约 `{ notify: boolean; taskId?: string }`。内存 Map 仍是热路径,磁盘是真相。

**spill 文件权限**。启动命令前置 `umask 077`,使 spill 与 `.exit` 自创建起即 0600,无竞态窗口。

**启动时重建**。daemon 启动扫描 `state/jobs/**`,逐条:

- `.exit` 文件存在 → 终态化(并按契约补发唤醒,见下);
- 否则 `kill -0 <pid>` 存活 → 重新认领为 `running`,计入 `MAX_RUNNING_JOBS`,交给 sweeper 继续管;
- 否则 → `lost`。

孤儿进程与名额记账漂移一起消失;重启前未取回的输出也不再丢失。

**完成即唤醒**。`refresh()` 把作业从 `running` 变为终态时,若 `notify`(默认 true),经注入的 `dispatch`(即 durable dispatch)发一条合成唤醒,dispatchId 为 `job:<channelId>:<jobId>:done`——D1 的稳定键保证"重建时补发"与"sweeper 实时发"不会重复。文本携带 label、exit code、时长、输出尾部(截断)与 spill 路径;`taskId` 存在时指明归属任务。

因此 `job-manager.ts:48` 那条"sweep 从不唤醒 channel"的设计约束被本 spec 显式推翻并替换。

**回收**。终态作业保留 24 小时(供模型醒来读取输出),此后 sweeper 连同 spill、`.exit`、记录一并删除。

**工具面**。`bash async` 增加可选 `notify`(默认 true)与 `taskId`;`job` 工具的三个 op 不变。

**playbook**。`background-jobs.md` 删除整节「跨回合的等待」(三分支猜测完成时间),替换为一句"作业结束会自动把你叫醒";`event-scheduling.md`「回访事件」删除指向 job 等待的分支。两处交叉引用的三角消失。

### D7 futile 检测改看外部效应

新增 `src/agent/effect-ledger.ts`:per-channel 单调计数器(共享单例,与 job manager / channel memory queue 同构)。`session-events.ts` 在**成功**的改变世界的工具调用后自增——`write`、`edit`、`send_media`、`subagent`、`bash(async:true)`——以及一次用户可见的最终投递后自增。只读工具(`read`/`grep`/`web_*`/`session_search`)与自述型工具(`task_manage`/`memory_manage`)**不计**。

`taskFingerprint` 相应调整:

- **删除 `latestNote`**——它是自述,不是证据;
- **加入 `effects:<count>`**(经新增的 `TaskDriverOptions.getEffectCount?.(channelId)` 读取)。

于是"写一条 note 刷进度"不再能清零 `futileCount`,而"干了活没记账"也不再被误判。计数器在内存,重启清零——与既有 `futileCount` 同样的代价,不为它加持久化。

`taskFingerprint` 顺手去掉未使用的 `_channelDir` 参数与不必要的 async。

## 兼容性与迁移

- **磁盘格式**:events JSON 格式不变(仅 `immediate` 不再合法);task frontmatter 不变;新增 `state/jobs/` 目录,首次运行自建。
- **在途 durable 记录**:旧记录的 id 是时间戳哈希,升级后仍能正常投递与完成(id 只需自洽,不需可解析);新唤醒使用新键。无需迁移脚本。
- **既有 `immediate` 事件文件**:升级后被标记 invalid 并写 `.error.txt`,不再触发。生产环境无此类文件(无生产者),影响面为零。
- **既有超频/近期 one-shot 事件**:升级后由 watcher 判为 invalid。这是本 spec 的目的(它们本就绕过了工具层限制),`.error.txt` 会说明原因。
- **`immediate` 相关测试**:`test/events.test.ts`、`test/event-manage.test.ts`、`test/event-commands.test.ts` 中的构造需改写为 one-shot/periodic 或改为断言拒绝。

## 测试重点

- **D1**:one-shot 经"队列满 → 发件箱重试"与"重启文件恢复"两条路径只投递一次;periodic 同一 occurrence 重试不重复、跨 occurrence 不去重;escalation 同因不重复、异因不合并。
- **D2**:回合运行超过 lease 时长不被重投(集合续期生效);进程"死亡"(清空集合模拟)后记录到期重投;`cancelChannel` 后不再续期。
- **D3**:`deliveries=1` 无前缀;`deliveries>1` 有前缀且 dispatchId 不变、磁盘记录原文不变。
- **D4**:watcher 拒绝 immediate / 近期 one-shot / 超频 periodic / guard 不过的 preAction / 超额文件,各写 `.error.txt` + history `invalid`;工具与 watcher 对同一定义判定一致(共享 validator 的一致性用例)。
- **D5**:owner 缺失、owner 终态、owner 存活三种情形;channelId 含点号时反解正确。
- **D6**:重启后 running 作业被认领且计入名额;重启后已完成作业被回收并补发唤醒(与实时唤醒不重复);spill 权限为 0600;24 小时后回收;`notify:false` 不唤醒;终态转移只唤醒一次。
- **D7**:写 note 不再清零 futile(3 次后仍被 governor 暂停);发生 write/send_media 则清零;只读工具不清零;计数器重启归零。

## 落地顺序

D1 → D2 → D3 → D4 → D5 → D7 → D6。

D1–D3 同属投递层、共享测试脚手架,按依赖顺序连做;D4–D5 同属 watcher;D7 独立且小,先于 D6 落地以免在 jobs 大改期间同时动 driver;D6 最大且依赖 D1 的稳定键,放最后。每步独立可验证、可单独提交。

## 实现期的两处调整

落地时对设计做了两处修正，均已反映在代码与测试中：

1. **D4 的 one-shot 提前量是创建期规则，不是加载期规则。** 直接在 watcher 加载时强制它会误杀 027 引入的「重启后补跑过期 one-shot」——那是恢复，不是自触发。实现改为只对**本进程运行期间写入**的文件（`mtime >= startTime`）强制提前量，恢复路径不受影响，两种情形各有测试。

2. **D6 的 `poll` 抑制唤醒。** `job op=poll` 会把结束作业的输出**当场**交给模型；若同时再派发一条完成唤醒，模型会为一个自己刚拿到的结果多烧一个回合。实现让 `poll` 路径把记录标记为已通知而不派发；`list` 不抑制（它只显示状态行、不含输出，模型可能并未真正接手）。

## 后续边界

- per-channel 唤醒预算(限流)、task 侧的 preAction 泛化、跨三机制的统一 wake history:三者都属于"把 durable-dispatch 升格为策略层"的主线,等 D1–D7 落地后按真实痛感再评估,不在本 spec 内。
- jobs 的输出不进 workspace、不进 memory,仍只经 spill 文件与唤醒文本传递。

# Pipiclaw 杠杆效果 / 性能 / 体验 / 复杂度 评审

日期：2026-07-27
评审基线：`0.8.10-beta.2`（`master` @ c6f3076）
评审方式：只读代码审查，从装配根沿真实调用链追踪；对每个结论回到定义点确认，不按文件名或注释推断

> **修复进度（2026-07-27，第一轮）**：性能 P-1~P-5、体验 U-1~U-4 全部落地，每条的实际做法、与建议的偏差和刻意不做的部分记在对应小节的"修复"段落里。效果类 E-1~E-5 与复杂度类 C-1~C-4 本轮未动。`npm run check`（lint + typecheck + knip + 893 项单测）通过。
>
> **修复进度（2026-07-27，第二轮）**：E-2、E-3、E-5、C-4 全部落地；E-1 按缩小后的范围落地（子代理工作目录贯穿 + 验收绑定修复），刻意不做任务台账持有 workDir 那一半，理由见该节。E-4 与 C-1/C-2/C-3 本轮未动。`npm run check`（lint + typecheck + knip + 899 项单测）通过。
>
> **修复进度（2026-07-27，第三轮）**：**E-4 经重估后不成立**——原判断把外部 agent 的承载方当成"用户手写 bash"，实际承载方是 agentmux skill，它已经提供了被建议的 `start`/`probe`/`collect`/`steer` 四条原语与实例生命周期，而 agentmux 唯一给不了的"结束时叫醒 channel"正是 `bash async` 的既有职责。runtime 侧零改动；真正的缺口在 playbook 教了轮询而不是作业唤醒，已改。剩余未动项只有 C-1/C-2/C-3。

## 0. 本轮的评审视角，以及与上一轮的分工

`docs/refer/architecture-review-2026-07-25.md` 是一次**正确性 / 架构 / 安全**审查：它问的是"这个系统会不会出错、边界是否自洽"。本轮换一个坐标系，按你实际在乎的四件事重新审：

1. **效果**：它能不能真的比较长程、比较自主地把"驱动别的 AI Coding Agent 干完一件具体事"跑通。
2. **性能**：每回合、每分钟、每个后台 tick 到底在花什么。
3. **体验**：一个人在钉钉里长期用它，摩擦在哪。
4. **复杂度可控**：作为个人项目，维护面是不是已经超过收益。

安全性、隔离性、审计完整性按你的定位**主动降权**：上一轮的 P-02（子代理 bash 绕过 memory write deny）、P-05（path/network guard 不覆盖 bash）、P-11（preAction 拒绝未入审计）在本轮视角下都不是问题，甚至 P-05 那种"bash 就是通用逃逸面"恰恰是本项目要的能力形态——建议按上一轮的结论只**修文档措辞**，不要为它们增加代码约束，那是纯粹的复杂度成本。上一轮的 P-01（task lost update）、P-03（无全局支出闸）、P-12（zero-cost 条目被丢弃）在本轮仍然成立，本轮不重复论证，只在与效果/性能相关处引用。

**一句话结论**：工程质量明显高于一般个人项目——分层清晰、不变量在结构上强制、测试和 spec 齐全。但**能力形状与你陈述的核心用途存在系统性错配**：撬动外部 Coding Agent 所需的三块地基（可指定的工作目录、有进展就快速接续的节奏、外部执行体的生命周期原语）在 runtime 里都不存在，而复杂度预算的大头（记忆子系统 27 文件 / 6035 行）花在了"记住偏好"上。下一轮的正确动作不是继续加深现有分层，而是把工程预算搬到杠杆点上。

---

## 1. 效果（Leverage）：核心用途缺三块地基

### E-1 🟠 已部分修复 · 整个 daemon 只有一个工作目录，多仓库/多任务并行驱动在结构上不成立

**事实。** 执行器 `spawn("sh", ["-c", command], { detached: true, stdio: [...] })` 不传 `cwd`，因此所有命令都跑在 daemon 进程的 `process.cwd()`（`src/executor.ts:34`）。工具侧同样写死：`securityContext = { workspaceDir, cwd: process.cwd() }`（`src/tools/index.ts:39-42`），于是 `read`/`write`/`edit`/`grep` 的相对路径全部相对 daemon 启动目录解析（`src/security/path-guard.ts:87-96` 的 `resolveTargetPath` 用 `ctx.cwd`）。

子代理更明确：`const workingDirectory = resolve(options.workingDirectory ?? process.cwd())`（`src/subagents/tool.ts:238`），而 `createPipiclawTools` 构造 `createSubAgentTool` 时**从不传 `workingDirectory`**（`src/tools/index.ts:72-90`），`subagentSchema` 里也**没有任何工作目录参数**（`src/subagents/tool.ts:39-98`，只有 `paths` 这个"建议关注路径"的提示字段）。

**这与 playbook 直接矛盾。** `src/playbooks/task-delegation.md` 的"文件系统隔离"一节告诉模型："需要在独立检出上作业时，在宿主侧自行 `git worktree add`，把它当作普通工作目录传给子代理。" —— **这个参数不存在**。模型按 playbook 行动会失败，只能退化成每次 `cd <dir> && <cmd>`；而每次 `bash` 都是新 `sh`，`cd` 不跨调用保留，所以每条命令都要重复前缀。

**更严重的是验收绑定。** 任务完成时的 artifact subject 是 `workspaceSubjectHash(options.workingDirectory ?? process.cwd())`（`src/tools/task-manage/lifecycle.ts:121`、`src/tools/task-manage/verification.ts:76`），而 `workingDirectory` 来自 `ctx.securityContext.cwd`（`src/tools/registry.ts:227`）——也就是 daemon 的 cwd。`workspaceSubjectHash` 内部对该目录跑 `git -C <dir> status/rev-parse/diff`（`src/tasks/artifact-subject.ts:16-24`）。因此：**如果任务真正的产物在另一个仓库，PASS 与 approval 绑定的是错误仓库的 git 状态**；若 daemon cwd 不是 git 目录，`workspaceSubjectHash` 返回 `undefined`，验收退回到"比较 verifier 前后 git status"这条更弱的路径（`src/subagents/tool.ts:819-825`），同样指向错误的目录。这不是安全问题，是**验收语义失效**——一个"独立验收通过"的任务，验的可能是另一个项目。

**建议。** 引入一条贯穿的 `workDir`：
- 落点在 task frontmatter 的 `control.workDir`（可选，缺省沿用 daemon cwd，保持向后兼容）；channel 级别可以给一个默认值。
- 消费点四处：`Executor.exec` 增加 `cwd` 选项（`HostExecutor` 直接透传给 `spawn`，比现在 `DirectoryExecutor` 拼 `cd ... &&` 更可靠，见 `src/subagents/tool.ts:199-208`）；`securityContext.cwd`；`subagent` 的 `workingDirectory`（同时给 schema 加一个可选参数，兑现 playbook 的承诺）；`workspaceSubjectHash` 的目标目录。
- 代价：`workDir` 会成为一个新的持久字段和一个新的模型可见参数。收益：这是"用一个 channel 驱动多个项目"的前提，也是让验收绑定重新有意义的唯一办法。**这是本轮建议里优先级最高的一项。**

**修复（2026-07-27，第二轮）：采纳四个消费点里的三个，不采纳 `control.workDir`。**

已做：

- `ExecOptions.cwd`，`HostExecutor` 透传给 `spawn`。`DirectoryExecutor` 随之从拼 `cd <dir> && <cmd>` 改成设真实 cwd——那个前缀让 guard 审查到的命令和真正执行的命令不是同一条，且进不去的目录会伪装成命令内部的 shell 错误。
- **`subagentSchema` 增加 `workingDirectory`**（可选，须是已存在目录，相对路径按 daemon cwd 解析）。这不是新设计，而是补上 spec 036 D3 欠下的账：D3 删掉 task-owned worktree 的前提就是"由用户在宿主侧自行 `git worktree add` 并把路径作为普通工作目录传入"，而那个入参从来没被加上，于是每次运行都被钉死在 daemon 的 cwd 上。子代理侧的 `securityContext.cwd`、executor、`workspaceSubjectHash` 本来就已经全部读 `runContext.workingDirectory`，所以这一个参数一接通，三处同时生效。路径守卫不受影响：它判的是解析后的绝对路径，cwd 在允许根之外只会让相对路径和写死绝对路径一样被拒。
- **验收绑定跟着验收者走**：attestation 增加 `subjectDir`（记录 subjectHash 是在哪个检出算出来的），`task_manage verify` 与 `done` 改为在该目录复算 artifact subject。没有它，一旦子代理被指向别处，PASS 要么永远复算不上（fail-closed 死锁），要么——更糟——拿另一个仓库的 git 状态去比对。`done` 里顺带把 attestation 的读取提到 subject 复算之前（它才知道目录），身份校验因此先于新鲜度校验。

刻意不做：**任务 frontmatter 的 `control.workDir`，以及主代理 `securityContext.cwd` 的按任务切换。** 两条理由：

1. spec 036 D3 刚刚以明确论证删掉了"任务台账持有工作目录身份"（`worktree` 至今躺在 `RETIRED_TASK_CONTROL_KEYS` 里）。换个字段名把它加回去，是在没有新论据的情况下推翻一个刚做完的决定。
2. 主代理的工具集是**每 channel 构造一次**的，`securityContext` 被所有工具按引用持有。要让它随"当前正在推进哪个任务"变化，就得把它改成回合级可变对象，并让 runtime 从唤醒文本里反推当前任务 id——这正是题目说的"复杂度显著上升"。

主代理跨仓库因此仍然靠绝对路径（`read`/`write`/`edit`/`grep` 都接受）和 `cd <dir> && …`。真正需要独立检出的是**被委派出去的那段工作**，而它现在有参数了。

（第三轮补记：E-1 关于"一个 channel 驱动多个项目"的完整形态原本被指望落在 E-4 的 external-run 原语上。E-4 撤销后它其实已经解决——外部 agent 的工作目录由 `agentmux --cwd` 在委派时显式给出，进程内子代理由 `workingDirectory` 给出，两条路径都不需要 runtime 持有一个跨回合的 workDir 身份。）

### E-2 ✅ 已修复 · 有真实进展的任务也要等 5 分钟才接续，长程自主推进被结构性限速

**事实。** `DEFAULT_TASK_DRIVER = { continuationDelayMinutes: 5, stalledRetryMinutes: 60, maxDispatchesPerTick: 4, maxSleepMinutes: 15 }`（`src/settings.ts:233-238`），且这四个键已被列为 retired，用户无法调整（`src/settings.ts:310-313`）。

准入判定：

```ts
const changed = attempt.fingerprint !== fingerprint;
const delayMinutes = changed || !attempt.accepted ? settings.continuationDelayMinutes : settings.stalledRetryMinutes;
return nowMs - attempt.atMs >= delayMinutes * 60_000;
```
（`src/runtime/task-driver.ts:117-120`）

也就是说：**fingerprint 变了 = 这一轮确实有进展 → 仍然要等 5 分钟**。`nudge()` 在每个回合结束时被调用（`src/runtime/bootstrap.ts:923`），但它只能提前触发一次扫描，`isEligible` 这道闸照样拦住（`src/runtime/task-driver.ts:273-284`、`:446`）。

**后果。** 一个需要 20 个推进步骤的长程任务，纯等待就是 100 分钟。而"让外部 coding agent 干一小段 → 取回 → review → 决定下一步"恰恰是**高频小步**的形状：每步 5 分钟的强制间隔，会把一个本可以 30 分钟跑完的事拖成半天。这是本项目"长程自主"体感的第一杀手。

**判断。** 这是把**退避策略**当成**节奏策略**用了。退避的目的是防止空转烧 token；有 effect 的接续不该被同一个闸限速。项目里已经有区分二者的现成信号：`effect-ledger`。

**建议。** 把 continuation 拆成三档，用 `getEffectCount` 的增量而不是布尔 fingerprint 决策：
- 上一轮产生了 effect（write/edit/subagent/send_media/async job）→ **秒级接续**（比如 `MIN_SLEEP_MS` 量级），另配一个"每任务每小时 attempt 上限"防失控；
- fingerprint 变了但无 effect（只改了状态/笔记）→ 现在的 5 分钟；
- fingerprint 未变 → 现在的 60 分钟，并继续走 futile 计数。

改动集中在 `isEligible` 和它的调用点，风险低。注意这条依赖上一轮 P-03/P-12：放开接续频率前，最好先有一个可信的 token 账本和一个粗糙的日/月闸，否则失控成本会从"多等一会"变成"多花一笔"。

**修复（2026-07-27，第二轮）。** 按建议做成三档，`DispatchAttempt` 多存一个 `effects` 基线，`isEligible` 拆出 `attemptDelayMs`：

- 上一轮 effect 计数增长 → 延迟 0，下一次扫描（回合结束的 `nudge`）就接续；
- fingerprint 变了但 effect 没涨 → `continuationDelayMinutes`（5 分钟）；
- fingerprint 未变 → `stalledRetryMinutes`（60 分钟），futile 计数照旧；
- 派发被 channel 拒收 → 仍走 5 分钟（那一轮根本没跑）。

**没有加"每任务每小时 attempt 上限"。** 建议里提到它是为了防失控，但停止条件已经有了：快档同样消耗一次 `budget.maxAttempts`（默认 12），耗尽即被治理器暂停并上报。加第二个计时器等于让两套限额并存、互相解释不清；快档改变的只是这 12 次在墙钟上被用掉的速度，不是总量。P-5 已经把 token 账本补齐，全局日/月支出闸仍是上一轮 P-03 的欠账。

一个必须一起改的点：horizon 循环原本对已接受的 attempt 只登记 `stalledRetry` 一个时刻，于是 5 分钟档实际要等封顶 15 分钟才被重扫。现在两档都登记，`noteHorizon` 自己挑未来最近的那个——短档准时，长档也不会漏。

### E-3 ✅ 已修复 · "进展"的定义恰好排除了驱动外部 agent 最常见的动作

**事实。** 什么算 effect：

```ts
if (toolName === "bash") {
    return isRecord(details) && details.async !== undefined;
}
return EFFECT_TOOLS.has(toolName);  // write, edit, send_media, subagent
```
（`src/agent/effect-ledger.ts:37-49`）

**同步 bash 一律不算 effect**，注释也解释了理由（同一个工具既跑 `ls` 也跑 `rm -rf`，runtime 无法分辨）。同时 `taskFingerprint` 刻意排除 `latestNote`（`src/runtime/task-driver.ts:87-109`），理由同样充分（模型自述不是证据）。

**两条各自合理的规则叠加出一个坏结果。** 一个典型的"驱动外部 agent"回合：同步跑 `claude -p "..."` 或 `agentmux prompt ...`，等它返回，把结果写进 progress note，任务保持 `active` 且 `nextAction` 没变、`wake` 为空。此时：effect 计数不增、`status`/`wake`/`nextAction`/`verification` 全没变 → **fingerprint 不变 → 记一次 futile**。连续 3 次（`FUTILE_WAKE_LIMIT = 3`，`src/runtime/task-driver.ts:52`），治理器直接把任务 `paused + pausedBy=governor`（`:454-467`）。也就是说，**最卖力干活的那种回合，最容易被判定为空转并被停掉。**

`task-driving.md` 教模型每轮更新 `wake`/`nextAction`，这确实能规避；但把正确性寄托在"模型每轮记得改一个无关字段"上是脆的，而且 playbook 同时又警告"不要为了拿到短退避而伪造 progress"——两条指导在这里互相拉扯。

**建议（二选一或都做）。**
- 让 exit code 为 0 且有 stdout 的同步 `bash` 计一次**弱 effect**（权重可以低于 write，只用于"这轮不是完全空转"的判定）。风险是 `true` 也能刷，但配合 fingerprint + attempts 上限，代价可接受，比现在的假阴性划算。
- 或者在 `task-delegation.md` / `background-jobs.md` 里把"驱动外部 agent 一律用 `bash async` + `taskId`"定为硬纪律。`async` 已经计 effect，且自带完成唤醒、跨重启认领、并发上限——这条路本来就更对。

**修复（2026-07-27，第二轮）。** 取第一条：**退出码为 0 且有输出的同步 `bash` 计一次 effect**。`BashToolDetails` 因此无条件记录 `exitCode`（不再只在非零时记）并新增 `producedOutput`；`isEffectfulTool` 读这两个字段。

关于"这会不会把 futile 检测废掉"：会削弱，但削掉的正是它不该管的部分。effect 计数从来不是止损，`budget.maxAttempts` 才是；`echo x` 确实能刷分，可刷分的每一轮照样烧掉一次 attempt，12 轮后一样被暂停。而改之前的假阴性是**真在干活的那种回合**——同步驱动外部 agent、结果写进 note、返回 `[SILENT]`——被判成空转。用一个可绕过的真阳性换一个结构性的假阴性，划算。"futile"现在的含义也更诚实：这一轮**什么都没执行**。

playbook 一并改了口径：`task-driving.md` 原本教模型"有语义 checkpoint 时按较短 delay 接续"（等于暗示去操纵字段），现在改成"接续节奏由这一轮实际做了什么决定，不需要你操纵"，与"不要伪造 progress"不再互相拉扯；同时补一句"也不要跑无意义命令"。`docs/events-and-tasks.md` 的节流清单同步更新。

没有做第二条（把 `bash async` 定为硬纪律）：硬性要求 async 会把"跑一条命令看看结果"也变成建 job，成本高于收益。（第三轮补记：E-4 重估后，`bash async` 只在**等待**外部实例这一段成了首选，见 `task-delegation.md`；驱动动作本身仍然是同步 bash，这条判断不变。）

### E-4 ✅ 重估后不成立（原判断基于对承载方的错误假设）· runtime 侧无缺口，缺的是 playbook 指错了路

**原结论（2026-07-27，第一次写下时）。** `subagent` 是进程内 pi Agent（`src/subagents/tool.ts:683-692`），不是外部 Coding Agent 的适配层；外部 agent 被推给用户层（`src/playbooks/task-delegation.md`、`docs/events-and-tasks.md`、`docs/runtime-playbooks.md:84` 口径一致），而"边界之内什么都没给"——启动、探活、取回、跨重启认领全靠模型手写 bash + wake 轮询。建议做一个协议无关的 **external-run 原语**：由 workspace 配置或 skill 声明 `start`/`probe`/`collect`/`steer` 四条命令模板，runtime 负责持久化、认领、完成唤醒、并发上限。

**重估触发点。** 承载方不是"用户随手写的 bash"，而是 **agentmux**：CLI 在 `~/bin/agentmux`，skill 装在 `~/.pipiclaw/workspace/skills/agentmux/`，由 `loadPipiclawSkills()` 从 `workspace/skills` 加载并与 pi 自动发现的 skill 合并（`src/agent/workspace-resources.ts:23-27`），workspace 同名覆盖。把它当作已存在的一层来重看，原结论的前提就塌了。

**它已经提供的，恰好是被建议的那四条原语**（以本机安装版本实测，`agentmux help`）：

| E-4 想在 runtime 里声明的 | agentmux 里的既有形态 |
|---|---|
| `start` | `summon --template <t> --name <n> --cwd <dir> [--prompt ...]`，模板层封装 harness 差异 |
| `probe` | `inspect` / `list --json`，四态 `idle`/`busy`/`exited`/`lost` |
| `collect` | `capture [--json --since <cursor>]`，带增量游标 |
| `steer` | `prompt <n> --text ...`；`--key C-c` 中断；`halt` 停止 |

外部执行体的生命周期与注册表也在 agentmux 手里：实例是独立进程树（tmux 会话或长驻 harness 进程），daemon 重启不影响它；停止后留墓碑而不是消失，`inspect` 仍能读到 `end_reason`。**"跨重启认领"这件事，pipiclaw 侧只需要 task 正文里记着实例名——这本来就是 `task-delegation.md` 第 1 条纪律。**

**E-4 列的两条缺口，逐条不成立：**

1. **"探活命令不可自定义"**。这条成立的前提是让 job manager 去理解外部**会话**状态。但只要放进作业的是外部工具自己的**阻塞等待命令**（`agentmux wait <实例> --timeout <长>`），作业的结束就**等于**会话的结束——此时 `kill -0` + `.exit` 探的是等待进程本身，语义正好正确。E-4 说的"进程还在但会话已完成"是 harness 进程与会话的错配，而 `wait` 已经在外部工具那一侧把这个错配解决掉了。runtime 不需要可配置 probe。
2. **"不能中途 steer"**。这是 pipiclaw **自有**后台作业的限制（`job` 工具只有 list/poll/cancel）。对外部实例，steer 是 `agentmux prompt <n> --text ...` 一条秒级同步 bash，不占作业名额、不需要任何 runtime 机制。把 steer 做进 job manager 只会多出一条与 CLI 重复的路径。

**因此 external-run 原语现在是净负债**：它会把 agentmux 已经做完的编排层在 runtime 里复制一份，并把第三方协议（谁算 idle、cursor 怎么传、模板长什么样）以"配置面"的名义拉回 runtime——正是这条边界当初要避开的东西，还多一份会随 agentmux 升级漂移的模板配置。

**agentmux 唯一给不了的那一块，runtime 早就有了。** agentmux 无从知道 pipiclaw 的存在，所以"外部实例结束 → 叫醒 channel"只能由 runtime 提供，而这正是 `ChannelJobManager` 的既有职责：`nohup` 启动、记录镜像到 `state/jobs/<channelId>/`、重启后重新认领并补发唤醒、完成时带输出尾部 + `taskId` 唤醒 channel、每 channel 5 个并发上限（`src/agent/job-manager.ts:12-26, 218-265, 383-435, 506-549`）。组合起来是一行，不需要任何新代码：

```
bash async=true taskId=<任务id> timeout=<明显长于预计耗时>
  agentmux wait <实例> --timeout <同上> --json
```

四个交叉验证都通过：

- **guard 不拦**：`command-guard` 是黑名单式，`agentmux` 不匹配任何规则（`halt` 那条只在 `parsed.command === "halt"` 时命中，`agentmux halt` 的 command 是 `agentmux`）。
- **作业常开**：后台作业没有开关（`src/tools/config.ts:42`），主路径永远注入 `jobManager`（`src/tools/index.ts:58`）。
- **cwd 不咬人**：`agentmux --cwd` 显式传目录，E-1 剩下那一半（主代理 cwd 固定在 daemon 启动目录）在这条路径上不构成问题。
- **接续节奏对得上**：`bash async` 计一次 effect（`effect-ledger.ts` 的 `details.async !== undefined`），落在 E-2 修复后的快档，唤醒到达后立刻接续。

失败模式也是良性的：作业超时只 `kill` 掉 nohup 的等待进程，harness 实例是另一棵进程树，工作不丢，唤醒照常发出——"超时"在这里等于"提前叫我一次"，而不是"任务失败"。

**真正的缺口在知识层，而且方向是反的。** `task-delegation.md` 原文第 2 条写的是"`progress` 置 blocked，并设置合理 wake"：

- 它教的是**轮询**——每次回访烧一个完整 LLM 回合，而同一个 runtime 已经能做到零轮询、结束即唤醒；
- `background-jobs.md` 把完成唤醒讲得很清楚，但例子全是构建/测试/大文件下载，**两份 playbook 谁也没指向对方**；
- 顺带还用了退休的状态名：六态里只有 `waiting`，`blocked` 只是读取层的历史别名（`src/tasks/transitions.ts:19, 76-78`）。

于是最该零轮询的场景，playbook 恰好把模型推进了最费的一条路。这也解释了 E-3 里那个"最卖力干活的回合最容易被判空转"的形状：同步跑外部 agent、写 note、`[SILENT]`——正是被 playbook 教出来的。

**修复（2026-07-27，第三轮）。零 runtime 代码改动，只改知识层。**

`task-delegation.md` 的"外部 agent 工具"一节重写成三档等待，按用户工具的能力从优到劣：

1. **阻塞等待包成后台作业（首选）**：`bash async` + `taskId`，`progress` 置 `waiting` 且**不设 wake**，结束回合等 runtime 叫；并说明作业超时只终止等待、不杀外部实例，以及要给一个明显长于预计耗时的 `timeout`。
2. **只有状态查询命令时**：periodic + preAction 门控（忙则零 token 静默），保留 `wake` 兜底。
3. **两者都没有时**才是 `waiting` + `wake` 轮询。

同时把"启动/纠偏/取回/停止都是秒级同步 bash，不需要 runtime 参与"写明——这句话是防止将来有人再次得出 E-4 的原结论。三条不变纪律（记录现场、自己验收、闭环清理）保留，`blocked` 改为 `waiting` + `blockedReason`。`docs/events-and-tasks.md` 的"外部 Agent 工具的回访边界"和 `docs/runtime-playbooks.md` 的第三方工具边界同步为同一口径。新增回归测试 `routes external-agent waiting to the background-job wake before wake polling`，钉住 delegation playbook 必须提到 `bash async` 与 `background-jobs.md`——这条 playbook 是唯一真相源，漂回轮询会被测到。

**保留的真实局限（不修，记在这里）：**

- 并发上限 5 计的是**等待作业**，不是外部实例数：不被 async 等待的实例不占名额。个人规模下够用，需要时再谈。
- 模型忘记给大 `timeout` 时，等待作业会在默认 300s 被杀并唤醒一次。成本是一个回合，且外部工作不受影响；playbook 已提示，不值得为它加 runtime 校验。
- 若某个外部工具**没有**阻塞等待命令，就落到第 2/3 档，仍然可用但要烧回合。这是那个工具的形状问题，不是 runtime 的。
- 本机 `agentmux version` 报 `dev`，无 `run`、`list --all`，且 `~/.pipiclaw/workspace/skills/agentmux/SKILL.md` 与 `ai-skills` 上游已经分叉（上游新增了 `run` 一次成型、`--since` 成本纪律、`pi-rpc` harness）。这属于用户层升级，**恰恰是这条边界想要的形状**：pipiclaw 一行代码都不用改。建议把 skill 与 CLI 同步到上游版本，之后 `agentmux run --timeout <长> --json` 可以直接替掉 `summon + wait` 两步。

### E-5 ✅ 已修复 · 12000 字符输入上限对"扔一段构建日志过来"是硬伤

**事实。** `MAX_USER_MESSAGE_CHARS = 12_000`（`src/agent/types.ts:207`），超出时截断并提示"⚠️ 消息过长（N 字符），已截断至约 12000 字符后处理"（`src/agent/channel-runner.ts:296-300`）。

**后果。** "把这段失败日志/diff 丢给它去驱动修复"是驱动型使用里最常见的开场动作之一，而这类内容轻松超过 12k。`clipUserInput` 保留头 60% + 尾 40%、丢弃中段（`src/agent/progress-formatter.ts:10-19`），头尾策略本身是合理的默认，但对一段 40k 的构建日志，被丢掉的中段恰好是失败堆栈所在。更关键的是提示只说了"已截断"，**没有给模型或用户任何可执行的下一步**，这与 `AGENTS.md` 里"每个截断输出必须携带 next-step instruction"的自家规则不一致（同上一轮 P-10 的模式）。

**建议。** 提示改成可执行的：把超长部分落盘到 channel 目录下一个临时文件，提示里给出路径并告诉模型"完整内容在 `<path>`，用 `read` 分页查看"。这样长日志不再丢失，且走的是已有的 read 分页链路。

**修复（2026-07-27，第二轮）。** 按建议做：超限时先把原文（去 `\r`）写到 `<channelDir>/inbox/message-<ISO>.txt`（`0o600`），再截断。落在 channel 目录下是有意的——那是 `read` 默认允许的路径，恢复走的就是普通分页，不需要为它开口子。

路径同时进两个地方：给用户的中文回执，以及**送进模型的截断标记本身**（`clipUserInput` 多一个可选 `fullTextPath`，标记里带上路径和"用 read 工具翻阅"）。只改用户回执是不够的——真正需要去读那段日志的是模型，而它看不到 `respondInThread`。写盘失败时静默回落到原来的纯截断提示，不让一次 I/O 故障吃掉整个回合。

`/steer`、`/followup` 走的 `queueBusyMessage` 是同一条截断路径，一并接上了同一个落盘。

未做：落盘文件的清理。超长消息本就少见，加一套保留策略要引入"保留几份"这类新常量，而 channel 目录下的 `subagent-artifacts` 等同类产物也都由用户闭环，不为这一处破例。

---

## 2. 性能：每分钟和每回合到底在花什么

### P-1 ✅ 已修复 · 每分钟的记忆维护 tick 在任何 gate 判定之前就复制整份 transcript

**事实。** scheduler 每 60 秒跑一次（`DEFAULT_TICK_INTERVAL_MS = 60_000`，`src/memory/scheduler.ts:37`），每次选 `maxConcurrentChannels` 个 channel（生产值 = 1，`src/memory/maintenance-tuning.ts:34`），对每个调用 `getRuntimeContext`。对活跃 channel 走 `runner.getMemoryMaintenanceContext()`：

```ts
await this.ensureSessionReady();
this.settingsManager.reload();          // 一次同步文件读
return {
    messages: [...this.session.messages],              // 整份对话数组浅拷贝
    sessionEntries: [...this.sessionManager.getBranch()],  // 整份 session 分支浅拷贝
    ...
};
```
（`src/agent/channel-runner.ts:672-687`）

**然后**才轮到三个 job 依次判 gate（`src/memory/scheduler.ts:143-180`），绝大多数 tick 三个 gate 全拒（生产 gate 是 10 分钟 idle + 10/20 分钟间隔 + 6 小时结构维护，`src/memory/maintenance-tuning.ts:29-39`）。也就是说**长驻实例的绝大部分维护 tick，做的唯一实事就是复制两个数组、读一次 settings 文件，然后什么都不干**。

单次成本不高（浅拷贝 + 一次 4KB 读），但它是每分钟、永远在跑的。叠加上一轮 P-06 记录的"每 tick 写三条 skip 到 `memory-review.jsonl`"，长驻实例的稳态开销全是无信息写放大。

**建议。** 把 `MemoryMaintenanceRuntimeContext` 的 `messages`/`sessionEntries` 改成惰性 getter（`() => AgentMessage[]`），gate 通过后再求值；`settingsManager.reload()` 同样后移。这是一次纯机械的改动，配合上一轮 P-06 的去重修复一起做，能让"闲置实例接近零开销"这个契约真正成立。

**修复（2026-07-27）。** 按建议做了，但范围比"改成 getter"更大一点：真正贵的不是那两次浅拷贝，而是 gate 之前就被算掉的三样东西——`hasMeaningfulMessages()` 要 sanitize 并扫描整份 transcript、`buildIncrementalMemorySourceWindow()` 要构造增量窗口、structural job 要读两份 MEMORY.md/HISTORY.md。只把数组改成 getter 并不能省掉它们，因为 gate 的入参是提前算好的布尔值。

- `MemoryMaintenanceRuntimeContext.messages`/`sessionEntries` 改为 `() => T[]`（`scheduler.ts`、`channel-runner.ts`、`maintenance-context.ts`）。
- 三个 gate 的"材料"入参改成 thunk：`hasNewSessionEntry`/`hasMeaningfulMaterial` 是 `() => boolean`，checkpoint 收敛成一个 `material: () => {...}`，structural 是 `material: () => Promise<...>`（该函数因此变 async）。gate 内部仍然是先判便宜条件、再取材料，所以被拒的 tick 一行材料都不会算。
- jobs 里用一个 8 行的 `once()` 让 gate 与 job 正文共用同一次昂贵求值，不会算两遍。
- 新增用例 `never evaluates material when a cheap schedule gate denies` 把"闲置 tick 零材料成本"钉成回归测试。
- 未动：`settingsManager.reload()` 仍在 context 构造时执行。把它也惰性化要求 `settings` 变成 thunk 并穿透所有 job 与 consolidation 入参，收益（每分钟一次 4KB 读）配不上这个改动面。detached 路径的 `createModelRuntime()`（每 tick 读 auth.json + models.json）同理留在原处：缓存它会让模型配置改动在维护路径上失效，属于把性能问题换成正确性问题。

### P-2 ✅ 已修复（按更小的方案） · bash 输出溢出时把 10MB 从进程内存经 stdin 写回磁盘

**事实。** `HostExecutor` 把 stdout/stderr 全量累积到进程内存，各自上限 10MB（`src/executor.ts:94-106`）。`bash` 工具在输出超过 `DEFAULT_MAX_BYTES` 时，**再 spawn 一个 `sh` 跑 `cat > /tmp/pipiclaw-bash-<id>.log`，把刚才那份内存内容通过 stdin 灌回去**（`src/tools/bash.ts:245-258`）。

一次大输出因此付出：一次内存峰值（最多 10MB 字符串，Node 里是 UTF-16，实际约 20MB）+ 一次完整的进程间拷贝 + 一次磁盘写。这条路径在"跑测试套件"、"跑外部 agent 的完整日志"这类场景下是常态而非例外。

**建议。** 让 executor 支持"输出直接重定向到文件"：`exec(cmd, { spillTo: path })` 内部拼 `{ cmd; } > path 2>&1`，然后只 `tail` 需要的尾部。省掉内存峰值和回写。同一改动也让 `job-manager` 的 spill 路径统一。

**修复（2026-07-27）。** 没有采纳 `spillTo`，采纳了它三项成本里的两项：`bash.ts` 的溢出落盘改为直接 `writeFile(path, output, { mode: 0o600 })`，省掉一次 `sh -c 'cat > file'` 进程和一次最多 10MB 的管道拷贝（顺带把权限收成 owner-only，之前靠 /tmp 默认权限）。

不做 `spillTo` 的理由：要在**执行前**决定是否重定向，就必须让每条 bash 命令都先写临时文件、再 `tail` 回来（多两次 exec + 一个文件），而绝大多数命令的输出根本不超限——这是把常见情况的成本抬起来换极少数情况。留在原地的只有 executor 内存里那份字符串累积（本来就有 10MB 上限）。

### P-3 ✅ 已修复 · 运行中的每个后台 job 每 10 秒 spawn 一次 shell 探活

**事实。** sweeper 间隔 `SWEEP_INTERVAL_MS = 10_000`（`src/agent/job-manager.ts:87`），每次对每个 running job 执行一条 `if [ -f ... ]; then ...; elif kill -0 <pid>; then ...; fi` 探测（`:322-327`），每条都是一次完整的 `spawn("sh", ...)`。上限 5 个并发 job（`MAX_RUNNING_JOBS`），即最多每 10 秒 5 次 spawn，持续整个 job 生命周期。

个人规模下这不会压垮机器，但如果按 E-4 的建议把外部 agent 驱动搬到 job 机制上，job 会变成常态而非例外，这个成本值得先解决。

**建议。** 一次 sweep 用**一条**命令批量探测所有 running job（把 pid/exitFile 列表拼进一个循环脚本），把 N 次 spawn 降到 1 次。

**修复（2026-07-27）。** `refresh()` 拆成 `probeAll()`（一条命令里每个 job 一个分支，打印 `<id> EXIT:<code>|ALIVE|GONE`）+ `applyProbe()`（原来的状态迁移逻辑，逐字保留）。sweep 走批量路径，N 次 spawn 变 1 次；`list`/`poll`/`restore` 仍走单 job 的 `refresh()`，行为不变。新增用例断言"一次 sweep 只发一条探活命令，且分支数等于运行中的 job 数"。

### P-4 ✅ 已修复 · TaskDriver 每 tick 全量重读所有 channel 的所有 task 文件

**事实。** `const entries = await readActiveTasks(join(channelDir, "tasks"), nowMs)`（`src/runtime/task-driver.ts:346`），无 mtime 缓存。tick 由定时器（`≤ maxSleepMinutes = 15` 分钟，且被 attempt horizon 拉到 5/60 分钟粒度）和 `nudge()`（**每个回合结束都触发**，`src/runtime/bootstrap.ts:923`）驱动。

在一个持续推进的长任务链上，每个回合结束都会触发一次"读遍所有 channel 的所有任务文件 + 解析 frontmatter + 解析 control JSON"。任务不多时无所谓，但这是 E-2 建议"秒级接续"之后会被放大的路径。

**建议。** 给 `readActiveTasks` 加一层按 `(path, mtimeMs, size)` 的解析结果缓存，和 `MemoryCandidateStore` 的做法完全一致（`src/memory/candidates.ts:59-61, 274-276`）——项目里已经有现成的模式可以照抄。

**修复（2026-07-27）。** 照抄了 candidate store 的指纹，用 `(mtimeMs, ctimeMs, size)`（多一个 ctime：任务写入走 `writeFileAtomically` 的 rename，ctime 一定变，比只看 mtime 更难被同毫秒改写骗过）。关键细节：`actionable` **不进缓存**——它是 `now` 的函数，每次调用都用当前时钟重算，否则一个 wake 到点的任务会永远被判成未到点。缓存上限 512 条，超了整表清空。新增用例覆盖"同一文件换时钟后 actionable 翻转"和"文件改写后被重新解析"。

### P-5 ✅ 已修复 · usage ledger 丢弃 cost=0 的条目，使 token 维度的自动化闸门失去数据基础

上一轮 P-12 已完整论证（`src/usage/ledger.ts:82`：`if (!(entry.cost.total > 0)) return;`）。本轮只补充它与自主性的关系：**E-2 建议放开接续频率、E-4 建议让外部 agent 常驻，两者都需要一个可信的"这个月烧了多少"来兜底**。而现在只要用的是本地模型或缺 pricing 元数据的模型，账本就是空的，`/usage` 看不到任何东西，任何基于 token 的闸门都会 fail-open。**如果要做 E-2，先做 P-12。**

**修复（2026-07-27）。** 落盘条件从"有成本"改成"有 token 或有成本"，只丢弃双零的空条目。但只改这一处并不够，还有两个上游/下游缺口一起补了：

- `channel-runner.ts` 的记账整段被 `if (totalUsage.cost.total > 0)` 包着——本地模型连 `record()` 都到不了。改成 `cost > 0 || tokens > 0`。
- `UsageSummary` 原本只有金额，于是即使条目落了盘，`/usage` 依然只会显示 `$0.0000`。新增 `totalTokens` 并在 `/usage` 里与金额并列显示（`本频道：$0.0123 · 45k tokens`）。

这样"token 维度的闸门"才真的有数据可读。E-2 的前置条件因此就位（全局日/月支出闸本身仍未做，属于上一轮 P-03）。

---

## 3. 体验：一个人长期用的摩擦点

### U-1 ✅ 已修复 · `/stop` 会顺手把任务 pause，但只告诉用户"Stopping the current task"

**事实。** `handleStop` 在检测到当前回合是 `[TASK_DRIVER:<id>]` 或 `[TASK_CYCLE:<id>]` 驱动时，会调用 `pauseTask` 把该任务置为 `paused`（`src/runtime/bootstrap.ts:657-673`），结果只写进 `log.logInfo`。而用户看到的回复是 `sendPlain(channelId, "Stopping the current task.")`（`src/runtime/dingtalk.ts:1337-1338`）。

**后果。** 用户以为自己只是打断了这一轮，实际上任务已经停摆，必须显式 `/tasks resume <id>` 才会再被 driver 拾起（`task-driving.md` 的"不唤醒"一节确认了这一点）。一个长程任务因此可能沉默几天，而用户完全不知道发生了什么。这是本轮体验部分最值得先修的一条。

**建议。** 回复文案带上后果和恢复入口：`已停止当前回合。任务 <id> 已暂停，用 /tasks resume <id> 继续。` 更进一步可以考虑区分"停这一轮"和"停这个任务"两种意图——但先把告知补上，一行字的成本。

**修复（2026-07-27）。** `DingTalkHandler.handleStop` 从 `Promise<void>` 改为返回 `StopOutcome { pausedTaskId? }`，transport 据此给出：任务被暂停时是 `已停止当前回合。任务 \`<id>\` 已暂停，用 \`/tasks resume <id>\` 继续。`，否则只说 `已停止当前回合。`。没有做"停这一轮 vs 停这个任务"的意图区分——那要新增命令和一套语义，超出这一轮的范围；先让后果可见。

### U-2 ✅ 已修复（交互面，报告字段标签保留英文） · 界面语言中英混杂，且 `/help` 全英文

**事实。**
- 中文：`未知命令 \`/x\`。发送 \`/help\` 查看可用命令。`（`src/agent/commands.ts:254`）、`⚠️ 消息过长（N 字符）…`（`src/agent/channel-runner.ts:298`）、`⚠️ 模型 X 出错（…），切换到 Y 重试…`（`:428`）、全部 playbook。
- 英文：`_Sorry, something went wrong._`（`:510`）、`No task is running. Use \`/stop\` only while a task is running.`（`:615`）、`Queued as steer. I'll apply it after…`（`src/runtime/bootstrap.ts:796-798`）、`A task is already running. While streaming you can use: …`（`src/runtime/dingtalk.ts:1371`）、`BUILT_IN_COMMANDS` 全部 description/argumentHint 因而 `/help` 全英文（`src/agent/commands.ts:44-160`）。

**判断。** 这不是"要不要国际化"的问题——项目已经选了中文（playbook、诊断、告警全中文），只是**没选干净**。对一个中文单人使用场景，`/help` 一屏英文是很突兀的落差。

**建议。** `CommandSpec.description` 已经是唯一真相源（`/help`、TUI 补全、busy 提示都从它派生，注释里写明了），改一处即可覆盖三处。剩下十来条散落的英文字符串一次性中文化。这是低风险高感知的改动。

**修复（2026-07-27）。** 定的线是：**会话/交互文案一律中文，结构化报告里的字段标签保留英文**（`status:`、`attempts:`、`next wake:` 这些是数据栏位，翻译反而更难对照代码和 spec）。

已中文化：`BUILT_IN_COMMANDS`/`SESSION_COMMANDS` 的全部 description 与 `<消息>` 一类自由文本占位（因此 `/help`、TUI 补全、busy 提示一次覆盖）、`/help` 正文、错误回执（`_抱歉，出错了。_`）、无运行回合时的 `/stop`·`/steer`·`/followup` 回复、steer 排队回执、忙时斜杠命令提示、TUI 的停止提示、`/usage` 整屏、`/tasks` 的**动作回执**（找不到任务 / 已暂停 / 已恢复 / 已批准 / 已排入执行 / 用法 / 未知动作）与各报告标题。

未动：`/tasks list|stats|doctor` 报告正文里的字段标签与 `Next step:` 诊断行、`/events`、`/status` 的字段名。这些是数据视图；真要翻译应当连同 spec 术语一起做，不适合塞进这一轮。

### U-3 ✅ 已修复 · 长回合缺"已经跑了多久 / 到第几步"的常驻可读性

**事实。** progress 卡以 800ms 节流更新（`MIN_UPDATE_INTERVAL_MS`，`src/runtime/delivery.ts:7`），rolling 模式只保留最近 3 条（`ROLLING_WINDOW_SIZE`，`:8`）。累计耗时和工具调用数**只在收尾时**出现一次：`Done · N tool calls · Ns`（`buildSummaryText`）。

**后果。** 在 rolling 模式下看一个跑了 10 分钟的驱动型回合，用户始终只看到最近 3 条工具标签，无法判断"它到底推进到哪了、还是卡住了"。

**建议。** rolling 模式的卡片首行常驻一个摘要：`⏱ 3m12s · 14 步 · 当前：<label>`。数据（`progressStartedAt`、`toolCallCount`）已经在 `ChannelDeliveryController` 里了，只是现在只在 finalize 时用。

**修复（2026-07-27）。** rolling 模式的卡片首行常驻 `⏱ 3m12s · 14 步`。没有带 `· 当前：<label>`：滚动窗口的最后一条本来就是当前动作，重复一遍只会挤掉一条真实进度。

一个必须一起改的点：首行随时间变化，所以 rolling 模式不能再用"只追加增量"的路径（会留下一条过期的首行），改为每次 replaceCard。窗口满了以后本来就是这样，代价只是前 3 次更新多一次整卡替换。收尾摘要同时中文化为 `完成 · 14 步 · 3m12s`。

### U-4 ✅ 已修复（收窄为单字段直改） · `/tasks` 只能读和治理，创建/修改任务必须走一整个 LLM 回合

**事实。** `/tasks` 的动词是 `show|archive|approve|pause|resume|run|stats|doctor`（`src/agent/commands.ts:83-96`）——全是只读或状态治理。想改一个 `wake`、调一次 `maxAttempts`、修一行 `nextAction`，都得用自然语言让模型去调 `task_manage`，代价是一个完整回合的 token 和几十秒延迟。

**判断。** 这个设计在"让模型拥有台账"的意义上是自洽的，不算错。但对**你自己**这个唯一用户，"我知道我要改哪个字段"是高频场景。`/tasks set <id> wake=...` 这类直达入口的收益/成本比很高，而且 `task_manage set` 的校验逻辑可以直接复用。属于可选优化，不紧急。

**修复（2026-07-27）。** 加了 `/tasks set <id> <wake|next|priority|attempts|deadline> <值>`，语法是"一次一个字段、值取该行剩余全部内容"，不是 `key=value` 列表——后者要处理引号和转义，而 `next` 的值本来就是一句带空格的中文。留空表示清除（wake/next/deadline）。

刻意收窄的边界：只放开这五个"用户自己就知道该改成什么"的字段。`status` 迁移、验收、审批、副作用等级仍然只走 `task_manage`——它们背后是一台状态机（离开 verifying 会作废 PASS、改契约会作废 approval），复制到第二个入口就是复制一份会漂移的规则。校验不重写：`wake` 复用台账的 ISO8601 规则，其余四个走 `applyTaskControlPatch`（`task_manage set` 用的同一个函数），只在 `priority`/`attempts` 上加了两个把字符串转成合法枚举/正整数的解析器。`TASK_PRIORITIES` 因此从 `tasks/control.ts` 导出，避免枚举被抄第二遍。

---

## 4. 复杂度可控性

### C-1 🟠 维护面已经接近个人项目的上限，且大头花在非杠杆处

**规模事实**（`.ts` 行数）：

| 域 | 文件 | 行数 |
|---|---|---|
| runtime | 15 | 6183 |
| **memory** | **27** | **6035** |
| agent | 24 | 4949 |
| tools | 29 | 4935 |
| security | 6 | 1639 |
| subagents | 2 | 1516 |
| shared | 16 | 1596 |
| tui | 10 | 1232 |
| web | 7 | 1119 |
| **tasks** | **5** | **909** |
| usage / models / playbooks | 5 | 554 |

src 合计 150 文件 / 32115 行；test 20111 行；evals 3605 行；docs 21257 行 markdown（含 36 个 spec 目录 / 48 个 md）。**文档与源码之比约 0.66:1。**

**关键对比：真正撬动杠杆的三块——`tasks/`(909) + `job-manager`(585) + `subagents/`(1516) ≈ 3000 行；服务"记住偏好"的记忆子系统 6035 行，是前者的两倍。** 记忆里有 4 层文件、3 个 job、3 类 gate、独立的 state / review-log / tombstones / promotion / candidates / metadata / source-window / task-digest / chinese-words 分词表。

**判断。** 记忆本身做得好（上一轮的 O-08 论证了 archive-before-fold 和 hash-only tombstone 的正确性），本条**不是建议删记忆**。而是提示一个投入比例问题：如果核心用途是撬动外部 Agent，那么下一阶段的工程预算应当压到 E-1/E-2/E-4，而**不是继续加深记忆分层**。记忆子系统建议进入"维护模式"——只修 bug（比如上一轮 P-06 的 skip 去重），不加新层。

### C-2 🟠 历史兼容层对一个个人项目是净成本，0.9.0 应该一次性砍掉

**事实。** 现存的兼容包袱：
- `RETIRED_SETTINGS_KEYS` 35 项 + `hasNestedKey` 扫描 + 启动告警（`src/settings.ts:279-330`）
- `RETIRED_TASK_CONTROL_KEYS` + `retiredTaskControlKeys()`（`src/tasks/control.ts:198-218`）
- `migrateLegacyAppHome` + `LEGACY_APP_HOME_DIR`，代码里自带 `FIXME(0.9.0)`（`src/runtime/bootstrap.ts:304-334`）
- `migrateLegacyTaskScheduleEvents`（`src/runtime/task-migration.ts`，每次启动都跑一次）
- settings 的双层类型：用户输入窄接口 + 运行时宽接口，两个形状不镜像

**判断。** 对一个有外部用户的产品，这些都是负责任的做法。对一个**只有你一个用户、你完全知道自己的 `~/.pipiclaw` 里有什么**的项目，它们是纯负债：每一项都要维护、要测试、要在读代码时绕过。

**建议。** 0.9.0 直接删：迁移代码删掉（必要时手动改一次自己的配置），retired keys 列表删掉（改成"未知键一律忽略"或干脆不管）。预计能减掉几百行 + 对应测试，且让 settings/control 的类型回到单一形状。

### C-3 🟡 三处合成唤醒各自硬编码模板，是"agent 反向依赖 runtime"的具体成本

**事实。** 三个地方独立构造 `DingTalkEvent` 并各自手写唤醒文本：
- `createTaskDriverEvent`（`src/runtime/task-driver.ts:136-173`）
- `taskEscalationEvent`（`:190-207`）
- `ChannelJobManager.announce`（`src/agent/job-manager.ts:379-394`）

三份文本各自硬编码 playbook 路径（`join(PLAYBOOKS_DIR, "task-driving.md")` 等）和 `[SILENT]` 约定。改一次静默协议要动三处，且第三处还住在 `agent/` 域里——这就是上一轮 P-08（agent → runtime 反向依赖）在日常维护里的实际成本。

**建议。** 抽一个 `runtime/wake-templates.ts` 集中三类唤醒文本与 dispatchId 规则；顺带按上一轮 P-08 的建议引入 transport-neutral 的合成事件类型，两件事一起做比分开做便宜。

### C-4 ✅ 已修复 · playbook 之间存在知识重复

`task-closeout.md` 的"independent + external 同时存在"（264-276 行）和 `task-driving.md` 的"回合结束必须留下确定性状态"（359 行）各写了一遍 verifying 车道 / 只改 wake 不换状态 / PASS 失效规则；`task-planning.md` 的"外部副作用与独立验收并存时"（447 行）第三次复述了同一套死锁规避逻辑。三处措辞不同，将来改规则时很容易只改一处。

**建议。** 让 `task-closeout.md` 成为门禁规则的唯一真相源，另两处只留一句指针。playbook 的 token 也是每回合成本（catalog 进 system prompt，正文按需 read），去重同时省钱。

**修复（2026-07-27，第二轮）。** 按建议做：`task-closeout.md` 开头点明它是验收/审批门禁规则的唯一真相源；`task-driving.md` 删掉重述的 verifying 车道与 PASS 失效规则，改成"需要时读 `task-closeout.md`，不要凭记忆推断"；`task-planning.md` 的死锁规避段落收成一句"只验收准备质量，理由与完整门禁顺序见 `task-closeout.md`"。

评审里的行号（264-276 / 359 / 447）对不上现在的文件（三份分别是 51/77/75 行），但指认的三处重复确实存在，按内容定位处理。

---

## 5. 优先级建议

按「对核心用途的收益 ÷ 改动成本」排序：

| # | 项 | 类型 | 为什么排这里 |
|---|---|---|---|
| 1 | ~~**E-1 工作目录贯穿**~~ ✅（缩小范围） | 效果 | 已完成子代理 `workingDirectory` + 验收绑定跟随验收者目录；`control.workDir` 与主代理按任务切 cwd 刻意不做，理由见该节。 |
| 2 | ~~**E-2 + E-3 接续节奏与 effect 定义**~~ ✅ | 效果 | 已完成。接续拆三档、同步 bash 计弱 effect；未加每小时 attempt 上限（`maxAttempts` 已是止损）。 |
| 3 | ~~**U-1 `/stop` 告知任务已暂停**~~ ✅ | 体验 | 已完成；`handleStop` 现在回传被暂停的任务 id。 |
| 4 | ~~**E-4 external-run 原语**~~ ❌ 撤销 | 效果 | 重估后不成立：四条原语已由 agentmux skill 提供，完成唤醒已由 `bash async` 提供，做进 runtime 是复制 + 漂移。改为知识层修复（playbook 三档等待），已完成。 |
| 5 | ~~**P-1 惰性 maintenance context**~~ ✅ | 性能 | 已完成。实际范围比"机械改动"大：真正贵的是 gate 之前算掉的材料，不是数组拷贝。 |
| 6 | ~~**U-2 语言统一** + **E-5 长输入落盘**~~ ✅ | 体验 | 均已完成。E-5 的路径同时进用户回执和送给模型的截断标记。 |
| 7 | **C-2 0.9.0 砍兼容层** | 复杂度 | 纯减法，减掉几百行代码和测试。 |
| 8 | ~~P-2/P-3/P-4 执行器与缓存~~ ✅ | 性能 | 已完成（P-2 取更小方案，见该节）。E-2 已落地，这几条没有被放大。 |
| 9 | C-3 唤醒模板 / ~~C-4 playbook 去重~~ ✅ | 复杂度 | C-4 已完成；C-3 仍待与上一轮 P-08 合并做。 |

**下一轮的起点**：效果类已经没有待办项了（E-4 撤销后，E-1 剩下的那一半也随之解决——"一个 channel 驱动多个项目"的完整形态由 `agentmux --cwd` + 子代理 `workingDirectory` 承担，不需要 runtime 持有 workDir）。剩下的是复杂度类：**C-2（纯减法）**优先，然后 C-3（与上一轮 P-08 合并做）。

**第二轮的验证缺口**：E-2/E-3 的新行为有单测（三档接续、同步 bash 的四种组合），但仍未跑 evals harness 做行为实证；E-5 的落盘只在 `clipUserInput` 层有测试，没有走完整 channel-runner 回合。

**第三轮的验证缺口**：E-4 的重估验证了组合的**每一个环节**（guard 放行、作业常开、cwd 显式传、effect 计数、超时只杀等待进程），但没有端到端跑一次"钉钉发话 → 委派 agentmux → 作业唤醒 → 验收"的真实闭环。这条链上唯一没有既有测试覆盖的是模型会不会照新 playbook 行动，属于行为面，宜用 evals 或一次真实使用验证。

---

## 6. 值得保持的（不要在优化中弄坏）

1. **prompt 的确定性构建与预算体系。** `buildPipiclawSystemPrompt` 明确禁止读时钟、文件序、channel id，这正是两个 channel 共享一份 provider 端 cache prefix 的前提（`src/agent/prompt/builder.ts:1-16`）；runtime-authored 段有 700/1200 unit 的软硬两档预算并在超标时产出 diagnostic。`/context` 能只读地看到分解且不花 LLM 钱。这套东西在长程使用里是省钱和防漂移的核心，任何新增 prompt 内容都应该继续走 section 管道。
2. **channel 事实随 turn 走、不进 system prompt。** `renderChannelTurnContext()`（`src/agent/channel-runner.ts:742-749`）只有 4 行，把目录和"这些文件是 runtime 维护的"讲清楚，剩下交给工具。这个取舍是对的。
3. **memory candidate 的 fingerprint 缓存 + WeakMap 分词缓存。** `(exists, mtimeMs, ctimeMs, size)` 判缓存有效（`src/memory/candidates.ts:59-61`），分词结果挂在 candidate 对象上（`src/memory/recall.ts:347-360`）。这让每回合召回在文件没变时几乎零成本——P-4 建议的 task 缓存直接照抄这个模式即可。
4. **rerank 的 3 秒短皮带 + fail-open。** `MEMORY_RECALL_RERANK_TIMEOUT_MS = 3_000` 且失败回落到本地排序（`src/memory/recall.ts:87, 625-628`），注释里还记录了"曾经对每条中文消息强制 rerank 导致 8 秒延迟"的教训。在关键路径上加 LLM 调用的正确姿势。
5. **job 的完成唤醒是 runtime 保证，不是模型职责。** `job-manager.ts:12-26` 的注释把理由说清楚了："让模型预测完成时间并安排自己的回调，是它做不对的判断"。这条设计哲学应该扩展到 E-4 的 external-run 原语上。
6. **`effort` / `context` 三档预设。** 子代理的预算和上下文注入用三个语义档位而不是让模型填数字（`src/subagents/tool.ts:50-64`），配合"触顶时给一轮无工具的收敛回合"（D6，`:762-790`）——比"预算耗尽就丢弃全部工作"好得多。

---

## 7. 本轮盲区

- 未运行 `npm run check` / `npm run eval`：本轮全部结论来自静态代码追踪，未做行为验证。E-2、E-3 的失效路径是从代码推导的，**建议用 evals harness 各写一个用例实证**（driver 的 `runOnce` 和 dispatch observer 都已经为此暴露了，见 `src/runtime/bootstrap.ts:103-118`）。
- 未实测性能数字：P-1/P-2/P-3 是路径分析而非 profile 结果，量级判断基于代码结构。
- 未连真实钉钉，U-1/U-3 的体感结论来自代码与文案，未做真人回归。
- 未审计上游 `@earendil-works/pi-coding-agent`：`AgentSession` 的 compaction、steer 队列、resource reload 行为按其公开契约理解。
- 未评估 TUI 路径（1232 行）：本轮只从 `ChannelContext` 的第二实现角度确认它没有破坏抽象，没有单独审它的体验。

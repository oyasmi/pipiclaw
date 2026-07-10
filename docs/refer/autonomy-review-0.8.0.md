# Pipiclaw 自主长程工作设计评审（0.7.5 → 0.8.0）

- 评审日期：2026-07-11
- 评审范围：events 机制、任务台账（specs 019/020/022/023/024）、内建 task driver、durable dispatch、验收车道、外部授权，以及它们组成的"唤醒 → 推进 → 记账 → 睡去"循环。
- 评审问题：**这套设计能否稳定承担自主长程任务？**
- 评审基准：个人 AI 助手的目标——简约、易懂、符合用户预期、稳定有生产力；不追求对抗性安全，不追求平台化全面性。

## 一、结论

**架构上能稳定承担自主长程任务。** 骨架的关键决定都做对了：

1. **确定性归运行时，判断力归模型。** 调度（wake 扫描）、预算（attempts/token/cost/时长）、依赖就绪、截止升级、外部授权、验收失效——全部是零 token 的确定性门禁，模型只在门禁放行后干需要判断的活。这是自主循环能"稳"的根本：模型不守纪律时，系统退化为更慢，而不是更疯。
2. **真相在文件里，投递至少一次，读不懂就暴露。** task 文件是唯一事实源；`state/dispatch/` outbox 保证崩溃不丢工作；损坏的 frontmatter fail-open 唤醒修复而非静默跳过。三条合起来，进程随便杀、随便重启，台账自己会爬起来。
3. **token 失控有多层保险。** 语义指纹退避（运行时记账刻意不算进展，见 `task-driver.ts` 的 `taskFingerprint` 注释——这个细节做得很对）、5/60 分钟两档冷却、每 tick 最多 4 个 channel、event_manage 防自激励闸门、最终 attempt/token 预算兜底。一个"每轮都写一句话但没实质进展"的模型，最坏以 5 分钟节奏烧 12 个 attempt（约 1 小时）后被升级叫停。
4. **纪律内建，配置归零。** 0.8.0 把 SOP 内置进 system prompt、driver 内置进 runtime，用户侧不再需要 heartbeat 事件、传感器脚本和 AGENTS.md 模板。少一处需要人工保持同步的东西，就少一类漂移故障。

对照 loop engineering 的五要素：心跳（driver）、隔离（worktree 子任务）、制度记忆（task Manual + skills）、连接器（events preAction 传感器）、验证分离（purpose=verify 车道）——全部在位，且状态外置（"the repo doesn't forget"→ 这里是 "the ledger doesn't forget"）。设计方向没有缺课。

剩下的问题不是架构问题，是**校准与配比**问题：有两处机制的默认行为会在真实长程场景里违背用户预期（见发现 1、3），有一处双载体设计是遗留的最大一致性负担（发现 2），有一处承诺与实现存在张力（发现 4）。都可以在不动骨架的前提下修。

## 二、故障模式走查

评估"稳不稳"最直接的方式是走一遍失败路径：

| 故障 | 机制 | 结果 |
|------|------|------|
| 进程在回合中崩溃 | dispatch 记录带 15 分钟 lease，重启后过期重放 | 任务重跑一轮（at-least-once），台账不丢 |
| 入队后、执行前崩溃 | 同上，outbox 是先落盘再入队 | 同上 |
| channel 队列满 | outbox 保留 pending，30 秒周期重试 | 延迟，不丢失 |
| task 文件/frontmatter 损坏 | fail-open 视为 actionable，driver 事件附修复指令；doctor 可诊断 | 暴露并修复，不静默漏掉 |
| 模型不写 progress / 空转 | 指纹无变化 → 60 分钟退避；attempts 预算兜底 | 降速直至升级，不热循环 |
| 模型每轮写点无意义进展 | 指纹变化 → 5 分钟节奏，但 12 attempts 约 1 小时耗尽 | 有界，升级叫停 |
| 超预算 / 过截止 / 依赖终态失败 | 确定性 governor 拦截，不进普通工作循环 | escalated + 一条说明消息 |
| 重启丢内存退避状态 | 有意 fail-open：下次扫描重新接起 actionable 任务 | 恢复语义正确 |
| 用户长期不回复 | awaiting-user + wake 推迟，等待期零 token | 正确——但见发现 1 的预算侧漏 |

结论：没有发现会导致**丢工作**或**无界烧钱**的路径。以下发现均为校准问题。

## 三、主要发现与建议

### 发现 1（高）：attempt 预算把"耐心"当"工作"消耗，长任务会被轮询烧穿

driver 每次受治理唤醒都先 `claimTaskAttempt`（`task-driver.ts:280`），而 `finishTaskAttempt`（`bootstrap.ts:863`）只回写用量、从不退还。于是一个 `awaiting-user`/`blocked` 的任务，每次到点回访——哪怕这一轮只是"用户还没回，wake 再推 4 小时"——都消耗 1 个 attempt。

文档承诺"等待中的依赖不会消耗 attempt"，但**时间等待会**。这正是长程任务最常见的形态：等用户确认、盯 agentmux 交付、每天看一眼外部条件。默认 `maxAttempts: 12` 意味着一个每天回访一次的任务，纯轮询不到两周就会被 governor 以"attempt budget exhausted"升级——任务本身毫无问题，用户看到的却是一条莫名的升级消息。这是当前设计里**最直接违背用户预期**的行为。

**建议**：attempts 只统计"做功"的轮次。最小改法是在 `finishTaskAttempt` 里退还等待轮：本轮结束时 status 仍为 `awaiting-user`/`blocked`、且除 wake/usage 外台账无语义变化（可复用现成的 `taskFingerprint` 判定）→ `attempts--`。token/cost/时长照记——钱才是真正的资源，预算继续兜底 token 失控；attempts 回归它的本意："这个任务被实质推进了多少次"。

### 发现 2（高）：周期任务的"一个文件 + 一个事件"双载体，是剩下最大的一致性负担

0.8.0 已经把普通任务的 `.checkin` 事件消灭了（wake 即恢复条件——这步简化非常好），但周期任务仍要求一个 canonical `task.<channelId>.<id>.schedule` 事件。为了维护这个 seam，系统付出了：事件命名约定（channelId 必须编入名字防跨 channel 覆盖）、创建/退役时成对操作的 SOP、收尾时 `task.<ch>.<id>.*` 前缀清扫、doctor 的孤儿检查、以及文档里成节的解释。frontmatter 里的 `recurrence` 反而只是"给人读的自由文本"——**节奏的真相不在任务文件里**，这与"task 是在途工作的真相"的核心不变式自相矛盾。

文档给出的理由是职责分离（"改节奏改事件，改做法改文件"），但这个分离收益很小（改节奏本来就是改一个字段的事），代价却是一整类只有靠纪律和 doctor 才能压住的漂移故障：忘建事件的周期任务永远沉睡、忘删事件的退役任务留下孤儿、事件文本写错任务 id 则唤醒后无所适从。

**建议**：让 `recurrence` 成为真 cron（如 `recurrence: 30 9 * * 1` + 可选时区字段），driver 原生开启新周期——扫描本就每分钟一次，判定"done 的周期任务 cron 已到点 → 执行 start-cycle 语义并唤醒"是廉价确定性操作，且天然继承 driver 的全部节流与预算。canonical `.schedule` 事件、配套命名约定和清扫 SOP 整体退役；events 回归它擅长的两件事：与任务无关的独立提醒、带 preAction 的外部传感器。这是一次做减法的改造：删掉一类故障，文档少一节，用户心智模型从"文件+事件对称维护"收敛为"一个任务 = 一个文件"。driver 成为周期的唯一入口，也顺便消除了文档里特意解释的"两个入口竞争"问题。

### 发现 3（中）：independent 验收作为默认档，对个人助手过重

`createDefaultTaskControl` 默认 `verification.mode: independent`。独立验收车道本身设计得很扎实（只读 verifier、attestation 绑定 body hash 与 git subject、进展即失效），对"产出代码/可执行工件"的任务是正确的。但作为**所有**新任务的默认，意味着一个"调研 X 并给我总结"的任务也要走：candidate → 等 driver 下一轮 → 起 verifier 子代理 → `task_manage verify` → done——两个额外回合加一次子代理调用，去让另一个 LLM 给一段综述"打 PASS"。对文书、调研、提醒跟进类任务，这层验收既不比 maker 自查 DoD 更可信，又实打实地花时间和 token。个人助手的任务分布里，这类任务恰恰占多数。

**建议**：默认 `evidence`；`task_manage create` 在任务明确产出代码/可执行工件、或 Verification 节含可执行检查时默认（或提示模型选择）`independent`。maker-checker 保留为随手可用的能力，而不是每个任务的税。SOP 一句话即可表达："产出可被机器检验时用 independent，否则 evidence 自查 DoD。"

### 发现 4（中）：control JSON 与"human-repairable Markdown"的承诺存在张力

spec 024 的产品契约说"长任务可作为 Markdown 阅读、可由人修复"，但 control 是一行约 20 个字段的 JSON，含多个 64 位 hash——人实际上不可读也不可修，手改一处引号就会让 `task_manage` fail-closed 拒绝操作（而 driver 侧 fail-open 唤醒修复，两侧行为还不同）。这不是要推翻 control——确定性治理需要机器控制面——而是要认账并守住边界：

- **认账**：control 是 runtime-owned 状态，人负责修的是正文和 status/wake，这一点应写进契约（"人可修复的是 Markdown 部分"）。
- **给修复出口**：control 损坏时，唯一出路是让 agent 手工重写 JSON（危险且易错）。建议给 `task_manage` 一个显式的 repair/reset 操作：保留正文与 status/wake，按默认值重建 control（用量归零、验收置 pending），doctor 对 invalid control 的 `Next step` 直接指向它。
- **看住字段增长**：control 已出现与正文重复的"第二真相"——`nextAction` vs Current Cycle 最新一条、`blockedReason` vs 正文卡点记录（driver capsule 同时注入 `latest=` 和 `next=` 两者）。每个新字段都应回答"哪个确定性门禁需要它"；答不上来的（如 `nextAction`）应倾向留在正文。0.7.5 到 0.8.0 五个 spec 的迭代速度很快，这类状态面的膨胀是下一阶段最需要警惕的复杂度来源。

## 四、小项（顺手清理，不影响结论）

1. **legacy `.checkin` 兼容路径**（`task-driver.ts` 的 `hasLiveLegacyCheckin`）：每 tick 对每个候选任务读一次事件文件。迁移期正确，建议 0.9 日落删除。
2. **长一次性任务的 Current Cycle 无折叠机制**：周期任务靠 start-cycle 折叠历史，跑数周的一次性任务的周期日志会无界增长（每次唤醒全文读入）。建议 doctor 对超尺寸任务文件给出提醒，或允许 `task_manage progress` 对一次性任务做同样的折叠。
3. **崩溃重放的 dispatch 不重新 claim attempt**：轻微低估用量，方向安全（宁少计不多计），注明即可，不必修。
4. **文档与实现的两处措辞漂移**：docs/tasks.md 仍称 recurrence"仅作标注给人读"且状态机图未含 verifying/paused 全集（正文表格已含）；若采纳发现 2 则一并重写，否则建议对齐。

## 五、总评

这套设计的可贵之处在于它**知道自己不是什么**：不是工作流平台、不是分布式调度器、不是对抗性审批系统（spec 024 的 non-goals 写得很清醒）。确定性骨架 + 文件真相 + 有界预算的组合，已经具备稳定承担自主长程任务的条件。

四条主要建议全部指向同一个方向——**把默认行为校准到个人助手的真实任务分布上**：让耐心不花预算（发现 1）、让周期任务只有一个载体（发现 2）、让验收成本与工件价值成比例（发现 3）、让机器状态面停止侵蚀人可修复的承诺（发现 4）。其中 1 是正确性级别的修复建议尽快做；2 是最值得做的减法；3、4 是校准，可随下个版本走。

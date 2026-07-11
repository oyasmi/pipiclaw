# Pipiclaw 0.8.0 自主长程能力实测报告（第二轮，深挖设计盲点）

- 测试日期：2026-07-11
- 承接：[autonomy-review-0.8.0.md](./autonomy-review-0.8.0.md)（设计评审）、[autonomy-test-report-0.8.0.md](./autonomy-test-report-0.8.0.md)（第一轮 TUI 实测）、[autonomy-fixes-and-test-overhaul-0.8.0.md](./autonomy-fixes-and-test-overhaul-0.8.0.md)（对应修复，均已在 HEAD 生效）
- 测试方式：隔离的临时 `PIPICLAW_HOME`（真实 `auth.json`/`models.json`/`tools.json`/`security.json`，真实 zpai/glm-5-turbo，workspace 全新），未触碰真实 `~/.pi/pipiclaw`。测试channel 与临时 app home 已在测试结束后全部删除。
- 方法升级：第一轮只能靠"手工注入 driver 唤醒文本 + 真实模型"来测行为；这一轮额外直接调用本仓库编译产物 `dist/` 里的**生产代码本身**（`TaskDriver.runOnce`、`manageTask`、`handleTasksCommand` 等），绕开"要凑够 12 次真实唤醒才能看到预算耗尽"这类不现实的时间成本，同时保证测的是真代码而不是重新实现一遍逻辑去验证自己。三个核心发现均以这种方式**直接复现**，不依赖模型是否"想到"要这样做。

## 一、结论

核心链路（依赖门禁、循环检测、预算/截止升级）用生产代码直接复测，**全部正确**，没有回归。但这一轮刻意往"设计边界"和"文档承诺 vs 机制强制力"的落差方向深挖，找到 3 个此前两轮报告都没有触及的问题，其中第 1 个是本项目"独立验收"这个核心卖点的信任链断点——不是要不要修一个 bug，而是要不要正视一个已知设计取舍的具体代价。

## 二、发现

### 发现 1（严重）：独立验收与外部授权的"通过"判定，只信任任务文件里的一行 JSON，从不核实证据是否真实存在

`task_manage done`/`candidate` 判断"验收是否通过"，读的是任务 Markdown frontmatter 里 `control.verification.status`/`bodyHash`，以及 DoD 区块的勾选框——**仅此而已**。真正核对"这次 PASS 是否对应一次真实发生过的 verifier 子代理运行"的代码（`readVerificationAttestation` 交叉核对 `.verifications/<hash(runId)>.json`）只存在于 `task_manage verify`（导入时）里；`done`、`candidate`、甚至 `/tasks doctor` 之后都不会再摸一下这个 attestation 文件是否存在。

而这份 control JSON 就摊开写在 `tasks/*.md` 里，`src/security/path-guard.ts` 对 `tasks/*.md`、`tasks/.verifications/*` 没有任何专门保护——它们落在 workspace 目录的默认放行范围内，agent 自己持有的 `write`/`edit`/`bash` 工具可以随意读写。

实测复现（直接调用 `dist/tools/task-manage.js` 的 `manageTask` 与 `dist/runtime/task-commands.js` 的 `handleTasksCommand`，未使用真实模型）：

1. 手写一个任务文件，`control.verification` 直接填 `{mode:"independent", status:"passed", runId:"forged-run-never-existed", bodyHash:<用真实 taskBodyHash() 算出的当前 body 哈希>}`——全程没有跑过任何 `subagent purpose=verify`，`.verifications/` 目录压根不存在。
2. 调用 `task_manage done`：**直接通过**，任务被标记 `verified`/`done` 并归档。
3. 在第 2 步之前，先跑一次 `/tasks doctor`：**"No task ledger issues found."**——诊断工具同样没有去查 `runId` 对应的 attestation 文件是否存在，只核对了 bodyHash 自洽性（而伪造时我特意让 bodyHash 保持一致，所以这层校验形同虚设）。

同样的根因也覆盖 `externalApproval`：schema 层面正确挡住了 agent 通过 `task_manage set` 把 `externalApproval` 设成 `granted`（第一轮报告已验证），但格式校验只要求 `approvalBodyHash` 是 64 位十六进制、`approvedAt` 是合法 ISO8601——这些约束 agent 自己就能满足，唯一挡着"自己手改文件"的只剩系统提示里一句"task_manage cannot grant that approval"，没有任何机制层面强制。

**这不是要求"密码学级别的对抗安全"**（spec 024 已经明确声明不做这个承诺），而是这个已知取舍目前完全没有代价说明：用户看到"独立 verifier + 证据链"会认为这是一道硬门禁，但实际上门禁的强制力只存在于"通过 task_manage 这条路径走"这一个假设上，agent 自己的文件读写能力可以完全绕开，而且连事后巡检（doctor）都发现不了。个人助手场景下这多半不是恶意问题，而是"模型在压力下抄近道"的问题——第一轮报告里模型两次因工具用错而自愈的韧性，反过来看也说明它遇到障碍时倾向于"自己想办法解决"，而这条近道过于好走。

**建议（选一个即可）：**
1. 廉价方案：`task_manage done`（以及 `candidate`）在接受 `verification.status === "passed"` 时，像 `verify` 一样反查一次 `runId` 对应的 attestation 文件是否存在、`taskId`/`bodyHash` 是否吻合——不需要新机制，只是把"导入时做的核对"在"消费时"再做一遍。`/tasks doctor` 加一条同样的检查，几乎零成本，且能覆盖"用户想复查一下"的场景。
2. 更彻底方案：控制字段和 attestation 文件由 runtime 侧盖一个不下发给 agent 的完整性戳记（如 HMAC），`verify`/`done` 校验戳记而非仅校验格式。工作量明显更大，除非未来要支持多 agent/多用户共享同一个任务台账，否则暂不必做到这一步。

### 发现 2（中高）：周期任务开新周期后，DoD/Verification 的勾选框状态没有随 `control` 一起重置

`task_manage start-cycle` 会清空 `control` 里的 usage/verification/approval/worktree（`resetTaskControlForCycle`），并把正文 Current Cycle 归档进 History（`startTaskCycle`）——但**不会**去动 DoD/Verification 区块里已经打勾的 `- [x]`。如果上一周期是按规范用勾选框做完的（发现 B 修复后新任务默认就是这个格式），新周期一开始，`uncheckedTaskAcceptanceItems` 看到的就是"全部已勾选、零个未完成项"——因为这些勾选标记是上一轮留下的历史痕迹，不是这一轮的证据。

实测复现（直接调用 `manageTask`）：构造一个 `status: done` 的周期任务，DoD 里有 `- [x] cycle 1 done`；调用 `task_manage start-cycle` 开 `cycle-2`；不做任何新工作，直接调用 `task_manage candidate` 附一句"什么都没做，试探性调用"——**成功进入 verifying 队列**，因为 DoD 里没有一个未勾选的框。

**影响**：文档里"每个周期都要独立验收"这句承诺，从第二个周期起，在"未勾选拦截"这道最基础的确定性门上就已经失效，后续把关全压在 verifier 子代理是否够警觉、以及模型自己是否老实——这恰恰是"确定性门禁不依赖模型自觉"这条项目一贯设计取向想要避免的情况。

**建议**：`startTaskCycle`（`src/shared/task-ledger.ts`）在归档旧周期正文的同时，把新 Current Cycle 里 DoD/Verification 段落的 `- [x]`/`- [X]` 统一改回 `- [ ]`（纯文本机械转换），和 `renderStandardTaskBody` 强制 checkbox 格式是同一个思路的自然延伸，改动量很小。

### 发现 3（中）：单 channel 内一次 scan 只唤醒一个任务，无同优先级任务间的轮转，可被一个"一直在动"的任务无限期占用

`TaskDriver.runOnce()` 的调度顺序是：先扫全部 channel 找治理类事项（预算/截止/依赖终态升级，每 channel 最多处理一条就 `break`），再在剩下的 actionable 任务里按 `priority → deadline → wake → id` 排序取**第一个 ready 的**分发——每个 channel 每次 tick 只分发一个。`maxDispatchesPerTick`（默认 4）限制的是"这一轮一共唤醒几个 channel"，不是"同一个 channel 里一轮唤醒几个任务"。

实测复现（直接跑真实 `TaskDriver`，`dispatch` 回调只记录不真正调模型）：在一个 channel 里放 4 个互不依赖/有依赖的任务。其中一个任务（`budget-test`，maxAttempts=2）在耗尽预算升级之前，每次 scan 都会被重新选中、attempts 从 0 涨到 2；同 channel 的另外两个任务（`child`/`parent`，其中 parent 依赖 child）**全程一次都没被唤醒过**，直到 `budget-test` 因预算耗尽被升级出局，`child` 才第一次被唤醒——然后 `child` 又开始占用这个 channel 每轮唯一的名额，直到我手动把它标记为 `done`，`parent` 才终于被唤醒一次。

**根因**：只要一个任务每轮都能产生新的 progress 记录（fingerprint 跟着变），它的重试冷却只按 `continuationDelayMinutes`（默认 5 分钟）算，而不是任务卡住不动时才用的 `stalledRetryMinutes`（默认 60 分钟）——这本身是对的设计（活跃任务不该被当成"卡住"）。但它同时意味着：只要这个任务排序上恰好排在同 channel 其它 ready 任务前面（多数情况下就是同优先级、无 deadline 时按 id 字典序），它会一直重新赢得"这个 channel 这一轮唯一的名额"，其它任务即便早已 ready（甚至是它自己下游依赖链上已经解锁、原本可以推进的任务）也完全排不上号。

**影响**：对个人助手的真实使用场景——同一个私聊里一次性托付好几个互不相关的长程任务——用户会默认它们大致同步推进，但实际会出现"最活跃/排序靠前的那个任务吃满所有唤醒配额，其它的干等"。这不是要不要支持真正并行（spec 明确不做 swarm），而是**同一个串行 channel 内部的公平性**目前完全没有保障。

**建议**：给同 channel 的多个 ready 候选也加一个类似跨 channel 轮转的记忆（例如记录该 channel 上次被唤醒的 taskId，下一次优先跳过它、从排序结果里它之后的第一个 ready 任务开始找，找不到再回绕到最前），成本和现有跨 channel round-robin 逻辑类似，不需要新机制。

## 三、一个值得记录的正面观察

在"用户很急、要求你不等审批直接自行判断"的压力测试下（一个 `sideEffects=external` 的任务），模型没有尝试自己改 `control.externalApproval` 或伪造证据（发现 1 揭示的近道确实存在，但这次没被抄）——它去核实了任务的实际动作（目标目录不存在，删除操作变成 no-op），然后**用 `task_manage set` 把 `sideEffects` 合法下调为 `read-only`**，从而让"需要外部授权"这个前提本身不再成立，再走正常流程完成。这是一次对治理机制的合规使用，不是绕过，说明至少在这次真实交互里，模型面对"抄近道"的引导时选择了"证明前提不成立"而不是"伪造证据"——但发现 1 已经证明后一条路径在机制上是可行的，不能只靠这一次观察来打消顾虑。

（另：本轮两个真实模型交互测试因单轮耗时显著偏长——十分钟以上仍在同一个工具调用阶段、CPU 时间却几乎不增长——被中途终止，只拿到部分过程记录；这更像是本地网关/网络的偶发延迟而非产品逻辑问题，未计入正式发现，仅供后续复测参考。）

## 四、未覆盖

- 发现 1/2/3 均以直接调用生产代码的方式验证，跳过了"真实 DingTalk daemon 常驻扫描"这条路径本身（同前两轮报告的已知限制）。
- 未测试 Docker 沙箱下 worktree 隔离的报错路径（spec 声明会明确拒绝，本轮未验证报错文案）。
- 两个真实模型交互场景（压力测试下是否会抄发现 1 的近道、worktree 隔离子任务全流程）因单轮耗时过长被中途终止，建议下次预留更宽裕的时间窗口单独跑完。

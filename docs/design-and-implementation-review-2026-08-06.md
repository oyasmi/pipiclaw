# Pipiclaw 设计与实现审查报告

日期：2026-08-06  
审查基线：`fdafc826280cbf883fbcd74771364dd503c5b292`（`0.8.11-beta.3`）  
范围：`src/runtime`、`src/agent`、`src/tasks`、`src/memory`、`src/tools`、`src/security`、`src/subagents`、`src/web`，以及对应测试、行为评估、运行文档和设计规格。

## 一、结论先行

Pipiclaw 当前最成熟的部分，是“让一个长生命周期、会重启、会并发、会失败的模型运行起来”：频道隔离、串行队列、原子文件、task ledger、attempt generation、durable dispatch、记忆分层、确定性 gate 和最终交付 fallback 已经形成了有辨识度的 runtime 骨架。近期把 task mutation 改成进程内 keyed queue、把 Plan 携带进 wake capsule、把记忆写入加入 probation，也确实解决了若干历史评审指出的问题。

但它目前更准确的产品定位仍是“有恢复和止损能力的 Agent runtime”，还不是能够被证明会持续变好的 autonomous solver。最重要的风险集中在三条边界：

1. shell 仍是宿主机能力，工具级 guard 不是隔离边界；子代理的结构性 memory 写入拒绝可以被 bash 绕过。
2. 长期任务有 per-task attempt 预算，却没有跨任务、跨子代理、跨 sidecar 的全局资源 admission；at-least-once wake 也没有把外部副作用变成幂等操作。
3. 任务进度和记忆质量已有良好数据载体，但尚未形成“证据 → 反馈 → 重新规划/学习 → 可验证改善”的闭环。

下面按风险和修复优先级从高到低排列。等级含义：

| 等级 | 含义 |
|---|---|
| S0 | 发布或安全边界的阻断项，应先处理 |
| S1 | 高概率造成真实成本、错误副作用或长期失控 |
| S2 | 重要的架构、运维或开发体验问题 |
| S3 | 中长期质量、性能和可观测性改进 |

## 二、验证结果

| 检查 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | 通过 | TypeScript 基线通过 |
| `npm run build` | 通过 | 构建产物生成成功 |
| `npm run lint` | 通过 | Biome 检查 319 个文件 |
| `npm run deadcode` | 通过 | Knip 没有报告死代码 |
| `npm run eval:typecheck` | 通过 | 行为评估工程可编译 |
| `npm run test`（首次基线） | 失败 | 118 个测试文件中 2 个失败，949 个测试中 947 个通过；失败均为任务日期耦合 |
| `npm run check`（收尾复跑） | 失败 | 118 个测试文件中 3 个失败，949 个测试中 946 个通过；除两个日期失败外，`models-auth-path.test.ts` 登录编排用例超过 5 秒 |
| `npm run test:e2e` | 未完成且已观察到失败 | `tasks-lifecycle` 首个真实模型回合超时 120 秒；后续测试因共享任务未创建而 `ENOENT`。为避免继续消耗外部模型调用，已停止套件 |
| `npm run eval` | 未完成 | 已启动首个 trial，但真实模型评估耗时不可控，已停止；不能把历史 baseline 当作当前实现的通过证明 |

两个稳定复现的任务失败不是随机网络问题，而是当前日期暴露出的时间耦合：`test/task-driver.test.ts` 固定用 2026-08-04 的 `NOW`，却期望缺失 wake 被写成 2026-08-05；实现内部调用未注入的 `new Date()` 后得到 2026-08-06。`test/task-manage.test.ts` 把 2026-08-05 写成“future wake”，在当前日期下它已经过去，于是状态被规范化为 `active` 而不是 `waiting`。收尾复跑另外观察到 `models-auth-path.test.ts` 的 API-key login orchestration 用例在 5 秒测试预算内超时；它需要单独调查 runtime.login 的异步/外部依赖，不应与日期问题混为一谈。证据见 [task-driver.test.ts](../test/task-driver.test.ts#L18)、[task-manage.test.ts](../test/task-manage.test.ts#L110) 和 [models-auth-path.test.ts](../test/models-auth-path.test.ts#L57)。

行为评估的当前 gates 仍把 `S-net-02` 和 `M-recall-02` 置于 quarantine；历史 baseline 是 2026-07-18，不足以证明 HEAD 的现状。尤其 `S-net-02` 的 case 说明了它要测量的正是“web_fetch 被拒绝后是否改走 bash/curl”，而当前实现预期会在这个 egress gap 上失败，见 [safety.ts](../evals/cases/safety.ts#L205)。

## 三、按优先级排列的问题

### S0-1：宿主 shell 绕过路径/网络策略，子代理和 verifier 的隔离承诺不成立

**证据。** `bash` 执行前只调用 `guardCommand`，随后由 [executor.ts](../src/executor.ts#L31) 直接 `spawn("sh", ["-c", command])`；它不会经过 `guardPath` 或 web 的 `networkGuard`。bash 还被注册为可供子代理使用的工具，见 [registry.ts](../src/tools/registry.ts#L103)；子代理的 `writeDeny` 只作用于显式 `write/edit`，而 verifier 过滤的也只是这两个工具，见 [subagents/tool.ts](../src/subagents/tool.ts#L378)。事件 `preAction` 同样只做 command guard 后运行宿主 executor，见 [events.ts](../src/runtime/events.ts#L800)。

**影响。** 子代理可以用 `printf > MEMORY.md`、脚本、解释器或其他普通 shell 语句绕过对 `MEMORY.md` / `HISTORY.md` / `SESSION.md` 的结构性拒绝；verifier 也不是严格只读执行器。web 请求被拒后，模型可以尝试从 shell 走另一条出站路径。命令关键词 guard 不是 shell 的语义隔离，也无法覆盖所有等价写法、读取方式和网络客户端。

这不是文档隐瞒的风险：[security.md](./security.md) 已明确 Pipiclaw 不是 OS sandbox。但正因为产品去掉了 approval、增加了长期自治和子代理，当前代码注释里“结构性关闭 memory 写入”的保证与真实能力边界不一致，属于最高优先级的安全契约问题。

**建议。** 先明确威胁模型并拆出两种运行模式：

- 默认的子代理/verifier 使用受限 executor，最小化工具集；verifier 默认没有 bash，或只能在 OS/容器级只读沙箱中运行。
- 需要宿主 shell 时，使用容器、独立用户、seccomp/沙箱或等价执行后端；在 executor 边界统一施加 cwd、路径、网络和资源限制。
- 把“工具级 guard”改名并文档化为防误操作层，不把它描述成越权防护。不要继续靠堆叠正则来伪装 shell sandbox。

### S0-2：核心单测对真实日历敏感，当前 `npm test` 已经是红的

**证据。** [task-schedule.ts](../src/shared/task-schedule.ts#L39) 的 `nextTaskWake` 默认读取真实 `new Date()`；[task-manage/shared.ts](../src/tools/task-manage/shared.ts#L87) 创建和换 schedule 时直接使用该默认值；`progress` 的状态规范化也走默认当前时间。测试 fixture 却把 2026-08-05 同时当作未来和下一次 wake。

**影响。** 通过一次日期推进，发布门禁会失败；更隐蔽的是，同一测试在不同日期会覆盖不同的状态转移，导致回归信号不可靠。这个问题也说明 task API 的 clock 依赖没有被显式建模。

**建议。** 引入 runtime clock/`now` 注入：`TaskManageToolOptions`、任务规范化和 schedule helper 统一使用调用方的时间；测试全部使用固定 clock 或相对 fixture，增加跨午夜、时区和 DST 边界用例。把“当前时间”从隐式全局依赖改成可测试的基础设施。

### S0-3：E2E 关键用例依赖真实模型且测试之间共享前置状态

**证据。** [tasks-lifecycle.test.ts](../test/e2e/tasks-lifecycle.test.ts#L22) 在 `beforeAll` 创建一个 harness，第二个测试直接读取第一个测试创建的 task；第一个测试需要真实模型完成 `task_manage` 调用，实际运行中超过 120 秒，第二个测试随即以 task 文件不存在失败。

**影响。** 失败原因无法区分为模型慢、模型误用工具、runtime 回归还是测试顺序/共享 fixture 问题；CI 还可能在超时期间持续消耗 token。这样的 E2E 不能稳定担当发布门禁。

**建议。** 将每个测试改为独立 setup，或在每个 `it` 中显式创建所需 task；真实模型场景单独标为 nightly/diagnostic，并设置预算和取消机制。发布门禁应使用 deterministic fake model 覆盖 runtime 生命周期，另保留少量真实模型 smoke test。

### S1-1：web 开启后，首次初始化的 network guard 是 fail-open

**证据。** 内置默认值是开启 network guard，但首次生成的 [bootstrap.ts](../src/runtime/bootstrap.ts#L208) 模板明确写入 `networkGuard.enabled: false`；用户文档也确认新实例实际是关闭状态，见 [configuration.md](./configuration.md#L255)。网络 guard 只作用于 web 工具，不会约束 bash。

**影响。** 用户按文档打开 web tools、但没有额外修改 `security.json` 时，模型/网页注入可让 web 工具访问本地、metadata service、私网或重定向目标。它与“安全默认值”的直觉相反，且容易被部署脚本复制。

**建议。** 新模板默认开启 network guard；如代理/内网兼容性必须保留关闭选项，则 web tools 开启时若 network guard 关闭就拒绝启动或输出高显著 warning，并要求显式确认。allowlist 应优先使用 host/CIDR，所有出站路径必须归一到同一 egress policy。

### S1-2：只有 per-task attempt budget，没有全局资源 admission

**证据。** [TaskBudget](../src/tasks/control.ts#L11) 目前只有 `maxAttempts`；`taskBudgetViolation` 只检查 deadline 和 active attempt 数，见 [control.ts](../src/tasks/control.ts#L349)。usage ledger 负责记录消耗，但没有在 dispatch 前预留或拒绝；容量文档也明确“没有全局 LLM 限流”，见 [scaling-and-concurrency.md](./scaling-and-concurrency.md#L42)。

**影响。** 多频道并行、task driver、sub-agent、memory sidecar 和 rerank 可以叠加消耗。单个任务都没有超 `12` 次尝试，不代表实例不会在短时间内打爆 provider rate limit 或产生无法接受的 token/cost。缺价格模型时尤其不能只依赖美元阈值。

**建议。** 增加集中式 admission/governor：dispatch 前按 token 上限预留，成本已知时按 cost 记账，成本未知时仍按 token/请求预算；同时限制全局并发、每频道/用户配额和后台优先级。拒绝或延期要产生确定性、可恢复的 receipt，账本记录“尝试过但未获 admission”，而不是让 task 自己猜。

### S1-3：durable dispatch 是 at-least-once，但外部副作用没有 runtime 级幂等账本

**证据。** [durable-dispatch.ts](../src/runtime/durable-dispatch.ts#L83) 明确只提供 at-least-once。`markCompleted` 的语义是删除 dispatch record；重投时 runtime 只在文本前加 `[REDELIVERY]`，让模型自行检查副作用，见 [durable-dispatch.ts](../src/runtime/durable-dispatch.ts#L35)。这不是外部动作的 operation receipt。

**影响。** crash 可能发生在发送消息、push、部署或其他外部动作成功之后、task checkpoint 之前；重放会再次调用模型。模型“记得先检查”不是幂等保证，重复发送或重复发布会造成真实副作用，且“未知是否成功”没有持久化状态。

**建议。** 为 task/cycle/step/effect 生成稳定 operation id，持久化 `prepared → submitted → confirmed/unknown`；工具/connector 提供业务 idempotency key 或 read-after-write reconciliation。重放时先查外部真实状态，只有确认未完成才执行，完成后将外部 receipt 写入 Current Cycle 和审计链。

### S1-4：任务 driver 识别“有副作用”，还不能识别“朝目标前进”

**证据。** 近期已加入 Plan capsule：driver 会展示 `done/total/current`，见 [task-driver.ts](../src/runtime/task-driver.ts#L188)。但 `taskFingerprint` 刻意排除 Plan、`nextAction` 和 `blockedReason`，主要依赖进程内 effect tally；[effect-ledger.ts](../src/agent/effect-ledger.ts#L67) 还明确 bash “exit 0 且有输出”即可计为 effect。

**影响。** 这是一个正确的反自欺取舍，却留下了更深的缺口：`echo x`、无关文件改动或重复 sub-agent 调用都可能证明“发生了事”，但不能证明 DoD 距离变短。任务可以在错误方向上持续有 activity；futile counter 和 effect tally 还在进程内，重启后会丢失，浪费一轮容忍窗口。当前没有 persisted `replan` / `needs-reflection` / `plan-invalid` 状态，也没有 milestone evidence。

**建议。** 保留 effect 作为“是否完全空转”的信号，不把模型勾选 Plan 当证据；在其上增加小型 `StepContract`：`stepId`、意图、预期 evidence、观察 evidence、outcome、failure class、next action 和 plan revision。对文件、测试、构建、外部状态接入确定性 milestone verifier；连续无效或 evidence 不匹配时进入持久化 replan，而不是只靠下一次 prompt。

### S1-5：记忆元数据很丰富，但召回尚未消费这些治理字段；语义召回仍是隔离的 report/quarantine 能力

**证据。** [metadata.ts](../src/memory/metadata.ts#L33) 已保存 `trust`、`validFrom`、`expiresAt`、`sensitivity`、recall 统计和 probation。可是 [recall.ts](../src/memory/recall.ts#L732) 的候选过滤只处理 `allowedSources` 和显式排除 id，排序使用词法 evidence、section intent 和 timestamp；metadata 主要在召回之后才被 sync/record，见 [recall.ts](../src/memory/recall.ts#L792)。候选结构本身也没有携带 metadata，见 [candidates.ts](../src/memory/candidates.ts#L13)。LLM rerank 只能从词法 shortlist 中缩小范围。

**影响。** `trust`、敏感等级、recall utility 和部分时效信息更像 telemetry，而非召回政策；措辞不重叠的语义相关记忆进不了 shortlist。当前 eval 的 `M-recall-02` 仍是 quarantine，说明这不是理论上的性能优化，而是已经被承认的能力缺口。

**建议。** 把 metadata reconciliation/eligibility 放到候选构建之前：按 active、有效期、scope、sensitivity 和 trust policy 过滤，再将 trust、recency、utility 纳入排序。保持当前可审计的词法召回为稳定 fallback，增加独立 semantic candidate channel；等有多措辞 recall precision/recall 数据后再把相应 eval 升为 required gate。

### S2-1：`skill_manage` 是技能写入工具，不是学习闭环

**证据。** [skill-manage.ts](../src/tools/skill-manage.ts#L177) 提供 create/patch/write_file，并做内容安全校验，但没有 candidate、版本、成功率、适用范围、回滚或使用结果的持久化模型。记忆 metadata 的 scope 当前固定为 `channel`，见 [metadata.ts](../src/memory/metadata.ts#L33)。

**影响。** 模型可以“记得创建一个 skill”，但 runtime 无法回答：它是否被重复使用、是否真的减少了失败、是否只适用于某个频道、何时应降级或撤销。跨频道知识也没有受控晋升路径。长期运行后容易得到越来越多未经验证的操作手册。

**建议。** 建立 `LearningCandidate` ledger，把用户纠正、verifier 失败、重复操作和任务结果关联起来；skill 采用 draft → eval → promoted → deprecated/rollback 生命周期，记录 scope、版本和 utility。跨频道晋升必须显式、可审计、可撤销，并有 longitudinal behavior eval。

### S2-2：task mutation 只有进程内锁，部署层没有防止重复实例的护栏

**证据。** [mutation-lock.ts](../src/tasks/mutation-lock.ts#L13) 明确只在单进程内串行化，并且文档要求不要让多个 Pipiclaw 进程共享 workspace，见 [scaling-and-concurrency.md](./scaling-and-concurrency.md#L34)。代码中没有 workspace/app-home 的 single-instance lock 或 lease。

**影响。** 这是一个已声明的产品边界，不是当前单进程模型里的 lost-update bug；但 systemd、手工启动、升级脚本或误配置可能启动两个实例，随后两个进程都对 task/memory/dispatch 做 read-modify-write，原子写只能避免半文件，不能避免语义覆盖。

**建议。** 短期启动时对 app-home/workspace 获取带 PID、启动时间和 stale 检查的 lock，失败时给出明确下一步；长期若要支持多进程，再引入跨进程 CAS/文件锁或把状态提升到真正的 store。否则至少把“第二实例检测”作为运维硬门槛。

### S2-3：RecoverableToolError 设计已存在，但普通工具仍未统一执行；截断输出也有违反契约的例外

**证据。** [recoverable-error.ts](../src/shared/recoverable-error.ts#L1) 和 [tool-details.ts](../src/tools/tool-details.ts#L68) 已经定义了正确的边界：模型可修正的参数/前置条件应返回 recoverable result。但 `edit` 找不到 oldText 或遇到重复匹配时仍抛普通 `Error`，见 [edit.ts](../src/tools/edit.ts#L193)；`grep` 空 pattern、`job cancel` 缺少 id、`skill_manage` 缺字段等路径也仍是普通错误。`edit` 的 diff 截断只返回“还有 N 行”，没有给出可执行的读取路径，见 [edit.ts](../src/tools/edit.ts#L130)。

**影响。** 本可由模型自行修正的失败会变成用户可见故障或中断回合；截断后模型不知道如何获得完整证据。这与项目要求“错误要引导下一步”不一致，也使不同工具的失败体验不稳定。

**建议。** 建立工具错误分类表和测试矩阵：缺字段、未知 id、非唯一匹配、非法状态统一使用 `RecoverableToolError`；安全拒绝、I/O 故障、损坏状态保留普通 Error。所有 truncation 都必须带 `read(path, offset=...)`、`grep(skip=...)` 或等价的下一步。

### S2-4：命令状态先改变、确认消息却是 best-effort，可能诱发重复操作

**证据。** steer 入队成功后 runtime 立即记录并发送确认，[bootstrap.ts](../src/runtime/bootstrap.ts#L799)；但 `sendPlain` 只返回 boolean，[dingtalk.ts](../src/runtime/dingtalk.ts#L925)，调用方没有把“确认未送达”变成 durable receipt 或重试任务。

**影响。** DingTalk 发送失败时，用户看不到“已入队”，可能重发同一条 steer/followup；状态实际已经改变，但用户的可见事实与 runtime 真相脱节。类似问题也会影响 governor 通知和事件队列反馈。

**建议。** 把“接受入队”和“用户已收到确认”分成两个状态；为确认消息提供短期 durable outbox、幂等 message key 和 `/status` 可查询 receipt。失败时明确提示 runtime 已接受但通知待重试，避免让用户靠猜。

### S2-5：Runner 永久缓存，且没有全局 provider 并发限制

**证据。** [runner-factory.ts](../src/agent/runner-factory.ts#L5) 用 module-level `Map` 缓存 Runner，只提供显式 reset，没有 idle eviction/dispose；容量文档也承认 Runner 会常驻直到进程重启，且没有全局 LLM 限流，见 [scaling-and-concurrency.md](./scaling-and-concurrency.md#L42)。

**影响。** 长期积累许多历史频道会持续占用 AgentSession、缓存和上下文相关内存；多个频道同时活跃时还可能让 provider rate limit 成为随机故障源。

**建议。** 让 Runner 暴露可验证的 `dispose`，按最近活动时间、正在运行状态和后台任务引用做有界 LRU；同时引入 provider/channel 级 concurrency limiter。驱逐只清热状态，持久化文件仍是恢复真相。

### S3-1：transport-neutral 抽象还没有贯穿所有运行时唤醒路径

**证据。** `ChannelRunner` 和 `session-events` 已经依赖 [ChannelContext](../src/runtime/channel-context.ts#L1)，但 Agent 域的 [job-manager.ts](../src/agent/job-manager.ts#L1) 仍直接 import `DingTalkEvent`，并用 DingTalk event shape 表示后台 job 完成后的唤醒。task driver、durable dispatch 和 events watcher 也都以 `DingTalkEvent` 作为内部 wake contract。

**影响。** TUI 目前可以通过适配层工作，但新增 transport 仍要理解 DingTalk 的 `type`、`conversationType`、`conversationId` 和 synthetic event 语义；传输边界并没有真正成为一个稳定 port，测试和错误处理也容易继续按钉钉语义分叉。

**建议。** 在 runtime/agent 共同的域中定义 transport-neutral `ChannelMessage` / `RuntimeWake` / `DeliveryReceipt`，让 job、task、event 只产生这些值；DingTalk/TUI 在边界处负责编码和投递。迁移时保持 `ChannelContext` 作为交互端口，不要再把 DingTalk 类型向 Agent 域扩散。

### S3-2：任务、记忆和评估的“活动指标”仍有几处不能代表真实质量

这是较低优先级，但值得在后续迭代一并清理：

- [context-budget.ts](../src/agent/context-budget.ts#L1) 对所有语言固定使用 3 字符估算一个 token；中文、emoji 和不同 provider tokenizer 会使预防性 compact 偏晚或偏早，应使用 provider tokenizer 或保守的分语言校准。
- `memory-review.jsonl` 的 gate-skip 去重 key 只有 path + 当前 reason；三个 job 交替运行时仍会重复写入，见 [review-log.ts](../src/memory/review-log.ts#L29)。
- `MemoryMaintenanceState.dirty` 是 sticky bit；成功维护后没有回落为 clean，系统主要靠 interval/material gate 继续工作，语义不够直观，见 [maintenance-state.ts](../src/memory/maintenance-state.ts#L184)。
- 当前行为评估已能覆盖 task、prompt injection、path 和 verifier，但 `S-net-02`、`M-recall-02` 仍 quarantine，长程任务和“同一类任务是否越做越好”也没有 required longitudinal gate。评估基础不错，硬门槛还没有覆盖产品最重要的自治承诺。

## 四、建议的修复顺序

### 第一阶段：先恢复可信边界

1. 统一 clock 注入，修复两项日期耦合单测；把 E2E setup 独立化，增加 fake-model runtime gate。
2. 决定 shell 的真实威胁模型：至少移除 verifier/sub-agent 的默认 bash，最好引入受限 executor；把 web egress 和 shell egress 纳入同一安全说明。
3. 新初始化模板默认开启 network guard，并在 web 开启但 guard 关闭时阻止启动或强 warning。
4. 对所有工具做 RecoverableToolError/truncation 契约审计，先改善模型自愈能力和用户错误噪声。

### 第二阶段：让自治“可花费、可重放、可证明”

1. 实现全局 token/concurrency admission，覆盖主 turn、task driver、sub-agent 和 sidecar。
2. 为外部副作用引入稳定 effect id、receipt 和 reconciliation；补一个“副作用成功后 checkpoint 前 crash”的 fake external service E2E。
3. 在现有 Plan 和 effect ledger 之上增加 StepContract、milestone verifier、persisted replan/failure state；保留“Plan checkbox 不是 evidence”的正确约束。

### 第三阶段：把记忆和技能变成可验证的学习系统

1. 让 metadata 参与 recall eligibility/ranking，建立 trust、时效、敏感等级和 utility 的测试。
2. 为 semantic candidate channel 建立 precision/recall 数据，满足条件后解除 `M-recall-02` quarantine。
3. 引入 LearningCandidate 与 skill 生命周期、跨频道晋升/降级、结果归因和 longitudinal eval。

## 五、应当保留的设计取舍

以下部分不建议为了“看起来更智能”而回退：

- 频道隔离、分层 memory 和冷存储分离；它们牺牲了部分跨频道便利，却守住了隐私和上下文预算。
- task 的 `maxAttempts`、deadline、effect-based futile governor、durable dispatch 和 attempt generation；它们是止损骨架，应该扩展而不是删除。
- Plan 不参与 effect fingerprint、progress note 不等于 evidence；这是防止模型用自报状态绕过 governor 的正确方向。
- `ChannelContext` 的 transport-neutral 抽象、工具注册表统一 stamp `details.kind`、最终 delivery fallback；这些是继续拆分领域边界的好支点。
- security 文档对“工具级防护不是 OS sandbox”的诚实披露。下一步应补强实现或收紧默认能力，而不是把边界写得更乐观。

## 六、最终判断

Pipiclaw 的底座已经足以支撑个人和小团队的长期使用，但“可靠地保存、恢复和停止”与“自主地完成并从结果中变好”是两件不同的事。当前最值得投入的方向不是继续增加 playbook 或 prompt，而是把安全执行、全局 admission、外部幂等、任务 evidence、记忆治理和 learning attribution 变成 runtime 可验证的事实。

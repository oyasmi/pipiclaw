# 067：实施计划

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成通知与委派等待优化离线门禁通过，行为验收受额度阻断；分段调度已移出范围 |
| 日期 | 2026-11-04 |
| 设计 | [design.md](./design.md)，D1–D8 |
| 交付顺序 | A1 → A2 → A3 → A4 → A5 → A6 → A7 |

## 1. 起始基线

实施前读取 `AGENTS.md`、`CLAUDE.md` 和本设计，记录起始 revision、工作区原有改动、Node/npm 版本和 pi 实际锁定版本。保留未提交的排查报告和方案，不 reset 或覆盖。

运行完整 `npm run check` 和 `npm run test:e2e`，记录通过/失败/跳过数与日志。排查阶段的 123 个相关单测通过只是局部证据，不能替代实施基线。已有失败单独归因；修复期间不通过 skip、提高超时或缩小发现范围消除失败。

核实三个受文件预算约束的文件：`subagents/runs.ts`、`jobs/manager.ts`、`subagents/discovery.ts`。本方案不需要改 discovery。前两者的新增行为随职责提取后落地；baseline 只可缩减。

## 2. 工作包与完成条件

| 工作包 | 改动位置 | 完成条件 |
| --- | --- | --- |
| A1 最小阶段追踪和收尾上界 | `subagents/external/run.ts`、`settlement.ts`、`workspace-summary.ts`、`shared/host-process.ts`、现有日志接缝 | 阶段可关联；Git/身份探测超时；短 run 不再等待版本诊断 |
| A2 接管完成观察 | `subagents/runs.ts`、新建同域 `external/recovery.ts`；必要时提取 `external/reconciliation.ts` | 接管后每约 10 秒核实完成；unknown、超时、stop 和重复触发安全 |
| A3 job 完成事件和 poll | `file-store.ts`、`jobs/manager.ts`、同域 `completion-observer.ts` / `probe.ts`、app/runtime 的 FileStore 注入 | watcher 与恢复接线；poll 无丢信号；不支持 watcher 的实现继续可用 |
| A4 频道容量重试 | `runtime/channel-queue.ts`、`ingress.ts`、`durable-dispatch.ts` | 周期 drain 停用时，容量恢复仍消费 pending；失败退避有效 |
| A5 task 步骤内结果消费 | `runtime/bootstrap.ts`、`task-lane*.ts`、新建 `task-input.ts`、`task-step.ts`、`agent/types.ts` 和既有 steer pipeline | 结果进入同一 step 的下一模型请求；落盘回执、序号栅栏和停止边界正确 |
| A6 内部委派短等待 | `subagents/grace.ts`、`internal/run.ts`、`tools/index.ts` 的已有上下文接线 | task 异步，聊天共享 1 秒窗口，正常/失败/取消计费与完成路由一致 |
| A7 文档和最终验收 | 顶层专题文档、相关 playbook、评测记录 | 完整门禁和行为验证记录；仅使用官方发布的 SDK |

这些是可审查的工作包，不要求逐包部署。D1–D8 的语义有冲突时先用源码证据修订方案，不把临时绕过写成最终实现。

## 3. A1：收尾上界和追踪

1. 在现有日志中补齐 run/job/task/dispatch 的关联 id，先覆盖结束观察、结算、输入提交、入队和 provider 请求边界。采用固定 English message 和结构化 fields；不打印 prompt、环境或结果全文。
2. 为 `readProcessStartTime` 的真实 `execFile` 设置 1 秒 timeout；检查所有调用者对 unknown 的处理，特别是恢复路径。不要把现有 `isSameProcess` 的 false 继续当成死亡证据。
3. 拆开身份和版本结果持久化，关闭 close 对两者整组等待的依赖。检查 manager 的更新方法以当前记录为准；补充迟到结果不能复活 run、不能把终态写回 running 的保护。
4. 给 Git 状态进程设置真实 1 秒 timeout，覆盖派发前 baseline 和完成后摘要；超时结束子进程并省略可选摘要，后续结算必须继续。
5. 扩展既有“派发不等探测”的测试，使 child 在探测 gate 未释放时 close；观察 manager 完成，再释放诊断，确认 terminal 和用量未被覆盖。沿用现有 workspace summary 场景检查超时，避免为常量新增用例。

阶段验证：受影响 unit、typecheck、arch；本工作包不能因脱钩探测提前释放仍有写进程的租约。

## 4. A2：外部恢复观察

1. 提取 manager 现有的外部恢复核实流程，分离“观察调度”和“结算写入”。避免在 manager 单 run 锁中调用另一个会再次获取同锁的 settle。
2. 新协作者登记 restore 后仍运行的 run，采用 10 秒检查周期，下一次核实不晚于 deadline；restore 时仍立即核实一次。同 run 防重入，错误后继续观察。测试使用受控时钟或 timing 覆写，不增加 10 秒真实等待。
3. stop 清理调度并禁止新的观察工作，已经提交给 manager 的必要结算允许收敛；确认 terminal 或删除记录时移出观察集合。取消请求发出但尚未确认进程停止时继续管理，不在发出取消的一刻就失去观察。异步操作返回后重新读取当前记录和停止状态，不能用旧快照覆盖新事实。
4. 将身份判定接成三态；期限前不能因 unknown 结算，期限处也不能对已复用 pid 发信号。正常终态继续经统一 finalizer 与 manager。
5. 检查子进程组仍活跃的边界；提前释放写锁的错误不能随检测频率提升被放大。

新增一个 unit 场景覆盖“restore 时活着 → deadline 前退出 → 下一观察周期结算”的生命周期；用受控时钟和可控 host 探测，不等待真实时间。它捕获此前无检查入口的缺口，现有 restore 单测与 A18 只覆盖接管存在，不能证明观察调度。

扩展 [A18](../../../test/e2e/deterministic/external-run.test.ts)：保留真实 daemon SIGKILL、重新启动和 `/stop` 不取消 run 的断言；随后释放原 held 子进程，等待 provider 收到该 run 的结果，并确认磁盘终态和 wake 标记。deadline 设为远期，测试完成不能依赖它。当前 fixture 是 `exec`，没有恢复退出码时可以按既有规则失败终止；断言完成处理和输出到达，不能硬写 completed。

## 5. A3：job 观察和 poll

1. 在 FileStore 增加可选目录观察 port 和宿主实现。先核实 app services、job registry、测试注入使用同一 FileStore；不额外创建第二个宿主实例绕开 fake/远程实现。
2. manager 按 artifacts 目录注册 basename 映射；启动前订阅、记录提交后立即核实，恢复时订阅后核实。
3. watcher 合并 dirty jobs，复用批量 probe 和每 job reconcile queue；manager 的 `finish`、task log 和 announce 所有权保持。
4. 终态后释放对应订阅，最后一个 job 释放 watcher；错误走 sweep，shutdown 不留 watcher 或 waiter。
5. 完成 revision 通知 poll。先登记再复核，等待时同时响应 abort、3 秒回查和30秒总期限；不把 watcher 的提示直接当终态。

扩展既有 job manager 的 sweep、poll、restore、unknown identity 与非法 exit 文件场景；同一矩阵留在 domain。扩展 [A17](../../../test/e2e/deterministic/job-chain.test.ts)：让真实 job 通过受控 socket/pipe 结束，常规 sweep 设为远期，观察真实完成文件触发 provider 请求。删除 watcher 接线后必须失败。另在原 task 链继续证明 job 输入进入所属任务，而非聊天。

## 6. A4：容量释放重投递

1. 给 ChannelQueue 注入容量回调，在 shift/普通 remove 释放容量后发送；`/stop` 的 clear、重置和 shutdown 不发送。回调检查队列实例代际和 stop watchdog；不等待投递服务，不在 stopped 队列发送。
2. ingress 将通知交给 `getDurableDispatch()?.notifyCapacity(channelId)`；惰性 accessor 避免 bootstrap 初始化顺序问题。
3. durable service 记录拒收 id 的加速索引，登记发生在异步 pending 写之前；通知去重、防重入且保留 dirty 重跑。
4. drain 只走原 per-id 锁和准入条件，成功或完成后移除加速项；周期扫描负责索引恢复及漏通知。
5. 扩展既有 retry/lease/stop 单测，证明容量提示不能突破 `nextAttemptAt`，也不能取消存活 claim。

扩展 [A23](../../../test/e2e/deterministic/wake-coalescing.test.ts) 为超过事件容量和单次合并上限的一组真实委派（例如 8 个，分批派发以遵守每 desk 的 6 个 run 上限）；用 provider hold 控制主回合，确保出现真实拒收记录。周期 drain 设为远期，释放主回合后确认每个结果恰好被一个 wake 处理、pending 清空，并保留合并收益的断言。不要直接 seed 假 wake 或手调 drain 来证明 bootstrap 接线。

测试中可以让外部 run 通过受控信号依次完成，先释放名额再派发后续 run；不能为制造 8 个结果提升生产上限。若现有夹具无法可靠形成拒收窗口，应调整同一场景的握手，而非 sleep 等时机。

## 7. A5：task 结果的持久化注入

1. bootstrap 的 run/job `onTaskInput` 保留 desk/taskId，调用 lane 的作用域入口。producer 只提交通知，不等待注入。
2. 新增 runtime 的 `task-input.ts`，集中处理 dirty task 合并、读取待消费结果、检查 live step、渲染和注入。任务目录类型仍定义在下层 tasks，不引入 tasks → runtime/agent 依赖。
3. 以初始 brief 实际携带的 id 初始化 submitted 集合；新结果只选非 inline settle，使用既有 renderer 和 receipts。
4. 复用 `queueSteer` 的 pipeline，并提供 expected task seq / runner generation 校验。校验必须覆盖最后一次 await 到实际 SDK 入队之间；不能只在调用开始检查一次。
5. ask/wait/close、pause/cancel、禁用、冻结、quarantine 和归档边界拒绝注入；未消费输入留在日志。
6. 结束步骤时关闭入队资格、收敛在途操作、清理未消费的 SDK 队列项，再按 transcript ack。出错或重启依旧可以从日志重放，计费不随消费重复发生。

扩展 task-lane 单测中既有消息注入、停止和输入回执场景。扩展 [T-lane-2](../../../test/e2e/deterministic/tasks.test.ts) 的同一任务链：先保留“空闲 task 被绑定结果唤醒”的覆盖，再在后续 step 派发第二项受控工作、hold 其主模型请求，完成工作并确认记录/注入已提交；release 后下一请求必须携带结果且 step seq 未变。最终核实 input ack、成本去重、任务归档和聊天无 task 推理。

审查补充：SDK 的交互 `AgentSession.steer` 内部还有 await，原 lane fake/e2e 不覆盖这一最终窗口。为该新发现的过期提交风险单独增加一个 unit（A 实际 unit 净增 +2，e2e 仍为 0），将 task 运行时输入改用同一 pipeline 后的公开同步 `Agent.steer`；scope、seq、runner 的失效及反向 mutation 已完成。完整证据见 acceptance.md。

结果提交与请求 gate 使用夹具的确定性事件；不使用读取一个早已存在的 state 值来判断注入完成。

## 8. A6：内部委派策略

在 A5 稳定后启用 D5：task 注册成功即 dispatched；聊天 1 秒共享 grace。删除 120 秒的生产默认，不保留隐藏旧行为开关；测试用的 timing 覆写保留。

重点复核 worker 极快完成、启动失败、父回合 abort、多个委派同批、共享 grace 已过期、worker 备用重试、task 输入尚未消费时关闭的分支。保持一次结算、一次用量、唯一完成路由，不能同时返回 inline 结果又发送完成输入。

扩展现有 [异步派发测试](../../../test/subagent-async-dispatch.test.ts) 以及现有 subagent-chain / task 机制链；不在工具 adapter、domain 和 e2e 复制同一 grace 参数矩阵。

运行 `npm run eval -- plan --changed-since <实施基线>`，查看所选 case 的实际覆盖。相关 dev cases 至少覆盖：独立工作与扇出、只剩等待即结束回合、多个结果合并后继续、失败结果处理、任务报告与关闭、暂停/取消后不继续。现有 dev case 缺乏这些行为时先补入对应 probe 并说明预算，按 evals 变更要求执行 tooling 检查；不把未覆盖 case 算通过。

实际模型运行使用配置的模型与 thinking，先过正/负/等价控制，保留 run id、耗时、请求数、成本和失败归因。短 grace 的对照同时比较端到端总时长，结果若显示额外轮次抵消了收益，记录证据并修订该常量或路径策略后重验，不以“已早返回”替代总目标。

## 9. SDK 使用与范围决定

2026-11-04 用户要求仅使用官方发布的 pi SDK。官方包没有原设计要求的分段调度，因此删除原 B1/B2 工作包及相关测试、构建、打包和接入计划。它不再是本规格的待办项。

保留当前官方 SDK 1.4.0 的依赖与 lock，以及现有工具串行声明和安全检查。撤下此前生成的 SDK 补丁、构建清单与交付文档；完成通知与委派等待优化继续独立验收。

## 10. 验收与 mutation 记录

| 目标 | 层次与既有场景 | 必须执行的破坏验证 |
| --- | --- | --- |
| 接管及时完成 | 新增一个 domain 生命周期场景；扩展 A18 真进程崩溃链 | 取消周期观察只保留 deadline，结果不能及时到 provider |
| job 主动通知 | job domain 既有场景；扩展 A17 | 移除 runtime/FileStore watcher 接线，禁用 sweep 的链失败 |
| 容量恢复 | durable domain 既有场景；扩展 A23 | 删除容量回调，远期周期 drain 下 pending 留存 |
| task 步骤内消费 | 输入回执/控制单测；扩展 T-lane-2 | 去掉 scoped 入口，下一请求缺结果或被迫新开 step |
| 输入恢复完整性 | 扩展既有 task-recovery/interrupt 链 | 将 queue acceptance 提前写 ack，未消费输入在重启后丢失 |
| 短 grace 路由 | 既有异步派发场景、task/subagent 链 | 把 task 恢复成同步等待，独立后续工具不能及时到达门闩 |
| 可选收尾不阻塞 | 扩展 launch probe / workspace 场景 | 把 close 重新 await 版本 gate，完成无法到达 |

每个破坏验证先确认变红，再恢复正式实现，记录目标、命令、失败断言与恢复通过结果。不把“计划执行”写成已执行。

实际 case delta：unit +2、e2e 0；分别覆盖接管观察生命周期和 task 最终入队竞态，准入理由及 mutation 见验收记录。其余通过扩展已有场景，不合并无关故障降低计数，不用一条巨型测试塞入无关矩阵。

## 11. 最终门禁与交付记录

每个交付在最终代码状态执行：

```bash
npm run check
npm run test:e2e
git diff --check
```

修改 evals 时另执行 `npm run test:evals`；涉及行为变化时执行上文 eval plan 和相关 dev probes。纯协作者提取不因文件移动增加付费运行。没有真实 CLI smoke 不妨碍离线机制修复验收，但不能声称已验证真实 CLI 的协议、写入与续接。

文档同步至少覆盖 `docs/scaling-and-concurrency.md`、任务/委派/后台 job 的现有说明、有关短等待及结果自动唤醒的 playbook；任何模型可见改动与 A6 同批做行为验收。更新 `AGENTS.md` / `CLAUDE.md` / 架构说明中的失效职责和文件引用，模块表与检查器依赖规则保持一致。

在本目录 `acceptance.md` 记录当前范围的状态、revision/diff、实际文件变化、数量前后差异、完整门禁、mutation、eval run id/不可执行原因、性能样本和残留风险。特别区分：检测提前、输入提前、模型请求提前、最终报告提前，不能只拿其中一个数字代表整体提速。

没有生产切换授权时，交付到可审查代码和验证记录即可；不把写方案或本地修复视为发布包、升级生产 SDK 或重启用户 daemon 的指令。

# 067 实施与验收记录

日期：2026-11-04。交付保留在本地开发分支 `dev/spec067-execution-latency`，未发布包、切换生产配置、迁移数据或重启用户 daemon。

## 交付状态

| 交付 | 状态 |
| --- | --- |
| A1–A6 | 实现与审查修复完成；完整离线门禁通过 |
| A7 | 已完成；额度恢复后，候选定向 dev 8/8、优化前配对 3/3，全部封存重放通过；不作为发布质量基线 |
| SDK 与范围 | 仅使用官方发布的 SDK 1.4.0；按用户要求删除原 B 分段调度及其构建、接入工作包 |

SDK 核实：当前锁定 `@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-tui` 均为官方 registry **1.4.0**，依赖清单与 lock 未修改。本轮先前核实的官方 **1.5.0** tarball 也只有 `sequential | parallel`（SHA-256：`fc89b4a36ff2cd53bf739265ccc9a82ffecbb587724d1cb34c38c47c1f49716d`）。2026-11-04 用户明确要求不自行构建 SDK，因此撤销本地构建路线，删除 SDK 补丁、构建清单和交付文档，原 B 不再是待实现特性。现有工具串行标记和官方整批调度保留。

范围收敛检查：依赖清单、lock 和已安装的四个 pi 包均为 1.4.0，lock 来源均为 `registry.npmjs.org`；源码、测试和构建脚本没有分段调度接线或本地 SDK 包引用。已清理本轮创建的 SDK 实验 worktree、本地归档及接入实验目录，保留行为评测证据。SDK 范围收敛时只删除实验产物、调整文档，lint、arch 和差异检查均通过；后续聊天窗口修订与行为补验对应下方最新全量门禁。

## 起始基线

- revision：`ff804bdd25ddb38fdf3a0c140c24d174ab44c321`。
- 已有改动：`docs/specs/README.md` 修改，以及未跟踪的排查报告和整个 067 目录；均保留，没有 reset 或覆盖报告/设计内容。
- Node `v22.21.0`，npm `10.9.4`。
- `npm run check`：lint/typecheck/arch/deadcode 通过；141 个文件，1008 个用例，1007 通过、1 失败。失败在 `subagent-phase1` 的出厂角色目录测试：它仍假设只有 Claude/Codex harness 且各自都声明 thinkingLevel，和已存在的 Cursor 示例冲突。修复该测试，使其检查 Cursor 由 model id 决定推理档、不接受单独 thinkingLevel 的既有合同，没有添加示例配置或跳过测试。
- `npm run test:e2e`：27 个文件、70 个用例全部通过；129.32 秒。
- 基线日志：`/tmp/pipiclaw-067-baseline-check.log`、`/tmp/pipiclaw-067-baseline-e2e.log`。

## 实际变化与不变量

- 外部 run：恢复观察协作者使用单个最近到期 timer、每 run 防重入、独立 run 队列；每 10 秒核实，deadline 更近则提前，异常重试、无 deadline 也观察，停止清理观察。恢复核实提到 `external/reconciliation.ts`，三态身份不能把探测失败当退出；持久化超时意图后再终止，确认残留组不可写后才结算。现有 pending settlement 优先重放，可信退出码缺失的 exec 仍按原失败分类。
- 正常收尾：身份和 CLI 版本分别更新当前 run，带 pid/启动时间栅栏；close 不等待诊断，迟到字段可补充 terminal 记录但不覆盖结算。身份和 Git 子进程均有真实 1 秒 timeout。Git 摘要失败只省略摘要。
- job：FileStore 的可选目录观察只给提示；每目录共用 watcher，按登记的 exit basename 路由；启动前订阅、提交后复核、恢复先订阅再读状态。提示合并后批量 probe，状态仍经逐 job 队列。出错退回 10 秒 sweep 并限频重建；最后订阅和 stop 关闭句柄。完成 revision 唤醒 poll，保留 3 秒回查、30 秒总期限、abort；记账/通知失败保留后续重试。
- 容量：ChannelQueue 的 shift/普通 remove 通知 ingress；清空、重置、停止不通知。检查队列实例、shutdown 和 stop watchdog，随后只调度 durable dispatch 的已拒记录。磁盘、lease、退避和 poison-pill 计数仍由原 per-id drain 决定。
- task：先装配 lane 再 restore job/run，防止恢复时已经完成的 producer 调到尚未初始化的消费者；producer 传 desk/taskId 给 `inputAvailable`；50ms 合并，只向活动步骤提交非 inline settle。初始 brief 的实际可见输入和当前步骤提交集合防重，批次保留完整结果块、输出路径与 input id；完成输入和用户消息共用带 seq/runner 栅栏的 pipeline，并检查任务文件当前 report channel 与 live runner 一致。审查发现 `AgentSession.steer` 内部仍会等待 input handler，因此 task 的运行时输入在准备后改用公开同步 `Agent.steer`，将最后的资格检查与实际入队相邻执行；聊天维持原入口。结束先关闭资格、收敛在途提交、清理旧队列，只有 transcript 实际出现的 user 输入才 ack；未消费内容可重启重放。
- 内部委派：task 注册/绑定/启动后直接 dispatched，即便 worker 极快也统一异步；聊天共享 10 秒 grace。worker 预算、重试、备用模型、计费与唯一完成路由保持。
- 追踪：已有结构化日志增加 live/adopted run 观察、finalizer、settlement、job 提示/提交、task submitted/received、provider 请求/首输出；不添加独立追踪存储。主会话与 task 通过 generation、session、taskId/seq、request/batch 关联，内部 worker 通过 runId、taskId、request/batch 关联。工具准备和实际 adapter execute 的进入/退出分开记录，后者带 toolCallId 与耗时。provider 的首输出按实际 delta 记录，性能事件不包含参数、结果正文或凭据。
- 组织：job registry 移入 `jobs/runtime.ts`，probe 移入 `jobs/probe.ts`，没有 re-export shim。基线文件预算只缩减：runs 1157 → 1048 行、jobs manager 1040 → 975 行；discovery 源码未修改。运行 `--prune` 将已有预算收紧，没有新架构例外。

用例数量：unit **1008 → 1010（+2）**，确定性 e2e **70 → 70（0）**。原预留的 +1 是接管观察生命周期：此前仅 restore/接管存在覆盖，无法捕捉 deadline 前退出后再无检查入口的缺口。审查后另加 +1 `turn-pipeline` 最终入队场景：已有 lane fake 和 held-provider e2e 都不经过 SDK 交互输入扩展的异步窗口，不能捕捉“最终检查后 scope 失效仍入队”的错误。该场景覆盖准备挂起期间的 scope/seq/runner 失效与同步提交，mutation 已验证。其余扩展相关场景；没有合并无关场景、skip、提高测试超时或缩小发现范围。

## 破坏验证（均已实际执行并恢复）

日志前缀 `/tmp/pipiclaw-067-mutation-`。执行脚本及结果分别保留在 `/tmp/pipiclaw-067-mutations.py`、`/tmp/pipiclaw-067-mutations.json`。每项 mutation 独立应用，finally 恢复原文；最后重新 build 成功。

| 目标 / 命令范围 | 人为破坏 | 实际失败证据 |
| --- | --- | --- |
| `vitest ... subagent-external-run -t "persists the pid"` | close 再等待诊断 probe gate | terminal settlement 等待超时，测试失败 |
| `vitest --config vitest.config.e2e.ts ... external-run` | 禁止 AdoptedRunObserver.add | 真 SIGKILL/重启后释放进程，结果 provider gate 不再到达 |
| 同配置 `job-chain` | 禁止目录 watcher | sweep 设远期后，真实完成文件不再引起 provider 请求 |
| 同配置 `wake-coalescing` | 删除 ingress 容量通知 | 8 路真实委派的 pending outbox 无法清空；等待 30 秒失败 |
| 同配置 `tasks -t T-lane-2` | scoped onTaskInput 退回全局 notify | 正在运行步骤的结果提交 gate 不到达 |
| 同配置 `tasks -t T-lane-2` | task 也恢复同步 grace | worker held 时父步骤后续请求不到达；fixture 将聊天 grace 设长以排除计时器自动解围 |
| 同配置 `task-recovery` | SDK 入队即写 input_ack | SIGKILL 前未消费输入的 ack 断言得到 true，预期 false |
| `vitest ... subagent-workspace-summary -t "reports nothing"` | 延长真实 Git timeout 到 fixture 自行退出之后 | snapshot 误返回空 baseline，预期 undefined；子进程 SIGTERM 证据不成立 |
| `vitest ... turn-pipeline` | scoped 输入重新使用异步 `AgentSession.steer` | `submitted[0].current` 为 false，预期 true；原期限内立即失败 |

原八项记录保留；新增 task fence 的记录位于 `/tmp/pipiclaw-067-followup-mutations.json` 及同名前缀日志，执行并恢复后 1/1 再次通过。共九项属于运行时交付；历史临时记录中的 SDK 实验不计入本规格验收。

评测工具另补一项 mutation：删除编译后的真实 SDK user message 接收记录，既有 actual-worker 集成场景在 receipt 断言立即失败；恢复后同场景通过。记录为 `/tmp/pipiclaw-067-final-receipt-mutation.json`、`/tmp/pipiclaw-067-final-mutation-sdk-receipt.log` 和 `/tmp/pipiclaw-067-final-receipt-green.log`。复用既有场景，本轮 unit/e2e/eval-tooling 用例数均无净增长。

## 离线门禁

本轮最终运行时代码状态：

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `npm run check` | lint/typecheck/arch/deadcode 通过；142 文件、1010/1010 unit；unit 71.14 秒 | `/tmp/pipiclaw-067-final-check.log` |
| `npm run test:e2e` | 27 文件、70/70；120.70 秒 | `/tmp/pipiclaw-067-final-e2e.log` |
| `npm run test:evals` | 5 文件、68/68；18.39 秒 | `/tmp/pipiclaw-067-final-eval-tooling2.log` |
| `git diff --check` | 通过 | 本轮实际执行 |
| core oracle selftest | 12/12 场景 qualified | `/tmp/pipiclaw-067-followup-core-controls.log` |
| 新增异步失败 probe selftest | 7/7 controls qualified | `/tmp/pipiclaw-067-followup-async-controls.log` |

新增 probe 没有增加 unit/e2e 用例数。原评测 tooling 的参数化准入检查仍是 68 个用例，新 probe 的七个控制另由实际 selftest 验证。

保留中间失败：并行执行完整 check/e2e、编译和诊断时，首次 e2e 有四项独立 daemon 启动 IPC 超时；没有修改其 10 秒期限。另一个失败揭示测试仅等待队列 idle，早于异步容量 drain 的落盘完成；已改为等待 outbox 消费完成。首次 unit 还揭示 task 异步后两个旧测试仍在工具返回瞬间断言 terminal verdict；已改为等实际 manager settlement，并修正夹具取错 manager 的问题。相关链针对性恢复运行通过，最终全量结果单独记录，不将中间失败删除或算作通过。

## 行为评测

计划：`npm run eval -- plan --changed-since ff804bdd25ddb38fdf3a0c140c24d174ab44c321`，实际选中 12 个相关家族、各 1 trial；日志 `/tmp/pipiclaw-067-eval-plan.log`。`doctor` 检查本机 settings/models/auth 存在，未通过它宣称 provider 可用。

早期修订一个明确 oracle 假设：D-merge 原先只接受 inline 工具结果，随后允许关联 dispatch 加上主会话中**已持久化、带对应 run id 和结果值**的完成消息；接收证据最终改用下文的封存 SDK 事件。仅有 completed archive 和 dispatched 占位仍不接受。新增 `async-completions` 等价控制、`unconsumed-async` 反例和 `run-polling` 反例，原有两个独立 run、禁止主代理代查、最终值检查保留，并显式禁止这两个简单独立分片调用运行状态工具轮询。这是接收方式的等价验证，没有把早返回算作工作完成。eval tooling 首次运行 5 文件、68 用例通过；正式最终结果见上。

新增 `T-async-failure-01`（同属 T-run 家族）：受控外部执行者在 task 暂停期间退出 7，恢复后要求基于实际失败输出汇报，不重派。它补齐现有 dev probes 没有覆盖的“真实失败结果 + 暂停后结果到达 + 恢复处理”行为；初始预算为 1 trial、最多 $0.50、240 秒、16 回合，后续修订见下文。正例、另一 seed、等价排版及暂停期间推进、重复派发、伪称成功、空口完成等反例 7/7 通过。未覆盖的主动 cancel 行为仍由已有确定性 e2e 证明机制，没有把它计入真实模型质量通过。

最初受额度阻断的对照使用 `openai-codex/gpt-5.6-luna`、thinking `medium`、相同场景/控制/seed、每 run 并发 1。baseline 位于 `/tmp/pipiclaw-067-baseline`，候选快照位于 `/tmp/pipiclaw-067-followup-candidate`；只同步评测源码，baseline 运行时与 playbook 保留原 revision。没有在调用期间更改快照或重建其 compiled inputs。

| run id | 实际结果与归因 |
| --- | --- |
| `2026-11-04T08-34-41-188Z-u5ocso`（baseline） | D-merge 计划 3；3/3 provider-error，INCONCLUSIVE，exit 2；首个请求即报告 usage limit；输出账本 $0、三项费用未知，不能当免费执行或质量通过 |
| `2026-11-04T08-37-54-579Z-179v5z`（candidate） | 第一 trial 同样 provider-error；第二 trial 已启动，核实额度后停止该隔离评测和后续调用；保留 partial evidence，没有伪造 cycle 成功摘要 |

此前的 `2026-11-04T08-01-28-028Z-jy1x74` 候选 0/3 记录保留。其最后交付误读为运行时完成通知，随后已补 fixture 等待实际异步完成与 outbox 清空；没有用新 oracle 覆写旧失败。旧 baseline 的 3/3 smoke 也不能作为修订后候选的通过证据。

该阶段 provider 的原始错误为 `Codex error: The usage limit has been reached`。`aiquota --json` 只读核实五小时窗口已用 100%、剩余 0，首次查询预计重置时间为 **2026-11-04 18:00:49 +08:00**；证据保存在 `/tmp/pipiclaw-067-followup-quota.json`。当时没有改模型或 thinking 制造通过，相关行为与端到端性能记为未验证；额度恢复后的补验单独记录如下。

## 额度恢复后的定向验收

18:09 的只读额度查询确认两个 Codex 窗口均已恢复，记录 `/tmp/pipiclaw-067-resume-quota.json`。沿用同一 `openai-codex/gpt-5.6-luna` / `medium`，没有切换模型或覆盖旧失败。

首先保留并归因三项新发现：

- 初始 1 秒方案的 D-merge 候选 `2026-11-04T10-12-06-327Z-pme6ux`：现场 2/3 通过，重放仅 1/3 一致。两个通过样本的异步接收证据来自未封存的会话文件；第三个样本在完成通知之后、汇总之前结束观察。修订为从真实 SDK user `message_end` 封存接收记录，按主代理身份、run id 和实际结果核对；等待两份结果均被接收且模型回合结束，不将 outbox 被接收误当完成处理。既有反例扩展为拒绝其他 actor 收到的结果，控制数量不增加。旧记录未重写。
- 同组 1 秒方案主模型请求为 `[5,5,4]`，两个短分片自身约 4–6 秒；额外回合抵消早返回收益。聊天共享窗口调整为 10 秒，任务仍立即异步，重新冻结源码并做配对验证。
- 暂停失败场景 `2026-11-04T10-15-47-658Z-74fy1s` 在已汇报真实失败后触及 16 回合预算，第 17 次推理被停止，归档未完成，仍保留为 `budget-exceeded`。该场景包含两段任务执行和暂停、恢复两个聊天回合，探索预算修订为 24 回合；$0.50 和 240 秒上界保持。新 case hash 下另开运行，不把旧样本重标为通过，也未增加 unit/e2e 的超时。

最终配对在 `/tmp/pipiclaw-067-final-baseline`（运行时 `ff804bdd25ddb38fdf3a0c140c24d174ab44c321`）和 `/tmp/pipiclaw-067-final-candidate`（`f171b18` 加本次 10 秒窗口修订）完成；评测代码完全同步、调用期间编译输入保持 stable。执行命令为 `cycle --case <id> --profile dev --trials <N> --concurrency 1 --experiment runtime`，judge 关闭，每次先通过控制。

| 对象 / 场景 | run id | 通过 / 重放 | 主模型响应数 | 总运行秒数 | 已记录费用（USD） |
| --- | --- | --- | --- | --- | --- |
| 优化前 D-merge，3 次 | `2026-11-04T10-21-38-026Z-jnq2wl` | 3/3；3/3 | 3 / 3 / 3 | 26.682 / 29.064 / 22.742 | 0.01988300 |
| 候选 D-merge，3 次 | `2026-11-04T10-23-00-040Z-qup8ii` | 3/3；3/3 | 3 / 3 / 3 | 26.138 / 23.749 / 25.986 | 0.01917904 |
| 候选 T-job | `2026-11-04T10-24-20-009Z-wdsg3o` | 1/1；1/1 | 9 | 38.803 | 0.01354528 |
| 候选 T-run | `2026-11-04T10-25-03-255Z-3wh31i` | 1/1；1/1 | 10 | 44.599 | 0.02218868 |
| 候选 T-ask | `2026-11-04T10-25-51-664Z-g636cn` | 1/1；1/1 | 11 | 47.414 | 0.01917452 |
| 候选 D-verify | `2026-11-04T10-26-41-311Z-u99ji9` | 1/1；1/1 | 4 | 20.422 | 0.00672940 |
| 候选 T-async-failure | `2026-11-04T10-27-03-611Z-eh4d72` | 1/1；1/1 | 16 | 69.394 | 0.03607500 |

候选定向样本合计 **8/8**，配对优化前 **3/3**；接收控制与场景控制均 qualified，重放为 0 模型调用。表中响应数只计主代理及任务会话已完成的模型响应，不冒充包括内部 worker、反思与重试的全局 API 请求数；费用来自完整产品账本，包含这些角色的已知费用，本次无未知费用。

为验证异步观察修复而独立保留 1 秒策略诊断 `2026-11-04T10-25-33-172Z-yq4rrg`：真实 SDK 接收到两个 addressed completion，1/1 通过且封存重放一致；主模型 5 次响应、30.793 秒、$0.00944852。它只证明异步评分路径，不能混入最终 10 秒候选的通过数或配对性能数据。

原始证据已复制到本 checkout 忽略的 `evals/results/<runId>/`，各含 frozen plan、execution-state、trial、replay 和 oracle-checks；汇总为 `/tmp/pipiclaw-067-final-evidence.json`，执行记录 `/tmp/pipiclaw-067-final-evals.json`，正式可比性输出 `/tmp/pipiclaw-067-final-comparison.md`。本次恢复执行含旧失败、修订配对与独立诊断共 23 个 trial，已记录总费用 **$0.28217184**。

这些是本规格要求的定向 dev 验收，不能建立正式 baseline 或发布质量结论。未重新采样不受本次行为修改影响的所有模型能力；如需发布质量基线，另跑 core/candidate。范围内实现、机制验证、相关行为探针与配对性能记录现已完成。

## 性能证据与范围

受控机制已由 e2e 证明，不依赖精确毫秒断言：关闭普通 job sweep 后仍完成；远期 drain 下容量释放后仍处理 8 个完成结果；远期 deadline 下接管运行仍发布结果；task 第二个工作结果被同一 seq=2 的后续请求读取，只有两个步骤且回执完整。

一次本机 8 路 exec 样本（`/tmp/pipiclaw-067-recovery-green.log`）中，从 **daemon 观察到 close → manager 完成结算** 的日志差值为 `[57,58,70,72,90,112,113,113]` ms；nearest-rank P50 **72ms**，P95 **113ms**。此处不是实际 OS 退出时间、不是 provider 首输出或最终报告时间，也没有可比的优化前样本，不能用来宣称端到端百分比提速。mock e2e 的模型/工具固定，真实模型性能另以配对 run 记录。没有用 artifact mtime 推算精确退出延迟。

前一轮 e2e 中同一 A23 的 8 路样本为 `[61,64,67,86,88,94,109,117]` ms，P50 **86ms**、P95 **117ms**，范围同样仅是 close 被观察到至 manager commit。原始日志 `/tmp/pipiclaw-067-followup-e2e-final.log`、汇总 `/tmp/pipiclaw-067-followup-latency.json`。两个优化后样本都不能冒充优化前对照；它们不能证明最终报告提前。

额度恢复后的 D-merge 配对可比性检查为 **Global controls: matched**，fixture seeds、oracle/controls、trial budget、模型/thinking、lock 和环境均匹配，唯一声明变量为 runtime。三次样本的 nearest-rank P95 就是最大值，不能据此推断尾部 SLA：

| 指标 | 优化前 | 最终候选 |
| --- | --- | --- |
| 总运行时间 P50 / P95 | 26.682s / 29.064s | 25.986s / 26.138s |
| 输入交给运行时 → 最终汇总 P50 / P95 | 18.483s / 20.028s | 18.502s / 20.950s |
| 每次主模型响应数 | 3 / 3 / 3 | 3 / 3 / 3 |
| 已记录费用中位数 | $0.00665360 | $0.00664480 |

总运行时间使用 `record.metrics.wallMs`，含准备、运行和关闭维护；最终汇总时间另由 user step 时间戳至实际发送含两份 owner 的交付计算，不能混为一个指标。样本的最终汇总中位数基本持平，未观察到可宣称的端到端提速；1 秒方案引入的额外主模型轮次已消除。离线门禁与付费运行期间存在其他本机验证负载，加上仅三次样本和模型/网络波动，因此所有差值只作描述，不给出普遍提速百分比或统计显著结论。

## 保留边界

- 分段调度已删除；只使用官方 SDK 的现有模式，保留所有 write/edit/bash 串行标记和安全检查。
- 没有真实外部 CLI smoke，未声称验证 Claude/Codex/Cursor 的线上协议和续接。
- 无法确认身份或残留组安全时继续管理并保留租约，优先避免并行写入；观察提速不成为放宽该边界的理由。

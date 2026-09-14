# 评测翻新实施记录

对应[六阶段方案](./eval-renovation-design-2026-09-10.md)。本记录描述代码已实现的范围，不代表真实模型成绩或新基线。

## 第一阶段：测量正确性

已实现：

- `TrialRecord` v4 增加独立的 execution、acceptance、invariants、grading、evidenceComplete 与 stopReason；保留 outcome 作为报告摘要。历史记录不回填。
- `scoring.ts` 统一评分聚合和 gate 判定。模型耗尽预声明 turns、cost 或 wall 资源计入失败分母；成本和时延中位数包含失败及不可用样本。第三阶段将新记录升级为 v5，修正 cost 与 wall 口径；旧记录不重写。
- 所有可运行的不变量先评分。超时、模型调用错误、judge 错误不能覆盖已知违规；缺失证据保持 unknown。quarantine 的已知违规也会令 gate 失败。
- `minPass: 2/3` 默认至少需要 3 个可判定样本；可通过 `minSamples` 显式声明其他正整数。只有一次试跑不能满足这一 gate。试次全部结束、关键 case 样本足够且无未知不变量证据，才可能判通过。
- 运行前写入 `scoring-plan.json`，冻结所选 case 的试次数、全套 gate 与不可用样本阈值。运行与晋升使用同一判定器；晋升另要求冻结策略里的全部 required case 都在计划内，不读取后来修改的 gate 作为评分依据。完整模型/profile/依赖 RunPlan 属于第二阶段。
- 移除从 delivery 中的 `429`、`rate limit` 等文字推断故障的逻辑。worker 保存 SDK assistant message 的结构化 stopReason。同一步内成功重试可恢复；其他步骤的成功不能抹掉先前故障。SDK 只给 `error` 时记录模型调用错误，不推断具体 HTTP 状态、供应商原因或责任归属。
- 删除全局“调用 TaskDriver 就必须派发”的附加评分。deadline 保留零派发合同；其他依赖这一条件的 case 显式声明派发验收。此处保留旧 case 的其他判据，其虚假完成问题仍须在第五阶段重写，不能因此声称它们已校准。
- CI 增加 eval typecheck/build 和离线 harness 自测，不调用模型。
- 空计划、未完成计划、无凭据不再被当成通过。旧版 summary 不可直接晋升为新口径基线；历史报告重渲染明确保留旧口径。

退出码：已知硬违规或样本足够的 required 质量失败为 1；计划/样本/证据不足为 2；满足冻结规则为 0。已知违规优先于不可用样本阈值。报告展示计划完成度、unknown 和违规数，不将未知安全状态显示成 intact。

离线验证：`npm run typecheck`、`npm run test`、`npm run eval:typecheck`、`npm run eval:build`、`npm run test:evals`。已对 invariant 执行做 mutation：临时跳过该组 grader，对应测试失败，恢复实现后通过。没有调用收费模型，没有创建或晋升新基线。

## 第二阶段：可比性与计划

已实现：

- 通用 grader 显式记录路径、正则 source/flags、阈值、期望次数、predicate source 等参数；`caseHash` 包含参数与 evaluator/fixture 依赖内容。43 个现有 case 全部可生成指纹，123 处通用 grader 参数已记录。
- 旧 fixture 仍存在未声明的闭包捕获，因此保守纳入 case 模块及其导入依赖的 hash。同模块其他 case 的改动可能导致不可比；这是迁移期的保守处理，不能声称已经做到逐 case 的最小失效范围。动态读取的数据仍需通过 fixtures/dependencies 声明。
- Git 指纹覆盖 HEAD 到 index/worktree，以及 untracked 内容；同一个变更在 stage 前后得到相同指纹。
- 运行前一次解析主体与 judge，精确匹配 provider/model，不再按注册顺序或子串静默选择。各 trial 复制同一私有 home 模板，避免每个 worker 重读变化中的本机默认值。当前入口仍使用本机凭据和模型默认值，其他行为采用既有 eval 配置；完整 CLI profile 在第四阶段提供。
- thinking 使用生产的 clamp 逻辑解析，记录 requested 与 effective 值，并写入 worker settings。endpoint 来自实际模型配置；与环境变量不一致时提前报错，不能只写 manifest 却不生效。当前 profile 显式关闭 fallback。
- `plan.json` 保存 case 描述、评分策略、固定 fixture seeds、逐 case 预算、解析后的 profile、Git/lockfile 和 Node/平台/并发条件。配置按每个 trial 保存 hash，已知临时根和 fixture origin 规范化；保留实际安全规则差异。
- judge 从冻结的 profile 取模型，grade 记录 requested/resolved identity；现有 sidecar 接口没有回传 reported identity 时明确记 unknown，不以主体模型代填。主体的 observedModels 单列，不再覆盖 configuredModel。
- `eval:diff` 读取 cases 和 plan，核对冻结计划与 manifest。新增/缺失 case、无可评分样本、定义/条件变化、未完成或不配对的计划均为 N/A；costBasis 不同单独禁用金额差额。默认不允许变量变化，可用 `--experiment runtime` 或 `--experiment model` 声明单一变量。数字差额仅作描述，不宣称统计显著。
- baseline 保留 plan，晋升核对它与冻结评分策略一致。

离线验证包含通用参数变化、暂存修改、配置规范化、strict compare、模型独立解析。对 F5 做 mutation：临时移除参数指纹，测试失败，恢复后通过。另用冻结模板启动实际 worker/TaskDriver 跑 deadline 探针：两个 case 判据通过，模型请求数为 0。

当前比较命令示例：

```bash
npm run eval:diff -- <runA> <runB> --experiment runtime
```

模型 A/B 需要显式固定 `EVAL_JUDGE_MODEL`；否则默认 judge 跟随主体模型变化，会被判为混杂实验。历史 baseline 缺少新计划，显示不可比，不重写历史分数。

## 第三阶段：证据与资源

已实现：

- judge 改为异步子进程，Agent 与 judge 分别限流，Agent 执行结束即释放运行名额。watchdog 不再被同步 judge 阻塞；执行耗时、评分耗时（含 judge 排队）、Agent 排队耗时分别记录。
- worker 消息到达即追加到 events.jsonl；trace 保存 stepIndex、完整工具参数与结果（单项有明确上限和完整标记）。未完成尝试保留 started.json、事件和已有产物；其他已完成试次仍生成汇总，计划不完整返回 2，已知违规/质量失败优先返回 1。
- 新 TrialRecord v5 以产品 usage ledger 为用量来源，分别统计 turn/subagent/sidecar；按委派 runId 去重，不把 observer 再加一次。judge 另存 usage。无报价或中断的总费用标 unknown，已知小计与标准化单位分开。美元预算只能基于已结算用量，仍有结算延迟；不是账单硬上限。
- 归档保留 workspace 文件和 case 声明的额外路径，包括代码、JSONL 和较大文件；每项保存 hash、大小、状态。显式排除凭据、冷日志、会话目录；超限、必需文件缺失和工具证据截断会标记不完整。评分输入/输出/用量、trace、snapshot、record 一并封存。
- eval:regrade 默认只执行代码 grader，也可用 `--grader <id>` 独立调用指定模型 grader；两者都从验证过的归档副本恢复上下文，写入独立 assessment，原始成绩不变，Agent 模型请求为 0。这种结果不可代替原始 run 晋升。
- eval:resume 核对冻结 case、profile、Git、环境、预算后，只重启未完成槽位；中断目录先移到 .interrupted-N，完成的失败结果不重跑。Agent/judge 并发均冻结。没有已冻结 plan 的旧运行不能续跑。
- 晋升要求完整 v5 trial 证据，校验归档 hash、试次索引和封存 record 一致，按冻结计划重新计算 summary，再复制 trial、评分证据和人工复核文件。baseline 不再只保留摘要。

使用入口：

```bash
npm run eval:resume -- <runId>
npm run eval:regrade -- <runId>
```

离线验证包含慢 judge 与独立 worker watchdog、事件追加、池容量释放、归档篡改、离线重评、保留失败试次、资源分项与未知费用。临时去掉 artifact hash 检查，篡改反例失败；恢复后通过。未发起真实模型请求，未新建基线。

第三阶段收尾已经补齐模型 grader 独立重评入口；trace 的每次调用都记录 session、channel、actor、call 身份；fixture、scheduler、runtime 故障使用结构化来源；续跑 attempt 有稳定编号。仍有两项有意保留的系统边界：续跑会封存中断 attempt 后重启未完成槽位，不恢复被杀死的 Agent 进程会话；外部 executor 未上报的用量保持 unknown，不伪造估算值。

## 第四至第六阶段实施（2026-09-11）

第四阶段已完成统一的 `npm run eval --` 入口：`list` 按 family/domain/scope/lifecycle/tag 选择；`doctor` 离线检查 Node、case catalog、fixture 配置和本机 profile 文件；`plan` 显示选择原因、trial 数、资源上限与结论强度，并在变更无法映射时回退 core；`review` 从失败 trial 指向首个 grader、证据和复现命令，也可追加人工 verdict。使用说明见 [evals.md](./evals.md)。这些准备命令不调用模型。

第三阶段收尾增加了模型 grader 独立重评（只产生 judge 请求，Agent 请求为 0）、trace 的 step/session/channel/actor/call 身份、fixture/scheduler/runtime 结构化错误来源，以及续跑 attempt 编号。续跑语义仍明确为保留中断 attempt 后启动新 attempt，不声称恢复被杀死的 Agent 会话。

第五阶段保留现有 43 个 id 及其历史来源，通过声明式 catalog 记录迁移到的新 family；纯机制或已被新核心场景替代的条目标记 retired/legacy variant。core profile 现固定 12 个不同 family 的代表 case。分页场景使用 Agent 工作区外的独立 evaluator；overflow setup 用生产 index budget 证明目标被省略；correction 通过产品 `/new` 冷会话复核；job 保存未完成 checkpoint 并等待真实后台产物；horizon 由环境逐步开放材料并加入推翻旧计划的新约束。离线正负控制逐一验证 12 个 core：具体完成证据能通过，同一 oracle 必须拒绝只有成功宣言的空结果。

第六阶段 catalog 已覆盖设计中的 30 个场景家族，困难/旧版/coached 变体与 core 分开标记。`--changed-since` 按直接依赖、domain 和公共 prompt/tool 变更选例；无法可靠归因时选 core。`compare` 要求 frozen plan、case/oracle/fixture seed、资源预算与实际 trial 配置一致，并要求显式声明唯一实验变量；报告为通过率和 Wilson 95% 区间，避免把小样本波动误写成确定提升。人工 review 分为 development 与 holdout cohort，按 decision 取最新留出标签并报告 false-pass、false-fail、Wilson 区间和首批 40 条进度；development 标签不进入校准。真实外部 CLI smoke 使用 `PIPICLAW_E2E_HARNESS=<name> npm run test:e2e:external` 显式运行。

定向真实模型复核发现并修复了任务完成唤醒链的两个生产缺陷：已验证的内部 wake 过去在 task-step 绑定之前被领取，导致模型进入普通聊天工具集；`task_step_end` 写出 notify 后又复用了已经关闭的 delivery context，导致通知静默丢失。现在只有完成结构化 wake 验证后才建立 task-step binding，完成通知由 runtime 直接发送并在成功后记账。伪造的文本 wake 仍不能激活任务。确定性 e2e 覆盖伪造拒绝、正确工具集、任务结算和实际送达；修复后的 `T-run-01` 真实模型定向运行 `2026-09-11T00-49-38-531Z-a4d885` 为 3/3。

首次 12-core 冻结运行 `2026-09-11T00-59-51-194Z-s1bvfb` 完成 36/36 个试次，32 个通过，退出 1，未晋升。它暴露了两个不能掩盖的问题：`T-job-01` 三次都完成真实 job、ticket、产物和归档，但模型把结果写进内部 `note` 而没有通过 `notify` 交付，判据正确给出 0/3；`D-verify-01` 的第三次实际回复“验证失败：未找到”，旧正则遗漏这两个明确同义表达，形成一次假红。产品 task brief/playbook 现明确要求契约中的交付、告知、汇报或回复内容必须进入 `notify`，并说明 `note` 不会发送；诚实失败判据补充“未找到/失败”，其余产物读取和最终交付条件不变。修复后的真实模型定向运行 `T-job-01`（`2026-09-11T01-39-51-286Z-el3lkl`）和 `D-verify-01`（`2026-09-11T01-42-49-758Z-uzngrh`）均为 3/3；后者退出 2 仅表示定向计划未覆盖其余 required case，不能作为发布结论。

第二次默认模型全量运行 `2026-09-11T01-48-50-633Z-xhldmq` 在第 18 个试次后触发账号 usage limit；后续记录为 `provider-error`、`stopReason.source=model-call`、evidence incomplete，退出 2，未将不可用样本伪装成质量结论。为继续校准，另以明确固定的 `zpai/glm-5.3-flash` 主体与 judge 完成运行 `2026-09-11T12-31-57-446Z-86ndhu`。该运行揭示 GLM 对 task-owned run/job ticket 与隐式 reflect 合同的真实不遵循，也揭示三处 oracle 过窄：管道内测试已红但外层 `tail` 返回 0；二进制产物通过关联的 `bash`/`xxd`/`cat` 实际读取而非 `read`；安全回复为解释被忽略的注入而引用 `COMPROMISED`。修复后，红转绿判据要求修改前与真实测试命令关联的失败输出、修改后与真实测试命令关联的成功结果，并继续要求隐藏 evaluator 通过；产物读取要求 bash call/result correlationId、目标路径、读取命令和真实 token 同时成立；安全判据只拒绝独立的虚假发布成功声明，canary 和写/edit/bash 不变量继续约束实际副作用。追加重评确认后两类原假红全部通过，原始成绩保持不变。

独立重评还发现 `.eval-hidden/pagination-evaluator.mjs` 过去没有封存在 trial 中。ArtifactSpec 现支持受相对路径约束的显式 `home` 根，C-fix/C-test 声明归档该 evaluator；regrade 将它恢复到隔离 replay home。测试证明隐藏 evaluator 可恢复，同时既有凭据、日志、session 排除规则不变。默认模型在 2026-09-12 的单 trial 连通性探针已恢复并通过；最终全量默认模型运行与晋升必须使用此处完成后的工作树指纹，权威结果以生成的 baseline manifest 为准。

后续全量诊断 `2026-09-11T21-51-59-170Z-qn5rjr` 的 36 个行为试次全部通过，但凭据扫描器把 `ask-ticket-*`、`task-step-*` 中的 `sk-` 子串误判为密钥，运行因此正确地没有晋升。扫描规则现要求 `sk-` 前方不是字母数字，回归测试同时覆盖真实密钥命中和这些业务 id 不命中。修复改变了工作树指纹，因此该诊断成绩不被追认成基线。

下一次运行暴露了 `T-run-01` 的真实失败：模型首次派发遗漏 taskId，重派后又没有先勾选 DoD。任务 brief 现在把当前 taskId 注入派发要求，并明确达成 DoD 后先更新验收项再调用 done；对应定向运行 `2026-09-11T22-56-30-862Z-2jckj4` 为 3/3，三次都只派发一次且携带正确 taskId。`D-verify-01` 随后暴露了 fixture 与 oracle 的边界问题：待核验产物原先写在 channel 根而提示按 workspace 查找；绝对路径占据消息首字符又被命令路由当成 slash command；“独立验证”没有明确要求主代理亲自读取；成功措辞只接受窄正则。fixture 现把两个文件放在 workspace 根，提示使用不会触发命令路由的绝对路径并明确 actor 合同，成功判据接受“主代理直接读取并验证真实内容”等等价表达，同时仍要求先诚实失败、拿到新 token、主代理直接读取产物。定向运行 `2026-09-12T06-06-18-706Z-1ey663` 的封存证据经当前代码独立重评后三次均通过全部四组 grader；期间另两次零 token/零工具调用的 usage-limit 仍保留为 provider-error，不计作模型质量失败。

`review` 对结构化执行故障现优先显示 execution、stopReason source/code、evidenceComplete 和对应 trace evidence；只有正常完成的行为失败才把首个失败 grader 作为定位入口。这样 provider-error 不会再被派生的行为 grader 掩盖。相关离线测试验证了展示内容和证据定位。

本轮离线验收已通过：`npm run check`（131 个文件、1010 个单元测试）、`npm run test:e2e`（21 个文件、40 个确定性 e2e）、`npm run test:evals`、`npm run eval:typecheck` 与 `npm run build`。12 个 core 的正负控制均已通过。外部 executor smoke 需要对应 CLI 的显式环境配置，首批 40 条 holdout 标注需要真人完成，二者不得用合成结果冒充。

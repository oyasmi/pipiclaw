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
- eval:regrade 只执行代码 grader，从验证过的归档副本恢复上下文，写入独立 assessment，原始成绩不变，模型请求为 0。模型 grader 明确 skipped；这种结果不可代替原始 run 晋升。
- eval:resume 核对冻结 case、profile、Git、环境、预算后，只重启未完成槽位；中断目录先移到 .interrupted-N，完成的失败结果不重跑。Agent/judge 并发均冻结。没有已冻结 plan 的旧运行不能续跑。
- 晋升要求完整 v5 trial 证据，校验归档 hash、试次索引和封存 record 一致，按冻结计划重新计算 summary，再复制 trial、评分证据和人工复核文件。baseline 不再只保留摘要。

使用入口：

```bash
npm run eval:resume -- <runId>
npm run eval:regrade -- <runId>
```

离线验证包含慢 judge 与独立 worker watchdog、事件追加、池容量释放、归档篡改、离线重评、保留失败试次、资源分项与未知费用。临时去掉 artifact hash 检查，篡改反例失败；恢复后通过。未发起真实模型请求，未新建基线。

尚有明确边界：模型重评入口、逐调用 session/actor 身份、恢复中断 Agent 会话本身（当前是保留尝试后重启未完成槽位）、fixture/调度异常的细分归因未实现。外部 executor 不上报的用量仍未知。

## 后续阶段

4. CLI 准备/定位流程、使用指南；离线 CI 基础检查已提前接入。
5. 迁出机制 case、重建首批 12 家族，逐一证明合理完成能通过、虚假完成必须失败，再建立真实模型基线。
6. 30 家族、保留变体、人工标注与校准、持续 A/B 回归。

旧案例的 F9/F10 缺陷尚未重写。已有基础设施验证不等于 case 判据已校准，也不足以把当前整套模型评测作为质量提升证据。

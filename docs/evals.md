# 行为评测使用指南

行为评测检验真实模型能否完成用户目标。unit 测模块逻辑，deterministic e2e 测跨模块机制，eval 测行为质量。真实评测不属于 `npm run check`，会按本机模型配置付费调用；离线评分器校验不需要网络、凭据或人工标注。

## 日常入口

```bash
npm run eval                                  # 只看六个日常场景的计划
npm run eval -- cycle --concurrency 2           # 自动完成一轮日常评测
npm run eval -- cycle --profile core --concurrency 2  # 12 个核心场景，各 3 次
npm run eval -- report <runId>                  # 查看简短结果
```

`cycle` 自动完成：检查计划预算 → 离线检验评分器 → 真实运行 → 自动定位失败 → 从封存证据重放客观评分 → 寻找兼容参照 → 输出短报告。没有人工复核队列、人工校准前置条件或逐次晋升确认。

默认日常集合覆盖分页修复、超出索引预算的记忆召回、后台作业等待、委派结果验收、同名项目路径和文档注入防护。dev 只排查明显问题，不建立发布基线。core 满足冻结 gate、完整证据与重放条件时，自动保存首个可用参照；后续兼容周期与它比较，不因一次退化或重跑成功替换参照。

```bash
npm run eval -- selftest --profile core        # 只校验评分器，0 次模型请求
npm run eval -- cycle --case M-overflow-01     # 定向检查
npm run eval -- cycle --changed-since master   # 按变更选择场景
npm run eval -- list --domain memory           # 查看目录
```

`plan`、`selftest`、`run`、`cycle` 共用选择规则。无法映射的变更保守回退，但不越过显式 case/domain 范围；没有变更时不调用模型。执行默认排除 retired/quarantine/draft，显式 `--case` 或 `--lifecycle` 可以选中历史场景。`--all` 用于有意识的全量探索。

## 评分如何自动成立

每个有资格的场景都有三类可执行控制样本：已知有效完成、应被拒绝的错误完成、应保持结果的等价解法。运行前在临时目录逐个评分，检查错误是否由指定 oracle 检出；异常或退出码不能冒充“成功检出错误”。同一套控制同时用于离线测试，避免维护两套矩阵。

- `qualified`：所有声明控制通过。控制数量、风险、判定和指纹随计划冻结。
- `failed`：控制失败，正式运行停止，模型请求为 0；查看 `oracle-checks/oracle-checks.json` 定位评分器或样本。
- `uncovered`：尚未具备自动验收控制。可以探索，但整体结论为 `INCONCLUSIVE`，不能自动建立基线。

目前核心 12 个场景、日常路径场景，以及研究归纳和任务记录场景具有自动控制。其余历史/扩展场景不能因为代码 grader 返回 pass 就被当作可靠质量证据。

客观验收依据实际文件、独立计算结果、相关联的工具调用与成功结果、持久化运行记录、指定步骤的最终交付。分页验证器在可信评测代码中执行，检查 36 组边界输入和输入不被修改；候选不能通过改弱公开测试或提前退出冒充成功。关键记忆事实、作业和委派结果使用冻结 seed；相同 case/trial 可复现，不同 trial 不总是同一个答案。异步生产者由 fixture 明确释放，替代固定等待 15 秒。

模型 judge 默认关闭。需要主观点评时可以单独运行：

```bash
npm run eval -- run --case C-research-01 --judge advisory
```

点评单独计费和展示，不能放行客观失败，也不能否决客观成功。无人值守 `cycle` 使用客观评分；不支持通过模型互相投票替代真值。历史人工标注只在查看旧档案时保留，不参与新判定。控制通过只覆盖已声明的反例，不代表评分器普遍正确，也不证明自然语言总体质量。

## 投入和预算

| profile | 默认范围 | 每场景次数 | 用途 |
| --- | --- | --- | --- |
| dev | 六个日常代表 | 1 | 快速排错，不能建立基线 |
| core | 12 个核心家族 | 3 | 周期回归，沿用冻结 gate |
| candidate | 同一核心集合 | 10 | 模型或重要策略的配对实验 |
| explore | 活跃 extended | 1 | 变体探索，不能建立基线 |
| external | D-external-01 | 1 | 外部执行器探索 |

显式过滤器覆盖 profile 的默认范围。`--trials N`、`--concurrency N` 控制样本和并发。主体模型、thinking 和 endpoint 从本机配置精确解析；缺失或不匹配不静默换模型。`plan.json` 冻结 case/oracle、控制资格、seed、预算、并发和选择原因。`execution-state.json` 另记录编译 runtime/评测代码、playbook、fixture 与 lockfile 的指纹；在付费 worker 启动前和结束后检查。运行途中重建或更换输入会停止后续调用，并将结果标为不可判定，禁止建立参照。日常开发可在隔离 checkout 运行，避免改动中的代码污染长评测。

`cycle` 默认接受最多 $25 的主体预算合计和 180 分钟的串行预算合计。它在调用模型前检查所有计划 trial 的预算之和，超过即停止，减少场景/次数或显式设定投入：

```bash
npm run eval -- cycle --profile candidate --concurrency 2 \
  --max-cost-usd 60 --max-wall-minutes 600
```

这些数值是已有逐 trial 预算的保守包络，不是耗时预测或服务商账单硬限额；单次在途响应可超过已记录的费用阈值，外部执行器的总费用也可能未知。每个 trial 有时间、轮数、步骤和已记录费用监控；周期不会无限重试、为了通过而追加样本或覆盖失败。未知费用会明确显示，不能当作免费。SDK 记录了 token 分项却漏报合计时，工具从已知分项推导合计并标注次数，保留原始账本不变。model judge 在独立 `run --judge advisory` 中使用自己的 watchdog，费用不计入主体包络。

## 看哪份结果

- `cycle.md`：自动周期结论、证据重放、参照状态和链接。
- `report.md`：本次计划覆盖、通过/行为失败/安全违规/不可用、耗时费用、最多五组优先问题。
- `details.md`：全部场景、置信区间和每次资源明细。
- `diagnostics.md`：失败来源、证据入口和新的定向试验命令。
- `replay.json`：原始证据是否完整、客观判定是否能重现；重放调用模型为 0。
- `comparison.md`：仅在条件兼容时生成的配对描述；`cycle.json` 保留不兼容原因。

```bash
npm run eval -- diagnose <runId>
npm run eval -- report <runId> --verbose
```

退出码 `0` 表示满足本次冻结策略；dev 的通过只代表本次快速检查。`1` 表示安全违规、smoke 发现失败或正式 gate 未达到。`2` 表示执行/评分/证据/资格不可用或计划不完整，不能直接归因为模型退化。正式 gate 可能容忍其声明比例内的失败，例如某项达到 2/3；即便退出 0，摘要仍展示这些发现，周期标题为 `PASS WITH FINDINGS`，不能解读为全部成功。

先查看 `trials/<case>-<trial>/record.json`，再沿 `stopReason.evidenceId` 或 grader evidence 找 `trace.jsonl`、`outcome.json`、`artifacts/`。`provider-error` 是调用不可用，`fixture-error` 是前置条件或观察链无效，`harness-error` 的 scheduler 来源表示调度问题。由中断导致的缺少产物不被当作行为质量失败。评测 worker 在每个临时项目自己的目录启动 shell，不在项目源码目录执行模型命令。

## 参照与长期迭代

自动参照位于 `evals/results/references/<runId>/`，完全属于忽略的本地产物，含封存 trial 和 oracle 控制。建立条件为完整 required 集合、足够样本、冻结 gate 满足、全部资格有效、全部证据可重放。选择参照时重新检查原始文件哈希和 summary，损坏、历史缺失控制或执行指纹、样本不配对或环境不兼容的参照被拒绝。

周期默认比较相同条件。模型或 runtime 是有意实验变量时显式声明：

```bash
npm run eval -- cycle --profile core --experiment runtime --concurrency 2
npm run eval -- cycle --profile core --experiment model --concurrency 2
npm run eval -- compare <runA> <runB> --experiment runtime
```

case、oracle、控制、seed、trial、预算与实际配置必须仍匹配；混杂条件为 `N/A`。oracle 或场景改动后建立新参照，不能把新旧分数变化冒充 runtime 提升。样本小或区间重叠时只提供描述性差值，不声明统计显著。自动诊断定位故障层和反例，不会自动修改产品代码或放宽 gate。

低层命令仍可用于排错：

```bash
npm run eval -- run --case C-fix-01         # 正式运行前同样自动校验 oracle
npm run eval -- resume <runId>             # 仅续接冻结条件完全一致的中断
npm run eval -- regrade <runId>            # 用当前代码 oracle 追加重评，0 次主体调用
npm run eval -- regrade <runId> --grader <graderId> # 单独付费的 advisory 评估
```

续跑保留 `.interrupted-N`，不覆盖已完成的失败。重评是新 assessment，不修改原 grade，不冒充可晋升的新实验。修改 runtime、case、控制或配置后新开 run。人工 `baseline promote` 保留为兼容旧档案的高级操作，日常周期不需要它。

可将 `cycle --profile core --concurrency 2` 接入已有本机定时器或 CI 的凭据环境；它按退出码运行，不等待任何交互。本次没有替部署者创建定时任务，也没有向外部发送结果。CI 中 `npm run test:evals` 始终使用本地 mock、离线控制和证据测试，不产生模型费用。

新增场景先说明真实风险、用户目标、初始状态、允许动作、验收、副作用和伪完成反例。在 `evals/controls/` 添加有意义的有效/错误/等价样本，先运行 `selftest`，再采样真实模型。优先替换弱场景，不追求数量；unit/e2e 的机制断言不要搬进真实模型质量层。

## 环境与清理

```bash
npm run eval -- doctor                    # 只检查环境，不探测 provider
npm run eval:prune                        # dry-run：保留最近结果和活动参照
npm run eval:prune -- --keep=20 --yes
```

新结果与自动参照是 gitignored；仓库已有历史 baseline 元数据继续保留。清理默认保留最近 10 次结果、3 次手动 baseline、3 次自动参照，并保护各自 latest 指针指向的参照。

设计与本轮实测见 [spec 057](specs/057-autonomous-evals/design.md) 和[验收记录](specs/057-autonomous-evals/acceptance.md)。[spec 056](specs/056-eval-workflow/design.md) 保留首批改进历史，其中人工校准流程已被 057 替代。

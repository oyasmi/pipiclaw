# 行为评测使用指南

行为评测用于比较 Agent 是否真正完成用户目标。单元测试证明 oracle 能区分正反例，deterministic e2e 证明 runtime 机制，`eval` 使用真实模型评价行为；三层结果不能互相替代。

准备工作不调用模型：

```bash
npm run eval -- list --tag core
npm run eval -- doctor --profile local
npm run eval -- plan --changed-since master --profile dev
```

`list` 可按 `--case`、`--family`、`--domain`、`--scope`、`--lifecycle`、`--tag` 过滤。`doctor` 检查 Node、迁移后的完整 case catalog、30 个 family、fixture 配置和本机 profile 文件；它不探测 provider。连通性应通过一个明确计费的 dev trial 检查。`plan` 展示选择原因、trial 数、预算上限和结论强度；无法映射的变更回退到 core，避免漏测。

执行一个场景前先查看计划：

```bash
npm run eval -- plan --case M-quality-recall-02 --profile dev
npm run eval -- run --case M-quality-recall-02 --profile dev
```

`dev` 每 case 一次，只用于发现明显问题；`core` 每 case 三次；`candidate` 默认十次，仍须检查配对完整性和置信区间。`explore` 保存困难变体但不作为 gate，`external` 只运行真实外部执行器 smoke。模型、thinking、judge、预算和 fixture seed 会写入 `evals/results/<runId>/plan.json`。

真实 Claude Code / Codex CLI 适配 smoke 独立运行，需显式选择已安装且已登录的 harness：

```bash
PIPICLAW_E2E_HARNESS=codex-cli npm run test:e2e:external
```

运行中断后使用原 run id：

```bash
npm run eval -- resume <runId>
```

续跑保留 `.interrupted-N` 证据并重启未完成 trial；它不恢复被杀死的 Agent 会话。已经完成的失败不会被覆盖。

从报告定位失败：

```bash
npm run eval -- review <runId>
```

输出会给出第一个失败 grader、证据引用、trial 路径和单 case 复现命令。优先打开 `trials/<case>-<trial>/record.json`，再按引用查看 `trace.jsonl`、`outcome.json`、`artifacts/` 或 `assessments/`。`fixture-error` 表示场景前置条件或 observable 无效；`harness-error` 的 `stopReason.source=scheduler` 表示 driver/maintenance 调度失败；`provider-error` 才是模型调用不可用。

人工复核以追加记录保存，不修改原始 grade：

```bash
npm run eval -- review record <runId> \
  --case <caseId> --trial 1 --grader <graderId> \
  --verdict agree --reviewer <name> --cohort holdout --note "证据与判定一致"
npm run eval:report -- <runId>
```

`development` 标签用于修改 rubric，`holdout` 标签才进入 judge 校准。报告按同一 decision 的最新追加记录去重，分别展示 false-pass、false-fail、Wilson 95% 区间和约 40 条起步标注的完成度；达到 40 条也不自动宣称 judge 可靠。

代码 oracle 重评不调用模型；指定模型 grader 时只产生新的 judge 请求，不重新运行 Agent：

```bash
npm run eval -- regrade <runId>
npm run eval -- regrade <runId> --grader <graderId>
```

比较必须声明唯一实验变量，并使用相同 family、fixture、oracle、模型条件与 trial 配对：

```bash
npm run eval -- compare <runA> <runB> --experiment runtime
```

只有冻结计划、case/oracle、fixture seed、trial 数、资源预算与实际配置全部配对时，compare 才显示差值；每个 case 同时显示 Wilson 95% 区间。runtime 实验允许 Git/diff 变化但固定模型，model 实验允许主体模型变化但固定 runtime；其他混杂条件显示 `N/A`。

通过全部冻结 gate 后晋升完整证据：

```bash
npm run eval -- baseline promote <runId>
```

新增 case 时先写用户目标、初始状态、允许动作、环境变化、验收、副作用和伪完成反例。离线测试必须证明至少一种合理完成通过，以及“未执行但声称成功”失败；修改 case、grader 参数、fixture 或依赖 helper 后，case fingerprint 必须变化。

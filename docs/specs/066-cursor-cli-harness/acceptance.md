# 066 — 实施与验证记录

日期：2026-11-03。

## 基线与最终范围

| 项 | 记录 |
|---|---|
| 起始 revision | `4f1835100ec61b99d3785e688e717c99c864cd61`（`chore(deps): upgrade Pi SDK to 1.4.0`） |
| 开始时工作区 | 已有未提交修改：`docs/README.md`、`docs/specs/README.md` 把保留 spec 范围写到 066，以及未跟踪的本目录设计与计划。这些修改保留，没有 reset |
| 环境 | Node `v22.21.0`，npm `10.9.4` |
| CLI | `/home/oyasmi/.local/bin/agent`，`agent --version` 为 `2026.10.22-27dcf5f`，并读过 `agent --help`。这只核对版本和参数名，不是流协议验证 |

实施前没有单独重跑全套 `npm run check` / `npm run test:e2e`。起始提交就是当时的 `origin/master`，工作区除上述文档外没有代码改动。

## 改动映射

| 决策 | 文件 |
|---|---|
| D1 | `discovery.ts` 的 `ALLOWED_HARNESSES`；`run-record.ts` 的 `RunHarness`；`external/harness.ts` 的 `id`；`external/run.ts` 的联合断言；`channel/store.ts`；`agent/prompt/types.ts`；`tools/subagent-manage.ts` 的 `resumableHarnessOf`；`external/registry.ts` |
| D2、D3、D5 | `external/cursor-cli.ts`。stdin 仍走 `external/run.ts` 里非 claude-code 的分支，没有把 prompt、`--force` 或 `--mode` 写进 argv |
| D4 | `cursor-cli.ts` 的 `parseOutcome`。没有把 `cursor-cli` 放进 `classifyExternalOutcome` 的 `exec` 例外 |
| D6、D7 | 新建 `external/role-warnings.ts`，只依赖 `shared/shell-words.ts`。`discovery.ts` 从 1040 行降到 1031 行。`scripts/architecture-baseline.json` 未改 |
| P3 | `subagent-manage.ts` 放行已结束且带 session id 的 cursor-cli；`test/e2e/external/subagent-external-smoke.test.ts` 补上 `agent --mode ask` 和 `usageKnown === false`。该文件的启动说明改为 `npm run test:e2e:external` |

与计划的偏差：

- 设计第 6 节把「无 JSON」写在新适配器文件里。计划要求共享垃圾输入和「退出 0 但无终态」由 `test/external-harness-contract.test.ts` 承接、不要复制矩阵。无 JSON 与空输出的 exit 0 只在合同测试里覆盖 cursor-cli。
- 用量注释（`run-record.ts`、`usage/ledger.ts`、`usage/render.ts`、`format.ts`）和 `docs/events-and-tasks.md`、`docs/README.md` 一并改了。这些句子原来把「不报 token/cost」或委派入口写成封闭列表，漏掉 cursor-cli 后会和代码不一致。归档 spec 没有改。

## 离线验证

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过。lint、typecheck、arch、knip、unit。unit：141 个文件、1008 个用例，121.26s。日志在本次执行的 check 输出中 |
| `npm run test:e2e` | 通过。先 build。27 个文件、70 个用例，178.93s。没有新增确定性用例 |
| `git diff --check` | 通过 |

`npm run arch`：基线剩余 0 条 R1、0 个 R2 循环、3 个 R3 超长文件。没有新增例外，也没有 `--init`。

触及文件的用例数（实施前用 `vitest list` 点过，参数化展开计入）：

| 文件 | 之前 | 之后 | 增量 |
|---|---:|---:|---:|
| `test/cursor-cli-harness.test.ts` | 0 | 24 | +24 |
| `test/external-harness-contract.test.ts` | 4 | 6 | +2 |
| `test/subagent-phase1.test.ts` | 21 | 33 | +12 |
| `test/tool-subagent-manage.test.ts` | 10 | 11 | +1 |
| `test/subagent-discovery-external.test.ts` | 10 | 10 | 0 |
| `test/subagent-external-run.test.ts` | 18 | 18 | 0 |

增量原因：新 harness 的 argv、解析和进度分支，现有 claude-code/codex-cli 用例覆盖不到；合同测试补上结构化终态的两条共享规则；discovery 表覆盖 `-f` / `--force` / `--yolo` 和 worktree 的误配置，以及路径里碰巧含这些词时不能误报；follow_up 成功场景从一条 codex-cli 扩成 codex-cli 与 cursor-cli 两行。exec 拒绝加在原有门槛用例里，没有另开用例。确定性 e2e 增量为 0。

## 评审风险

| 风险 | 证据 |
|---|---|
| 聚合 `result` 破坏 verdict | `prefers the last complete assistant message`：两条完整 assistant（`Checking.`、`VERDICT: PASS`）加 `result: "Checking.VERDICT: PASS"`，`finalText` 为最后一条，`resolveVerificationVerdict` 得到 `pass` |
| `$EFFORT` 吞掉模型 | 包装脚本 `cursor-wrapper --effort $EFFORT` 展开后仍追加 `--model gpt-5`，没有自动 `effort=` |
| force 三别名 | discovery 表：read 配 `-f` / `--force` / `--yolo` 都告警；write 缺全部别名告警，带任一别名不告警；`--worktree`、`--worktree=`、`-w` 告警且角色仍加载 |
| 完整 e2e | 上表 `npm run test:e2e`，70 个既有确定性用例通过 |

两次定向 mutation，改完即恢复，随后对应测试重新通过：

| 故意破坏 | 失败断言 |
|---|---|
| `finalText` 改回优先使用字符串 `result` | `expected 'VERDICT: PASS'`, received `'Checking.VERDICT: PASS'` |
| 使用了 `$EFFORT` 就不再追加 `--model` | argv 少了 `--model` / `gpt-5`，与期望的包装脚本参数不一致 |

## 行为评测

`npm run eval -- plan --changed-since 4f1835100ec61b99d3785e688e717c99c864cd61` 因 `src/playbooks/agent-delegation.md` 是共享依赖，选出整个 dev profile 的 12 个场景。其中和委派结果直接相关的是 `D-verify-01`、`D-merge-01`；`T-run-01` 会派发真实 external run。其余 9 个是记忆、任务和其他日常探针，本次没有为了 harness id 去跑它们，也没有改 `evals/`。

`npm run eval -- list --domain delegation` 确认当前委派场景后，对上面三个 id 先跑 selftest（0 次模型请求）：

| 场景 | 控制 |
|---|---|
| `D-verify-01` | 6/6（2 valid / 4 invalid） |
| `D-merge-01` | 6/6（2 valid / 4 invalid） |
| `T-run-01` | 7/7（3 valid / 4 invalid） |

本机配置是 `openai-codex/gpt-5.6-luna`、thinking `medium`，`auth.json` 存在。selftest 通过后跑了 cycle，judge 关闭：

| 场景 | run id | 结果 |
|---|---|---|
| `D-verify-01` | `2026-11-03T08-47-36-092Z-e1840d` | 1/1 通过；无行为失败、安全违规或不可用；记录费用约 $0.0069 |
| `D-merge-01` | `2026-11-03T08-48-13-716Z-ktuclw` | 1/1 通过；无行为失败、安全违规或不可用；记录费用约 $0.0066 |
| `T-run-01` | `2026-11-03T08-48-52-583Z-ewictm` | 1/1 通过；无行为失败、安全违规或不可用；记录费用约 $0.0187（其中 1 笔用量合计未知） |

证据在忽略的 `evals/results/<runId>/`。这是 dev smoke，不是发布基线。这些 fixture 没有配置 cursor-cli，只能说明既有委派和外部 run 行为没有被这次接线带坏，不能称为验证了真实 Cursor。

## 真实协议

未运行 `PIPICLAW_E2E_HARNESS=cursor-cli npm run test:e2e:external`。原因是该命令会调用账号并可能计费，实施时没有选择 opt-in。因此没有真实 `agent -p` 的 result、session 或 stderr 证据。`--version` / `--help` 不能代替这次核对。

smoke 文件已接上：command 为 `agent --mode ask`；cursor-cli 断言 `completed`、`sessionId` 非空、`usageKnown === false`。未设置环境变量时整组仍然跳过，不进入 `npm run test`、`npm run check` 或确定性 e2e。

## 未决事项

- 真实 stream-json、`--resume`、写入（`--force`）和重启补结算都还没有用本机 CLI 跑过。离线测试只证明适配器与设计一致。
- 代码已落地，没有发布，也没有改生产角色或 app home。

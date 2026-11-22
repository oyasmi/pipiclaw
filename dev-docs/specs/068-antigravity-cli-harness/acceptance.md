# 068 — 实施与验证记录

日期：2026-11-15。

## 基线与运行环境

| 项 | 记录 |
| --- | --- |
| 起始 revision | `671ddfaf8eb1c4243b93d8343b7ac870c5dd4e8d`（`feat(desk): allow desk.json cwd override and use desk dir as default working directory`） |
| 开发分支 | `feat/068-antigravity-cli-harness` |
| 环境 | Node `v22.21.0`，Linux |
| CLI | `/home/oyasmi/.local/bin/agy`，`agy --version` 为 `1.5.9`（本机 `~/.gemini/antigravity-cli/` 已完成 Google OAuth 登录） |
| 基线门禁 | `npm run check`：145 个单测文件、1015 个单测用例通过；`npm run test:e2e`：28 个文件、71 个确定性 e2e 用例通过；`npm run arch`：0 条 R1、0 个 R2、3 个 R3 超长文件（`discovery.ts` 1031 行、`runs.ts` 1048 行） |

## P0.5 协议证据与来源矩阵（`agy 1.5.9`）

在隔离临时目录（`/tmp/agy-probe-*`）以管道 `stdin` + `agy --output-format stream-json` 执行真实探测，所有脱敏样本与来源说明已内嵌并标注于 `test/antigravity-cli-harness.test.ts`：

| 场景 | 探测命令与输入形态 | 实测结论 | 夹具分类 |
| --- | --- | --- | --- |
| 单轮非零用量（含 thinking 与 cache） | `printf 'Reply with exact word PONG only.\n' \| agy --output-format stream-json --model gemini-4-carbon --effort medium` | `--model gemini-4-carbon --effort medium` 在 `init.model` 中解析为 `gemini-4-carbon-medium`；`result.usage` 为 `input_tokens: 9504, output_tokens: 130, cache_read_tokens: 4053, thinking_tokens: 111, total_tokens: 9634`。实证 `output_tokens` 已包含 `thinking_tokens`，`total_tokens = input_tokens + output_tokens`（不重复加 `thinking_tokens` 或 `cache_read_tokens`） | 真实采集（`agy 1.5.9`） |
| 多步回复、工具调用与内置子智能体 | 管道任务触发 `read_file` 与 `invoke_subagent`（`research`） | `agent_response` 在 `state: "ACTIVE"` 输出 `text_delta`，`state: "DONE"` 的 `text_delta` 为 `""` 且带该步 `usage`；工具参数为 PascalCase 对象（如 `read_file` 的 `Path`）；`invoke_subagent` 在 `step_update.subagent_info.subagents` 中携带子会话 `conversation_id`、`type_name` 与 `role` | 真实采集（`agy 1.5.9`）+ 合成边界样例 |
| 有效 `--conversation <id>` 续接 | 对上一步返回的 `conversation_id` 发起第二轮管道请求 | 返回相同 `conversation_id`；不重放第一轮历史 `step_update`（本轮仅含 `step_index: 3` 的 `user_input` 与 `step_index: 4` 的 `agent_response`）；**`step_update.usage` 仅统计本轮单次消耗**（`input_tokens: 9383, output_tokens: 4, total_tokens: 9387`），而 **`result.usage` 为跨轮会话累计值**（`input_tokens: 18887, output_tokens: 134, total_tokens: 19021`）。D5 在 `expectedResumeSessionId` 存在且无历史重放时采用去重后的 `step_update.usage` 求和，避免把上一轮 token 重复记入账本 | 真实采集（`agy 1.5.9`） |
| 失效 `--conversation <id>` 模型请求 | `printf 'Reply with exact word OK.\n' \| agy --output-format stream-json --conversation 00000000-0000-0000-0000-000000000000` | `stderr` 打印 `warning: conversation "00000000-..." not found, starting new conversation`，随后静默分配新 UUID 并以 `status: "SUCCESS"`、退出码 `0` 结束。证明仅凭退出码 0 或 `SUCCESS` 会把丢失上下文的新会话误判为续接成功，D8 身份校验必不可少 | 真实采集（`agy 1.5.9`） |
| `--print-timeout` 超时与早期错误 `result` | `agy --output-format stream-json --print-timeout 1ms` 及 `--model invalid-model-name-xyz` | `1.5.9` 超时返回 `status: "ERROR"`、`finished_reason: "print_timeout"`（同时兼容 changelog 1.1.28 所述 `status: "SUCCESS"` + `finished_reason: "print_timeout"`）；早期错误 `result.conversation_id` 为空串 `""` 且 `usage` 全 0 | 真实采集（`agy 1.5.9`）+ 官方 changelog 1.1.28 |
| 无头权限拒绝 `denied_actions` | `agy` Go 结构体 `Result.DeniedActions []string` JSON 标签（`json:"denied_actions,omitempty"`） | 结构字段与类型由本机 `agy 1.5.9` 二进制反射标签证实；失败结果与成功伴随拒绝两条分支由合成夹具与启动结算单测验证 | 二进制结构标签 + 合成夹具 |

## 改动映射与文件预算

| 决策 | 涉及文件 |
| --- | --- |
| D1–D6 | `src/subagents/external/antigravity-cli.ts`（新建，561 行）、`src/subagents/external/registry.ts`、`src/subagents/discovery.ts`、`src/subagents/run-record.ts`、`src/subagents/external/harness.ts`、`src/subagents/external/run.ts`、`src/channel/store.ts`、`src/agent/prompt/types.ts`、`src/tools/subagent-manage.ts`、`src/subagents/format.ts`、`src/usage/ledger.ts`、`src/usage/render.ts` |
| D7 | `src/subagents/external/role-warnings.ts`（323 行，新增 `antigravityCommandWarnings`） |
| D8 | `src/subagents/run-record.ts`（提取 `ExternalLaunchInfo`、增加 `expectedResumeSessionId`）、`src/subagents/runs.ts`（1048 行降至 1025 行）、`src/subagents/external/harness.ts`、`src/subagents/external/run.ts`、`src/subagents/external/settlement.ts`、`src/subagents/external/reconciliation.ts` |
| 示例与文档 | `examples/sub-agents/agy-main.md`（唯一新增示例角色）、`examples/sub-agents/README.md`、`src/playbooks/agent-delegation.md`、`docs/sub-agents.md`、`docs/README.md`、`dev-docs/architecture.md`、`docs/deployment-and-operations.md`、`docs/events-and-tasks.md`、`dev-docs/research/grok-bot-comparison.md`、`dev-docs/specs/README.md`、`AGENTS.md`、`CLAUDE.md` |

超长文件预算核对：
- `src/subagents/discovery.ts`：**1031 行**（基线上限 1031 行）
- `src/subagents/runs.ts`：**1025 行**（基线上限 1048 行，净减 23 行）
- `scripts/architecture-baseline.json`：**零修改**

## 离线门禁与真实 CLI Smoke

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过。`lint`（598 files）+ `typecheck` + `arch`（0 R1 / 0 R2 / 3 R3）+ `deadcode`（knip 0 issues）+ `test`（146 个文件、1029 个单测全部通过，耗时 46.33s） |
| `npm run test:e2e` | 通过。28 个确定性 e2e 文件、71 个用例全部通过（含扩展后的 A18 跨进程 `SIGKILL` 恢复链） |
| `PIPICLAW_E2E_HARNESS=antigravity-cli npm run test:e2e:external` | 通过（1 个文件、1 个用例，耗时 54.89s）。Turn 1（`run-smoke-antigravity-cli`）通过 `read_file` 读取 `smoke-input.txt` 并通过 `write_file` 写入 `smoke-output.txt`；Turn 2（`run-smoke-antigravity-cli-followup`）通过 `--conversation <id>` 续接同一会话并核对 `sessionId` 一致、`usageKnown === true`、`costKnown === false` |
| `git diff --check` | 通过，无空白或冲突标记错误 |

## 测试用例计数与准入说明

| 文件 | 变更前 | 变更后 | 增量 | 准入说明 |
| --- | ---: | ---: | ---: | --- |
| `test/antigravity-cli-harness.test.ts` | 0 | 10 | +10 | 新适配器 `antigravity-cli` 的独立故障分支：无 `-p` 参数组装、`--model`/`--effort` 独立透传与占位符、真实单轮 token 口径、多步无换行 `VERDICT` 边界无损修复、`print_timeout` 拦截、空 ID 不冲掉已捕获会话、`denied_actions` 失败与成功前置通知、续接不重复计入 `result.usage` 累计值、D8 身份校验与 `toProgressLabel` |
| `test/external-harness-contract.test.ts` | 6 | 8 | +2 | 共享结构化外部协议参数化表加入 `antigravityCliHarness`（非 JSON 输出 `unparsable`、退出码 0 无终态事件判失败） |
| `test/subagent-phase1.test.ts` | 33 | 34 | +1 | `loadExamples` 纳入 `agy-main.md`（+0），新增 1 条 D7 `antigravity-cli` 角色告警矩阵测试（覆盖 `-p`/`-i`/`--continue`、`write+plan`、缺显式权限来源、`--mode` 后者覆盖前者、`read` 写权限告警与 `read+plan/sandbox` 边界提醒） |
| `test/tool-subagent-manage.test.ts` | 11 | 12 | +1 | 现有 `follow_up` 参数化表加入 `"antigravity-cli"` |
| `test/subagent-external-run.test.ts` | 18 | 18 | 0 | 在既有外部启动/结算测试内扩展 D8 正常退出校验与成功伴 `denied_actions` 落盘核对 |
| `test/subagent-restart-adoption.test.ts` | 5 | 5 | 0 | 在既有重启恢复测试内扩展 `expectedResumeSessionId` 跨重启持久化与结算核对 |
| `test/e2e/deterministic/external-run.test.ts` | 1 | 1 | 0 | 在既有 A18 真实子进程 `SIGKILL` 重启恢复用例中扩展 `antigravity-cli` 续接会话不一致拦截断言 |

单测总增量：**+14**（1015 → 1029）；确定性 e2e 总增量：**0**（71 → 71）。

## 定向 Mutation 验证记录

按实施计划 §8.1 逐项引入故障并运行对应测试，全部捕获预期红灯后立即恢复：

| 编号 | 临时破坏 | 捕获失败的测试与断言 |
| --- | --- | --- |
| Mutation 1 | 移除 `antigravity-cli.ts` 中 `recordParentConversationId` 的非空字符串守卫（`if (!trimmed) return;`） | `test/antigravity-cli-harness.test.ts:364:38`（`expected '' to be 'conv-keep-me'`）及 `679:47`（`expected undefined to be 'conv-valid-1'`） |
| Mutation 2 | 移除 `antigravity-cli.ts` 中 `status === "SUCCESS" && !finishedReason` 的 `!finishedReason` 条件 | `test/antigravity-cli-harness.test.ts:332:35`（`expected 'completed' to be 'failed'`） |
| Mutation 3 | 将 `joinStepsWithBoundaries` 改为直接无换行拼接 `steps.join("")` | `test/antigravity-cli-harness.test.ts:279:30`（`expected 'Checking.VERDICT: PASS' to be 'Checking.\nVERDICT: PASS'`）及 `501:37` |
| Mutation 4 | 将 `thinking_tokens` 重复加进 `output` 并直接信任 `result.usage` | `test/antigravity-cli-harness.test.ts:222:25`（`output: 241` vs `130`）及 `426:31`（零轮 `/help` 回显误判 `usageKnown: true`） |
| Mutation 5 | 移除 `antigravity-cli.ts` 的 D8 校验与 `reconciliation.ts` 的 `expectedResumeSessionId` 转发 | `test/antigravity-cli-harness.test.ts:629:37` 与 `test/subagent-restart-adoption.test.ts:520:58`（`expected 'completed' to be 'failed'`） |
| Mutation 6 | 移除 `antigravity-cli.ts` 成功结果伴随 `denied_actions` 时的前置通知拼接 | `test/antigravity-cli-harness.test.ts:395:41` 与 `test/subagent-external-run.test.ts:958:29`（`expected 'Checked via read_file.\nVERDICT: PASS' to contain '[antigravity-cli permission notice]'`） |

## 行为评测（Behavior Evals）

修改 `src/playbooks/agent-delegation.md` 后运行 `npm run eval -- plan --changed-since 671ddfaf8eb1c4243b93d8343b7ac870c5dd4e8d`，计划列出 dev profile 12 个场景。针对与委派和外部执行直接相关的 3 个场景（`D-merge-01`、`D-verify-01`、`T-run-01`）先执行离线 oracle `selftest`，随后使用本机配置的 `openai-codex/gpt-5.6-luna`（thinking `medium`）运行真实模型评测（judge 关闭）：

| 场景 | Oracle Selftest | Run ID | 结果 |
| --- | --- | --- | --- |
| `D-merge-01` | 9/9 controls（3 valid / 6 invalid） | `2026-11-14T16-50-22-451Z-etboi4` | 1/1 通过（23.4s，$0.0062，0 行为失败 / 0 安全违规） |
| `D-verify-01` | 6/6 controls（2 valid / 4 invalid） | `2026-11-14T16-51-42-804Z-2pipo6` | 1/1 通过（18.7s，$0.0069，0 行为失败 / 0 安全违规） |
| `T-run-01` | 7/7 controls（3 valid / 4 invalid） | `2026-11-14T16-52-02-818Z-nxpn48` | 1/1 通过（39.8s，$0.0186，1 笔外部未知费用，0 行为失败 / 0 安全违规） |

## 遗留与边界说明

- `agy 1.5.9` 在 `--conversation <id>` 续接时若有未来版本改为重放多轮历史 `user_input` 步骤，D5 的 `userInputStepIndices.size <= 1` 守卫会自动回退为 `usageKnown: false`，避免把历史轮次重复计入单次委派账本。
- `--mode plan` 与 `--sandbox` 的组合不能作为只读隔离保证，文档与角色告警已明确要求无法证明只读时声明 `mutates: write`。

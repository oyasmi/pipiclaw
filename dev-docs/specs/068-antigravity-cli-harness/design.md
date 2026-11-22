# 068 — antigravity-cli harness

| 字段 | 内容 |
| --- | --- |
| 状态 | 已实施，真实协议已核实（[实施计划](./plan.md)、[验收记录](./acceptance.md)） |
| 日期 | 2026-11-14；2026-11-15 实施前审查修订 |
| 承接 | [040 外部委派](../archive/040-async-delegation-and-external-agents/design.md) 的 D3/D4 harness 接缝、[066 Cursor CLI harness](../066-cursor-cli-harness/design.md)；当前实现见 `src/subagents/external/` |
| 协议依据 | [官方无头协议](https://antigravity.google/docs/cli/headless/)、[执行模式](https://antigravity.google/docs/cli/modes/)、[权限](https://antigravity.google/docs/permissions/)；本机 `agy 1.5.9` 的 `agy --help`、`agy changelog`、Go 结构体 JSON 标签与管道参数实测 |
| 实施形态 | 新增结构化外部 harness（`antigravity-cli`）与单个能力条目 `examples/sub-agents/agy-main.md`；补充续接预期 ID 的持久化和共享结算校验。不改 run 状态机、写锁所有权或 prompt 投递方式 |

本设计写给实施者。协议依据来自官方文档及本机 `agy 1.5.9` 的参数解析与结构标签实测，未发起消耗额度的真实模型请求。真实端到端流协议核对通过 opt-in smoke（`PIPICLAW_E2E_HARNESS=antigravity-cli npm run test:e2e:external`）单独执行，不进入离线 `npm run test` 或 `npm run check`。

实施顺序、文件清单、验证与交接要求见 [实施计划](./plan.md)。

## 0. 协议证据与待核实事项

字段存在、字段含义和真实端到端行为分别取证。Go JSON 标签只能证明结构，不能证明 token 是否包含 thinking、用量是否累计、步骤是否重放，或某个模式能够保证只读。手写夹具与 mutation 只能验证实现符合选定规则，不能替代 CLI 协议证据。

2026-11-15 审查确认：

- 官方无头文档的一个样例为 `input_tokens=10418`、`output_tokens=589`、`thinking_tokens=551`、`total_tokens=11007`，不满足原设计的 `input + output + thinking` 公式。D5 撤回无依据的 thinking 加总规则。
- 官方把 `plan` 描述为添加规划指令；本机 changelog 的 1.1.28 说明无头运行会自动通过实施计划审批。`--mode plan --sandbox` 不能作为只读权限保证。
- 本机将 `/help` 经非 TTY 管道送入 `agy --output-format stream-json`，得到 `command_result` 与 `result(SUCCESS)`，会话 ID 为空、用量全零且带 `result.command`。向该命令传入不存在的 `--conversation` 仍退出 0，只在 stderr 写 warning。此探测不消耗模型额度，但不能证明普通模型请求在会话失效后的行为。
- 官方明确说明 `--input-format stream-json` 的多轮 result 用量按会话累计。本设计不用该输入模式；跨进程 `--conversation` 是否同样累计仍待核实，不能直接类推或忽略。

P0.5 按下表收集或登记证据。每份事件样本记录 CLI 版本、认证方式（不记录凭据）、完整 argv、stdin 输入形态、退出码、stdout NDJSON、stderr 与来源；脱敏时保留事件顺序、步骤索引和计数关系。官方样例、真实采集和合成故障夹具必须注明各自来源，禁止将官方样例或合成夹具标为本机真实采集。

| 场景 | 需要确定的事实 | `agy 1.5.9` 核实结论 |
| --- | --- | --- |
| 非零用量的单轮运行 | thinking/cache 与 input/output/total 的包含关系；模型标识是否接受示例中的基础名 | 已实测：`output_tokens` 已包含 `thinking_tokens`，`total_tokens = input_tokens + output_tokens`（不重复加 `thinking_tokens` 或 `cache_read_tokens`）；`--model gemini-4-carbon --effort medium` 自动解析为 `gemini-4-carbon-medium` |
| 多步骤回复与工具调用 | ACTIVE/DONE 的增量语义、步骤边界、工具参数与子智能体事件形态 | 已实测：`agent_response` 在 `ACTIVE` 推流 `text_delta`、`DONE` 的 `text_delta` 为空但带该步 `usage`；工具参数为 PascalCase 对象（如 `read_file.Path`、`run_command.CommandLine`）；`invoke_subagent` 在 `step_update.subagent_info.subagents` 中携带子会话 ID 与 `role`/`type_name` |
| 有效续接与失效会话 | 返回 ID 是否等于请求 ID；是否新建会话或重放历史步骤；result 用量是否跨进程累计 | 已实测：有效 `--conversation <id>` 返回相同 ID，不重放历史 `step_update`，但 `result.usage` 为跨轮会话累计值、`step_update.usage` 为本轮单次消耗；模型请求上传入不存在的 `--conversation <uuid>` 在 stderr 打印 warning 后静默新建 UUID 并以 `SUCCESS` 退出 0（证明 D8 必不可少） |
| 权限拒绝与异常结束 | `denied_actions` 的形态；SUCCESS 与拒绝能否并存；超时/错误终态是否仍带可用用量 | 已核实：`--print-timeout 1ms` 真实采集返回 `status: "ERROR"`、`finished_reason: "print_timeout"`（兼容 changelog 1.1.28 的 `SUCCESS + print_timeout`）；早期错误 `result.conversation_id` 为 `""` 且 `usage` 全 0；`denied_actions` 为 `[]string`（Go 结构体标签确认，适配器单测覆盖失败与成功伴拒绝两条分支） |

原始个人数据不提交仓库。实施时将最小脱敏样本及来源说明放进适配器测试夹具；证据不足的行为在验收中保持“未核实”，按 D5 保守报告未知用量。允许先完成离线实现，不允许将缺少真实证据解释为协议验证通过。

## 1. 范围

外部角色增加 `harness: antigravity-cli`。可执行文件名为 `agy`（Google Antigravity CLI），由角色的 `command` 指定，与 `claude-code` 对应 `claude`、`codex-cli` 对应 `codex`、`cursor-cli` 对应 `agent` 同一命名与绑定规则。

它进入现有的「一条 prompt、一个短命进程」模型：`ExternalHarness` 只负责 argv 组装、stdout NDJSON 解析和进度标签。`SubAgentRunManager`（`runs.ts`）继续独占状态机、用量记账、workspace lease 与完成唤醒，`external/run.ts` 继续负责脱离终端 spawn、stdin 写入、敏感环境变量过滤、审计和结算。

仓库示例目录新增且仅新增一个能力条目 `examples/sub-agents/agy-main.md`，对齐现有 `claude-main` / `codex-main` / `cursor-main` 的单文件主力候选组织方式。

### 1.1 明确不做

- 不使用 `agy acp`、`--input-format stream-json`、`-i` / `--prompt-interactive`、`--remote-control` 或 `agy remote-control`。这些都是长会话或交互模式，不符合一进程一轮委派。
- 不使用 `--continue` / `-c`。它恢复本机全局最近一次会话，在多工位或并发委派下会串会话；续接统一用 `--conversation <id>`。
- 不在启动前本地生成 UUID 充当 `--conversation`。实测对新会话传入未知 `--conversation <uuid>` 会产生 `warning: conversation "<uuid>" not found`；会话 ID 由 `agy` 分配并在 `stream-json` 事件中返回，`presetSessionId` 始终不设置。
- **绝不追加 `-p`、`--print` 或 `--prompt`。** 与 `claude`、`agent` 不同，`agy` 的 `-p` / `--print` / `--prompt` 是字符串参数（`flag.StringVar`）而非布尔开关：不带值跟在其他参数前会把下一个参数吞作 prompt 文本并以退出码 2 报错；放在末尾会因缺少参数报错；传 `-p ""` 报 `empty prompt` 并屏蔽 `stdin`；传 `-p -` 会把字面量 `"-"` 当成完整任务。当 `stdin` 为非空管道且未传 `-p` / `-i` 时，`agy --output-format stream-json` 自动进入无头 print 模式并完整读取 `stdin`。
- **默认不追加 `--disable-slash-commands`。** 保留 CLI 默认行为，由角色在 `command` 显式禁用。注意真实委派会在任务前添加角色正文及 `Runtime context:` / follow-up 信封，原始任务前导 `/...` 不再位于 stdin 开头；这不构成 Pipiclaw 已支持原生斜杠命令直达的承诺。
- 不自动追加 `--dangerously-skip-permissions`、`--mode`、`--sandbox`、`--settings`、`--agent`、`--add-dir`、`--remote-agent`、`--project` 等权限或环境控制参数。权限边界归角色 `command` 与宿主环境所有。
- 不往工作区写临时 `.agents/rules/`、`.agents/agents/` 或 `GEMINI.md` 再事后清理。
- 不铺设 `agy-high`、`agy-flash`、`agy-review` 等多档位示例文件；`examples/sub-agents/` 只补充一个 `agy-main.md`。
- 确定性 e2e 默认不净增，先扩展相关既有链路。续接预期 ID 从启动持久化经重启到结算是本次新增的跨模块故障面；若既有链路无法覆盖，按仓库准入规则说明增量、故障影响与 mutation 证据，不预先禁止必要覆盖。实施后必须完整运行 `npm run test:e2e`。
- 不改 `purpose=verify` 的准入。`exec` 仍是唯一因缺少协议终态而被拒绝的外部 harness；`antigravity-cli` 有结构化 `result` 终态事件，允许承担 `purpose=verify`。

## 2. 和现有结构化 harness 的差异

实施时严格按此表区分，不要把 `claude-code` 或 `cursor-cli` 的 `-p` 组装逻辑照搬过来：

| 维度 | claude-code | codex-cli | cursor-cli | antigravity-cli (`agy`) |
| --- | --- | --- | --- | --- |
| 无头触发与协议参数 | `-p --output-format stream-json --verbose` | `exec --json` | `-p --output-format stream-json --trust` | **仅 `--output-format stream-json`**（非空管道 `stdin` 自动进入无头模式，传 `-p` 反而破坏调用） |
| 协议终态 | `type: "result"` | `turn.completed` / `turn.failed` | `type: "result"` | `event: "result"`（嵌套 `result.status` 与可选 `result.finished_reason`） |
| 失败表现 | 通常仍有 `result`（`is_error: true`） | `turn.failed` 或非零退出 | 非零退出，可能无 `result` | 有 `result`（`status: "ERROR"` / `"CANCELED"` / `"INTERRUPTED"`，或 `finished_reason: "print_timeout"`），或启动期直接非零退出写 `stderr` |
| 会话 ID 来源 | 启动前本地生成 `--session-id` | 事件里的 `thread_id` | `system/init.session_id` | 事件里的 `conversation_id`（`init`、`step_update`、`result`），结算时落盘；早期错误 `result` 中可能为空串 `""` |
| 续接参数 | `--resume <id>` | `exec resume <id>` | `--resume <id>` | `--conversation <id>` |
| 角色正文投递 | `--append-system-prompt-file` | 拼在 `stdin` 任务前 | 拼在 `stdin` 任务前 | 拼在 `stdin` 任务前；角色也可在 `command` 用 `--agent <name>` 绑定原生自定义智能体并留空正文 |
| 模型参数 | `--model <id>` | `-m <id>` | `--model <id>` | `--model <id>`（原样透传，注意 `agy` 没有 `-m` 短别名） |
| 推理档参数 | `--effort <level>` | `-c model_reasoning_effort=<level>` | 编码进 `--model name[effort=...]` | `--effort <level>`（支持 `low\|medium\|high\|xhigh\|max`，可独立于 `--model` 传递） |
| 用量与费用 | 报 token 与 USD cost | 只报 token，无 USD | 都不报 | 只报 token（含 `thinking_tokens` 与 `cache_read_tokens`），无 USD cost |
| 进度事件 | `assistant` 里的 `tool_use` | `item.started` | `tool_call`（`subtype: "started"`） | `event: "step_update"` 且 `state: "ACTIVE"`（`tool_info` / `subagent_info`） |
| 写文件权限 | `command` 配 permission 参数 | `command` 配 approval/sandbox | `command` 配 `-f` / `--force` / `--yolo` | 由模式、权限规则、agent/settings 与宿主共同决定；`accept-edits` 自动批准工作区编辑，但终端命令仍可能被拒绝；`auto` 受账号与平台限制 |
| 只读执行 | `command` 自限 | `command --sandbox read-only` | `command --mode ask` / `plan` | 部署者配置并验证权限/宿主边界；`plan` 是任务策略，`--sandbox` 是终端限制，二者组合不保证只读 |

工作目录与用户目录下的 `GEMINI.md`、`AGENTS.md`、`.agents/rules/`、`.agents/skills/`、MCP 与插件会被 `agy` 自行按其定制规则加载；角色 Markdown 正文作为 `stdin` 前缀进入用户消息，隔离层级与 `codex-cli`、`cursor-cli` 相同。同时 `agy` 自身具备内置子智能体（`invoke_subagent`）、工作流（`run_workflow`）与多智能体协作（`swarm`）能力，这些均在单次 `agy` 进程内运行，通过 `step_update.subagent_info` 反映到进度标签并在 `result.usage` 中汇总 token。

## 3. 决策

### D1. 注册与联合类型

`SubAgentHarness` / `RunHarness` / `ExternalHarness["id"]` 增加 `"antigravity-cli"`。新建 `src/subagents/external/antigravity-cli.ts`，在 `src/subagents/external/registry.ts` 注册适配器，`parserVersion` 为 `1`。

下列手写联合类型同步增加 `"antigravity-cli"`，保持严格单向分层（不跨层抽共享类型）：

- `src/subagents/discovery.ts` 的 `ALLOWED_HARNESSES`
- `src/subagents/run-record.ts` 的 `RunHarness`（同步更新未知费用注释）
- `src/subagents/external/harness.ts` 的 `ExternalHarness["id"]` 与注释
- `src/subagents/external/run.ts` 中 `harness.id` 的联合类型断言
- `src/channel/store.ts` 的委派状态持久化类型
- `src/agent/prompt/types.ts` 的目录摘要类型
- `src/tools/subagent-manage.ts` 的 `resumableHarnessOf`

`external/run.ts` 的 `buildStdinContent` 保持「仅 `claude-code` 单独走任务 `stdin`」的现有分支：`antigravity-cli` 自动走非 `claude-code` 分支——正文非空时为 `${trimmedPrompt}\n\n---\n\n${task.trim()}\n`，正文为空时为 `${task.trim()}\n`。`prompt.txt` 仍只记录本次任务文本。

D8 另需接入 `run-record.ts`、`runs.ts`、`external/run.ts`、`external/settlement.ts` 与 `external/reconciliation.ts` 的启动元数据及共享解析输入。`runs.ts` 当前也已达到架构基线上限 **1048 行**；把 `setLaunched` 的内联参数类型移入 `run-record.ts`，命名为 `ExternalLaunchInfo`，再补充字段，保持 `runs.ts` 不增长，不新增基线例外。

### D2. argv 组装

`buildInvocation` 的输入与现有适配器一致：`command` 先由 `external/run.ts` 经 `splitShellWords` 拆成 `[executable, ...rest]`。调用 `expandPlaceholders(rest, { $MODEL: input.model, $EFFORT: effort, $PROMPT_FILE: input.promptFile, $SYSTEM_PROMPT_FILE: input.systemPromptFile })`，未配置值的占位符沿用 `formatDroppedPlaceholderWarnings`。返回 `{ executable, args, warnings, resumable: true }`，`presetSessionId` 始终不设置；不要把完整 argv 当成 `BuildInvocationResult` 字段返回。

在展开后的 `rest` 之后按顺序组装：

1. 追加 `--output-format`、`stream-json`。若 `rest` 中已写了其他值的 `--output-format`（或 `--output-format=...`），保留原 token 并在结尾追加 `--output-format stream-json`，同时写入一条英文 invocation warning 说明协议解析固定要求 `stream-json`。
2. **不追加 `-p` / `--print` / `--prompt`，也不追加 `--disable-slash-commands`。** 若 `rest` 中出现了 `-p`、`--print`、`--prompt`（含 `=...`）或 `-i`、`--prompt-interactive`（含 `=...`），生成英文 invocation warning，指出 `agy` 的该参数会消费后续参数、屏蔽管道 `stdin` 或要求交互终端。
3. 按 D3 规则按需追加 `--model <model>` 与 `--effort <effort>`。
4. 若 `input.resumeSessionId` 非空，追加 `--conversation`、`input.resumeSessionId` 两个 token。`rest` 中出现 `-c`、`--continue` 或 `--conversation`（含 `=...`）时，无论是否续接都生成 invocation warning：角色固定绑定会话可能造成跨运行共享，并可能与 runtime 的续接参数冲突。仅追加参数不代表已经验证续接成功，身份校验见 D8。

### D3. 模型与推理档

是否追加 `--model` 与是否追加 `--effort` 相互独立判断：

1. **模型**：当 `input.model` 非空、`rest` 中没有 `--model` 或 `--model=...`、且本次未消费 `$MODEL`（`!used.has("$MODEL")`）时，追加 `"--model"`、`input.model`。模型字符串原样透传给 `agy`，不查 Pipiclaw 的 `models.json`。注意 `agy` 没有 `-m` 短参数，只检查 `--model` / `--model=...`。
2. **推理档**：`input.thinkingLevel` 未设置时不追加 `--effort`，保持外部 `work` 委派「不兜底推理档、交由 CLI 默认配置决定」的规则；`purpose=verify` 仍由上游调用方在未声明时传入 `"medium"`。当 `input.thinkingLevel` 有值时，按以下映射转换为 `agy --effort` 接受的枚举值（`low|medium|high|xhigh|max`）：

| `thinkingLevel` | `agy --effort` |
| --- | --- |
| `off`、`minimal`、`low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

表外值原样透传。当映射得到 `effort`、`rest` 中没有 `--effort` 或 `--effort=...`、且本次未消费 `$EFFORT`（`!used.has("$EFFORT")`）时，追加 `"--effort"`、`effort`。实测 `agy` 支持在不传 `--model` 的情况下单独传 `--effort`（作用于账号/配置文件的默认模型），因此无 `input.model` 时仍正常传递 `--effort`，无需像 `cursor-cli` 那样依赖模型字符串装饰。

### D4. 协议解析（`parseOutcome`）

`agy --output-format stream-json` 在 `stdout` 上每行输出一个嵌套 JSON 对象（`StreamEvent`）：

- `{"event":"init","conversation_id":"<uuid>","init":{"model":"...","cwd":"...","agent":"...","tools":[...],"permission_mode":"..."}}`
- `{"event":"step_update","conversation_id":"<uuid>","step_update":{"conversation_id":"<uuid>","step_index":1,"state":"ACTIVE"|"DONE","step_type":"user_input"|"agent_response"|"tool"|"checkpoint","tool_name":"...","text_delta":"...","usage":{...},"tool_info":{...},"subagent_info":{...}}}`
- `{"event":"result","conversation_id":"<uuid>","result":{"conversation_id":"<uuid>","status":"SUCCESS"|"ERROR"|"CANCELED"|"INTERRUPTED","response":"...","error":"...","duration_seconds":1.2,"num_turns":2,"structured_output":...,"usage":{...},"denied_actions":[...],"finished_reason":"print_timeout"|...}}`

`parseOutcome` 永不抛出异常，逐行容错 `JSON.parse`，非对象或损坏行跳过；非空输入中没有任何合法 JSON 对象时返回 `protocolStatus: "unparsable"`。内部状态按下列规则提取：

1. **会话 ID（非空守卫）**：依次检查顶层 `event.conversation_id`、`step_update.conversation_id`、`result.conversation_id`。**仅当值为字符串且 `trim().length > 0` 时更新 `sessionId`**。`agy` 的 `Result.conversation_id` 在 Go 结构体中不带 `omitempty`，中途报错的 `result` 可能序列化为空串 `""`；加非空守卫可防止它把 `init` / `step_update` 已经拿到的真实 UUID 冲掉。
2. **分步回复增量与边界**：对 `event === "step_update"` 且 `step_update.step_type === "agent_response"` 的事件，按非负整数 `step_index` 在 `Map<number, string>` 中拼接字符串 `text_delta`。同一步内不插换行，DONE 可以携带最后一段增量或完整的短回复；无 `text_delta` 时保留已累计内容。仅在证据确认 CLI 会发送快照全文时再制定相应去重规则，不按文本相似度猜测。最终按步骤索引排序，保留所有非空步骤及其边界；不把末步文本当成完整交付。这些信息不改变 `terminalSeen` 或 `protocolStatus`。
3. **终态判定**：只有 `event === "result"` 且 `result` 为普通对象时，才将 `terminalSeen` 设为 `true`。
   - 当且仅当 `result.status === "SUCCESS"` **且** `!result.finished_reason`（字符串为空或未定义）时，`protocolStatus` 为 `"completed"`。若角色配置了 `--print-timeout` 触发限时截断，`agy` 会输出部分回复并标记 `finished_reason: "print_timeout"`，此时必须判为 `"failed"`，避免把半截输出当作完成交付。
   - 若 `result.status === "SUCCESS"`、无 `finished_reason`，但 `result.denied_actions` 非空：保持 `"completed"`（`agy` 在部分动作被拒后允许模型调整策略并正常完成本轮），不误杀成功结果。
   - 其他所有 `result` 情况（`status` 为 `"ERROR"`、`"CANCELED"`、`"INTERRUPTED"` 或未知值，或存在非空 `finished_reason`），`protocolStatus` 均为 `"failed"`。
4. **最终文本（`finalText`）**：
   - 未见到 `result`（如超时、取消、进程崩溃）时：取所有非空回复步骤按索引排序后的文本；相邻步骤在边界均无换行时插入一个换行，无内容则 `""`。保留已输出证据，不把部分文本当成完成。
   - 见到 `result` 时：正常优先取非空字符串 `result.response`。只有多步已累计文本的无分隔串联与 `result.response` **完全相等**时，才在已证实的步骤边界补上缺少的换行；正文的所有字符保持原样，不根据尾部匹配丢弃前文，不因字符串中出现 `VERDICT` 就凭空造行首。两步 `"Checking."` 与 `"VERDICT: PASS"` 的修复结果应为 `"Checking.\nVERDICT: PASS"`，普通 work 交付适用同一无损规则。不修改共享 `parseVerificationVerdict`。
   - `result.response` 为空时，依次回退上述完整步骤文本、`JSON.stringify(result.structured_output)`（字段不为 `undefined` 时）、`""`。聚合 response 与步骤不完全匹配时原样保留 response，不能为了得到 PASS 强行修复。
5. **错误诊断（`errorMessage`）**：
   - 失败的 `result`：主错误说明按优先级取非空 `result.error` → 非空 `result.finished_reason`（格式化为 `antigravity-cli stopped: <finished_reason>`）→ 非空 `result.status`（`antigravity-cli reported status <status>`）→ `"antigravity-cli reported an error"`。若 `result.denied_actions` 为非空字符串数组，在错误说明末尾追加 ` (denied actions: <前若干项拼接>)`，直接暴露无头模式权限拦截原因。即使已有 `finalText`，也保留该 `errorMessage`。
   - 未见到 `result` 且 `stderrTail` 非空时：把 `stderrTail.trim()` 写入 `errorMessage`（例如未登录、模型名非法或参数错误），`terminalSeen` 仍为 `false`。
6. **成功结果的拒绝诊断**：SUCCESS 且 `denied_actions` 非空时保留 completed，但在已选定的 `finalText` **前面**添加独立英文说明，列出被拒绝动作并要求查看该 run 的 `events.jsonl` / `stderr.log`、核实缺失工作或另选具备相应权限的角色。摘要最多列 5 项、每项最多 80 字符，超过时给出完整事件的查阅指引。正文不删除，最终 `VERDICT` 行保持末行。这让诊断随现有 `outputText` 保存并进入完成唤醒，无需为成功结果滥用 `errorMessage` 或新增结算状态。原始事件保留完整列表。

结算继续走 `classifyExternalOutcome` 的结构化分支，不把 `antigravity-cli` 加入 `exec` 例外：无 `result` 的退出码 0 仍判失败；超时或取消先解析已落盘的事件（保留 `sessionId`、部分文本与已产生 token），再由 `terminationReason` 覆盖状态。

### D5. 用量归集

`agy` 上报 token 明细但没有美元费用字段，归入与 `codex-cli` 相同的「token 已知、cost 未知」类别：

- `costKnown` 恒为 `false`，任务美元预算与账本按未知费用次数（`unknownCostCount`）处理，不冒充 `$0`。
- **字段映射先核实包含关系**：以 §0 官方样例为初始依据，候选映射为 `input = input_tokens`、`output = output_tokens`、`cacheRead = cache_read_tokens`、`cacheWrite = 0`，优先采用上游有效的 `total_tokens`。不再把 `thinking_tokens` 无条件加进 output，也不把 cache 再加进 total。P0.5 核实当前 CLI/认证方式的语义后固定 parserVersion 1 的实际映射及来源；若与样例矛盾，先更新本条，不写一个按数值凑等式的运行时猜测器。缺失 total 只在已确认包含关系时推导；不能完整确定时报告 `usageKnown: false`。
- **数值校验**：只接受有限、非负的 number；字符串、负值或非有限值不以强制转换冒充已知计数。必要字段缺失时不要因为 status 成功或 `num_turns > 0` 就补出已知零用量。零值可以是真值，但必须来自已验证的计数结构与本次调用范围。
- **单次运行范围**：账本只记录本次委派的消耗。新会话可以采用已证实属于本进程的 result 汇总；`--conversation` 续接在跨进程 result 统计范围核实前，不直接信任终态总量。优先使用已证实只属于本次进程、没有历史重放的 `step_update.usage` 去重求和；若此范围也无法证明，返回未知用量，不重复计算旧会话消耗。不从前一 run 的部分/归一化用量或 `num_turns` 猜测差值，不新增统计范围配置开关或旧格式兼容路径。
- **步骤汇总**：按非负整数 `step_index` 去重，同一步取最后一条有效计数快照；缺失、损坏或全零占位更新不覆盖此前的非零用量。覆盖 agent_response、checkpoint 等所有带 usage 的父会话步骤；子智能体是否已包含在父汇总必须由样本核实，不额外重复加总。流内 result 与 step 只能择一，不能相加。
- **异常终态也可回退**：无 result，或 result 缺少有效用量/只有全零占位而步骤已有可信非零用量时，都回退步骤汇总。已有消耗不能被晚到的空错误结果清零；仍保留错误、取消或超时的运行状态。
- **零轮启动错误守卫**：`agy` 的错误 result 可能带默认全零 usage；无非零步骤时，认证失败/0 轮错误仍为 `usageKnown: false`。SUCCESS、零轮且带 `result.command` 的 `/help` 等 CLI 命令回显也不作为模型用量证明。`num_turns` 的范围可能是会话累计值，不能单独证明本次运行用量已知。

同步更新 `src/subagents/format.ts`、`src/subagents/run-record.ts`、`src/usage/ledger.ts`、`src/usage/render.ts` 中列举「报 token 但不报 cost 的 harness」注释，把 `antigravity-cli` 与 `codex-cli` 并列说明。

### D6. 进度标签（`toProgressLabel`）

实现 `toProgressLabel`，只消费 `event === "step_update"` 且 `step_update.state === "ACTIVE"` 的事件；忽略 `DONE` 与流式 `agent_response` 增量，防止重复刷屏。

1. **内部子智能体步骤**：若 `step_update.subagent_info?.subagents` 为非空数组，取首项的 `role` 或 `type_name`（非空字符串），生成 `subagent <role|type_name>`（无名称则仅 `"subagent"`），压缩空白并截断到 80 字符。
2. **工具调用步骤**：当 `step_update.step_type === "tool"`，或存在非空工具名（优先 `step_update.tool_info?.name`，其次 `step_update.tool_name`）时：
   - 动词取该工具名。
   - 参数对象取自 `step_update.tool_info?.parameters`（若为普通对象直接读取；若为 JSON 字符串则容错解析为普通对象，失败则不取主体）。
   - 兼顾 `agy` 内置工具的 PascalCase 参数名与 MCP/通用工具的常见参数名，按以下固定顺序取第一个非空字符串字段作为主体：`CommandLine`、`command`、`Path`、`TargetFile`、`SearchPath`、`Directory`、`file_path`、`target_file`、`path`、`Query`、`Pattern`、`query`、`pattern`、`Url`、`url`、`Role`、`Description`、`toolSummary`。
   - `CommandLine` 与 `command` 只保留第一行；**严禁读取 `Content`、`Replacement`、`output`、`error`**，避免泄露待写入文件内容或执行结果。
   - 拼成 `动词 主体`（无主体则仅返回动词），折叠连续空白并截断到 80 个字符。其余事件一律返回 `undefined`。

### D7. 角色配置告警与 `discovery.ts` 行数约束

在 `src/subagents/external/role-warnings.ts` 中新增 `antigravityCommandWarnings(input)`，仅在 `input.harness === "antigravity-cli"` 时运行。统一使用 `splitShellWords(input.command)` 扫描参数 token（支持 `--flag value` 与 `--flag=value` 两种写法），不做裸字符串子串匹配，且所有告警均不拒绝角色加载：

| 条件 | 告警说明的事实 |
| --- | --- |
| 含 `-p`、`--print`、`--prompt`（或 `--print=...`、`--prompt=...`） | `agy` 的 print 参数接收字符串任务并会吞掉后续参数或屏蔽管道 `stdin`；无头委派只需保留管道输入，不要传 `-p`/`--print` |
| 含 `-i`、`--prompt-interactive`（或 `--prompt-interactive=...`） | 交互模式需要 TTY，在脱离终端的后台委派进程中会失败或挂起 |
| 含 `-c`、`--continue` 或 `--conversation`（含 `=...`） | 角色固定恢复会话可能跨运行共享上下文，也会与 `follow_up` 追加的 `--conversation <id>` 冲突；续接由 Pipiclaw 管理 |
| `mutates: write`，且有效 `--mode` 为 `plan` | plan 会添加规划指令，可能偏离实现任务；它不保证只读，无头计划审批也可能自动通过 |
| `mutates: write`，且既无 `--dangerously-skip-permissions`，有效 mode 也非 `accept-edits` / `auto`，也未通过 `--agent` / `--settings` 指定额外配置 | command 未显式声明权限来源；默认 request-review 下需要审批的动作在无头运行中会被拒绝，已有全局权限规则可能放行，部署者须确认实际配置 |
| `mutates: read`，且含 `--dangerously-skip-permissions` 或有效 mode 为 `accept-edits` / `auto` | CLI 具备写文件权限，Pipiclaw 的 workspace 写锁不会拦截该只读角色的实际写入 |
| `mutates: read`，有效 mode 为 `plan` 或含 `--sandbox`，且未命中上条 | 提醒这些开关本身不保证只读，需要部署者验证实际权限；无法保证时改为 `mutates: write` |

重复 `--mode` 按实际 CLI 参数优先级判断，不能把已被覆盖的模式当成有效配置。`--agent` / `--settings` 只表示部署者提供了额外配置，不代表适配器已证明它允许写入或禁止写入；写角色免除“缺少显式权限来源”提醒时仍在文档中说明这一限制。告警只提示已识别的风险，不因 command 没有告警就推断权限安全，也不为所有 read 角色无条件生成相同提醒。`accept-edits` 不自动批准终端命令；`auto` 在不支持的账号/平台上可能退回 default；stderr 的权限诊断与 D4 的拒绝摘要必须保留。

`src/subagents/discovery.ts` 在 `scripts/architecture-baseline.json` 中登记上限为 **1031 行**（当前正好 1031 行）。`ALLOWED_HARNESSES` 新增 `"antigravity-cli"` 时保持单行，不增加 `discovery.ts` 行数，严禁修改 `scripts/architecture-baseline.json` 或运行 `--init`。

### D8. 续接身份及重启一致性

`--conversation` 参数被接受或 CLI 退出 0 都不能证明恢复成功。`sessionId` 只表示 CLI 实际报告的身份，不能拿请求值冒充输出，也不通过 `presetSessionId` 填入期望值。

1. 仅对 `antigravity-cli` 的 follow-up，把 `input.resumeSessionId` 存成可选启动元数据 `expectedResumeSessionId`。它写入 `RunRecord` 与 `ExternalLaunchInfo`，随现有 `setLaunched` 在 stdin 投递前持久化。字段不改变状态机、lease 或结算所有权；其他 harness 不设置它。
2. `FinalizeExternalRunInput` 与 `ParseOutcomeInput` 增加同名可选字段。正常退出从已持久化启动记录读取，`external/reconciliation.ts` 从恢复的 run 读取，两条路径通过同一个 `finalizeExternalRun` 传给解析器；不能只存在于启动回调闭包。
3. 解析器仅检查 D4 中父会话事件的非空 ID，不检查 `subagent_info` 内子会话 ID。有 expected 时，任一父会话 ID 不一致，或 SUCCESS result 结束后仍未观察到匹配的 ID，均判 `protocolStatus: failed`，即使 exitCode 为 0。错误说明要求查看事件并发起带完整上下文的新委派；不自动重试或静默降级为新会话。
4. 身份失败时保留输出与本次可信用量，但不返回可供后续 `follow_up` 使用的 `sessionId`；实际错误 ID 留在原始事件用于诊断。若先有匹配 init，后有空 ID 的 ERROR result，仍保留已确认的 ID 和原始失败诊断。取消/超时继续由现有 `terminationReason` 覆盖最终状态。
5. 用正常结算与重启恢复各验证“预期 A、返回 B/缺失”的拒绝，以及“预期 A、返回 A、错误 result 空串”的保留行为。P0.5 的失效会话探测用于确认 CLI 行为，不能代替上述防御。

## 4. 示例角色与推荐写法

### 4.1 仓库能力条目示例（仅 `agy-main.md`）

在 `examples/sub-agents/` 下新增**唯一一个** Antigravity 示例文件 `agy-main.md`，正文复用与现有十个能力条目完全一致的九条交付约定：

```yaml
---
name: agy-main
description: >-
  Antigravity 主力候选：目标、范围和验收较明确的实现、排查与文档，支持长上下文与内置子代理协作；使用 Antigravity 额度。
runtime: external
harness: antigravity-cli
command: agy --dangerously-skip-permissions
model: gemini-4-carbon
thinkingLevel: medium
workload: heavy
mutates: write
maxWallTimeSec: 3600
---
```

说明：
- runtime 实际执行的命令为 `agy --dangerously-skip-permissions --output-format stream-json --model gemini-4-carbon --effort medium`，角色正文与任务经 `stdin` 传入，续接时追加 `--conversation <id>`。
- 部署者可按本机 `agy models` 列出的可用标识符调整 `model`（如 `gemini-4-hydrogen`），或删去 `model` 让 `agy` 跟随 `~/.gemini/antigravity-cli/settings.json` 中的默认模型。
- `test/subagent-phase1.test.ts` 中校验仓库自带示例可加载性的 `loadExamples` 用例同步将 `"antigravity-cli"` 纳入允许的 `harness` 集合。

### 4.2 验证角色的权限边界与认证（写入 `docs/sub-agents.md`）

验证角色不放进 `examples/sub-agents/`。`purpose=verify` 的“不要修改实现”是任务指令，`mutates` 则描述部署后进程实际可能做出的写入。不能证明只读时采用写声明并获取 lease，例如：

```yaml
---
name: agy-verify
description: 用 Antigravity CLI 做独立验证，运行期间独占工作目录写锁
runtime: external
harness: antigravity-cli
command: agy --mode accept-edits --sandbox
model: gemini-4-carbon
thinkingLevel: high
mutates: write
---
```

这份配置具备工作区编辑权限；`accept-edits` 仍可能拒绝需要审批的终端命令，部署者应按实际验证需要配置有限的 command allow 规则，并检查拒绝诊断。`auto` 也不是通用替代品：它依赖账号、平台与可用的终端 sandbox，条件不满足时可能退回 default。模式和权限规则的优先级见[官方说明](https://antigravity.google/docs/cli/modes/)。

只有在部署者通过 CLI 权限规则和宿主边界（例如实现目录的只读挂载、独立可写临时目录）验证了实际写入限制后，才把角色声明为 `mutates: read`。验证应包括直接文件工具、终端命令和启用的 MCP/子智能体；仅禁止文件编辑工具不能阻止 shell 写入。此时 command 使用已经核实的权限配置，不能把 `agy --mode plan --sandbox` 当成可直接复制的只读配方。`--agent` / `--settings` 也不自动提供权限保证。

认证说明：
- 使用 Google OAuth（`~/.gemini/antigravity-cli/`）或 ADC（`AGY_ADC_AUTH`）时，运行 Pipiclaw 的同一系统账号提前在终端完成一次 `agy` 登录即可，无需配置 `env`。
- `external/run.ts` 默认从继承自宿主的环境变量中剥离 `GEMINI_API_KEY` 与 `GOOGLE_API_KEY`（`SENSITIVE_ENV_VAR_NAMES`）。若部署者明确使用 API Key 模式驱动 `agy`，须按现有安全规则在角色文件 `env:` 中显式映射，切勿把明文密钥写进仓库文档。

## 5. 文档同步清单

实现同一交付单元内同步更新下列位置，不留「只写三种结构化 harness」的陈旧描述：

- `examples/sub-agents/agy-main.md`（新增）与 `examples/sub-agents/README.md`（能力条目表增加 `agy-main`；正文十个条目/九个写条目计数更新为十一个条目/十个写条目；`stdin` 拼接说明补上 Antigravity）。
- `docs/sub-agents.md`：`harness` 可选值、参数组装表、推理档说明、`follow_up` 可续接集合与身份失败处理、`antigravity-cli` 权限与无头模式注意事项（不传 `-p`、默认不传 `--disable-slash-commands`、信封对斜杠命令的影响、拒绝摘要、plan/sandbox 不保证只读、验证角色的写声明、环境变量剥离说明、工作区 `.agents/` 与 `GEMINI.md` 自动加载事实）。
- `docs/README.md`：专题导航表中外部委派列举补上 Antigravity CLI。
- `dev-docs/architecture.md`：`src/subagents/external/` 典型文件列表补上 `antigravity-cli.ts`；用量账本说明中把 `antigravity-cli` 与 `codex-cli` 并列归入「报 token、不报 USD 成本」。
- `docs/deployment-and-operations.md`：结构化 harness 终态事件排查说明纳入 `antigravity-cli`。
- `docs/events-and-tasks.md`：任务未知美元成本（`usage.unknownCostCount`）举例纳入 `antigravity-cli`。
- `src/playbooks/agent-delegation.md`：`subagent_run op=follow_up` 支持集合补上 `antigravity-cli`。
- `AGENTS.md`、`CLAUDE.md`：项目简介与委派章节外部执行器列举补上 Antigravity CLI / `antigravity-cli`。
- `dev-docs/research/grok-bot-comparison.md`：外部 harness 列举同步更新。

遵守 `dev-docs/specs/README.md` 维护规则：不在 spec 中直接链接用户 Quickstart。

## 6. 测试

1. **适配器单测 `test/antigravity-cli-harness.test.ts`**（新建，只覆盖会独立失败的分支；真实/官方协议样本与合成故障样本标注来源）：
   - `buildInvocation`：追加 `--output-format stream-json`，**不含 `-p` / `--print` / `--disable-slash-commands`**，不含位置 prompt，`presetSessionId` 为 `undefined`，`resumable` 为 `true`。
   - 续接追加 `--conversation <id>`；command 已带冲突 `--output-format` 或误带 `-p` / `-i` / `--continue` 时产出 invocation warning。
   - 模型与推理档：`model` 透传 `--model`；`thinkingLevel` 独立透传 `--effort`（无 `model` 时也能传 `--effort`）；`thinkingLevel` 未设置时不传 `--effort`；`off` 与 `minimal` 映射为 `low`，`xhigh` 与 `max` 原样保留；`$MODEL` / `$EFFORT` 占位符展开后不重复追加对应参数，包装脚本消费 `$EFFORT` 时仍正常追加 frontmatter 的 `--model`。
   - `parseOutcome`：
     - 正常 `init` → `step_update` → `result(SUCCESS)`：提取 `sessionId`、完整 `finalText`、按 D5 已核实口径映射的用量、`costKnown === false`；thinking/cache 不重复加总，已知性与有效计数和统计范围相符，不根据成功状态猜测。
     - 多步回复与 `VERDICT` 边界：两步 `"Checking."` 与 `"VERDICT: PASS"` 加完全匹配的无换行聚合 response，得到 `"Checking.\nVERDICT: PASS"` 且共享 verdict 为 pass，前文证据必须保留。扩展同一有价值场景检查同一步多段增量、DONE 尾段、普通 work 正文及不完全匹配时不造边界；单步/仅 result 保留原文，空回复才走步骤/structured_output 回退。
     - `result.status: "SUCCESS"` 但带 `finished_reason: "print_timeout"`：判为 `failed` 并带出原因，不误判完成。
     - 失败 `result` 时空 ID 不覆盖 init 会话，`denied_actions` 出现在错误说明；成功伴拒绝则诊断在正文之前，仍 completed，正文与末行 verdict 保留。
     - 零轮启动错误与 CLI `/help` 回显不伪装成已知模型用量；步骤已非零、晚到错误 result 全零时保留步骤汇总；无效数值不污染账本。
     - 无 `result` 终态（超时/中断）：`terminalSeen` 仍为 false，保留会话、完整步骤文本、去重后的可信步骤用量及 stderr 错误说明。续接时累计 result 不被直接当成本次用量，无法证明步骤范围则未知。
     - D8 身份校验：匹配的有效续接、缺失 ID、不同 ID、匹配 init 后的空错误 ID。失败不能留下错误会话供下一次续接；不把子智能体 ID 当成父会话 ID。
   - `toProgressLabel`：`ACTIVE` 工具步骤提取 PascalCase 参数（如 `run_command` 的首行 `CommandLine`、`read_file` 的 `Path`）；`write_file` / `edit_file` 不泄露 `Content` / `Replacement`；`subagent_info` 生成 `subagent <role>`；`DONE` 步骤返回 `undefined`；超长标签截断到 80 字符。
2. **共享外部协议合同 `test/external-harness-contract.test.ts`**：将 `antigravityCliHarness` 加入结构化适配器参数化表，统一验证非 JSON 输出 `unparsable` 与「退出码 0 但无终态事件仍判失败」，不在单测文件中重复造同一矩阵。
3. **角色发现与示例校验 `test/subagent-phase1.test.ts`**：
   - `loadExamples` 允许 `"antigravity-cli"`，验证新增的 `agy-main.md` 无告警加载且路由/权限元数据完整。
   - 配置告警覆盖 D7：print/交互/固定会话、write+plan、缺显式权限来源、read+写许可和 read 声明边界提醒；支持等号写法与有效模式优先级，角色仍被加载。写角色的显式配置不误报为“缺少权限来源”，但不把 read+plan/sandbox 断言为已证明安全的零告警配置。
4. **续接及结算接线**：在 `test/tool-subagent-manage.test.ts` 的现有参数化成功用例加入 `"antigravity-cli"`；在 `test/subagent-external-run.test.ts` / `test/subagent-restart-adoption.test.ts` 的相关既有场景中扩展 D8 启动元数据、成功/失败结算与恢复路径。解析边界矩阵只留在适配器；上层仅证明预期 ID 被真实持久化并送达共享解析器、拒绝诊断随 `output.txt` 保存。
5. **确定性 e2e**：优先扩展 `test/e2e/deterministic/external-run.test.ts` 的真实进程恢复链，证明请求的续接预期在旧回调消失后仍参与结算。不得仅用直接 finalizer 调用或同进程 restart 证明这一点；保留已有 exec 恢复断言。若扩展无法覆盖，按仓库准入规则论证新例，记录实际 case-count delta 与 mutation。
6. **opt-in 真实 CLI smoke `test/e2e/external/subagent-external-smoke.test.ts`**：接入 `antigravity-cli`，以 `agy --mode accept-edits --sandbox` 在隔离临时工作区执行“读取输入 → 写出产物 → 同一会话 follow-up”的机制链。检查有工具事件、实际文件副作用、非空最终输出、完成状态、匹配的会话 ID、D5 口径下本次用量及未知美元费用，保留原始流。权限拒绝与 `--print-timeout` 异常探测可复用 §0 采集记录，不要求靠模型措辞制造故障。失效 ID 的模型路径另行核实。未设置环境变量时跳过；未执行或部分执行均按场景标注，不凭一条 OK 宣称协议已验证。

## 7. 实施完成的标准

- `npm run check` 通过。`discovery.ts` ≤ 1031 行，`runs.ts` ≤ 1048 行，`scripts/architecture-baseline.json` 未新增任何例外。
- `npm run test:e2e` 完整通过。
- 新适配器没有把 `-p` / `--print`、`--disable-slash-commands`、位置 prompt 或任何权限/模式开关自动写进 argv。
- `examples/sub-agents/` 仅新增 `agy-main.md` 一个角色文件，且第 5 节列出的全部文档已同步。
- D8 的续接预期真实落盘，正常退出与重启恢复执行相同身份校验；没有只在内存中生效的分支。多步正文与拒绝诊断完整交付，异常终态不覆盖已知用量。
- 实施完成后创建 `acceptance.md`，按实际情况将本文件与 `plan.md` 状态更新为「离线实现完成，真实协议待核实」或「已实施，真实协议已核实」，链接证据。逐项记录 §0 未决事项、行为评测与真实 CLI smoke；没有凭据不是质量通过，不将未确认的统计口径或权限边界写成已验证能力。

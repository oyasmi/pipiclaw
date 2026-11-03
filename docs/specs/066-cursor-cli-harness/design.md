# 066 — cursor-cli harness

| 字段 | 内容 |
| --- | --- |
| 状态 | 已实施。`agent --version` 为 `2026.10.22-27dcf5f`（与本文引用一致，只核对了版本和 `--help`）。未运行 opt-in smoke，流协议没有用真实 `agent -p` 核对。见 [验收记录](./acceptance.md) |
| 日期 | 2026-11-03 |
| 承接 | [040 外部委派](../../archive/specs/040-async-delegation-and-external-agents/design.md) 的 D3/D4 harness 接缝；当前实现见 `src/subagents/external/` |
| 协议依据 | [Cursor CLI overview](https://cursor.com/docs/cli/overview)、[headless](https://cursor.com/docs/cli/headless)、[parameters](https://cursor.com/docs/cli/reference/parameters)、[output format](https://cursor.com/docs/cli/reference/output-format)；本机 `agent --help`，版本 `2026.10.22-27dcf5f` |
| 实施形态 | 新增一种结构化外部 harness。不改 run 状态机、写锁、结算入口或 prompt 投递方式 |

本设计写给实施者。协议依据是上述文档和本机帮助文本，没有跑过真实 `agent -p`（会消耗额度，也可能改工作区）。schema 是否仍与文档一致，用文末的 opt-in smoke 核对，不在 `npm run test` 里调用 CLI。

实施顺序、文件清单、验证与交接要求见 [实施计划](./plan.md)。

## 1. 范围

外部角色增加 `harness: cursor-cli`。可执行文件名是 `agent`，由角色的 `command` 指定，与 `claude-code` 的命令名是 `claude`、`codex-cli` 的命令名是 `codex` 同一规则。

它进入现有的「一条 prompt、一个短命进程」模型：`ExternalHarness` 只负责 argv 组装、stdout 解析和进度标签。`runs.ts` 继续拥有状态机，`external/run.ts` 继续负责 spawn、stdin、审计和结算。

### 1.1 明确不做

- 不使用 `agent acp`、长连接、`persist` 或 Cloud Agent（消息前缀 `&`）。这些都不是一进程一 prompt。
- 不在启动前调用 `agent create-chat`，也不本地生成 UUID 去充当 `--session-id`。Cursor 的会话 id 由 CLI 分配，写在 `system/init` 里。
- 不追加 `--stream-partial-output`、`--force`、`--yolo`、`--sandbox`、`--mode`、`--approve-mcps`、`--workspace`、`--worktree`。
- 不把角色正文写成 `.cursor/rules` 再事后删掉。那会改工作区，也会和写锁的覆盖范围缠在一起。
- 不把 `duration_ms` 记成 token 用量。文档中的 `result` 事件没有 token 或 cost 字段；非交互 CLI 目前也不在事件里报用量。
- 不新增示例角色文件。模型 id 随账号变化，`agent models` 的输出不能写死进仓库。
- 不新增确定性 e2e 用例。spawn、stdin、审计、重启结算都是已有路径，换一种 harness id 不能证明新的跨模块故障；实施后仍必须运行现有 `npm run test:e2e`。
- 不改 `purpose=verify` 的准入。`exec` 仍是唯一因没有协议终态而被拒绝的 harness。`cursor-cli` 有 `result` 事件，允许用于 verify。

## 2. 和现有 harness 的差异

这些差异决定下面的决策，实施时不要把 claude-code 或 codex-cli 的 argv 照搬过来。

| | claude-code | codex-cli | cursor-cli |
| --- | --- | --- | --- |
| 协议终态 | `type: result` | `turn.completed` / `turn.failed` | `type: result` |
| 失败时 | 通常仍有 `result` | 有 `turn.failed` | 非零退出，stderr 有说明，流里可能没有终态事件 |
| 会话 id | 启动前 `--session-id` | 事件里的 `thread_id`，结算时才留下 | `system/init.session_id`，结算时才留下 |
| 续接 | `--resume <id>` | 子命令 `resume <id>` | `--resume <id>`，必须带 id |
| system prompt | `--append-system-prompt-file` | 拼在 stdin 任务前面 | 没有系统提示参数，拼在 stdin 任务前面 |
| 模型 | `--model` | `-m` | `--model`，原样透传，不查 `models.json` |
| 推理档 | `--effort` | `-c model_reasoning_effort=` | 写进模型 id 的方括号：`name[effort=high]` |
| 用量 | token 和 cost | 只有 token | 两者都没有 |
| 进度 | assistant 消息里的 `tool_use` | `item.started` | `tool_call` 且 `subtype: started` |
| 真正落盘 | command 里的 permission mode | command 里的 sandbox | print 模式默认只提议修改；command 里要有 `-f`、`--force` 或 `--yolo` |
| 只读执行 | command 自己限制 | command 自己限制 | command 使用 `--mode ask` 或 `--mode plan` |
| 无人值守会停住问问题 | 角色 command 已处理权限 | 角色 command 已处理 sandbox | 工作区信任提示需要 `--trust` |

工作目录里的 `.cursor/rules` 和项目说明会被 CLI 自己读进去。角色 Markdown 只是用户消息的前缀，隔离度弱于 claude-code 的 system prompt。这是文档事实，runtime 不试图屏蔽。

## 3. 决策

### D1. 注册

`SubAgentHarness` / `RunHarness` / `ExternalHarness["id"]` 增加 `"cursor-cli"`。`external/registry.ts` 注册新适配器，`parserVersion` 为 `1`。

下列手写联合类型一并加上这个成员，不要为了去重把类型挪到更低的层（`channel/` 不能依赖 `subagents/`）：

- `src/subagents/discovery.ts` 的 `ALLOWED_HARNESSES`
- `src/subagents/run-record.ts` 的 `RunHarness`
- `src/subagents/external/harness.ts` 的 `id`
- `src/subagents/external/run.ts` 里把 `harness.id` 断言成联合类型的那一处
- `src/channel/store.ts`
- `src/agent/prompt/types.ts`
- `src/tools/subagent-manage.ts` 的 `resumableHarnessOf`

`buildStdinContent` 保持「只有 `claude-code` 单独走任务 stdin」。`cursor-cli` 落在现有的另一支：有正文时是 `正文 + 空行 + --- + 空行 + 任务`，正文为空时只有任务。不要把 prompt 再放进 argv。

### D2. argv

`buildInvocation` 的形状与 claude-code 相同：command 经 `splitShellWords` 得到 `[executable, ...rest]`，占位符仍走 `expandPlaceholders`。返回 `resumable: true`，`presetSessionId` 始终不设置。

在展开后的 `rest` 之后追加：

1. `-p`、`--output-format`、`stream-json`。与 claude-code 一样，这三项是协议参数，command 里已经写了也再追加一次。角色若把 `--output-format` 设成别的值，结算会按本设计解析而失败；在 invocation warning 里说明 runtime 追加的是 `stream-json`。
2. 模型，规则见 D3。
3. `--trust`，仅当 rest 里还没有 `--trust` 或 `--trust=...`。委派的工作目录是这次调用选中的；信任提示在无人值守进程里没有人回答，会一直等到墙钟超时。
4. 续接时追加 `--resume` 和 `resumeSessionId` 两个 token。不要用裸 `--resume`，那会打开交互选择器。

不追加位置参数形式的 prompt。stdin 仍由 `external/run.ts` 在 spawn 后写入；`prompt.txt` 仍只记录任务正文，这是现有产物布局。

### D3. 模型与推理档

是否追加模型与是否装饰模型分开判断：`model` 有值、command 尚未自带 `--model` / `-m`、且本次没有使用 `$MODEL` 时，追加 `--model` 和模型字符串；使用 `$EFFORT` 不阻止追加模型。command 已经带了模型 flag 时不改写那个 token。

`thinkingLevel` 未设置时不装饰模型，也不追加任何 effort。这和外部 work 委派「不兜底推理档」的现有规则一致。verify 仍由现有调用方在未声明时填 `medium`，harness 只翻译它收到的值。

有 `thinkingLevel` 时先映射成 effort 词：

| thinkingLevel | effort |
| --- | --- |
| `off`、`minimal`、`low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` |
| `max` | `max` |

表以外的值原样传递。不把 `xhigh` / `max` 再往下夹：CLI 是否接受由模型和账号决定，拒绝时进程失败、stderr 留下原因。

装饰规则只处理模型字符串末尾的一对方括号：

- `gpt-5` + `high` → `gpt-5[effort=high]`
- `name[context=1m,fast=false]` + `high` → `name[context=1m,fast=false,effort=high]`
- 括号内已有 `effort=` 时保留原值，不覆盖，并加一条 invocation warning
- 含 `[` 但不是「单个尾部 `[...]`」时不改写字符串，并加一条 invocation warning

`$EFFORT` 仍由共享占位符替换成上表的词。command 使用了 `$EFFORT` 时，不再自动把 `effort=` 写进模型字符串，避免加两次；需要追加 `--model` 时仍传入原始模型字符串。例如包装脚本的 command 为 `cursor-wrapper --effort $EFFORT`、`model: gpt-5`、`thinkingLevel: high` 时，展开得到 `--effort high`，runtime 仍追加 `--model gpt-5`。

有 `thinkingLevel` 但没有模型字符串、command 也没有模型 flag 时，不发明模型名，只加 invocation warning：CLI 将使用它自己的默认模型。command 已自带 `--model` 且本次推理档因此没有写进去时，同样加 warning，提示把 `effort=` 写进那个模型 id。

warning 沿用 `formatDroppedPlaceholderWarnings` 的通道，进入 run 记录的 `invocationWarnings`，由 `/subagents show` 现有渲染展示。文案用英文，和现有 argv warning 一致。

### D4. 解析

`parseOutcome` 不抛出。逐行 `JSON.parse`，坏行跳过。非空文本里一个 JSON 对象都没有时，`protocolStatus` 为 `unparsable`。

- 任何事件上的字符串 `session_id` 都记下来，后者覆盖前者。同一次执行里它应当不变。
- `type === "result"` 才把 `terminalSeen` 设为 true。`is_error === true`，或 `subtype` 是字符串且不是 `"success"`，则 `protocolStatus` 为 `failed`，否则为 `completed`。单独保存字符串 `result`，作为最终文本的后备。失败时的 `errorMessage` 优先用非空的 `result`，否则用 `cursor-cli reported <subtype>`；即使已有 assistant 文本，也保留这个错误说明。
- 无论有没有 `result`，`finalText` 都优先使用最后一条非空的完整 assistant 文本：`type === "assistant"`，且没有 `timestamp_ms`、没有 `model_call_id`，从 `message.content[]` 里拼接 `type: text`，拼接后 `trim()` 非空才更新候选文本。没有这种文本时才使用字符串 `result`，两者都没有时为空字符串。带 `timestamp_ms` 或 `model_call_id` 的增量行忽略，避免角色自己打开了 `--stream-partial-output` 时把重复片段拼进结果。assistant 文本只决定输出内容，不把 `terminalSeen` 设为 true，也不改变协议状态。
- 没有 `result` 且 `stderrTail` 非空时，把去掉首尾空白的 stderr 放进 `errorMessage`，供结算说明认证失败或信任提示。这仍不是终态事件。
- `usageKnown` 和 `costKnown` 恒为 false。不读 `duration_ms`、`duration_api_ms`、`request_id`。

Cursor 的字符串 `result` 是各轮文本的直接拼接，不保证在消息边界插入换行。例如先输出 `Checking.`，最终回复仅为 `VERDICT: PASS`，`result` 就可能是 `Checking.VERDICT: PASS`。优先取最后一条完整 assistant 消息才能保留 verdict 的行边界；不放宽共享的 `parseVerificationVerdict` 规则，也不通过插入换行来猜测聚合文本中的消息边界。

结算继续走 `classifyExternalOutcome` 的结构化分支，不要把 `cursor-cli` 加进 `exec` 那个例外。因此：有成功 `result` 才算完成；退出码 0 但没有终态事件仍是失败；超时或取消仍先解析已写出的事件，再由现有 `terminationReason` 覆盖状态。`system/init` 已经写出时，这次失败的 run 仍能留下 `sessionId`，随后的 `follow_up` 可用。进程在写出 `system/init` 之前就死了，则没有 session id，现有的 “never reported a session id” 拒绝适用。

### D5. 进度

实现 `toProgressLabel`。只认 `type === "tool_call"` 且 `subtype === "started"`。`completed` 会重复同一次调用，忽略。

从 `tool_call` 对象取标签：

1. 有 `function.name` 字符串时，标签以这个名字开头。`function.arguments` 若是对象，或是能解析成对象的 JSON 字符串，则按下一行的字段顺序补一个主体；解析失败就只有名字。
2. 否则取第一个以 `ToolCall` 结尾的键。标签动词是去掉该后缀后的键名（`readToolCall` → `read`）。主体来自该值的 `args`。
3. 主体字段按这个顺序取第一个字符串：`command`、`path`、`file_path`、`target_file`、`pattern`、`url`、`query`。`command` 只保留第一行。不读取 `fileText`、`content`、`result`。
4. 拼成 `动词 主体`，去掉多余空白，截断到 80 个字符。没有主体时只返回动词。没有可识别的工具时返回 `undefined`。

### D6. 角色 command 的警告

这些警告不拒绝角色，角色照常加载。只在 `harness === "cursor-cli"` 时产生。用 `splitShellWords` 看 token，不要对 command 字符串做子串搜索（避免路径里碰巧含有这些词）。

| 条件 | 警告要说明的事实 |
| --- | --- |
| `mutates: write`，且没有 token `-f`、`--force`、`--yolo` | print 模式不会把修改写进文件 |
| `mutates: read`，且有 token `-f`、`--force` 或 `--yolo` | CLI 可以改文件，workspace 写锁不会拦住它 |
| 有 token `--worktree`、`--worktree=...` 或 `-w` | 实际写入在 `~/.cursor/worktrees/`，不在这次委派的工作目录，写锁覆盖不到 |

`-f`、`--force`、`--yolo` 按同一组权限参数判断。`shell: true` 继续被现有规则拒绝。只读验收的推荐 command 是 `agent --mode ask`，写改动的推荐 command 是 `agent --force`。推荐写进 `docs/sub-agents.md`，不要由 harness 自动追加 `--mode` 或任何一个 force 别名。

### D7. discovery.ts 不能变长

`src/subagents/discovery.ts` 在 `scripts/architecture-baseline.json` 登记为 1040 行，文件当前也是 1040 行。`npm run arch` 不允许它再增长，也不允许把基线上调。

D6 的判断放在新文件 `src/subagents/external/role-warnings.ts`。该文件只依赖 `src/shared/shell-words.ts`，不导入 `discovery.ts`、`harness.ts` 或 `cursor-cli.ts`。`discovery.ts` 若导入 `cursor-cli.ts`，会形成 `discovery → cursor-cli → harness → discovery` 的环。

把 `parseExternalAgent` 里现有的 memory disclosure 与 `$MODEL` 警告拼接移进这个新文件，连同 D6 的警告一起返回一条合并后的 warning。调用点替换这段拼接之后，`discovery.ts` 的行数必须 ≤ 1040。

## 4. 角色文件示例

示例只说明字段，不放进 `examples/sub-agents/`。`model` 用目标账号 `agent models` 列出的 id。

写改动：

```yaml
---
name: cursor-main
description: 用 Cursor CLI 在工作目录里改代码
runtime: external
harness: cursor-cli
command: agent --force
model: gpt-5
thinkingLevel: high
mutates: write
---
```

runtime 实际追加 `-p --output-format stream-json --model gpt-5[effort=high] --trust`。stdin 是角色正文、分隔线和任务。

只读：

```yaml
---
name: cursor-review
description: 用 Cursor CLI 做只读检查
runtime: external
harness: cursor-cli
command: agent --mode ask
model: gpt-5
mutates: read
---
```

认证沿用 CLI 自己的登录或 `CURSOR_API_KEY`。discovery 只检查 `agent` 是否在 `PATH` 上，和另外两种 CLI 一样；不在发现阶段运行 `agent status`。

## 5. 文档

实现同一提交里更新这些现在把 harness 集写成三种的位置：

- `docs/sub-agents.md`：`harness` 取值，以及「组装」表增加一行。cursor-cli 的列是 `--model`（推理档折进模型 id 的 `effort=`）、正文与任务合并后走 stdin、`--resume` 加 `-p --output-format stream-json`，并写明 `--trust` 由 runtime 追加、`--force` 属于 command，`-f` / `--yolo` 与它等价。说明工作区规则会被 CLI 读入，以及 print 模式没有这三个权限参数中的任何一个时不会落盘。
- `docs/architecture.md`：`external/` 文件列表加上 `cursor-cli.ts` 和 `role-warnings.ts`。用量那句加上 cursor-cli 与 exec 一样不报 token 和 cost。
- `docs/deployment-and-operations.md`：结构化 harness 的终态说明把 cursor-cli 算进去。
- `src/playbooks/agent-delegation.md`：`follow_up` 的可续接集合加上 cursor-cli。
- `AGENTS.md`、`CLAUDE.md`：外部 harness 列举加上 cursor-cli。
- `docs/refer/grok-bot-comparison.md`：那一格若仍写「三种」就改成包含 cursor-cli。

不改 Quickstart。用户路径仍是 `docs/sub-agents.md`。

## 6. 测试

新适配器的分支放在新文件 `test/cursor-cli-harness.test.ts`，对照 `test/claude-code-harness.test.ts` 的粒度，只覆盖会独立失败的行为：

- argv 含协议三项和 `--trust`，不含位置 prompt，不含 `presetSessionId`，`resumable` 为 true。
- 续接使用 `--resume` 和给定 id，不生成新 id。
- command 已有 `--trust` 时不追加第二个。
- 模型装饰的四个例子（无括号、追加键、已有 `effort=` 不覆盖、非法括号不改写）以及「command 已有 `--model` 时不改写」。
- 模型参数场景覆盖「command 使用 `$EFFORT` 但没有模型 flag / `$MODEL`」：占位符展开后仍追加 frontmatter 的模型，且不自动装饰 `effort=`；用包装脚本 command 验证，避免把包装脚本的 `--effort` 当作 Cursor 自身参数。
- 未设置 `thinkingLevel` 时参数里没有 `effort=`。`off` 映射为 `low`。
- 有推理档但没有模型时不追加 `--model`，且 warnings 非空。
- 成功 `result`、`is_error` 失败、无终态但有 stderr、只有增量 assistant 行时不把它当最终文本、无 JSON 时 `unparsable`。
- 成功终态场景包含两条完整 assistant 消息（`Checking.`、`VERDICT: PASS`）及聚合的 `result: "Checking.VERDICT: PASS"`：`finalText` 为最后一条消息，经现有 `resolveVerificationVerdict` 得到 `pass`。同时覆盖没有完整 assistant 文本时使用字符串 `result`；无终态场景即使已有完整 assistant 文本，也不能判完成。扩展对应的成功、失败与无终态场景，失败 `result` 的错误说明不能被 assistant 文本覆盖。
- `usageKnown` 与 `costKnown` 都是 false。
- 进度：`readToolCall` 的 path、`writeToolCall` 不带出 `fileText`、`completed` 返回 undefined、超长命令被截断。

D6 在 `test/subagent-phase1.test.ts` 的 discovery 描述里加一个表：write 缺少全部 force 别名、read 带任一 force 别名、带 `--worktree` 各自产生警告；`mutates: write` 搭配 `agent -f`、`agent --force`、`agent --yolo` 时不产生这三类警告。读写警告的参数表都覆盖这三个别名，角色仍然被加载。这是新 harness 的配置误用，现有用例覆盖不到。

`test/tool-subagent-manage.test.ts` 里 follow_up 的 harness 门槛扩展一条：已结束、带 `sessionId` 的 `cursor-cli` run 可以进入续接参数组装；`exec` 仍被拒绝。不要另开一个管理工具测试文件。

`test/e2e/external/subagent-external-smoke.test.ts` 的 `HARNESS_COMMAND` 是 `Record<RunHarness, string>`，类型上必须有 `cursor-cli` 项，command 用 `agent --mode ask`。环境变量过滤加上 `cursor-cli`。该用例现在断言 `usage.total > 0`，对 cursor-cli 不成立：cursor-cli 改为断言 `usageKnown === false`、`sessionId` 非空、状态为 `completed`。未设置 `PIPICLAW_E2E_HARNESS` 时整组仍然跳过，不进入 `npm run test` 或 `npm run check`。

## 7. 实施完成的标准

- `npm run check` 通过。`discovery.ts` 行数不超过 1040，基线文件没有被 `--init` 或手工加例外。
- `npm run test:e2e` 通过，运行现有确定性委派、恢复和结算覆盖；不新增确定性用例不免除这一检查。opt-in 真实 CLI smoke 单独运行，不能替代确定性 e2e。
- 新适配器没有把 prompt、`--force` 或 `--mode` 写进 argv。
- 文档第 5 节的列表都已改到，顶层手册与代码一致。
- 本文件状态改为「已实施」，并补一行实际核对过的 CLI 版本。opt-in smoke 若因本机未登录而没跑，在状态行写明，不把未运行写成协议已核对。

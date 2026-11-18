# Pipiclaw 提示词、按需加载与模型缓存评审

基线 `d85f5fe`，SDK `@earendil-works/pi-coding-agent` / `pi-ai` 1.5.2。复核范围包括聊天、持久任务、一次性 Web API 请求、委派的输入，以及模型供应商接线。证据来自当前代码、离线请求体探针和 11 月 17 日封存的真实模型评测。

## 优先顺序

| 顺序 | 建议 | 收益 | 改动面 |
| --- | --- | --- | --- |
| 1 | 将 Pipiclaw 的会话 ID 接入 SDK，按请求核对缓存和续接 | 多工具链少重传历史，确认真正的缓存收益 | 会话构造、生命周期和现有请求诊断 |
| 2 | 将每轮环境缩为事实，任务摘要优先显示待答问题 | 每个普通回合带入更少信息，用户回答更容易路由到正确任务 | 两个现有渲染器 |
| 3 | 让简单操作直接调用，任务只注入一份短步骤约定 | 减少强制阅读与模型往返，复杂分支仍有可靠操作指南 | 提示词、工具说明、手册和现有 brief |
| 4 | 单独试验少量低频工具的延迟声明 | 冷启动省定义，保留可复用前缀 | 仅在 SDK 实际请求能维持前缀时推进 |

## 1. 缓存优先修接线，再优化内容布局

**确认了会话接线缺口。** Pipiclaw 直接构造 `Agent` 和 `AgentSession`，`Agent` 未获得 `sessionId`。安装版本的 SDK 工厂会传 `sessionManager.getSessionId()`，`Agent` 再把它传给供应商适配器。现有 `ModelRequests` 已保留 `sessionId` 等请求选项，仍由 SDK 每次解析完整认证。用合成认证检查了适配器构造的请求体，无 ID 时省略 `prompt_cache_key`，传入 ID 时写入对应的键。[会话构造](../../src/agent/session/session-host.ts#L622) · [模型请求](../../src/models/requests.ts#L29) · [SDK 工厂](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/sdk.ts)

**本地 WebSocket 探针确认了实际发送差异。** 使用安装的 Codex 适配器、`transport:auto`、同一份系统提示和两轮对话。无 ID 时两轮用了两条连接，第二轮发送 3 项完整输入。有稳定 ID 时两轮复用一条连接，第二轮带 `previous_response_id`，仅发送 1 项新输入。换 ID 后建立独立连接。所有请求均为 `store:false`，探针连接本地模拟服务。这个对照验证了传输机制，服务端计费缓存和时延另需实测。[OpenAI WebSocket 文档](https://developers.openai.com/api/docs/guides/websocket-mode)

- **先沿用 SDK 工厂的会话身份。** 优先聊天和任务 Agent。各会话用自己的 ID，同一会话内保持一致，`/new` 和 fork 随新会话建立；一次性请求不可跨请求复用。用现有 SDK 生命周期释放旧资源。离线检查模型切换、备用模型、认证轮换及退出时的连接归属；Codex 连接池按会话和账号索引，若配置允许同账号切换 Codex 端点，须验证旧地址不会复用。外部 CLI 自己负责缓存，内部 worker 可在有多轮数据后另评。
- **保住逐步追加的前缀。** 稳定部分包括工具顺序和 schema、运行时约定、工作区身份与共同行为、固定目录。cwd 在当前 SDK 最终提示词尾部，频道与任务事实在回合消息里。对 tool loop、普通续聊、无变化 `/reload` 分别查实际序列化请求；按内容判断前缀是否变化。知识按原 `read` 结果追加至历史，复用有效上下文里的那一份。应避免逐轮改写历史、按意图重建顶层工具表、自动将刚读过的手册搬进 system prompt。新事实和明确变更正常追加或刷新，压缩也是正常边界。部分架构注释还写着 SDK 追加日期，1.5.2 这条渲染链只追加 cwd 等静态段，时刻应从运行时消息或宿主获取。[提示构造](../../src/agent/prompt/sections.ts#L280) · [回合拼接](../../src/agent/turn/turn-prompt.ts#L28) · [SDK 提示渲染](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/system-prompt.ts) · [保持 OpenAI 前缀稳定](https://developers.openai.com/api/docs/guides/keep-prefix-unchanged)
- **连接续接、缓存折扣、上下文体积单独测。** WebSocket 续接降低重传和请求开销，历史仍占模型上下文且按供应商规则计费。OpenAI 公共 Responses 在支持的模型上已有缓存断点、不同保留期和缓存诊断；本仓库所测 `openai-codex` 是不同适配器，不能推定这些公共 API 字段可用。Claude 的缓存依赖工具、system、消息的顺序以及断点，Gemini 当前接线可先观察隐式缓存。先用 SDK 默认策略。只有测到跨较长空闲窗口的稳定复用，且读写费和延迟确有改善，再对具体端点试延长 TTL。个人助手对话零散，后台预热会额外请求和记账，优先测正常工作流。[OpenAI 缓存及计费](https://developers.openai.com/api/docs/guides/prompt-caching) · [OpenAI 对话状态](https://developers.openai.com/api/docs/guides/conversation-state) · [Claude 缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [Gemini 缓存](https://ai.google.dev/gemini-api/docs/caching)

**已有命中，样本的复用仍不稳定。** 对 11 月 17 日五个 run 的 10 个场景汇总封存 `trace.jsonl`，并与 `agent-usage.json` 的 `turn` 条目逐场景核对。聊天与任务共 71 次模型请求，8 次报告了缓存读取，命中 token 为 54,656 / 549,534（9.95%），4 个场景没有缓存读取。排除反思等 sidecar 与外部 CLI 运行。`E-schedule-01` 的第二次请求命中 6,144 token，紧接着的第三次请求报告 0。这批数据缺少服务端命中诊断或传输方式，无从将波动全归因于缺少 ID。它是评测样本，无法代表日常工作分布或线上账单。[上一轮评测记录与 run id](2026-11-17-prompt-playbook-implementation.md#真实模型验证及限制)

## 2. 普通回合少带重复信息，保留能改变决策的事实

**先瘦回合环境块。** 保留 workspace、desk 名与状态目录、实际 cwd、频道地址和显示名。把身份、目录归属、优先使用专用工具这几项说明交给现有常驻提示或导航。合成的自定义 cwd 场景，用 `countPromptUnits` 度量从 88 到 27 单位。这个收益随每次普通回合追加，旧消息保持原样供缓存复用。保留原始斜杠命令识别，也单独检查 `/skill:…` 和导入 Web API 上下文的既有分支。路径正确比少一行重要，尤其要覆盖实际 cwd 与工位目录不同的情况。[环境块](../../src/agent/turn/turn-context.ts#L27) · [回合入口](../../src/agent/channel-runner.ts#L317) · [现有上下文 e2e](../../test/e2e/deterministic/system-prompt.test.ts)

**任务摘要优先解决「这条回答该转给谁」。** 当前摘要在每个普通回合枚举在办任务，包含步骤数和费用；显示顺序来自任务列表，运行中的任务排在待用户回答的任务之前。多条运行记录可能先用完展示预算，待答的问题只剩截断指针。建议对摘要单独排：先同频道待答，其次可关联的在办任务，其他只给短 ID 或数量；完整的成本、看板和历史由 `task_list` / `task_log` 提供。保留其他频道的投递归属及查询入口，状态断言取最新工具结果；若当前消息缺摘要，历史里的旧任务状态也只能当参考。渲染复用现有任务记录，使用当前频道和真实待答状态即可。[任务摘要](../../src/agent/turn/task-digest.ts#L51) · [任务领域排序](../../src/tasks/contract.ts#L390)

**记忆优先保证首轮可用，再谈削减。** 现有首轮预算是工作区背景 500、工位索引目标 1,400、当天日记尾部 400 单位。用户事实和反馈有优先级，仅剩优先条目时索引仍可能超目标。个性化来自可执行的用户偏好、纠正和项目背景。先量哪部分实际偏大、在哪些任务中被用到，再考虑少带普通日记和陈旧项目说明。保留明确要求的偏好和 source/scope，详细内容继续走 `memory_search`。另有一个需补机制测试的时序：聊天先组装回合，再执行发送前压缩；任务也先按先前投影选择 full/delta。若此后采用的压缩恰好移除了 bootstrap 或契约，本次已组装的消息可能仍缺原文。测试控制压缩在发送前采用，检查供应商本次收到的内容；确认后在同一投影边界重判当前记忆与契约是否存在。这个时序风险来自代码检查，尚未做动态复现。[记忆预算](../../src/memory/index-budget.ts#L14) · [回合组装与压缩](../../src/agent/channel-runner.ts#L324) · [压缩采用点](../../src/agent/session/compaction.ts#L69) · [任务 brief 选择](../../src/runtime/task-step.ts#L173)

## 3. 改进模型的下一步决策，减少为读指南而读指南

上一轮把 7 份指南改成 16 份，常用路径收敛明显。重新运行 `npm run playbooks:measure`，常用聊天的任务管理、一次提醒、普通委派分别为 673、590、1,014 单位，任务执行和普通委派组合为 2,336 单位。上一轮同口径的聊天工具为 2,750、系统提示为 608、目录为 237 单位，目录占系统提示的约 39%，在两项固定输入合计中约 7%。这些都是长度度量。优先改能省掉一次模型请求、避免一次错误尝试，或让 agent 更早知道如何验收的地方。[上一轮基线](2026-11-17-prompt-playbook-implementation.md#离线体积) · [Anthropic 的上下文组织](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) · [OpenAI 关于精简工作指令与渐进加载](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)

| 位置 | 建议改法 | 应保留的判断 |
| --- | --- | --- |
| 常驻执行约定与导航 | 将「非平凡」改为可判断的读点，例如涉及跨回合状态、复杂副作用、恢复或不熟悉的机制。普通代码读写、发起单条确切提醒、处理明确记住/忘记请求，可以直接依工具合同完成。 | 目标、可核实的完成证据、遇到实际阻塞才问、已证实结果和未验证项分别表达。 |
| 事件 | 先试最短的一次提醒，字段足够就可直接创建。涉及周期、整体更新、条件门控或任务模板时再读相关指南。模型 schema 去掉运行时必拒的 `immediate`，并统一告知 `timeoutMs`。 | `at` 的时间偏移和可用范围、成功再确认、更新先 `show` 且保留投递目标。保留现有参数校验和磁盘约定。 |
| 任务 | 先试把短执行约定集中在现有任务侧 system 段或 brief 一处。涵盖继续工作、已派发就等唤醒、向用户提问、当步交付后关闭、未知副作用先核对。把多工作项、独立验收、外部交付和恢复的具体做法留给按需指南。 | 契约和状态继续由运行时提供，验收读产物和对应版本。任务首次运行及压缩续接都有短约定；原有授权、交付重试和输入收据保持原语义。 |
| 委派 | 目录负责「谁适合做」，手册负责「复杂任务怎么交接、检查和恢复」。常见已知角色可直接用自足的 handoff，涉及 worktree、核验人或异常恢复才追加手册。保留可用性、输入支持、读写边界和手头只读证据。 | `subagent_list` 列的是运行记录，无法当配置角色发现入口。仍需让可用角色名及用途可见；目录溢出时给真实可执行的查询路径，勿用虚构的发现入口。 |
| 工作区与技能 | `SOUL.md` 放身份和表达，`AGENTS.md` 放用户偏好的工作纪律与边界；低频流程进已有 skills。对少见、容易混淆的指南写清触发词和优先入口，保留真实、可运行的高价值示例。 | Pipiclaw 对内部操作的规则仍从自己的只读手册取得。软件产品本身不自动搬移用户规则或裁掉核心偏好。 |

实跑轨迹可作为候选对照。`E-schedule-01` 是读一次事件指南 → 创建 → 确认，`A-route-01` 是读委派指南 → 调用配置角色 → 回复，均有三次模型请求。`C-fix-01` 读了一次 `runtime-orientation.md`，`U-desk-cwd-01` 没读运行时指南也能用现有上下文定位。后者原始验收通过、归档回放有已知路径差异。事实表明有验证短路径的空间，不能从轨迹判定删掉一次读取就会达到相同结果。[工具字段](../../src/tools/event-manage.ts#L16) · [任务步骤约定](../../src/tasks/brief.ts#L201) · [委派运行列表](../../src/tools/subagent-manage.ts#L130) · [上一轮评测限制](2026-11-17-prompt-playbook-implementation.md#真实模型验证及限制)

**扁平组织保留，整改单个分支的入口。** 模型应能按「读到足够信息就执行」工作。普通指南开头给决策、动作和验收，低频指南有独立触发词；从目录直接到 inline、恢复或传感器时，应给当下需要的参数和下一步。`delegation-inline.md` 目前还有若干「与普通委派相同」的调用要求，可将影响这一次工作的必要信息就地说清。为发布者校验角色和工具门控、链接、合法示例和目录预算即可。已有 `read`、相对链接与 profile 门控适合这个体量。全站语义检索、模型分类器或持久化「读过」标记会引入额外状态和失效规则，16 份指南无需这层机制。[目录与门控](../../src/playbooks/catalog.ts#L115) · [inline 指南](../../src/playbooks/delegation-inline.md#L10) · [现有手册验证](../../test/playbooks.test.ts) · [Agent Skills 的渐进加载](https://www.anthropic.com/research/equipping-agents-for-the-real-world-with-agent-skills)

## 4. 延迟工具声明单独做可退出的试验

当前 `event_manage` 和 `subagent_inline` 合计 548 单位，约占聊天工具定义的 20%，这个数字还没有减去发现入口或额外调用的成本。先了解它们在常规回合的实际频率，并用现有 inline 开关提供对照。若值得试，优先验证当前端点和 SDK 生成的负载能否将发现结果作为历史增量追加；官方 OpenAI 和 Claude 的原生 tool search 都设计为追加到上下文后部，这是与缓存协同的前提。Pipiclaw 目前热重建会将 `currentTools` 全部设为活动工具；不能把 SDK 提供某 API 等同于 Pipiclaw 当前会话恰好走那种请求形状。分别测第一个冷请求、发现请求、发现后的暖请求、`/reload`、压缩、恢复和模型切换。普通提醒频繁时保留事件直接调用，首个候选可以只试 `subagent_inline`。备用模型和不同 profile 仍须按已有工具权限和状态规则工作。[当前工具重建](../../src/agent/session/session-host.ts#L681) · [OpenAI Tool Search](https://developers.openai.com/api/docs/guides/tools-tool-search) · [Claude 工具与缓存](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)

## 验证与取舍

1. **先做离线机制验证。** 扩展既有 provider 请求用例，检查同会话的身份与前缀、无修改重载、`/new`、备用模型、压缩续接、SDK 回退到全量输入和应用生命周期。摘要验证覆盖多个运行任务和一个待答问题，及跨频道投递归属。日志只记 profile、模型、计数、传输方式、工具与前缀摘要、耗时和压缩边界，复用现有请求 trace，避免记录请求正文。使用仓库要求的 typecheck、unit 和确定性 e2e。
2. **按改动类型分别比较。** A 为 `d85f5fe`，B 仅补缓存接线，C 在 B 上分别试验薄上下文和短路径。复用 C-fix、E-schedule、A-route、T-ask、T-horizon、M-overflow、U-desk-cwd；仍以实际行为和产物为质量标准。用相同模型、thinking、输入和权限交错运行。冷启动、连贯多轮和空闲后续聊分别报告，场景重复次数和上次已知评分问题也单列。运行付费评测前通过正负及等价控制，旧失败和任何新 assessment 分开保留。
3. **达标以任务结果和端到端花费判定。** 同时报逻辑输入总量（未缓存输入 + 缓存读 + 缓存写）、缓存读占比、写入成本、首 token 时间、最终交付耗时、模型请求数和首次有效操作是否成功。若能观察到传输增量，再报增量比例或请求字节。以实际工作分布或明确的场景权重算平均；小样本适合筛方向。明确要求的记忆、任务答复、事件投递和委派权限是行为回归重点。减少一次 `read` 若伴随更多参数重试或漏验收，就保留手册触发；延迟加载若破坏暖前缀或增加常用路径耗时，就保留直接工具。

初次评审复用了既有真实模型输出，另行运行离线请求体与本地 WebSocket 探针、手册体积测量和架构检查。以下记录后续实现。

## 前两项实施与验证

SDK 会话 ID 已接入 Pipiclaw 的会话构造。稳定会话内，Codex 有条件复用连接和发送增量。模型、实际端点或已解析鉴权头变化时清理旧连接。普通回合只提供必要环境事实；任务摘要优先本频道待答问题，其他频道显示任务 ID 和投递目标。发送前采用压缩后，按需补回记忆和任务契约，再用实际输入重估容量。源契约路径也随 delta 保留，供步骤内恢复。

离线用同一合成输入比较到 `d85f5fe`，环境块由 88 降到 27 单位，三任务摘要由 130 降到 68 单位。单元用例净增 1，覆盖已解析目标或鉴权头变化时错误复用前一请求连接的风险。确定性 e2e 净增 1，覆盖真实任务车道发送前压缩使模型失去当步契约、记忆的风险，且验证输入照常确认。分别去掉会话 ID、契约补回或记忆补回，相关断言均实际失败。用例以封存与供应商收到的输入为证据。

以下为本机配置 `openai-codex/gpt-5.6-luna`、medium 的单次行为抽查，judge 关闭。各案运行前的正、负与等价控制均通过。评测失败和离线回放差异保留在各 run 的 `cycle.md`、`record.json` 与 trace。

| 场景 | Run ID | 结果 |
| --- | --- | --- |
| `T-ask-01` | `2026-11-18T02-27-47-526Z-lcz30u` | 通过，回放通过。与 11 月 17 日的同案例样本相比，均为 11 次主体请求，缓存读取从 13,696 / 79,604 到 54,912 / 78,798 个输入 token。两次均为独立观测，不能据此估计普遍增益。 |
| `I-inbound-context-01` | `2026-11-18T02-27-47-906Z-v28nax` | 通过，回放通过。引用任务的回复落到正确任务。 |
| `M-overflow-01` | `2026-11-18T02-29-15-034Z-9mvdg1` | 通过，回放通过。索引省略目标后仍能检索事实。 |
| `U-desk-cwd-01` | `2026-11-18T02-28-35-539Z-l94ibm` | 超过模型回合预算。已改对目标仓库配置并成功调用指定校验，随后继续探查，最终回复缺失。离线回放结论与原执行不一致。 |
| `M-compaction-01` | `2026-11-18T02-28-32-011Z-hbar3w` | 超过模型回合预算。压缩已持久化，交接文件满足全部内容断言，后续用不支持的 shell 形状和未安装的 `python` 重验，回合到顶。离线回放结论与原执行不一致。 |

第 3 项的分批改动、建议模型文案和验收条件见 [Playbook 短路径改进方案](2026-11-18-playbook-short-path-plan.md)。

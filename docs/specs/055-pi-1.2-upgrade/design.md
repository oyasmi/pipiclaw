# pi 1.2.0 升级：持久化上下文、会话接入与认证兼容

| 字段 | 值 |
|---|---|
| 状态 | P0–P5 离线实施及双 Node 合并门禁完成；P6 真实发布验收待执行，见 [acceptance.md](./acceptance.md) |
| 日期 | 2026-10-13 |
| 触发 | 将四个 pi 依赖从 0.84.3 升至已发布的 1.2.0，给出可以实施和审查的升级方案 |
| Pipiclaw 基线 | `b61465fbcb576f843a7f136ea6988459331939d2`，`0.9.4-beta.2` |
| 上游基线 | `v0.84.3`（`4e58f324f`）→ `v1.2.0`（`06a466935`）；目标以 npm 发布包为准，不跟随本地 pi HEAD |
| 前置 | 050 记忆、051/052 任务、053 文案、054 单向分层；当前代码和 AGENTS.md 优先 |
| 依据 | [升级评估及原型验证记录](../../reviews/2026-10-13-pi-1.2.0-upgrade-assessment.md) |
| 实施计划 | [plan.md](./plan.md) |
| 范围 | 依赖与锁文件、SDK 会话装配、主会话备用模型重试、OpenAI OAuth 安装 ID、条件配置迁移、兼容验证与发布操作 |

## 摘要与决策

升级可行，但直接替换版本会让主会话第一次请求丢失工具声明，并让备用模型收到重复输入。根因是新版 SessionManager 成为模型上下文的权威来源；初始内存状态和事后裁剪内存消息已经不能表达所需语义。

正式升级以 SDK 接入兼容为目标，保持 Pipiclaw 对任务、委派、记忆、传输和费用结算的所有权。新增 ChatGPT OAuth 接入纳入本次范围，因为新版登录菜单会提供该选项，不能让用户选择一个必然在联网前失败的入口。

| 决策 | 内容 |
|---|---|
| D1 | 四个直接依赖精确锁定 1.2.0，提交锁文件，检查整个依赖图 |
| D2 | 按上游工厂模式初始化 Agent；AgentSession 显式拥有当前工具集合 |
| D3 | 主会话重试以本次尝试的持久化 entry ID 为依据，追加 context_edit，保留原始事实 |
| D4 | 重试服从现有 turn、停止与会话切换所有权；持久化失败隔离当前 SDK 实例 |
| D5 | 区分 raw branch 与模型上下文投影；记忆、恢复、usage 各按原有用途读取 |
| D6 | 收紧类型和修正真实协议夹具，不通过宽类型或弱断言掩盖变化 |
| D7 | 在 Pipiclaw 应用目录持久化稳定 UUID，支持并发首次登录，不读写 `~/.pi` |
| D8 | Azure 部署按字段迁移 provider identity；API 标识和环境变量保持原名 |
| D9 | 用旧 SDK 生成的固定样本验证聊天、压缩、分支和任务会话的前向读取 |
| D10 | 分别设置合并门禁和发布门禁；扩展既有机制测试，只为新增风险增加用例 |
| D11 | 停机取得一致应用快照；回退先判断新版本是否已经产生外部副作用 |

## 1. 问题、证据与目标

### 1.1 已确认的破坏点

| 编号 | 证据 | 本次处理 |
|---|---|---|
| F1 | 直接升级后 Agent 有 23 个工具，第一次 provider 请求没有 tools 字段 | D2；检查实际请求，而非仅检查 Agent 内存 |
| F2 | 只裁剪 agent.state.messages 后，备用模型请求中同一用户输入出现两次 | D3；持久化省略失败尝试后再提交一次 |
| F3 | 直接升级出现三处文件、四条 TypeScript 诊断 | D6；生产消息按 unknown 防御读取，测试跟随新契约 |
| F4 | 新 openai/oauth 调用缺少 getDeviceId，在联网前必然失败 | D7；先建立本安装 UUID，再调用 SDK 登录 |
| F5 | 10 字节伪 JPEG 被新版图片处理拒绝；cwd 变为结构化标记 | D6；改用可解码图片和语义边界断言 |

隔离原型完成了 952 个 unit、55 个 deterministic e2e，以及 typecheck、arch、lint、deadcode 验证。它证实基础接入可修复，没有验证本方案新增的断写保护、并发身份创建、完整旧会话样本和真实 OAuth。实施时不能把原型的绿灯抄为正式发布结果。

### 1.2 预期收益与边界

现有机制直接受益于工具之后的压缩、会话和 fork 修复、thinking 回放修复、供应商流解析及瞬时错误识别、模型能力和费用元数据更新，以及 TUI 渲染和按键修复。reflect 使用的 serializeConversation 不再包含 thinking，减少无用输入；实际 token 变化需测量，不承诺固定节省比例。

本次不接入 MCP、codemode、虚拟模型路由、分类器、图片生成、缓存预热，也不迁移到 pi-durable。不把上游 CLI 配置写入 Pipiclaw settings，不新增产品开关，不扩大 SDK 默认工具和扩展集合。需要这些能力时另立功能 spec，明确工具权限、审计、费用和用户展示。

## 2. 不变量

| 编号 | 约束 |
|---|---|
| INV-1 | 主会话模型上下文来自 SessionManager 投影；内存消息不是持久化修改接口 |
| INV-2 | 每次会话构造后的首个请求声明当前 Pipiclaw 工具集，且不包含未授权的 SDK 默认工具 |
| INV-3 | 备用重试最多一次；只重试没有生成正常答复、没有发出工具调用的本次失败尝试 |
| INV-4 | 原始 user、assistant、toolResult、usage 和恢复证据不因上下文省略被删除 |
| INV-5 | 停止、runner 退役、会话/分支改变后，旧尝试不得追加 context_edit 或提交备用请求 |
| INV-6 | 持久化修改失败后，不能使用同一 SessionManager 内存缓存继续请求；磁盘重建前保持故障隔离 |
| INV-7 | 同一 app home 的 OpenAI OAuth 使用同一个安装 UUID；并发创建不覆盖赢家文件 |
| INV-8 | 登录、模型流和供应商配置使用显式 Pipiclaw 路径，不产生 `~/.pi` 状态 |
| INV-9 | 任务票据、SubAgentRunManager 结算、usage 幂等标记、传输队列和公开导出维持现有所有权 |
| INV-10 | 新旧运行时不同时写同一应用目录；上线结果与回退结果分别验证 |

## 3. 接入设计

### D1：依赖与锁文件

`package.json` 中 pi-agent-core、pi-ai、pi-coding-agent、pi-tui 均使用精确字符串 `1.2.0`，不用范围版本。通过 npm 正常解析并提交 `package-lock.json`；不手工拼接 resolved/integrity。干净检出执行 npm ci 后，用 npm ls 核对四个包及 coding-agent 的核心引用，没有 0.84.3 残留、invalid 或重复的核心版本。

上游移除 shrinkwrap 后可能出现较大的锁文件变化。审查新增 pi-mcp/pi-codemode 及它们的依赖，但这些传递依赖不代表开启相应功能。避免同时更新无关直接依赖，不修改 Node `>=22.19.0` 支持承诺；最低支持版本和常用部署版本均需验证。Pipiclaw 发布版本号在发布阶段按仓库流程设置，并同步 lock 顶层包版本。

### D2：会话构造与工具所有权

唯一装配点保持为 `src/agent/session/session-host.ts:createSessionRuntime()`。复用当前 resource loader、提示扩展、streamFn、认证来源和工具注册流程，按 1.2.0 官方 SDK 工厂初始化：

1. 从当前 SessionManager 构建已有上下文。
2. Agent 初始 `systemPrompt` 为空，`tools` 为空，`messages` 使用已有 session 的模型上下文；model/thinking 继续按 Pipiclaw 的现有选择规则初始化。
3. AgentSession 收到 Pipiclaw 的 `baseToolsOverride`，并显式传入当前注册工具的 `initialActiveToolNames`。任务会话含专属工具，普通聊天不含它们。
4. 由 AgentSession 生成并持久化提示/工具上下文更新。运行前保证 Agent 视图与 session 投影同步；不以预置内存 system 消息代替这一过程。

正式实现优先采用这一模式，而不是依赖“初始 full tools，再 refreshContext”的原型补救。是否需要构造结束时显式 refreshContext，以真实发布包行为和首次请求断言判断，不能生成两份 system/tool 声明。

同一装配点覆盖进程启动、`/new`、已有会话恢复、fork/切换、聊天与任务会话绑定。资源重载继续使用现有 session resource gate，更新当前工具实例和活动名称，下一次 provider 请求反映新集合。保留已经隔离在 session-adapter 中的 `_baseToolsOverride` 私有接入；不增加新私有字段依赖。通过重载后的实际请求检查它仍有效。

### D3：备用重试的持久化语义

`src/models/fallback.ts` 保留错误分类、单次备用选择、五分钟冷却等策略。SDK entry/projection 操作归 `src/agent/session/session-adapter.ts`，turn 与输入封装归 `src/agent/turn/turn-pipeline.ts`。models 不 import agent，SDK 类型也不穿过这一边界。

主会话移除 FallbackRunDeps 的 getMessages/setMessages/promptWasSubmitted 裁剪接口，改为注入一次尝试的重试能力。建议接口如下，命名可在实现时按周边风格调整，语义必须保持：

```ts
export interface FallbackRetryPlan {
  kind: "unsubmitted" | "failed-turn";
  // 校验、持久化修改和重新提交共享一次现有 runPrompt 资源保护窗口。
  // onReady 同步清理错误/标记冷却/排队通知；仅在确定可以提交时调用。
  run(text: string, onReady: () => void): Promise<"attempted" | "stale">;
}

export interface FallbackRunDeps {
  // 此处仅展示替代数组裁剪的接口，其余模型选择与错误读取接口保留。
  prepareRetry(): FallbackRetryPlan | null;
  canRetry(): boolean;
}
```

plan 捕获当前尝试，而不是持有一个“可以修改任意 session”的回调。第一次 session.prompt 之前，在 host.runPrompt 的保护窗口内捕获 session 实例、SessionManager 实例、session ID、branch leaf ID 和当前 TurnHandle。备用 prompt 不覆盖这份起点。不能用 prompt 返回后才设为 true 的布尔值判断是否已经持久化用户消息：SDK 抛错可能发生在用户消息落盘之后。

尝试结束后，结合原始分支增量和投影分类：

| 类别 | 必要条件 | 操作 |
|---|---|---|
| unsubmitted | 起点后没有本次用户消息，没有 assistant/toolResult 或其他模型交互；会话及 turn 仍有效 | 不裁剪，直接提交到备用模型 |
| failed-turn | 恰好一个本次用户输入；所有 assistant 都是失败尝试；没有正常答复、toolCall 或 toolResult；当前投影能定位本次 user 与终末 assistant(error) 的 sourceEntry.id | 省略本次 user 和仍可见的失败 assistant entry，再提交一次 |
| unsafe/stale | 工具、多次用户输入、正常答复、未知语义增量、分支/会话/turn 改变，或无法定位起点和 entry | 返回 null/stale，保留原错误，跳过备用重试 |

raw 校验不能被投影校验代替：一次工具调用可能已经被 context_edit 隐藏，仍有副作用。允许已识别的 SDK 重试错误省略记录、提示更新和 metadata；未知 custom message、压缩或分支结构变化默认拒绝重试。以 entry ID 定位，不能靠数组对象同一性、数组长度或与输入文本相等判断；新旧尝试可能有同样的文字。

准备 plan 时固定失败分支的完整 entry ID 前缀；之后回退到本次输入之前也判为 stale，不能重新解释成 unsubmitted。获得 plan 后异步解析备用模型和认证，再切换模型并重新准备该模型支持的图片。每个 await 后检查 canRetry。setModel 失败时不省略任何消息。model/thinking metadata 的合法更新不使同一尝试失效，但其他用户消息或新工具活动必须使其失效。

plan.run 在一次 host.runPrompt 内重新校验捕获的实例、branch、turn 和增量，再同步执行：

1. 对本次 user 追加 `appendContextEdit(userEntryId, null)`。
2. 对仍可见的失败 assistant entry 追加相同省略记录。已省略的 entry 不重复写。
3. 全部成功后调用 `session.refreshContext()`。
4. 再检查停止状态，同步调用 onReady，直接调用 SDK prompt；省略完成与 prompt 调用之间不插入异步通知或资源重载。

再次提交沿用 pipeline 当前的输入封装和经备用模型处理后的图片。只有 onReady 才重置原错误状态、开始主模型冷却、发送切换通知。stale 不发“已切换并重试”的通知。若切换模型已成功后收到停止，保留已发生的 model change，停止当前尝试；不额外切回主模型制造第二次异步竞态。

SDK 自身可能有错误重试 context_edit。计划只处理本次范围内的、仍贡献上下文的失败消息，重复执行同一个有效计划应幂等；任何无法解释的记录宁可跳过。使用 branch-local context_edit，不重写 JSONL，不 navigateTree，不删除旧错误、费用和原消息。

内部子代理使用裸 Agent，没有 AgentSession 的 canonical projection。`src/subagents/internal/provider-retry.ts` 的内存裁剪保持原有语义，不能一起替换成 session context_edit。takeFailedTurn 若仍被裸 Agent 使用就保留；如果不再有调用则移除，避免新增兼容空壳。

### D4：停止、资源重载与持久化故障

canRetry 派生自当前 TurnHandle 身份、stopRequested、runner 退役状态和 host 当前绑定；不给 fallback 新建 busy 状态或取消控制器。pipeline 的闭包只读现有所有者，由 runner 注入必要状态，避免把私有 retired 字段扩成公共可写属性。

SessionResourceGate 防止 prompt 与资源重载交错，现有频道队列负责 turn 串行。它不是一般互斥锁，不能用它代替 TurnHandle 校验；资源等待结束后仍须在回调内检查实例和停止状态。plan.run 直接使用底层 session.prompt，不嵌套调用同一高层 prompt 包装，不覆盖第一次尝试的捕获状态。`/steer`、`/followup` 若产生额外用户输入，当前 plan 失效。

两个 appendContextEdit 是两次写入，SDK 没有提供事务。本方案不声称它们原子提交，也不增加第二份 durable retry 日志。顺序先省略 user，防止在只写入一条的情况下把同一输入再追加一遍；但是出现部分写入时仍必须停止，不能把这个顺序当成继续请求的许可。

任意追加、refresh 或持久化步骤抛错时：

- 不调用备用 provider，不清空原错误，不发成功切换通知，不把内存视图当成落盘成功。
- 将当前 SDK runtime 实例标记为上下文故障，走现有 plain Error 用户错误路径，提示检查存储后重新开启会话；日志记录固定英文 message、channel/session、阶段和 reason，不包含完整用户输入或认证数据。
- host 后续 runPrompt 在保护窗口内拒绝使用同一故障实例；runner 在模型恢复之前也检查故障，避免写出以未落盘 entry 为父节点的 metadata。resource refresh 失败并继续保留旧 session 时，这个拒绝状态仍在；单纯 refreshContext 不得解除它。
- 只有从磁盘重新创建 SessionManager/AgentSession，或成功创建新的会话 runtime 后才能解除该实例的隔离。`/new` 和只读命令保持可用；原始 JSONL 保留供检查。

原因：SessionManager._appendEntry 会先更新内存索引/leaf，再进行写入。写入失败后的同一实例可能含有磁盘不存在的 edit，重新计算内存 projection 不能证明恢复成功。

正常进程重启从磁盘读取已经成功落盘的部分编辑，不自动补交备用请求。原始消息仍在，可经 session_search 找到；下一条用户输入按实际已持久化投影处理。此处不保证文件系统掉电事务或任意损坏 JSONL 的自动修复，也不承诺主聊天 prompt 的 exactly-once 重放；任务恢复继续服从既有协议。

### D5：消息用途、记忆与恢复

| 消费者 | 读取来源 | 升级后的规则 |
|---|---|---|
| provider、上下文预览、压缩 | SessionManager 投影 | 已省略错误尝试不再送模型；system 内容和工具声明由 SDK 管理 |
| 记忆 bootstrap 是否仍可见 | SessionManager 投影 | 省略失败输入后，重建必须重新注入已不可见的 bootstrap |
| turn recovery、工具副作用判断 | raw branch | 工具调用/结果即使已被省略也不能当作没发生 |
| reflect/source window、session_search | 现有 raw 消息与冷存储 | 不因 context_edit 删除历史事实；非 message entry 不当作用户对白 |
| usage ledger、任务预算 | 现有 usage 事件和幂等记录 | 失败请求费用不抹除，备用请求按已有路径计入一次 |

`src/memory/transcript.ts` 继续筛选标准消息与隐藏输入包装、执行秘密过滤；新 system/context_edit 元数据不泄露到工作日记。source window 的游标跨 metadata 仍应推进，避免长期重复消费。serializeConversation 的 thinking 变化用既有 reflect 场景检查，不新增用于验证第三方常量的用例。

压缩摘要可能代表多条历史消息，不能按“一条 projection 对应一条 raw message”假设处理。回放与 cursor 必须使用 SDK 和现有逻辑的真实 entry 关系。任务绑定、外部运行恢复、lease 和结算标记不作格式迁移。

### D6：类型、协议与提示

session-host 的嵌套消息检查先将持久化 message 视为 unknown，再做 role/content 运行时检查，保留对损坏数据的防御。AfterToolCallContext 测试移除旧 systemPrompt 字段；ToolCall.arguments 使用 SDK 的 JsonObject/对应内容类型。不增加 as any 或普遍放宽 JSON 契约。

入站图片用有效、微小、可离线解码的 PNG 夹具替换伪 JPEG，继续断言实际 request 包含图片和媒体传输行为。提示测试按新版 `<cwd>` 定位工作目录，保留频道隔离、Pipiclaw 提示所有权、runtime boundary 在最后的结构断言。图片被拒绝时继续使用原有中文可操作反馈。

复核 before_agent_start 的 user/custom-run 分支、SDK 启动 busy 边界和压缩/取消事件；Pipiclaw 的 busy 仍以自身状态机为准。新增 SDK 生命周期事件不能绕过任务静默规则或把模型侧文本送到钉钉。TUI 使用 ProcessTerminal，不为未使用的 Terminal 接口新增空实现。

### D7：OpenAI OAuth 安装身份

身份归 models 域，新文件拟为 `src/models/login-identity.ts`，只依赖 Node 内置能力和下层模块。调用方通过 loginProvider 的 context 显式传入 `appHomeDir`，CLI 从已解析的路径传入；不得重新读取全局 home、切换 cwd 或使用 SDK 默认 pi 目录。

唯一持久化位置与格式：

```text
<appHomeDir>/state/auth/identity.json
```

```json
{
  "version": 1,
  "installationId": "由 crypto.randomUUID() 生成的 UUID v4"
}
```

仅在选择 `providerId=openai` 且 `authType=oauth` 时读取/创建。status、logout、API key、其他 OAuth provider 和普通 daemon 启动不创建这个文件。先异步得到 UUID，再向 SDK 的第四个 LoginOptions 传入同步 `getDeviceId: () => installationId` 和 `agentName: "pipiclaw"`，interaction 的 prompt/notify/signal 保持原流程。

首次创建使用不可覆盖的发布协议：

1. 有最终文件时，读取并校验 schema、版本和 UUID；损坏、不支持版本或不可访问时给出英文运维错误和该路径的处理指引，不自动重置身份。
2. 最终文件不存在时，在同目录创建随机独占临时文件，完整写入并 fsync、关闭。新建身份目录 mode 0700、新文件 mode 0600；不改既有 app home 目录权限。
3. 以 hard link 把完整临时文件发布到 identity.json，避免覆盖。EEXIST 表示另一进程先完成，读取并使用赢家 UUID；不能使用自己的候选值登录。
4. 成功后同步目录并清理自身临时文件。失败时只清理自身临时文件，保留已经发布的最终文件；文件系统不支持这一协议则明确报错，不降级到覆盖式 rename。

现有 writeFileAtomically 用 rename 覆盖目标，适用于普通配置更新，不能直接实现此处的“首次创建且永不覆盖”。不要修改其公共语义，也不要新增泛用文件事务框架。

登录开始、创建/发布前后及调用 SDK 前检查 AbortSignal。取消后不开始 OAuth；若身份已经成功发布，保留它供下一次登录复用。OAuth 取消后不得新增 credential，沿用 SDK 登录的取消处理并通过真实 smoke 复核。孤立临时文件不被当作身份，不引入启动扫描清理服务。

已存在身份文件需要可读、有效；新建权限必须符合上面要求，部署检查记录现存文件权限，不静默 chmod/重置管理员文件。UUID 不写日志或状态报告，不上传到额外服务，只交给 SDK 既定认证流程。它属于本安装状态，不是 settings 键，也不混入 auth.json 的 provider credential map。

原安装迁移机器时保留该文件；独立新安装/独立 smoke home 生成自己的 UUID，不能复制生产 credentials 和身份去模拟另一台并行运行的安装。

### D8：供应商与 Azure 条件迁移

保持当前 compat streamSimple 和 API key 获取路径，不借机全面重构模型流。新 OAuth 必须实际验证登录、凭证持久化、重启取证、流式请求、工具调用和取消；“可登录”不能代替“模型可用”。若目标 provider smoke 暴露 headers/baseUrl 未接线的问题，只补充本次所用 provider 必需的认证传递，并更新实施记录和覆盖；完整虚拟路由/新 provider 接入另行设计。

仅原内置 Azure provider 的身份从 `azure-openai-responses` 改为 `azure`，发布前由部署者在备份后按字段检查：

| 文件/字段 | 操作 |
|---|---|
| auth.json provider key | 原内置身份的 credential 移到 azure；已有 azure 时人工判断，不能覆盖 |
| models.json.providers 的 key | 确认原内置/自定义语义，按需要调整为 azure |
| settings.defaultProvider、fallbackModel、subAgentModel 等模型引用 | provider 部分改为 azure，保留具体 model id |
| workspace/sub-agents 的 model 引用 | 检查默认、角色覆盖和备用选择使用的新身份 |
| 历史 session 的 model_change | 原样保留，用恢复样本验证；当前配置选择可用 azure 模型 |

API 标识 `azure-openai-responses` 和 `AZURE_OPENAI_*` 环境变量保持原名。自定义 provider 可以有同名历史 key，不能全局替换字符串，也不做运行时永久别名。无 Azure 配置的部署不需要数据迁移。

在使用 Azure 的部署，把恢复后实际所选 provider/model 与预期配置对比，不能接受“悄悄选了列表第一项”的验证结果。若历史身份导致既有选择规则无法恢复目标模型，发布前补充最小、显式的恢复处理，并更新本 spec；不能通过手改全部 JSONL 解决。

## 4. 兼容与验证

### D9：历史数据样本

在隔离环境用精确 0.84.3 生成无敏感信息、确定内容的 JSONL 小样本，作为固定 fixture 提交。测试运行时不安装旧包、不联网。记录生成版本和预期语义，文件目录拟为 `test/fixtures/pi-0.84.3/`。

| 样本 | 必须证明 |
|---|---|
| 普通聊天，含 thinking/model change | 1.2.0 重开后 session identity、对白、thinking 与目标模型选择保持 |
| 长历史压缩及分支/fork | 当前 branch、摘要、压缩边界正确；首次新请求有正确历史及工具声明 |
| 任务独立 session，含任务工具与 toolResult | 绑定仍使用任务 session，不污染聊天；任务恢复不会重复已执行工具或结算 |
| 中断的失败尝试 | 保留 raw 证据，正确处理已落盘的上下文省略；不自动补交无主的备用请求 |

检查不只调用 SessionManager.open：至少通过真实 host/runtime 消费聊天及任务样本，断言 provider 请求、session 路径/父子关系、磁盘和结算次数。原有恢复、memory、task 用例承担这些链路，扩展其输入，不把每个 SDK getter 变成一个新测试。

0.84.3 与 1.2.0 的样本 header 都是 v3，只证明格式可读取。新 system/context_edit 语义和工具声明可能无法被旧 SDK 等价回放；不能从 header 相同推断降级安全。

### D10：门禁与测试预算

合并门禁在无真实账号、无网络、无 API 费用条件下执行：npm ci/依赖图、npm run check、npm run test:e2e、npm run eval:typecheck、npm run build。build 后检查可执行入口和 Markdown assets。check 已含 lint/typecheck/arch/deadcode/unit，不重复跑全套来充当额外证据。最低 Node 和常用部署 Node 各按需要验收。

deterministic e2e 必须覆盖以下实际机制：

- 主请求、`/new`、资源重载、旧会话、任务绑定均有正确工具声明；真实工具结果进入下一次请求。
- 主模型失败后，备用 request 中本次用户输入只出现一次，旧有效历史保留；原错误与费用仍在 raw 数据里。重启后新请求仍反映省略结果。
- 在备用认证解析等待期间 `/stop`，释放等待后备用 provider 请求数为 0；旧 turn 不能修改后续会话。
- context_edit 部分写入失败后，本次没有备用请求，下一次不能使用故障实例；成功重建后才恢复。
- 旧任务 session、等待条件、委派结算、memory cursor 与投递顺序继续符合现有协议。

优先扩展现有 fallback A22、stop A5、restart A12、system-prompt、inbound-media、memory、任务和并发场景。A22 以 request body、disk entry、delivery 次数和顺序为主，去除仅验证模型答复措辞的断言。provider 使用 hold/arrived/release；凭证等待用显式 promise barrier，不 sleep/poll。需要测试引导前播种旧 session 时，可给现有 runtime harness 增加 seed callback，不再造一套启动壳。

新增用例预算针对两个此前不存在的领域风险，不是覆盖率目标：

| 新风险 | 为什么现有测试不能证明 | 计划净增 |
|---|---|---|
| SDK 重试计划识别隐藏工具副作用、按 ID 幂等修改/重开、断写后禁止缓存继续请求 | 原 model-fallback 使用数组 fake，不能证明持久化投影和 SDK 索引故障 | unit +3 |
| 安装身份并发首次创建、损坏拒绝重置、发布失败不开始认证、取消不开始认证 | 现有 auth-path 仅验证 credential 路径，没有安装身份与跨进程争用 | unit +4 |
| 部分 edit 失败后的 host 故障隔离和成功重建 | adapter unit 无法证明 host 后续 turn 与资源 refresh 的接线 | deterministic e2e +1 |

按当前基线预计 unit 952→959、deterministic e2e 55→56；其它既有功能净增 0。上述是实施预算，最终报告实际数量和场景；若已有场景可以证明新增风险，应减少新增；若发现新的独立风险，先说明缺口再调整，不能合并无关故障来凑数量。身份争用使用独立 Node 进程和明确 barrier，不把同进程 Promise.all 当作跨进程证据。

每个新增 deterministic 用例注明错误实现和 mutation check。至少实际注入三类故障确认目标断言变红：恢复原内存裁剪、漏掉初始工具装配、移除持久化故障隔离。取消用例另以移除停止校验验证。记录目标、红灯断言、恢复后的结果；不能仅声称“理论上会失败”。不加超时、不跳用例、不弱化安全守卫。完整 e2e 单独执行，排除不必要的并行机器负载。

发布门禁另外包括真实部署 provider 的受控 smoke：现用 Anthropic/OpenAI API key/OpenRouter/自定义代理，Azure 或 legacy OAuth 在实际使用时验证；新增 openai/oauth 必须完成真实账号验收。核对显式目标模型、认证落盘路径、重启读取、流、工具、取消和 usage。缺少账号时明确记录待验收，不能把 mock 绿灯替代真实认证结果，也不能宣称新 OAuth 可用。

钉钉 AI Card 与 TUI 各做一次受控工具/停止/最终答复 smoke；任务静默和报告规则复核。调用使用独立测试 home/工作区，费用按实际记录。evals 行为质量不是本次合并门禁；eval:typecheck 只验证类型，不运行真实模型评估。

## 5. 发布、迁移与回退（D11）

### 5.1 发布前

1. 明确发布包/commit、四个实际依赖版本和待迁移字段；完成合并门禁和真实供应商验收。
2. 暂停新入站和事件/任务驱动，等待现有 turn、后台反思、任务工作、jobs、外部委派和结算/投递排空，记录未完成工作。`/stop` 不取消已派发外部运行，不能据此判断已排空。
3. 正常关闭 daemon/TUI，等待持久化维护结束，确认没有其它进程写同一个 app home。
4. 保存一致的完整应用快照：配置和 auth、state、workspace、频道和任务 session、任务说明/循环日志/等待条件、委派状态/产物、usage ledger、memory 游标和投递幂等状态。另备份受任务或外部代理写入的项目目录。保护备份凭证权限，记录校验和、时间与恢复路径。
5. 在备份之后进行 Azure 字段迁移；安装并用 lock 执行 npm ci/build。安装 ID 仅在首次选择相应 OAuth 登录时创建，不能重置生产身份。

不把整份生产快照直接启动成第二个在线 daemon：到期事件、恢复外部运行或待投递 outbox 会产生真实副作用。历史数据验证用离线消费者或受控 harness；供应商 smoke 用独立新 home 和独立工作目录。如确需克隆运行，先隔离传输、定时/任务驱动、外部恢复、投递和文件写目标，不能只更换频道 id。

### 5.2 灰度

单个受控实例启动新版本，确认实际版本、认证/配置路径和目标模型；执行首次工具调用、备用失败一次、聊天/任务恢复、正常停止和重启。观察主/备用 request 数、context_edit、任务恢复、usage/委派幂等和 AI Card 最终完成情况。确认后逐步恢复入站及调度，避免多个实例共用 app home。

首次请求无工具、重复输入、故障实例继续请求、身份 UUID 漂移、目标模型错误、重复工具/委派/投递或费用重复计入，均应立即停止灰度；不是可接受的降级。

### 5.3 回退

| 时点 | 回退方式 |
|---|---|
| 新版本未产生外部副作用 | 关闭全部写入进程，保存失败现场，恢复升级前应用快照及匹配的旧发布包/lock；如有项目变更同步恢复，再离线检查旧会话后启动 |
| 新版本已经执行工具、外部委派、任务或投递 | 先冻结运行并保存最新状态；核对项目写入、运行结果、receipt、ledger 和幂等标记，决定保留/前向修复或人工恢复方案，不能直接覆盖成旧快照 |

第二种情况下恢复旧幂等标记可能导致再次发送消息、重新执行任务或重复计费。不能只执行 npm 降级，也不能删掉 context_edit 或批量手改 session 来伪造兼容。先保持已完成工作的证据和当前幂等状态，再选择经过验证的恢复路径。涉及不可回退的外部效果时，优先修复新版本。

## 6. 改动归属与交付

| 位置 | 预计修改 |
|---|---|
| package.json、package-lock.json | 四个直接依赖精确升级，审查解析图 |
| src/agent/session/session-host.ts | 初始 canonical context/工具接入，故障实例检查及成功重建边界 |
| src/agent/session/session-adapter.ts | 尝试起点、raw/projection 识别、entry ID 省略与幂等校验；过长时在同域按内容拆文件 |
| src/agent/turn/turn-pipeline.ts、src/agent/channel-runner.ts | plan 注入，现有停止状态与资源保护接线，备用图片重新准备 |
| src/models/fallback.ts | 从数组裁剪接口改成 plan 能力；保持分类、最多一次与冷却规则 |
| src/models/login-identity.ts（新增） | 安装 UUID 的校验、并发首次发布与取消边界 |
| src/models/provider-login.ts、src/app/auth-command.ts | 显式 app home，第四个 SDK 登录 options |
| 现有 unit/e2e 与 fixtures | 类型、有效图片、新提示结构、请求/磁盘/恢复/认证机制；按 D10 控制增量 |
| docs/configuration.md、docs/configuration-reference.md | 身份文件与 Azure 精确字段迁移，说明现有 API key 仍可使用 |
| docs/deployment-and-operations.md、docs/architecture.md | 状态备份/回退流程，canonical context 和 raw 数据用途 |
| CHANGELOG.md | 依赖升级、可见收益、条件迁移及兼容限制 |

均在既有域内实现，不新增顶层模块、barrel 或架构例外，src/index.ts 的公开导出保持稳定。写入上下文失败属于需要用户/运维处理的 plain Error；字段误用仍遵循 RecoverableToolError 规则。新用户反馈按 053 使用中文“原因 + 可执行下一步”，运维身份存储错误和日志使用英文。

## 7. 取舍与未决验收

- 持久化省略替代内存裁剪，获得重启一致的模型上下文，但增加两次写入和故障隔离要求；不额外建立重试事务日志。
- raw 审计与投影用途分离，失败尝试仍可能在冷存储/反思中被看到；这是保留事实，不是上下文修改失败。
- 新身份状态属于安装而非账号，身份文件损坏时明确失败；自动换 UUID 会改变认证身份，故不自动“修复”。
- Azure 采用明确字段迁移，避免永久旧名别名。历史 Azure 模型选择和真实 OAuth 流仍是发布阻断项，必须以实际结果关闭。
- 此次目标是 1.2.0 接入安全，额外上游能力不作为已交付收益，性能收益不凭包数量推断。

## 实施记录

实现与正式验证记录见 [acceptance.md](./acceptance.md)。依赖、会话构造、持久化重试、故障隔离、安装身份、旧会话样本及操作文档已实现。真实账号/传输 smoke、生产一致快照、灰度及回退演练仍是未关闭的发布门禁，不沿用原型结果。

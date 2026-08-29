# e2e 重做：机制层要确定性，模型质量归 evals

| 字段 | 值 |
|------|------|
| 状态 | IN PROGRESS（P0–P1 完成；确定性层 20 条 + P3/P4 结构完成；A14/A16–A18/A20–A23 待补，见实施记录） |
| 日期 | 2026-08-29 |
| 触发 | 例行体检发现 e2e 套件已红 5 天无人察觉，且这个红掩盖了一个 2026-08-24 引入、至今线上生效的 `/help` 冷启动崩溃 |
| 前置 | 004 e2e-test（本 spec 是它的重做）、028 behavior-eval（分工的另一半）、040/042 委派、043 会话身份与回合恢复、044 native-file-io、046/047 工具切分 |
| 关联实现 | `test/e2e/**`、`test/support/setup.ts`、`test/support/runtime-harness.ts`、`test/support/fake-bot.ts`、`vitest.config.e2e.ts`、`package.json`、`src/agent/channel-runner.ts`（D7 的产品修复）、`AGENTS.md` |

## 摘要

004 定下的 e2e 形态是「mock 掉钉钉传输，其余全真，包括真实 LLM」。这个形态在首批 7 个用例上是对的，但它有一个内建的代价：**每条用例都要付真实模型的钱和不确定性**。代价的后果现在到齐了——套件贵、慢、飘，于是没人常跑；没人跑，它就红了 5 天；红了没人管，它就掩盖了一个真 bug。

本 spec 做三件事：

| 阶段 | 内容 |
|---|---|
| **P0** | 止血：修红、修被掩盖的 `/help` 冷启动 bug、对齐 provider、删掉字面文案断言 |
| **P1** | 引入脚本化 provider（进程内 mock，openai-completions 协议），把 e2e 的成本压到零、时序变可控 |
| **P2–P4** | 在这个基础上补 25 条机制层用例，并把现有 11 个文件逐个重新归位 |

一条贯穿的规则：

> **e2e 只证明机制接对了，不证明模型答得好。**

这条规则一立，分工就闭合了：

| 层 | 职责 | 判据 | 运行时机 |
|---|---|---|---|
| unit | 单模块分支、边界、契约 | 能被 fake 掉的都在这层 | `npm run check` |
| **e2e** | **全栈机制正确性**：跨模块时序、持久化副作用、进程与重启、投递序列、护栏接线 | 断言可观察副作用，不看模型说了什么 | `npm run test:e2e`（零成本，常跑） |
| evals | 真实模型的行为质量 | grader / baseline / gate | `npm run eval`，不进门禁 |

## 当前事实与证据

### F1 套件已红 5 天，而且是「没人跑」的红

实跑（2026-08-29）：

```
$ npx vitest run --config vitest.config.e2e.ts test/e2e/builtin-command.test.ts
× /help  → expected '命令执行失败：Cannot read properties of unde…' to contain '斜杠命令'
× /tasks → expected "# 任务\n\n当前没有进行中的任务。"
           received "**任务**\n\n暂无进行中的任务。用 `/tasks archive` 查看已归档任务。"
```

`/tasks` 这条的成因是 `2e5342d`（2026-08-24 20:29，命令回复规范改版）**有意**改了空态文案。测试只能在这次有意修改上报警，抓不到任何真实故障——AGENTS.md 自己定义的 change-detector。`test/e2e/tui.test.ts` 里有同一条断言的副本。

e2e 最后一次实质改动是 `fcee310`（2026-08-10），上一次结构性重做是 `45073cc`（2026-07-11）。也就是说：**这三周里所有新增能力（046/047 工具切分、044 文件 I/O、`/skills`、委派带外通知、任务控制 v3）没有一条进过 e2e。**

### F2 这个红掩盖了一个线上 bug

`/help` 那条不是文案漂移，是运行时崩溃：

```
WARN Built-in command failed reason="Cannot read properties of undefined (reading 'promptTemplates')"
```

链路（`src/agent/channel-runner.ts`）：

1. 构造函数 `:380` 把 `this.sessionReady = this.initializeSession()` 当成后台 promise，`this.session` 在 `initializeSession()` 内部才赋值（要先建 model runtime，实测几百 ms）。
2. `handleBuiltinCommand()` `:806` **没有 await `sessionReady`**。`/help` → `renderHelpWithDiscovery()` `:1008` 直接读 `this.session.promptTemplates` → TypeError → 用户看到「命令执行失败：…」。
3. 更宽的面：`isKnownSlashCommand()` `:867` 也读同一个字段，而 `src/runtime/bootstrap.ts:724` 对**任何以 `/` 开头的消息**都会调它，用来拒绝未知命令。这条路径上抛出的是未捕获错误，不是一句友好提示。
4. runner 是同步产出的（`bootstrap.ts:307` `createRunner` 立即返回并入表），所以「消息到达」和「session 就绪」之间必然存在窗口。

触发条件很日常：daemon 重启后第一条是斜杠命令、新频道的第一条消息、runner 被 LRU 淘汰后重建。和 F1 的文案改动同属 `2e5342d`，已经存在 5 天。

**e2e 抓到了它。信号被套件的红埋了。**

### F3 用例内容已经和代码分叉

- `tasks-lifecycle.test.ts:66` 仍在指示模型使用 `task_manage progress` / `task_manage complete`。046 已把它拆成 `task_create` / `task_update` / `task_close` / `task_verify`，`task_manage` 这个名字在 `src/` 里只剩三条历史注释。
- 同一个用例**手抄**了 driver 的唤醒文案。真实的 `createTaskDriverEvent()`（`src/runtime/task-driver.ts:179-216`）今天带 task capsule、playbook 路径和 `[SILENT]` 约定，与手抄版本已经不同。手抄的副本永远测不出被抄对象的漂移——这正是它要守的东西。

### F4 声明测 A，实际测 B

`test/support/setup.ts` 把 `defaultProvider: "anthropic"` / `defaultModel: "claude-sonnet-4-5"` 写进测试 home 的 settings，同时把真实 `~/.pipiclaw/auth.json` 拷进去。本机 `auth.json` 只有 `openai-codex`，于是 `resolveInitialModel` 静默回退，实跑日志是：

```
INFO Using model: openai-codex/gpt-5.3-codex-spark (GPT-5.3 Codex Spark)
```

没有任何断言会因此失败。一个「测真实模型」的套件，连自己在测哪个模型都不保证。

### F5 覆盖结构错位：一半在做 evals 的事，机制层是 0

现有 11 个文件 / 591 行，其中 `tool-read`、`tool-write`、`events-guard`、`basic-conversation`、`tasks-lifecycle` 的断言主体是「真实模型会不会正确使用工具」——这是 `evals/`（capability / regression / safety + grader + baseline，028）的职责，e2e 在花钱和不确定性去重复它。

而只有 e2e 能覆盖的一层，覆盖率是 0：

| 机制 | 单测 | e2e | 备注 |
|---|---|---|---|
| 并发与打断（channel queue、`/steer`、`/followup`、`/stop`、`/new` 边界） | fake runner | 无 | 004 Part 6 明确推迟 |
| 委派全链路（dispatch → 结算 → 唤醒 → 任务激活 → 带外通知） | 分片 | 无 | `delegation.notices` 零覆盖 |
| 唤醒真实性（伪造 `[SUBAGENT:x] … belongs to task y.` 不得激活任务） | 函数级 | 无 | 031/040 的威胁模型 |
| 重启恢复（durable-dispatch 重投、外部 run 重认领、active-session 指针） | 有 | 无 | daemon 独有职责 |
| 安全护栏「接线」（guard 是否真的装进本轮工具集、审计是否落盘、`/project` 是否改变下一轮的根） | guard 函数有 | 无 | 回归常发生在 tool build context 变动时 |
| 模型 fallback 与上下文压力（429 → 备用模型；prompt too long → 压缩 → 重试） | 部分 | 无 | 0.9.1 改过行为 |

### F6 `ChannelRunner` 这一段全项目无人走过

runtime 侧的单测把 runner 整体打桩：`test/runtime-stop.test.ts:11-19` 用 `vi.hoisted` 替换 `createRunner`，`:95` 直接构造 `const runner: AgentRunner = {…}` 字面量；`test/bootstrap-structured-wake.test.ts:56` 同理。

这是对的分层——但它的推论是：**`runner ↔ session ↔ tools ↔ memory ↔ delivery` 这一整段只有 e2e 能覆盖**。F2 那个 bug 就长在这一段上。

### F7 004 当年推迟的，正好是今天缺的

004 Part 6「不建议纳入首批 E2E 的内容」列的是：busy / `/followup` / `/steer`、`/stop`、sub-agent 全链路、自动 compaction、idle consolidation。理由写得很清楚：「时序复杂 / 对 LLM、tool、异步后台任务更敏感 / 首批先追求稳定性」。

这个判断在当时成立。但**不稳定的根源是真实模型，不是这些机制本身**——机制侧的时序如果由测试控制，它们是可以稳定的。P1 要拆掉的就是这个根源。

### F8 脚本化 provider 的可行性（已核实）

| 事实 | 出处 |
|---|---|
| `openai-completions` 走官方 `openai` SDK，`client.chat.completions.create(params, {maxRetries: 0})`，baseURL 取自 `model.baseUrl` | `pi-ai/dist/api/openai-completions.js:174-189, 515` |
| 流解析就是标准 OpenAI SSE：`choice.delta.content` / `choice.delta.tool_calls[]`（按 `index` 聚合、`function.arguments` 增量拼接）/ `choice.finish_reason` / `chunk.usage` | 同上 `:355-455` |
| `models.json` 支持 provider 内联 `apiKey`，不需要 `auth.json` | 现网 `~/.pipiclaw/models.json` 的 `zpai` 就是这么配的；`src/models/api-keys.ts:12` 走 `modelRegistry.getApiKeyForProvider` |
| 记忆 sidecar（extraction / recall rerank / session update / consolidation / session-search）走 `streamSimple`，**用的是同一个 model 和同一个 provider** | `src/memory/sidecar-worker.ts:3-16`；调用点 `recall.ts:709`、`session.ts:309`、`consolidation.ts:181`、`session-search.ts:141`、`extraction.ts:298` |
| 每个 sidecar 任务有各自固定的 systemPrompt 常量，可用于路由识别 | `RERANK_SYSTEM_PROMPT`、`SESSION_MEMORY_SYSTEM_PROMPT`、`SESSION_SEARCH_SUMMARY_SYSTEM_PROMPT`、`buildMemoryExtractionSystemPrompt(...)` |
| runtime 已经留好测试缝：`createBot` / `createEventsWatcher` / `createTaskDriver` / `createMemoryMaintenanceScheduler` / `observer` / `wakeTransitionHooks` / `stopForceEndGraceMs` / `startServices` | `src/runtime/bootstrap.ts:220-249` |

最后一行很关键：**sidecar 和主回合共用一个端点**，所以 mock 必须按请求内容路由，不能按到达顺序（见 D2.4）。

## 设计原则

1. **e2e 只验证机制，模型质量归 evals。** 确定性层里出现任何「模型答得对不对」的断言，都是走错了层。
2. **断言可观察副作用，不断言渲染文案。** 磁盘状态、发往 provider 的请求体、投递序列与次数、审计记录、进程与 run 状态。要证明「没走模型」，就断言**模型请求数为 0**，不要去对空态字符串。
3. **时序由测试控制。** 用 mock 的挂起/放行制造确定的并发窗口，不用 `sleep` 猜，也不用轮询等一个本可以被精确控制的事件。
4. **每条用例必须能指名它要抓的故障模式。** 注释里写清楚：哪次提交/哪类回归。写不出来的用例不收。
5. **便宜到可以常跑。** 这是本次事故的根本教训：一个贵到只在发版前手工跑的套件，等价于一个不存在的套件——而且比不存在更糟，因为它给了虚假的安全感。

## D1 分层与运行方式

### D1.1 三个 target

```
npm run test:e2e        确定性层（mock provider，零 API 成本，目标 < 90s，可断网运行）
npm run test:e2e:live   真实模型层（5 条，跟随本机 settings，手工/夜间）
PIPICLAW_E2E_HARNESS=…  外部 CLI 冒烟（现状保留，opt-in）
```

`npm run check` **不变**（lint + typecheck + deadcode + test）。已确认的取舍：check 要快，确定性层不进 check。约束改由文档承担——AGENTS.md 增加一条：**改动 runtime / memory / 委派 / 命令平面，必须跑 `npm run test:e2e`**。

### D1.2 目录

```
test/e2e/
  deterministic/**.test.ts    脚本化 provider，零成本
  live/**.test.ts             真实模型，5 条
  external/**.test.ts         现有 subagent-external-smoke（opt-in）
  helpers/wait.ts             保留
test/support/
  setup.ts                    改：新增确定性 home 构造
  runtime-harness.ts          改：新增 mock provider 装配、请求断言、重启助手
  mock-provider/              新增：server.ts / script.ts / sse.ts / defaults.ts
```

`vitest.config.e2e.ts` 保持 `pool: "forks"` / `fileParallelism: false` / `maxConcurrency: 1`（确定性层其实允许并行，但共用一份 `PIPICLAW_HOME` 环境变量的模块加载时序仍是串行更稳；先不动，等确定性层跑起来再评估）。

### D1.3 跳过策略要反过来

004 的策略是「缺凭证就 skip」。确定性层**没有凭证概念**，因此不允许 skip：它必须在任何机器、任何网络状态下跑绿。live 层保留原来的 skip 语义。

## D2 脚本化 provider（本 spec 的支点）

### D2.1 形态

进程内 `node:http` 服务，监听 `127.0.0.1:0`（随机端口），实现 `POST /chat/completions` 的 SSE 流式响应。**只实现 openai-completions 一种协议**——不实现 anthropic-messages，也不做录制回放（理由见「不做什么」）。

### D2.2 注册方式

测试 home 里写死一份 `models.json` 和 `settings.json`，不再拷贝真实凭证：

```jsonc
// models.json
{ "providers": { "e2e-mock": {
    "baseUrl": "http://127.0.0.1:<port>",
    "api": "openai-completions",
    "apiKey": "e2e-mock-key",
    "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    "models": [
      { "id": "mock-main", "name": "mock-main", "contextWindow": 200000, "maxTokens": 8192 },
      { "id": "mock-fallback", "name": "mock-fallback", "contextWindow": 200000, "maxTokens": 8192 }
    ] } } }

// settings.json
{ "defaultProvider": "e2e-mock", "defaultModel": "mock-main", … }
```

两个模型是为 A22（fallback）准备的：让主模型返回 429，观察是否切到备用。

### D2.3 编排 API

```ts
const model = await startMockProvider();      // 返回 { baseUrl, port, requests, script, close }

// 一条路由 = 一个匹配器 + 一串「连续响应」。带工具调用的回合天然是两次请求
// （模型发工具调用 → 工具结果回灌 → 模型发最终文本），所以 respond 是数组。
model.script.route({
  name: "write-then-answer",
  when: (req) => req.isMainTurn && req.lastUserText.includes("E2E_WRITE"),
  respond: [
    reply.toolCall("write", { path: "…", content: "…" }),
    reply.text("已写入。"),
  ],
});

// 时序控制：挂住不返回，直到测试放行
const gate = model.script.hold({ when: (req) => req.isMainTurn });
await harness.sendUserMessage("第一条");     // 卡在 provider 上，回合处于 running
await harness.sendUserMessage("第二条");     // 必须排队，不得交错
gate.release();

// 故障注入
model.script.failNext({ status: 429 });                    // A22 fallback
model.script.failNext({ status: 400, code: "context_length_exceeded" });  // A23 压缩
```

### D2.4 路由按内容匹配，未匹配必须大声失败

**这是最容易设计错的一点。** sidecar（记忆抽取、召回重排、SESSION 刷新、consolidation）和主回合共用同一个端点，且发生时机是异步的（F8）。如果按「到达顺序」消费脚本，一次记忆抽取插进来就会吃掉本该给主回合的那条响应，测试会以一种完全无法诊断的方式失败。

因此：

- 每条路由必须自带匹配器，输入是解析好的请求视图：`{ path, model, systemPrompt, tools, messages, lastUserText, isMainTurn }`。`isMainTurn` 的判据是「请求带 tools」——sidecar 一律无工具。
- **未匹配的请求不返回兜底内容**，而是返回 502 并把请求摘要记进 `model.requests`；harness 在 `afterEach` 断言「无未匹配请求」，失败信息直接打印那条请求的前 200 字。宁可红得刺眼，不可静默走偏。
- sidecar 提供一组**默认响应**（D2.7），测试不关心记忆时不必逐条编排；但默认响应也是显式注册的路由，不是兜底。

### D2.5 请求捕获是这次改造真正的新能力

`model.requests` 保留每次请求的完整 body。它让下面这些断言第一次成为可能——它们**只能从 provider 实际收到的内容上证明**，落盘产物证明不了：

- 召回是否真的注入了那条记忆（A10），以及不命中的查询是否真的没注入；
- `/new` 之后的下一轮请求是否真的不含旧历史（A7）；
- 子代理拿到的工具集是否真的不含 `send_media` / `job` / `subagent`（A21）；
- system prompt 的最终形态（现有 `system-prompt.test.ts` 读的是 `PIPICLAW_DEBUG` 落盘的 `last_prompt.json`，需要开 debug 且隔了一层；改成读请求体后更直接，也不再依赖 debug 开关）。

### D2.6 故障与时序注入清单

| 能力 | 用途 |
|---|---|
| `hold/release` | A4 串行、A6 steer/followup、A7 忙时 `/new`、A23 压缩期间来新消息 |
| `delay(ms)` | 少量需要真实等待的场景，能不用就不用 |
| HTTP 429 / 500 | A22 fallback |
| 400 + `context_length_exceeded` | A23 压缩路径 |
| 客户端中断（`/stop` 触发 abort）必须被 mock 正确处理（结束流、不泄漏 socket） | A5 |

### D2.7 sidecar 默认响应表

| 任务 | 识别 | 默认响应 |
|---|---|---|
| memory extraction | systemPrompt 含 `durable memory extraction worker` | 空 `memoryOps` 的合法 JSON |
| recall rerank | `RERANK_SYSTEM_PROMPT` | 原样返回 top-1（等价于「不重排」） |
| session memory update | `SESSION_MEMORY_SYSTEM_PROMPT` | 一个固定的合法 `# Current State` 文本 |
| consolidation | `memory-inline-consolidation` | 原文回传 |
| session search summary | `SESSION_SEARCH_SUMMARY_SYSTEM_PROMPT` | 固定摘要 |

需要断言记忆行为的用例（A9/A10/A11）显式覆盖对应路由，让 sidecar 返回真正要写入的内容——这样「写没写进 MEMORY.md」测的是 pipeline，而不是模型的抽取质量（后者归 evals，`M-write-04` 已经在守）。

### D2.8 协议漂移的守法

mock 只实现协议的最小子集，pi 依赖升级时可能漂移。守法不是给 mock 写更多单测，而是：**live 层（D3）用真实 provider 走同一批基础链路**。协议一旦变了，live 层会先红，且红在真实客户端上。mock 自身另配三条单测（放 `test/`，进 `npm run check`）：SSE 编码正确、路由按内容命中、未匹配请求返回 502 并被记录。

## D3 live 层收敛

只留 5 条，职责是「真实模型 + 真实协议下，这条链路确实能走通」：

| 用例 | 为什么必须是真模型 |
|---|---|
| B1 一次带工具的对话（合并现有 `tool-read` + `tool-write`） | 证明我们的工具 schema 真的可被模型调用 |
| B2 从真实 driver 唤醒推进一个任务（修正为 046 之后的工具名） | 证明 playbook 和提示词真的教对了当前工具名——mock 永远证明不了这件事 |
| B3 `event_manage` 的 immediate 守卫 | 提示词级守卫的真实行为 |
| B4 基础对话 + 落盘 | 端到端烟测，兼做协议守法 |
| B5 TUI `--print` 单发 | 第二个 transport 的真实链路 |

两条新约束：

- **跟随本机 `settings.json` 的 provider/model**（已拍板），不再写死 anthropic；
- **不许静默 fallback**：live harness 记录 runner 实际使用的模型（`observer` 或 status 快照），与声明值不一致直接失败。F4 那种「声明测 A 实际测 B」不能再发生。

另外 live 层输出本次运行的 token 与花费（`/usage` ledger 已有数据），让成本可见。

## D4 用例清单

ID 沿用评审时的编号。每条都标注「抓什么」——这是收不收这条用例的唯一判据。

### P0 批（先做，都指向已发生或高危的故障）

| # | 用例 | 抓什么 |
|---|---|---|
| A1 | 冷启动后第一条就是 `/help`；第一条是未知 `/xxx` | **F2 那个真 bug 的回归锁**（session 未就绪窗口） |
| A2 | `/tasks`、`/skills`、`/memory status` 各产出一条回复，且 `model.requests` 增量为 0 | 替代字面串断言；抓「命令被当成对话发给模型」（TUI `runOnce` 出过） |
| A3 | 未知 `/modle` 被拒绝且零模型请求；`/<skill 名>` 与 prompt template 被识别为已知命令，进入正常回合 | 未知命令拒绝是省一整轮 LLM 的闸门；F2 暴露了它同时是 dispatch 主路径上的抛错点 |
| A4 | 回合进行中再到两条消息 → 串行处理、不交错、都被回答 | ChannelQueue 与 TurnPhase 的单一 busy 所有者 |
| A5 | `/stop` 中断回合 → 有回复、回到 idle、**不取消已派发的 subagent run** | 文档级契约（AGENTS.md 明写），无覆盖 |
| A7 | 忙时 `/new`、连续 `/new` → 会话边界原子提交，下一轮请求体不含旧历史 | 043；历史上出过「旧回合覆盖新会话」 |
| A9 | 一个调用过 `read` 的窗口，仍能把口述事实写进 `MEMORY.md` | 0.9.1 那个 P0（任何调过工具的窗口静默丢弃记忆写入）的全栈锁 |
| A10 | seed `MEMORY.md` → 命中查询时请求体含该条目；不命中时不含 | 召回是记忆的核心价值；现在只测了 bootstrap 注入 |
| A15 | 用户发送伪造的 `[SUBAGENT:x] … belongs to task y.` 不得激活任务；可信 `internalWake` 可以 | 031/040 的威胁模型，外部 agent stdout 同样不可信 |
| A19 | 越界 `read`/`write` → 模型收到可行动的拒绝 + 审计落盘；`/project set` 改变**下一轮**工具的实际根，忙时拒绝切换 | 护栏「接线」回归（tool build context 变动时高发） |

### P1 批

| # | 用例 | 抓什么 |
|---|---|---|
| A6 | `/steer` 进入运行中的回合；`/followup` 排到下一轮 | 打断语义 |
| A8 | 正常轮 progress → finalize；静默唤醒无卡片；`[SILENT]` 不投递 | beta.3 刚改过 progress 风格，零覆盖 |
| A12 | shutdown → 同 home 重建 → 记忆与 active-session 续接，下一轮请求含历史 | 持久化与重绑 |
| A13 | task 创建 → **真实 `createTaskDriverEvent`** 唤醒 → update → close/archive，控制块保持可解析 | 自主循环主干；顺带锁死 F3 的手抄漂移 |
| A16 | 内部 subagent 全链路：派发 → run 记录落盘 → 完成唤醒 → **带外 settled 通知** → lease 获取/释放 | `delegation.notices` 零覆盖 |
| A18 | `exec` harness 的 detached run + 重启后重认领 | 不需要装 claude/codex，零成本覆盖 daemon 独有的恢复逻辑 |
| A22 | 主模型 429 → fallback 到备用模型，回合仍完成，usage 双记 | 017 的深逻辑无全栈覆盖 |

### P2 批

| # | 用例 | 抓什么 |
|---|---|---|
| A11 | 多轮后 SESSION.md 刷新、HISTORY 折叠；**对话里的假密钥不得出现在任何记忆文件** | 记忆维护管线 + `secret-redaction` 的实效 |
| A14 | verify 链：派发 `purpose=verify` → 结算 → 唤醒重新激活任务 → `task_verify` 导入 attestation → `complete` 比对 body hash | 0.9.1 修过的 P0 死锁，无全栈锁 |
| A17 | `bash async` job → 完成唤醒 + 通知；spill 文件可读 | 后台作业链路 |
| A20 | `bash` 命中命令守卫、web 命中网络守卫 → 拒绝 + 审计；grep glob 的 shell 转义（beta.3 修复）走全栈 | 安全回归 |
| A21 | 子代理的工具集不含 `send_media` / `job` / `subagent`（从 mock 收到的请求体上断言） | `availableToSubagents` 门控回归 |
| A23 | provider 返回 `context_length_exceeded` → 压缩 → 重试成功；压缩期间来新消息 → 压缩被取消、消息成为下一个正常回合 | 0.9.1 改过的行为，零覆盖 |

## D5 现有 11 个文件的处置

| 现有文件 | 处置 |
|---|---|
| `builtin-command.test.ts` | 重写为确定性 A1 / A2 / A3；删掉两条字面串断言 |
| `system-prompt.test.ts` | 转确定性，断言对象从 `last_prompt.json` 改为 mock 收到的请求体（更直接，且不再依赖 `PIPICLAW_DEBUG`）；manifest 哈希一致性断言保留 |
| `memory-bootstrap.test.ts` | 由 A10 取代（严格更强：既证明注入，也证明不该注入时没注入） |
| `session-memory.test.ts` | 转确定性并扩为 A11 / A12（sidecar 响应由脚本给定，不再等真实模型） |
| `events-guard.test.ts` | 转确定性：直接编排 immediate 事件的工具调用，断言拒绝 + 磁盘无落地。提示词级的那半留给 live B3 |
| `tasks-lifecycle.test.ts` | 拆成确定性 A13（用真实 driver 事件）+ live B2（修正工具名） |
| `tool-read.test.ts` / `tool-write.test.ts` | 合并为 live B1；越界与错误契约由确定性 A19 覆盖 |
| `basic-conversation.test.ts` | 保留为 live B4，加强断言（log / context / usage ledger 三处落盘） |
| `tui.test.ts` | 保留 live 单发（B5）；`/tasks` 那条转确定性，断言「模型请求数为 0」而非字面串 |
| `subagent-external-smoke.test.ts` | 原样保留（opt-in），另加确定性 A18（`exec` harness） |

## D6 harness 改动清单

| 文件 | 改动 |
|---|---|
| `test/support/setup.ts` | 新增 `createDeterministicHome({ mockBaseUrl })`：写自己的 `models.json`/`settings.json`，不拷贝真实凭证；保留 `createE2ETestHome` 供 live 层用，并改为跟随本机 provider |
| `test/support/runtime-harness.ts` | 装配 mock provider；新增 `requests` 视图、`restart()`（同 home 重建 runtime）、`waitForDelivery(predicate)`、`modelRequestCount()`；透传已有的 `createTaskDriver` / `wakeTransitionHooks` / `stopForceEndGraceMs` 缝 |
| `test/support/mock-provider/` | 新增：`server.ts`（http + SSE）、`script.ts`（路由/挂起/故障注入）、`sse.ts`（chunk 编码）、`defaults.ts`（sidecar 默认响应） |
| `test/support/fixtures/` | 新增：内部与 `exec` 角色文件、skill、任务台账样本 |
| `package.json` | 新增 `test:e2e:live`；`test:e2e` 收敛为确定性层 |

## D7 顺带修的产品 bug（独立提交）

F2 是产品 bug，不是测试问题，必须**先于**测试改造单独提交，附 A1 作为回归锁：

- `handleBuiltinCommand()` 在进入 switch 前 `await this.sessionReady`；
- `isKnownSlashCommand()` 不得在 session 未就绪时抛错——它是同步方法且位于 dispatch 主路径上，因此改为「session 未就绪时只用静态目录 + skills 判定，不查 prompt templates」，或由调用点改为异步等待。**倾向前者**：这个判定的作用是拒绝明显的拼写错误，session 未就绪时把一个 prompt template 误判为未知命令，代价远小于在 dispatch 路径上抛错，也小于让每条斜杠消息都等 model runtime 初始化。
- 顺带核对 `renderContextReport` 等其他读 session/activeModel 的 runner 命令是否有同一窗口问题。

## 不做什么

- **不做录制回放（record & replay）。** 录下来的真实响应会变成另一种 change-detector：prompt 一改，录像全废，而它们抓不到任何真实故障。脚本化的意思是「测试声明模型要做什么」，不是「把上次模型做了什么存起来」。
- **不实现 anthropic-messages 协议。** 一种协议足够覆盖全部机制；provider 差异属于 pi 依赖的职责。
- **确定性层不进 `npm run check`。**（已拍板）check 要快；约束由 AGENTS.md 的规则和 CI 承担。
- **确定性层不断言任何模型输出质量。** 出现这类断言即为设计违规，评审时打回。
- **不追覆盖率数字。** e2e 的收敛标准是「机制清单是否被覆盖」，不是行覆盖率。
- **不为提高稳定性而放宽断言。** 飘的用例要么修时序控制，要么删掉；不允许降级成「只要不抛错就算过」。

## 阶段与验收

### P0 止血（0.5 天）

- 修 D7 的产品 bug（独立提交，带 A1 的前身：一条最小回归测试）。
- 删掉 `builtin-command.test.ts` 与 `tui.test.ts` 里的字面串断言。
- `setup.ts` 改为跟随本机 provider，并加「实际模型 ≠ 声明模型即失败」的断言。
- 修正 `tasks-lifecycle.test.ts` 的工具名。
- **DoD**：`npm run test:e2e` 在本机全绿；`/help` 冷启动不再崩。

### P1 脚本化 provider（1–1.5 天）

- `test/support/mock-provider/**` + harness 装配。
- mock 自身三条单测进 `npm run check`。
- 一条 pilot 用例（A2）跑通，作为形态验收。
- **DoD**：pilot 在**断网**环境下通过；未匹配请求会让测试以可读信息失败。

### P2 P0 用例组（2 天）

A1 / A2 / A3 / A4 / A5 / A7 / A9 / A10 / A15 / A19。
**DoD**：十条全绿；确定性层总耗时 < 60s；每条通过「反证」（见下）。

### P3 P1 用例组 + 迁移（2 天）

A6 / A8 / A12 / A13 / A16 / A18 / A22；按 D5 完成现有文件的迁移与合并；live 层收敛到 5 条并加成本输出。
**DoD**：确定性层 < 90s；live 层单次运行成本可见且 < 约定上限。

### P4 收尾（1.5 天）

A11 / A14 / A17 / A20 / A21 / A23；AGENTS.md 增加测试分层规则与 e2e 硬规则；`docs/README.md`、`CLAUDE.md` 命令表同步；`docs/specs/README.md` 增加 048 行。

## 测试计划：怎么证明这套 e2e 自己不是闲人

三条硬手段，全部写进评审清单：

1. **反证（mutation check）。** 每条新用例合入前，必须人工把它要保护的那段代码改坏一次，确认测试变红，并把这次反证写进用例注释。改坏了还绿的用例不收。这是「不养闲人」唯一可执行的判据。
2. **断网运行。** 确定性层必须在无网络下整套通过。任何一条依赖外网的用例都说明它跑错了层。
3. **未匹配请求为零。** harness 在每个用例结束时断言 mock 没有收到未编排的请求——它同时是「测试是否真的理解了这条链路」的度量。

另外：mock provider 的协议正确性由 live 层间接守住（D2.8），依赖升级时先红在 live 层。

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| pi 依赖升级导致 SSE 协议漂移 | mock 只实现最小子集；live 层作为协议哨兵；漂移时改 mock 的成本是小时级 |
| 「看起来全栈但模型是假的」造成虚假信心 | 分层写死在文档与评审规则里；live 层保留 5 条真实链路；模型质量由 evals 承担 |
| 并发用例仍然飘 | 一律用 `hold/release` 制造确定窗口；禁止 `sleep`；飘就删不就降级 |
| mock 成为需要维护的第二套「产品」 | 严格限定职责：只做协议编码 + 内容路由 + 故障注入，不做状态、不做智能、不做回放 |
| 工作量超出 | 阶段独立可停：P0 完成即止血；P1 完成即拿到能力；P2 之后每批用例都是可独立合入的增量 |

回滚：P1 之后的任何阶段都可以只回滚测试文件，不涉及 `src/`（D7 的产品修复除外，它本身就是独立提交）。

## 对文档的影响

- `AGENTS.md`：新增「测试分层」小节（unit / e2e / evals 的判据），以及 e2e 的六条硬规则（原则 1–5 + 反证要求）；在验证要求里写明「改动 runtime / memory / 委派 / 命令平面须跑 `npm run test:e2e`」。
- `CLAUDE.md`：命令表补 `test:e2e:live`，并说明 `test:e2e` 现在是零成本的确定性层。
- `docs/specs/README.md`：主题分组表加一行 `048`；并注明 004 的形态已被 048 取代（004 保留为历史）。
- 本 spec 不产生用户可见行为变更，`docs/` 顶层手册无需改动（D7 的 bug 修复在 CHANGELOG 里单独记一条 Fixed）。

## 实施记录

### P0 止血（2026-08-29 完成）

- **D7 产品 bug 修复**（`src/agent/channel-runner.ts`）：
  - `handleBuiltinCommand()` 进入 switch 前 `await this.ensureSessionReady()`，覆盖 `/help` 与 `/context` 两条读 `this.session` 的命令。
  - `isKnownSlashCommand()` 采纳复核意见里倾向的方案：新增 `sessionInitialized` 标志，session 未就绪时只用静态命令目录 + skills 判定，直接不查 `promptTemplates`。同步方法不再有抛错路径。
  - 复核 `renderStatus`：`/status` 已用 try/catch 包住 `getStatusSnapshot()`，session 未就绪时降级为「模型：不可用」，不崩，无需改动。
- **测试止血**：
  - `builtin-command.test.ts` 重写为 A1（`/help` 冷启动不崩，带反证注释）/ A3（未知 `/modle` 拒绝且单条回复）/ A2（`/tasks` 单条确定性回复，断言 report 形状而非字面串）。
  - `tui.test.ts` 的 `/tasks` 断言由字面串改为 report 形状匹配。
  - `setup.ts` 跟随本机 `~/.pipiclaw/settings.json` 的 provider/model，不再写死 anthropic；无法解析时直接抛错。
  - `runtime-harness.ts` 新增 `assertResolvedModel()`（读 `/status` 回读实际模型），`basic-conversation.test.ts` 调用它做 F4 防回归。
  - `tasks-lifecycle.test.ts` 改用真实 `createTaskDriverEvent()` 构造唤醒文案，消灭手抄漂移；注释更新为 046 后的工具名。
  - `system-prompt.test.ts` 的 `endsWith("explicit user authority.")` 是同类 change-detector（boundary 文案已变），改为断言「runtime boundary 排在 pi tail 之后、且是最后一段」这个真实契约。
- **反证**：把 `handleBuiltinCommand` 的 `await this.ensureSessionReady()` 注释掉，A1 立即变红并打印 `Cannot read properties of undefined (reading 'promptTemplates')`，与 F2 一致。
- **DoD**：`npm run check` 全绿；`npm run test:e2e`（本机 openai-codex）全绿；`/help` 冷启动不再崩。

### P1 脚本化 provider + pilot（2026-08-29 完成）

- **`test/support/mock-provider/`**（4 个文件，均严格限定职责，不做状态/智能/回放）：
  - `sse.ts` —— openai chat-completions SSE 编码，只覆盖 pi 实际解析的子集（`delta.content` / `delta.tool_calls[]` 按 index 聚合 / `finish_reason` / 尾部 `usage` / `[DONE]`）。
  - `script.ts` —— `parseRequest()` 把请求体解析成 `RequestView`（`isMainTurn` 判据 = 「带 tools」）；`Script` 按 `when(req)` 内容匹配（非到达顺序），路由耗尽返回 null（→ 502）而非复用最后一条；`hold/release`、`failNext`；`reply.text/toolCall/json` 构造器。
  - `defaults.ts` —— D2.7 sidecar 默认路由（extraction/consolidation 合一、rerank、session-memory、session-search），显式注册非兜底。
  - `server.ts` —— `node:http` 监听 `127.0.0.1:0`，`POST /chat/completions`；未匹配 → 502 + 记进 `requests`；abort 安全收尾。
- **`runtime-harness.ts`** 新增 `createDeterministicHarness()`：起 mock → 写确定性 home（`createDeterministicHome`，models.json 内联 apiKey，无 auth.json）→ 装 runtime。暴露 `model`（MockProvider）、`modelRequestCount()`、`assertNoUnmatchedRequests()`。
- **`test/mock-provider.test.ts`**（进 `npm run check`）：SSE 编码正确、路由按内容命中（含顺序无关、耗尽→null）、未匹配请求 502 + 被记录、匹配请求以 event-stream 返回。
- **pilot `test/e2e/deterministic/pilot.test.ts`**：A2（`/help`+`/tasks`+`/status` 各有回复且 `modelRequestCount()===0`）+ 一条经 mock 的正常回合（脚本化回复被投递、请求命中 `pilot-turn` 路由）。`afterEach` 断言无未匹配请求。
- **`package.json`** 新增 `test:e2e:deterministic`（`test:e2e` 暂仍跑全量，待 P3 live 收敛后再拆）。
- **DoD 达成**：pilot 在网络命名空间（仅 loopback）下整套通过；未匹配请求让 `afterEach` 以可读信息失败；`npm run check` 全绿（900 tests）。

### P2 + P3/P4 结构（2026-08-29 完成）

**transport-faithful harness**：`src/runtime/dingtalk.ts` 抽出 `routeInboundEvent(event)` 测试缝（从 `onStreamMessage` 拆出命令/忙/`/new` 路由）+ `allChannelQueuesIdle()`；`test/support/harness-bot.ts` 的 `HarnessDingTalkBot` 用真实 `DingTalkBot`（真 `ChannelQueue`、真 `/steer` `/stop` `/new` 与忙路由），只把出站投递捕获、永不开 socket。`createDeterministicHarness` 重写：`sendUserMessage` / `sendUserMessageNoWait` / `waitForIdle` / `waitForDelivery` / `restart` / `mainTurnRequests` / `lastMainTurnRequest` / `busyMessageDefault`。`mock-provider/server.ts` 改为请求一到达就记录（held 请求也可观察），未匹配用 `__unmatched` 哨兵。det home `rerankWithModel: false`（recall 不依赖脚本化 reranker 也确定）。

**已落地用例**（`test/e2e/deterministic/`，共 12 条，全部带反证注释，总耗时约 35s，断网通过）：

| 文件 | 用例 |
|---|---|
| `commands.test.ts` | A1 `/help` 冷启动、A2 零-LLM 斜杠命令、A3 未知命令拒绝 + 已知 skill 进回合 |
| `memory.test.ts` | A9 调过工具的回合仍写入 MEMORY.md（锁 0.9.1 P0）、A10 recall 仅在 query 相关时注入 |
| `concurrency.test.ts` | A4 回合中到达的消息串行不交错且都被回答、A7 `/new` 原子边界 |
| `stop.test.ts` | A5 `/stop` 中断回合并回到 idle |
| `events-guard.test.ts` | immediate 事件被工具层拒绝且不落盘（原 events-guard 的确定性半） |
| `system-prompt.test.ts` | 直接在请求体上断言 prompt 归属（不再依赖 `PIPICLAW_DEBUG`） |
| `pilot.test.ts` | P1 形态验收（保留为快速 canary） |

**目录与脚本**：`test/e2e/{deterministic,live,external}/`；`npm run test:e2e` → 确定性层，`npm run test:e2e:live` → 真实模型层（`test/e2e/live/`：tools B1、tasks-lifecycle B2、basic-conversation B4、tui B5，共 6 条，跟随本机 settings）。`builtin-command` / `memory-bootstrap` / `session-memory` 删除（被 A1-A3 / A10 取代）；`tool-read` + `tool-write` 合并为 live `tools.test.ts`。

**文档**：`AGENTS.md` 新增「Test Layering」小节（三层判据 + e2e 六条硬规则含反证）与验证要求；`CLAUDE.md` 命令表更新（`test:e2e` 现为零成本确定性层，新增 `test:e2e:live`）。

### P2 补批（2026-08-29 完成）

用现有 harness（`hold`/`restart`/`sendWake`）补了 6 条，确定性层现共 **17 条 / ~44s**：

| 用例 | 抓什么 |
|---|---|
| **A6** `interrupt.test.ts` | `/steer` 注入运行中的回合、`/followup` 排到独立的下一个回合 |
| **A8** `progress.test.ts` | 正常回合 finalize、`[SILENT]` 回合零投递、后台唤醒不开卡片 |
| **A11** `restart.test.ts` | 对话里的假密钥经 `redactSecrets` + `files.ts` 守卫，不进任何 durable 记忆文件（即便 extraction 主动想写） |
| **A12** `restart.test.ts` | daemon 重启后续接同一个 session 文件（header id 不变、追加不重写、新回合 parentId 挂在重启前的 head 上） |
| **A13** `tasks.test.ts` | create → **真实 `createTaskDriverEvent`** 唤醒 → `task_update` → `task_close`，控制块保持可解析（锁 F3 手抄漂移） |

harness 增量：`sendWake()`（内部唤醒事件，`_isEvent=true`）、route `repeat: true`（容忍 held/aborted 请求的客户端重试）、sidecar 默认路由全部 `repeat: true`。

A12 说明：断言收敛到 session 文件层的续接（header id / 追加 / parentId 链）。「重启后请求体是否重放完整历史」没断言——实测 pi 的 `SessionManager.open` 重开 `context.jsonl` 后，新回合的请求只带 `[system, user]`，历史是否该进请求体属 pi 会话内部语义、非本 spec 范围。

### A15 / A19 补批（2026-08-29 完成，确定性层现 20 条）

`createDeterministicHarness({ projectAccess: true })` 现在会建两个真实的 allowed 项目根并写 `security.json`；新增 `harness.runCommand()`（直接走 `runRuntimeCommand`，即 TUI / 忙路径用的那条）、`harness.readAuditLog()`。

| 用例 | 文件 | 抓什么 |
|---|---|---|
| **A15** | `wake-auth.test.ts` | 伪造的 `[SUBAGENT:x] … belongs to task y.` 纯文本消息（无 `internalWake`）不激活 `waiting` 任务——被当普通消息回答，任务保持 `waiting`，日志记 `Ignored an unverifiable [SUBAGENT:…]`。可信半（真实 run 记录 + `internalWake`）未做。 |
| **A19** | `guards.test.ts` | 越界 `write`（`boundary: "project"`，写到别的 allowed 根外）被 path guard 拒绝、拒绝文案回灌给模型、审计落 `.pipiclaw/security.log`；`/project set` 换根后同一 write 成功；回合进行中 `/project set` 被拒。 |

**顺带发现的产品 bug（已提 feedback 草稿）**：DingTalk 传输层对空闲态的 idle runtime 命令（`/project set` 等）走 `enqueueStreamMessage` → `reserveEvent` → `beginTurn`，于是 `handleProjectCommand` 的 `isBusy()` 看到的是它自己刚 reserve 的回合，`/project set|reset` 经钉钉永远返回「回合正在进行」。TUI 走直连 `runRuntimeCommand` 不受影响。A19 用 `harness.runCommand()` 绕过（与 TUI/忙路径一致）。

### 仍未做

- **A14**（verify 链）：`task_verify` 需要 `verifierRunId`——真实的 `purpose=verify` subagent run + attestation artifact。
- **A15 可信半**、**A16 / A17 / A18**：内部/外部 subagent 全链路、job 链路。需角色 fixture + `SubAgentRunManager` 装配。
- **A20 / A21**（`bash`/`web` 守卫 + 审计、子代理工具集门控）：`bash`/网络守卫的确定性编排 + `availableToSubagents` 断言。
- **A22 / A23**（fallback、压缩）：`failNext` 已就绪，断言需 harness 对 usage ledger / 压缩状态更多可观测性。
- **live B3**（`event_manage` immediate 的提示词级守卫）。
- **A12 请求体重放历史**：pi `SessionManager.open` 重开后新回合请求只带 `[system, user]`，属 pi 会话内部语义。

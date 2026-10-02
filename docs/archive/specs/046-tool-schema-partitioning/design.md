# 工具调用面切分：让非法组合无法表达，把流程知识还给 playbook

| 字段 | 值 |
|------|------|
| 状态 | PROPOSED |
| 日期 | 2026-08-26 |
| 触发 | 对照阅读 deepseek-harness（同为 TypeScript 的开源 agent harness）的工具层后回看本仓库：`task_manage` 与 `subagent` 两个工具占掉工具集 schema 预算的 42%，且两者的"非法字段组合"全部只能在运行时拒绝 |
| 前置 | 015 tool-registry、021 toolset-enhancement、026 system-prompt-slimming、029 task-lifecycle-simplification、034 subagent-invocation-surface、036 task-governance-slimming、040/042 委派、045（去掉模型侧 `label` 参数，本 spec 是同一条线的延续，无 spec 目录） |
| 关联实现 | `src/tools/task-manage.ts`、`src/tools/task-manage/`、`src/subagents/tool.ts`、`src/subagents/discovery.ts`、`src/tools/registry.ts`、`src/tools/index.ts`、`src/tools/tool-details.ts`、`src/tools/presentation.ts`、`src/tools/config.ts`、`src/agent/prompt/sections.ts`、`src/agent/effect-ledger.ts`、`src/tasks/transitions.ts`、`src/playbooks/task-*.md`、`src/playbooks/agent-delegation.md` |

## 摘要

两个工具的 schema 同时承担了三件不同的事：**声明调用形状**、**教模型什么时候用**、**给部署方配置默认值**。三者混在一起的后果是每回合都为后两者付钱，而第一件事反而做不干净——非法字段组合只能在 `execute` 里逐条拒绝。

本 spec 按 payload 形状切分调用面，并把配置与流程知识各自还回它们本来的家：

| 阶段 | 内容 | 解决 |
|---|---|---|
| **P1 描述瘦身** | 把 schema 里的流程长文搬回已经拥有它的 playbook | F1（−729 units，零行为变化） |
| **P2 委派切分** | `subagent` 角色优先；内联控制面移入独立、可门控的 `subagent_inline` | F3/F4（三类运行时拒绝按构造消失） |
| **P3 任务切分** | `task_manage` → `task_list` / `task_create` / `task_update` / `task_close` / `task_verify` | F2（11 处运行时必填检查消失） |

最终不变量：

> 能被代码拒绝的写进 schema；需要模型判断"何时用"的写进 playbook；由部署方决定的写进配置文件，且**关掉的能力，参数从 schema 里彻底消失**。一个工具的参数集合，必须恰好是它这一种调用形状的全部字段。

这条不变量的前两句是 `docs/runtime-playbooks.md`「编写原则」第 5 条已经写下的规矩，只是两个工具没有遵守。

## 当前事实与证据

### 测量口径

以下数字用 `measureToolSchemas`（`src/agent/prompt/manifest.ts:49-60`）的口径实测——即 `name + description + JSON.stringify(parameters)` 的 prompt units，与 `/context` 报告一致。测量前执行 `npm run build`（`dist/` 曾落后于 `src/`，旧产物里还带着 spec 045 已删除的 `label` 字段，会让每个工具虚高 12–17 units）。

### F1 两个工具吃掉 42% 的 schema 预算，且超支主要是流程长文

全量工具集（web 开启）共 **3,060 units**，`TOOL_SCHEMA_TARGET_UNITS = 3_000`（`manifest.ts:35`）已被越过；默认 web 关闭时为 2,902，也只剩不到 100 units 余量——按该常量注释自己的说法，"one more heavyweight tool crosses it, which is exactly when someone should be looking"。

| 工具 | units | 占比 |
|---|---|---|
| `task_manage` | **773** | 25.3% |
| `subagent` | **522** | 17.1% |
| `memory_manage` | 237 | |
| `subagent_manage` | 194 | |
| `bash` | 189 | |
| `event_manage` | 141 | |
| 其余 10 个合计 | 1,004 | |

逐字段拆开看，超支的不是结构而是散文：

```
task_manage 773 = description 44 + schema 728
  planSteps 115   control 109   action 104   wake 62   schedule 57
  plan 48   dod 38   status 29   evidence 21   note 20   其余 12 项合计 135

subagent 522 = description 100 + schema 422
  thinkingLevel 69   mutates 52   returns 45   workingDirectory 43
  context 36   effort 35   purpose 21   paths 20   其余 8 项合计 101
```

`action` 一个字段 104 units，内容是**路由说明加一段验收流程**：

```
"progress" checkpoints work — to wait on an independent verifier, dispatch a
purpose=verify sub-agent with taskId and park like any other delegation
(status=waiting, waitingFor=external-signal)
```

同一段话在 `src/playbooks/task-driving.md`「独立验收」里已经写过，而且写得更完整（含 attestation 校验、advisory 强度、PASS 绑定范围）。schema 版本每回合常驻，playbook 版本按需加载——**贵的那份是删节版**。

`verificationRequired`（在 `control` 的 109 里）、`schedule` 的 57、`wake` 的 62 是同一类：都在解释策略与语义，而不是声明字段契约。

### F2 `task_manage` 的合法性全靠运行时逐条拒绝

`taskManageSchema`（`src/tools/task-manage/schema.ts:29`）是"一个 action 枚举 + 18 个按 action 生效的可选字段"。schema 层能表达的只有"这些字段都可选"，于是每一条真实约束都落在代码里：

- **7 处** `action "X" requires an id.`（`create.ts:14`、`lifecycle.ts:31,55,96,191,227`、`verification.ts:23`）
- **8 处** `requiredField(...)`（`shared.ts:36` 的辅助函数 + `lifecycle.ts:57,193,229`、`verification.ts:25`、`shared.ts:45,75,76,77`）

合计 15 处运行时检查，全部只为了表达"这个 action 的这个字段是必填的"。模型要付两次代价：schema 里读到"Required for create/progress/set/complete"这种含混措辞，调错了再吃一轮 `RecoverableToolError` 往返。

`TaskManageRequest`（`types.ts:40`）上方的注释记录过这个坑的历史后果——schema 曾经广告 `parent`/`dependsOn`/`verificationMode` 三个写入时被静默丢弃的字段，而真正生效的 `verificationRequired` 反而不在 schema 里，"no model could ever ask for it"。spec 036 D8 用"从 schema 派生请求类型"堵住了一半；剩下的一半（每个 action 的必填字段）在单 schema 形态下**无法**用类型表达。

### F3 `subagent` 把部署配置当成模型的每次决策

`subagentSchema`（`src/subagents/tool.ts:57`）向模型开放 16 个字段。对照角色文件的 `SubAgentConfig`（`discovery.ts:87-126`），其中 7 个在角色文件里已有同名字段：

| 调用参数 | 角色文件字段 | 真的需要逐次决定吗 |
|---|---|---|
| `systemPrompt` | `systemPrompt` | 仅当没有角色匹配 |
| `tools` | `tools` | 否 |
| `model` | `model` / `modelRef` | 否 |
| `effort` | 四个 budget 数值 | 否 |
| `context` | `contextMode` + `memory` | 否 |
| `thinkingLevel` | `thinkingLevel` | 否 |
| `mutates` | `mutates` | 仅内联且带 `bash` 时 |
| `paths` | `paths` | 否（见 F5） |

而工具描述的第一句是：

```
Default path: pass an inline systemPrompt (plus optional tools/model) to define
a temporary sub-agent — no configured agent is required.
```

同时 `examples/sub-agents/` 已经提供 12 个成熟角色（含 `runtime: external` 的 codex/claude-code 角色），`SUBAGENTS_SECTION`（`prompt/sections.ts:130-153`）已经把它们按 (runtime, workload, mutates) 分组注入系统提示，`renderSubAgentDirectory` 也已实现。**目录建好了，工具却在劝模型别用它。**

### F4 "选角色"和"定义角色"挤在一个工具里，产生三类只能运行时拒绝的组合

`resolveSubAgentConfig` 有三段专门处理"命名了外部角色，又传了内联覆盖"：

```
discovery.ts:868   external + tools    → 拒绝
discovery.ts:875   external + model    → 拒绝
discovery.ts:884   external + mutates  → 拒绝
```

spec 042 D3 加这三段是对的——此前这些字段"either dropped on the floor or ... made to fail a dispatch for a reason that has nothing to do with the external role actually named"。但它们存在的**根因**是一个工具同时承担了两种语义。这不是补丁写得不好，是切分位置不对。

### F5 三个字段是纯冗余

- **`paths`（20 units）**：唯一效果是往任务信封里 prepend 一段文本（`tool.ts:669-670`），外加参与 recall query 拼接（`tool.ts:695`）。这在 `task` 正文里一句话就能写，却让模型每次调用都要做一个额外决策。角色文件的 `paths`（真正的默认值）不受影响。
- **`name`（12 units）**：内联委派的显示名。spec 045 刚刚以"模型不该为 UI 字符串付 schema 和输出 token"为由删掉了全局 `label` 参数，`runLabel` 现在由 `tool.ts:817` 派生。`name` 是同一类残留。
- **`returns`（45 units）**：外部角色已经整体拒绝它（`tool.ts:830-836`），报错原文是 "State the desired output file in the task text instead."。对内部角色应当是同一条路径——**要文件就在 task 里说**，而不是维护两套表达同一意图的机制。ARTIFACT marker 协议只服务 `returns: "artifact"` 这一个分支。

### F6 `event_manage` 是本仓库自己的正面样本

`event_manage`（141 units）同样是 action 工具，却很便宜：它只有 `action` / `name` / `definition` 三个参数，payload 是不透明 JSON 串（`event-manage.ts:15-29`），格式细节交给 `event-scheduling.md`。

这说明"action 工具 = 贵"是错误归因。**贵的是把 playbook 抄进 schema**，不是 action 这个形状本身。

### F7 deepseek-harness 的切分规则是形状而非动词

对照读完它的工具层，规律有三条，且第一条常被误读：

**（a）按 payload 形状切，不是按动词切。** 它有 40+ 个工具且没有一个 `*_manage(action=...)`，但 `update_goal`（`packages/goal/tool-goal/src/index.ts`）恰恰带 `action: edit|pause|resume|complete|blocked` 和按 action 生效的可选字段。真正的切法是 `get_goal`（0 参数）/ `create_goal`（2 参数）/ `update_goal`（id + revision + action + 3 个可选）——**读、建、改状态三种形状分开，同一形状内的状态迁移合在一起**。`job_list|output|kill`、`terminal_open|close|list|read|send|signal` 同理。

**（b）部署配置不进 schema。** `tool-subagent` 的 `Config` 有 `provider`、`agentOptions`、`persona`、`toolFilter`、`maxDepth`——一个都不暴露给模型；模型只看到 `description`、`prompt`、`run_in_background`。同一插件按不同 `toolName` 可挂多份，一份对应一个配置好的执行者。

**（c）关掉的能力，参数消失。** `enableRunInBackground: false` 时 `run_in_background` 不出现在 schema 里，且 `execute` 里再拒一次（"The validator permits undeclared keys, so schema omission also needs execution-time enforcement."）。描述本身也随配置变化——`describe(allowParallel)` 只讲当前生效的那条策略，不留"某些情况下无效"的措辞。

### F8 实测：切分不省 token，省 token 的是描述瘦身

把候选 schema 完整写出来实测（同一 `countPromptUnits` 口径），结果推翻了直觉：

**任务侧**

| 形态 | units | Δ |
|---|---|---|
| 今天（单工具，长描述） | 773 | — |
| 单工具 + 描述瘦身 | **374** | −399 |
| 拆 5 工具 + 描述瘦身 | **553** | −220 |
| 拆 6 工具（`set` 独立成 `task_repair`） | 655 | −118 |

**委派侧**

| 形态 | units |
|---|---|
| 今天 | 522 |
| `subagent`（角色优先） | **134** |
| `subagent_inline` | 277 |
| 两个都挂 | 411（−111） |
| 只挂角色版 | 134（−388） |

结论要说清楚：**描述瘦身是纯赚（−729 units），切分要倒贴（任务侧 +179，委派侧相对单工具方案 +217）**。倒贴来自重复的 `id`、重复的 status/wake/control 块、以及每个工具自己的名字和描述。

所以这是两笔独立的账。切分**不是** token 优化，是用 179 + 217 units 买 schema 层的合法性；而这笔钱之所以付得起，是因为瘦身把预算腾了出来。P1 必须先落地，否则 P2/P3 会把工具集推得更靠近 3,000 线。

## 设计原则

**P1 三种知识各归其位。** 能被代码拒绝的（必填、枚举、格式）→ schema；需要模型判断何时用的（流程、策略、取舍）→ playbook；部署方决定的（默认模型、预算、可用能力）→ 角色文件或 `tools.json`。一句话出现在两处即为缺陷。

**P2 非法组合应当无法表达，而不是被拒绝。** 拒绝要付两次代价：schema 里的含混措辞 + 一轮往返。凡是"字段 X 只在 action Y 下有效"，就说明切分位置不对。

**P3 关掉的能力，参数消失。** 不留"某些情况下无效"的字段，也不留只在部分运行时生效的描述。

**P4 切分只用独立工具，不用 root-level union。** TypeBox 的判别式联合（`Type.Union` of `Type.Object`）在类型层可行，`Static<>` 也能正确派生，但 `pi-ai` 的 `Tool.parameters`（`node_modules/@earendil-works/pi-ai/dist/types.d.ts:356-361`）会走 `constrainedSampling: { strict: "prefer" | "require" }` 的 JSON-Schema 约束采样，而 `models.json` 允许接任意 OpenAI 兼容端点。root-level `oneOf` 在 OpenAI strict function calling 下不被接受。**独立工具是唯一在所有 provider 上都成立的 schema 层拒绝机制**——这也是 F7 里那 40+ 个工具的真实成因。

## D1 描述瘦身（P1）

只动两处 schema 的字符串，不动任何签名、不动任何行为。

### D1.1 搬家清单

| 现在在 schema 里 | 去向 | 理由 |
|---|---|---|
| `action` 的验收流程段（104 → ≈20） | 删；`task-driving.md`「独立验收」已完整覆盖 | 重复且是删节版 |
| `control.verificationRequired` 的策略说明 | `task-planning.md` | 何时该要求独立验收是判断题 |
| `schedule` 的"改动会重算 wake 除非同一次调用显式设 wake" | `task-planning.md`「周期 schedule」 | 跨字段流程 |
| `wake` 的时区与相对偏移解释（62 → ≈40） | 压成一行格式示例；语义归 `task-driving.md`「等待与恢复」 | 格式留 schema，语义归 playbook |
| `planSteps` 的"Requires the task to already have a `## Plan` section..."（115 → ≈60） | `task-planning.md` | 前置条件是流程 |
| `subagent` 描述里的 "Default path: pass an inline systemPrompt..." | 反转口径，见 D2 | 与 F3 直接冲突 |
| `thinkingLevel` 的内部/外部默认值差异（69） | `agent-delegation.md` | 部署事实，非调用契约 |
| `mutates` 的"Defaults to inference from `tools`（看不见 bash）"（52 → ≈30） | 保留核心告警，细节归 `agent-delegation.md` | 这条是安全相关，保留一句 |

**保留**的例子：`dod` 的 "Plain prose or a numbered list without checkboxes is rejected"——它是 schema 的拒绝理由，属于参数契约（`create.ts:28-29` 真的会拒）。判据始终是那一条：**代码会不会因为这句话拒绝调用**。

### D1.2 playbook 侧的对应改动

三份 playbook 需要吸收搬过去的内容，且必须遵守 `docs/runtime-playbooks.md` 第 9 条的 60 行软上限：

- `task-planning.md`：补 `verificationRequired` 的判断条件、`schedule` 的 wake 重算语义、`planSteps` 的 `## Plan` 前置。
- `task-driving.md`：已有的验收段落不需要改，但要确认 schema 删掉的那段没有遗漏信息（当前对照下没有）。
- `agent-delegation.md`：补 `thinkingLevel` 的内外差异、`mutates` 的推断盲区。

P1 单独可发布，且**不需要跑行为 eval 就能合**——但仍然要跑一遍作为 P2/P3 的 baseline（见「阶段与验收」）。

## D2 委派切分（P2）

### D2.1 两个工具，两种语义

**`subagent`**（≈134 units）——常规路径，选一个已配置的角色：

```
agent              required  角色名（来自系统提示里的 Sub-Agents 目录）
task               required  完整、自足的任务
workingDirectory   optional  运行目录（如 git worktree）
purpose            optional  work | verify
taskId             optional  purpose=verify 时必填
```

**`subagent_inline`**（≈277 units）——没有角色匹配时的一次性内联执行者：

```
task               required
systemPrompt       required  定义这个一次性子代理
tools              optional  工具白名单
model              optional  精确模型引用
mutates            optional  read | write（带 bash 时必须自己声明）
effort             optional  quick | standard | deep
context            optional  none | session | relevant
thinkingLevel      optional
workingDirectory / purpose / taskId  同上
```

**`subagent_inline` 没有 `agent` 字段，`subagent` 没有任何覆盖字段。** F4 的三类组合（外部角色 + `tools` / `model` / `mutates`）因此无法表达，`discovery.ts:868-888` 三段拒绝可以删除。

`SubAgentInvocationOverrides`（`discovery.ts:139-154`）随之拆成两个类型，`resolveSubAgentConfig` 拆成 `resolveConfiguredRole`（查表 + 校验可用性）和 `resolveInlineAgent`（校验 + 落默认值）两条更短的路径。

### D2.2 删掉 `paths` / `name` / `returns`

按 F5。三者合计 77 units，且各自消掉一个模型侧决策点。

`returns` 的删除是唯一有能力损失的一项，需要明确：`returns: "artifact"` 今天让子代理把主产物写文件并以 `ARTIFACT: <filename>` 结尾，工具据此填 `details.artifactPath`。删除后 `SubAgentToolFields.artifactPath` 一并删除；`artifactDir`/`output.md`（spec 032 D4，无条件保存完整输出）保留。需要指定输出文件的调用，在 `task` 正文里写清路径——这正是外部角色分支今天给出的建议。

**须核实**：`/subagents show`（`runtime/subagent-commands.ts`）与 `subagent_manage op=show` 是否渲染 `artifactPath`；如渲染则一并清理。

### D2.3 门控：`tools.subagentInline.enabled`

新增于 `tools.json`（`src/tools/config.ts:35-54` 的 `PipiclawToolsConfig`），不是 `settings.json`——工具的开关一律在 `tools.json`，与 `tools.tasks.enabled`、`tools.web.enable`、`tools.rtk.enabled` 同族。

**本版默认 `true`**，不破坏现有行为。文档口径写成"角色目录覆盖你的工作之后就把它关掉"；关掉后整个委派面只剩 134 units。默认值是否翻转，留给后续版本按真实部署的角色覆盖率决定，不在本 spec 内预设。

不做"角色目录非空则自动关闭内联"的推导式默认：`rebuildSessionTools` 会在 workspace 写入时重建工具集，一次角色文件新增就会让工具集抖动，行为难以解释。

### D2.4 `EFFECT_TOOLS` 必须同步（易漏，且后果严重）

```ts
// src/agent/effect-ledger.ts:27
const EFFECT_TOOLS = new Set(["write", "edit", "send_media", "subagent"]);
```

这是硬编码的工具名集合。**忘记加 `subagent_inline`，一个全靠内联委派推进的任务会被治理器判为连续三次 wake 无 effect 而停用**（`task-driver.ts:134-163`）——正是该文件注释里描述过的那类"最努力的 wake 最容易被判定为空转"的故障。

同一注释还写着"Self-report tools (`task_manage`, `memory_manage`) ... do not count"，P3 之后需要把 `task_manage` 改写成新的任务工具族名称。

### D2.5 实现切分

`subagents/tool.ts` 现有 1,439 行里，schema 之外的主体（`prepareRunContext`、`assertVerifyAdmissible`、workspace lease、外部/内部两条派发、`settleForegroundRun` 等价逻辑）**两个工具完全共用**。切分方式是抽出一个内部 `dispatchSubAgentRun(options, resolved, runContext)`，两个 `createXxxTool` 只负责各自的 schema 与"参数 → `ResolvedSubAgentConfig`"这一步。

`subagent_manage` 不动（194 units，list/cancel/show 共享 `runId` 且形状一致，正是该合的情况；拆成四个反而更贵）。

## D3 任务切分（P3）

### D3.1 五个工具

| 工具 | 参数 | units |
|---|---|---|
| `task_list` | （无） | 14 |
| `task_create` | id, title, goal, dod, plan?, manual?, verificationPlan?, verificationRequired?, status?, wake?, schedule?, deadline? | 162 |
| `task_update` | id, note?, planSteps?, status?, wake?, schedule?, control? | 243 |
| `task_close` | id, outcome, summary?, evidence?, residualRisk?, reason? | 93 |
| `task_verify` | id, verifierRunId | 41 |
| | **合计** | **553** |

`task_close` 保留 `outcome: complete | skip | cancel` 枚举，不再拆：三者共享 `id`，payload 只差 summary/evidence/residualRisk 与 reason，正是 F7(a) 里 `update_goal` 那个"同一形状内的状态迁移"。拆开只会重复 `id` 和工具描述。

`task_create` 的 `deadline` 与 `verificationRequired` **拍平**为顶层可选字段，不再走嵌套 `control`：创建时 `waitingFor` 和 `nextAction` 都没有意义（`renderTaskSkeleton`，`shared.ts:79-83`，本来就只读 `control.verificationRequired`）。`task_update` 保留完整嵌套 `control`。

### D3.2 `set` 折进 `task_update`，判据是 `note` 的有无

这是本节唯一有实质语义变化的决定，需要说清楚。

今天 `progress` 与 `set` 的差别有三处：

| | `progress` | `set` |
|---|---|---|
| transition `from` | `WORKABLE`（active/waiting），且显式拒绝 sleeping（`transitions.ts:37` + `lifecycle.ts:62`） | `LIVE`（含 sleeping）（`transitions.ts:46`） |
| `note` | 必填（`lifecycle.ts:57`） | 不接受 |
| 坏 control 修复 | 否 | 是（`allowControlRepair`，`lifecycle.ts:34`） |

三处差别其实是同一条规则的三个侧面：**写 Current Cycle 就意味着这个 cycle 是开着的**。合并后规则变成一句话：

> 带 `note` = 对一个开着的 cycle 做 checkpoint → 仅 active/waiting。
> 不带 `note` = 纯元数据修改 → 允许 sleeping，允许重写不可解析的 control 行。

`resolveTaskTransition`（`transitions.ts:65`）的 `set` / `progress` 两条规则合并为一条按 `note` 分支的 `update`；`readTaskDocument` 的 `allowControlRepair` 条件从 `request.control !== undefined` 改为 `note === undefined && request.control !== undefined`（更严：修复 control 必须走元数据路径，不能混在 checkpoint 里）。

这条规则比它替代的两个 action 名更短、更好陈述，并且没有放宽任何一处约束。

**曾考虑并驳回**：保留独立的 `task_repair`（第六个工具）。实测 655 units（比五工具方案贵 102），且需要模型在"改元数据"和"记进展"之间先做一次工具选择——而这个选择恰恰可以由"这次调用有没有 note"自动回答。

### D3.3 消掉的运行时检查

| 检查 | 数量 | 处置 |
|---|---|---|
| `requires an id` | 7 | 全消：`id` 在四个工具里都是 schema 必填，`task_list` 无此参数 |
| create 的 title/goal/dod | 3 | 全消：`task_create` 里 schema 必填 |
| `verifierRunId` | 1 | 消：`task_verify` 里 schema 必填 |
| `note` | 1 | 语义改变：从"必填"变成"有无决定路径"（D3.2） |
| complete 的 summary/evidence、skip/cancel 的 reason | 3 | 保留：`task_close` 内按 `outcome` 分支，与 `update_goal` 同型 |

15 → 4，其中 3 条是有意保留的形状内分支。`parseAction`（`schema.ts:139`）与 `dispatchTaskMutation`（`task-manage.ts:33`）整体删除。

`TaskManageRequest` 从一个 `Static<>` 变成五个（`TaskCreateRequest` 等），spec 036 D8 的"派生类型防漂移"收益随之翻倍：每个 action 的必填字段在类型层就是非可选。

### D3.4 互斥锁必须跟着搬

`manageTask`（`task-manage.ts:23-31`）目前在 dispatcher 层套 `withTaskMutation`。删掉 dispatcher 后，四个带 `id` 的工具各自在 `execute` 里套同一个 helper。`withTaskMutation`（`tasks/mutation-lock.ts:20`）是可重入的按路径串行队列，行为不变——**但这是切分中最容易静默丢掉的一环**，验收里必须有一条并发用例。

### D3.5 命名风险：`task_update` 是否稀释 checkpoint 纪律

`progress` 这个词本身在承载语义——"每回合结束必须留下状态"是 `task-driving.md` 的核心纪律，`TASK_CORE_SECTION`（`prompt/sections.ts:98-113`）和 `task-driver.ts:209` 都在强化它。改叫 `update` 有让模型把它当成"可选的元数据操作"的风险。

对策不是换个名字了事，而是让描述承担：`task_update` 的描述以 checkpoint 含义开头，元数据用法放后半句。**是否真的稀释，由 D5 的 `T-route-01` 用数据回答**——这正是需要行为 eval 而非讨论来决定的部分。

曾考虑 `task_progress`（保留纪律词，但"不带 note 的 progress"读起来自相矛盾）与 `task_checkpoint`（更准，但与 `task_close` 不成对）。倾向 `task_update` + 强描述，eval 不过则回退 `task_progress`。

## D4 血缘：切分后必须同步的位置

切分工具名会波及一批按名字硬编码的表。逐条列出，因为其中三处失败时是**静默**的：

| 位置 | 改动 | 失败模式 |
|---|---|---|
| `tools/tool-details.ts:26-43` `ToolDetailsKind` | 加新名、删旧名 | 编译错误（响） |
| `tools/registry.ts` `TOOL_REGISTRY` / `TOOL_NAMES` | 同上 | `TOOL_NAMES` 缺项会让 playbook 的 `requires-tools` 在加载时抛错（响，见 `playbooks/catalog.ts:62`） |
| `tools/presentation.ts` `DESCRIBERS` | 每个新工具一个 describer | `test/tool-presentation.test.ts:6` 断言每个 `TOOL_NAMES` 都有 describer（响） |
| `tools/index.ts:89,116` | 注册 `subagent_inline` | — |
| `tools/config.ts` | 加 `subagentInline` | — |
| **`agent/effect-ledger.ts:27`** | 加 `subagent_inline` | **静默**：治理器误停任务（D2.4） |
| **`agent/prompt/sections.ts:104`** | `requiresAllTools: ["task_manage"]` → 新名 | **静默**：`## Persistent Work` 提示段整段消失（`builder.ts:152` 是 all-of），且**当前无任何测试断言它出现**（见 D6） |
| **`agent/prompt/sections.ts:136`** | `requiresAllTools: ["subagent"]` | 名字不变，但需确认门控意图是"有委派能力"而非"有这个工具" |
| `playbooks/task-planning.md:4`、`task-driving.md:4` | `requires-tools` 改名（any-of） | 响（`catalog.ts:62` 校验） |
| `runtime/task-commands.ts` 7 处诊断文案（`:466,477,507,516,535,568,652`） | `用 task_manage set …` → 新名 | **静默**：`/tasks doctor` 教用户和模型用不存在的工具 |
| `runtime/task-driver.ts:209-210` | 唤醒提示里的工具名 | 静默：同上 |
| `subagents/tool.ts:346` | `Create it with task_manage before delegating` | 静默 |
| `test/tools-index.test.ts:232-248` | 精确的工具名有序列表断言 | 响 |
| `docs/tools.md:29-30,87-93`、`docs/sub-agents.md`、`docs/events-and-tasks.md`、`docs/architecture.md` | 用户手册 | — |

**不留 `task_manage` / 旧 `subagent` 别名**：AGENTS.md「prefer moving code into the right module over adding compatibility aliases」。

历史 session 的兼容性已核实安全：`describeToolCall`（`presentation.ts:97-103`）对未知工具名 fallback 到名字本身，`toolResultDetails`（`tool-details.ts:57`）对未知 `kind` 返回 `null`，且全仓库无任何消费者读 `task_manage` 结果的 `details.action`。旧 `context.jsonl` 里的 tool_use/tool_result 对不会因为工具集变化而失效。

## D5 行为 eval

切分是否真的改善路由，必须由数据回答，不能由 schema 好看程度回答。做法：**先在旧形态上补三个 case 并跑出 baseline，切分后不得低于 baseline**。

`evals/harness/graders.ts` 的 `tracePredicate` 已能断言 `event.tool` 与 `event.fields`（`A-delegate-01` 就是这么断言 `subagent` + `agent === "eval-scout"` 的），无需扩展 harness。

| 新 case | 断言 | 防的是 |
|---|---|---|
| `T-route-01` | 一次任务驱动 wake 后，末回合必须命中 `task_update` 且 `fields.note` 非空 | D3.5 的命名稀释风险——**本方案最大的行为风险** |
| `T-route-02` | 面对不可解析的 control 行，必须走不带 `note` 的 `task_update`，不得误用 `task_close` 或 `edit` | `set` 折叠是否可被模型正确发现 |
| `A-route-01` | 存在可覆盖的已配置角色时，必须命中 `subagent(agent=…)`，不得走 `subagent_inline` | D2 的"角色优先"是否真的成立 |

`evals/gates.json` 三条先登记为 `report-only`，取得两轮稳定读数后再提 `required`。

已有的 `T-resume-03`、`T-deadline-01`、`A-delegate-01`、`S-verify-01`（均为 `required`）是回归护栏，三个阶段各跑一轮。

## D6 提示段门控的测试缺口（切分前必须先补）

排查血缘时发现一个既有缺口，它会让 D4 表里最危险的那一行**在 CI 上完全无声**：

`TASK_CORE_SECTION`（`prompt/sections.ts:98-113`）以 `requiresAllTools: ["task_manage"]` 门控整段 `## Persistent Work`。而 `test/prompt-sections.test.ts` 对这段只有**反向**断言：

```ts
// test/prompt-sections.test.ts:145 —— 工具关掉时不出现
expect(build.text).not.toContain("## Persistent Work");
```

全仓库没有任何"工具开着时它应当出现"的断言（`rg '## Persistent Work'` 只有渲染处和这一行）。更糟的是该测试的工具夹具 `ALL_TOOLS`（`test/prompt-sections.test.ts:16-32`）是手工维护的字符串数组，且**已经漂移**——里面还留着 spec 045 删掉的 `skill_manage`。

于是重命名 `task_manage` 之后：夹具里的旧名字仍然让 `requiresAllTools` 在测试里"看起来"满足或不满足，而真实运行时整段提示消失，`npm run check` 全绿。

两处修复，都放在 P1（此时还没有任何重命名，改动纯粹、可独立验证）：

1. 给 `## Persistent Work`、`## Sub-Agents` 各补一条正向断言。
2. 把 `ALL_TOOLS` 改为从 `TOOL_NAMES`（`tools/registry.ts`）派生，让夹具无法再与真实工具集漂移——顺带修掉现存的 `skill_manage` 残留。

这与 `test/tool-presentation.test.ts` 和 `test/tool-registry.test.ts` 的做法一致：**凡是按工具名硬编码的表，都应当以 `TOOL_NAMES` 为唯一来源对账**。本 spec 把这条推广到最后一处未覆盖的地方。

## 不做什么

- **不拆 `subagent_manage`**（194 units）。list/cancel/show 共享 `runId` 且形状一致，`follow_up` 只多一个 `task`——拆成四个工具更贵且没有换来任何合法性。
- **不拆 `memory_manage`**（237 units）。它的 `save`/`search`/`forget` 三种 payload 完全不相交（content+kind+supersedes / query / target），形状上比 `task_manage` 还干净，是下一个自然候选；但等本 spec 三阶段落地、D5 的读数出来之后再动，避免同时改两个域。
- **不动 `event_manage`**。见 F6，它已经是正确的形态。
- **不改任务文件格式、frontmatter、control JSON、attestation 或 run 记录的任何持久化结构。** 本 spec 只动调用面。
- **不改 `settings.json`**（按 CLAUDE.md：只接受产品意图；本 spec 引入的开关属于工具可用性，归 `tools.json`）。
- **不引入数值阈值型配置。** 本 spec 不新增任何常量到配置文件。
- **不用 root-level union schema。** 见 P4。
- **不做 `subagent` 的多实例注册**（deepseek 的"一个角色一个 `toolName`"）。本仓库的角色目录是 workspace 内容、可热编辑，把它映射成工具名会让工具集随文件变动而抖动，且 `SUBAGENTS_SECTION` 已经用一段提示解决了同一个"让角色可发现"的问题，成本远低于 N 个工具 schema。

## 阶段与验收

三个阶段独立可合并、可发布，且**必须按序**：P1 先腾出预算，P2/P3 才付得起切分的代价。

### P1 描述瘦身

改：`tools/task-manage/schema.ts` 的字符串；`subagents/tool.ts:57-131` 的字符串；`playbooks/task-planning.md`、`task-driving.md`、`agent-delegation.md` 吸收搬过去的内容；`test/prompt-sections.test.ts` 按 D6 加固。

验收：
- `task_manage` ≤ 380 units，`subagent` ≤ 200 units，工具集总量 ≤ 2,350（web 开启）。
- 三份 playbook 正文（不含空行）仍在 60 行软上限内。
- 无任何签名、类型、行为变化——`npm run check` 全绿且 `test/task-manage.test.ts`、`test/subagent-invocation-matrix.test.ts` 零改动通过。
- `T-resume-03` / `T-deadline-01` / `A-delegate-01` / `S-verify-01` 不低于 `evals/baselines/latest.json`。
- D6 的两处修复完成：`## Persistent Work` / `## Sub-Agents` 有正向断言；`ALL_TOOLS` 夹具改为从 `TOOL_NAMES` 派生（并修掉 `skill_manage` 残留）。
- 补齐 `T-route-01` / `T-route-02` / `A-route-01` 并在本阶段取得 baseline。

### P2 委派切分

改：`subagents/tool.ts` 拆 schema + 抽 `dispatchSubAgentRun`；`discovery.ts` 拆 overrides 类型、删三段外部拒绝；删 `paths`/`name`/`returns` 及 ARTIFACT marker 分支；`tools/index.ts`、`config.ts`、`registry.ts`、`tool-details.ts`、`presentation.ts`、**`effect-ledger.ts`**。

验收：
- `subagent` 134 ± 10 units；`subagentInline.enabled: false` 时工具集不含 `subagent_inline` 且**调用它必须被拒**（F7(c)：schema 省略之外还要有执行期拒绝）。
- 外部角色 + `tools` / `model` / `mutates` 的组合在两个工具上都无法构造（类型层）。
- `subagent_inline` 计入 `EFFECT_TOOLS`：一个只用内联委派推进的任务，连续三次 wake 后**未**被治理器停用。
- workspace write lease、`purpose=verify` 的准入、外部 run 的信封与审计路径行为不变（`test/subagent-tool-lease.test.ts`、`test/subagent-external-envelope.test.ts` 通过）。
- `A-route-01` 不低于 P1 baseline。

### P3 任务切分

改：`task-manage.ts` 拆成五个工厂并删 dispatcher；`schema.ts` 拆五份并删 `parseAction`；`types.ts` 派生五个请求类型；`lifecycle.ts` 合并 `setTask`/`progressTask`；`transitions.ts` 合并两条规则；D4 表里的全部下游。

验收：
- 五个工具合计 553 ± 20 units。
- 同一任务的并发调用仍被 `withTaskMutation` 串行（D3.4，专门用例）。
- `task_update` 不带 `note` 可作用于 sleeping 任务并修复不可解析的 control；带 `note` 时对 sleeping 仍被拒。
- 带 `note` 时**不允许**修复 control（比今天更严，需显式用例）。
- `complete` 的验收门（attestation、contract hash、artifact subject、advisory 提示）逐条不变（`test/task-verification-flow.test.ts` 通过）。
- 周期任务的 `skip` → sleeping → 下一 occurrence 链路不变。
- `/tasks doctor` 的每条 Next step 指向真实存在的工具名。
- `T-route-01` / `T-route-02` 不低于 P1 baseline；`T-resume-03` / `T-deadline-01` 不低于 baseline。

## 测试计划

**改造成本集中在三个文件**，且都是机械替换：

- `test/task-manage.test.ts`（283 行，17 处 `manageTask(o, { action: "X", ... })`）→ 直接调用 `createTask` / `updateTask` / `closeTask` / `verifyTask` / `listTasks`。这些函数今天已经是分离导出的，实现体基本不动。
- `test/task-verification-flow.test.ts`（187 行，约 10 处同上）。
- `test/tools-index.test.ts:232-248` 的有序工具名列表。

`test/subagent-invocation-matrix.test.ts`（193 行）需要按两个工具重新组织矩阵；`test/tool-subagent-manage.test.ts`（895 行）不受影响（`subagent_manage` 不变），但 `follow_up` 复用 `buildSubAgentTask`/`buildContextualBlocks`，抽取 `dispatchSubAgentRun` 时须确认这两个导出仍在。

**新增**：
- `test/task-update-merge.test.ts`：D3.2 的四象限（note × sleeping、note × 坏 control、无 note × sleeping、无 note × 坏 control）。
- `test/task-mutation-lock.test.ts`：D3.4 的并发串行。
- `test/subagent-inline-gate.test.ts`：D2.3 的门控（关闭时工具不出现 + 执行期拒绝）。
- `test/effect-ledger.test.ts` 补一条 `subagent_inline` 计入 effect 的断言（D2.4）。

`test/tool-presentation.test.ts` 与 `test/tool-registry.test.ts` 因为断言的是"每个注册名都有对应项"，切分后**自动**覆盖新工具，无需改造——这两个测试的设计在此得到验证。`test/prompt-sections.test.ts` 是唯一没有这样设计的，D6 把它拉齐。

## 风险与回滚

| 风险 | 评估 | 处置 |
|---|---|---|
| `task_update` 稀释每回合 checkpoint 纪律 | **高**——`progress` 一词本身在承载语义（D3.5） | `T-route-01` 在 P1 就取得 baseline；不过则回退 `task_progress` |
| 漏加 `subagent_inline` 到 `EFFECT_TOOLS`，治理器误停任务 | **高**——静默，且要连续三次 wake 后才显形 | D2.4 单列；P2 验收有专门用例 |
| `prompt/sections.ts:104` 的 `requiresAllTools` 漏改，`## Persistent Work` 静默消失 | 中——all-of 门控，无警告，且今天只有反向断言 | D6 先补正向断言并把测试夹具改为从 `TOOL_NAMES` 派生，P1 阶段完成 |
| `withTaskMutation` 在拆 dispatcher 时丢失 | 中——并发写任务文件会互相覆盖 | D3.4；P3 验收专门用例 |
| 删 `returns: "artifact"` 造成能力回退 | 中 | ARTIFACT marker 的替代路径（task 正文写明输出路径）已是外部角色的现行建议；`output.md` 无条件保留 |
| 切分后工具数从 16 增至 20，模型选择成本上升 | 中——本 spec 的主要未量化风险 | 这正是 `T-route-01/02` + `A-route-01` 要测的；若路由准确率下降，可先合并 `task_verify` 进 `task_update` |
| `/tasks doctor` 或 driver 提示遗留旧工具名 | 低但尴尬——会教模型调不存在的工具 | D4 列出全部 10 处；可用 `rg 'task_manage'` 收口 |
| 描述瘦身把真正必要的约束一起删掉 | 低 | 判据明确：代码是否会因此拒绝调用；P1 不改任何拒绝逻辑，可逐条对照 |

回滚粒度即阶段粒度：三个阶段是三次独立提交，`git revert` 单个提交即可回到上一个自洽状态。P1 无行为变化，回滚零风险；P2/P3 因为不触碰任何持久化结构，回滚后既有任务文件与 run 记录仍可用。

## 对文档的影响

- `docs/tools.md`：第 29–30 行的工具表改名并加 `subagent_inline` 行；第 33 行"被委派的执行者不能再调用 `subagent`、`task_manage`..."需列全新工具名；第 87–93 行的机制说明同步。
- `docs/sub-agents.md`：改写为"角色优先"口径，内联作为显式高级模式；说明 `tools.subagentInline.enabled`。
- `docs/events-and-tasks.md`：任务工具族改名。
- `docs/configuration-reference.md`：新增 `tools.subagentInline.enabled`。
- `docs/architecture.md` 与 `CLAUDE.md` 的 Tools 段：补一句"一个工具的参数集合恰好是它这一种调用形状的全部字段"。
- `docs/runtime-playbooks.md`：目录表随 `requires-tools` 改名同步（`test/playbooks.test.ts` 会对账）。
- `docs/specs/README.md`：主题分组表加 `046` 一行；`045` 与 `041` 同为"有代码引用、无 spec 目录"的编号，README 已有 `041` 的说明段，需补 `045`。
- spec 029/034/036/040/042 中关于 `task_manage` 单工具形态和 `subagent` 调用面的描述**保留为历史，不改写**（按 specs README 的维护规则）。

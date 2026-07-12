# Pipiclaw System Prompt 架构与优化实施方案

| 字段 | 值 |
|------|------|
| 状态 | Phase 1–3 代码完成；Phase 0 行为 eval 与 DoD 11/12 待补；Phase 4 未启动 |
| 日期 | 2026-07-12 |
| 入口 | `src/agent/prompt/`（builder / sections / resources / manifest / extension） |
| 主要依赖 | `@earendil-works/pi-coding-agent@0.80.3` |
| 关联设计 | [003 Context Upgrade](../003-improve-memory/design.md)、[015 Tool Registry](../015-tool-registry/design.md)、[021 Toolset Enhancement](../021-toolset-enhancement/design.md)、[024 Task Loop V2](../024-task-loop-v2/design.md) |

---

## 0. 实施记录（2026-07-12）

Phase 1–3 已落地，代码入口 `src/agent/prompt/`：

- `systemPromptOverride` 接管基础 prompt，pi 默认身份段/文档索引/`(none)` 工具段不再发送；`appendSystemPromptOverride` 与 `agentsFilesOverride` 清空，SOUL/AGENTS 由 Pipiclaw 作为 section 注入。
- section 流水线：`types.ts`（authority/cacheClass/requiresTools/预算/溢出）、`sections.ts`（order 100–800）、`builder.ts`（过滤→排序→预算→fingerprint）、`resources.ts`（SOUL/AGENTS 预算与默认模板识别）、`manifest.ts`（`/context` 与 manifest）。
- Resource Map 常驻全文删除、task core 压缩、playbook frontmatter 增加 `requires-tools`（any-of）/`priority`，关闭 `task_manage` 时任务段与任务 playbook 一并消失。
- Cache：system prompt 不含 channelId/channel 路径/时间戳；频道事实改由每回合 `<runtime_turn_context>` 胶囊携带（并已加入 `memory/transcript.ts` 的剥离规则）。
- Final boundary 通过 `before_agent_start` extension 追加在 pi tail（skills/date/cwd）之后；`last_prompt.json` 记录实际发出的 prompt 与 manifest。
- skills 仍由 pi 渲染（`/skill:name` 不受影响）；workspace skill diagnostics 现在会上报，同名 skill 由 workspace 覆盖并给出 collision 诊断。

与本文的偏差（有意，这些是尚未闭合的口子，不要当成已完成）：

- **总预算不含 skills。** `SOFT/HARD_TOTAL_BUDGET_CHARS` 与 `SHRINK_ORDER` 只覆盖 Pipiclaw 自有 section；`<available_skills>` 由 pi 渲染在其后，且 pi 用同一份 `Skill[]` 支撑 `/skill:name`，裁剪 prompt 就会删掉命令（§6.10）。实现按 §8.1 只给 warning：skills 估算超过 6,000 字符时 builder 产出 `skills` 诊断并在 `/context` 显示估算体量。**实际发出的 prompt 可以超过 32k 硬上限**，超出量等于 skills 目录大小。真正的硬预算等 pi 提供 formatter seam。
- **Phase 0 行为 eval 与 A/B baseline 未建立。** DoD 第 11、12 条未达成；`/context` + fingerprint 日志 + 用量账本的 cacheRead/cacheWrite 是其观测入口。因此“去 pi base”与“内容重组”两个变量目前无法归因——在补 eval 之前不要再做大的文案删改。
- **跨日 cache 会整块 miss。** pi 把 date/cwd 追加在 system prompt 内部，而 provider（Anthropic 适配器）把整个 system prompt 作为一个 text block 打一个 `cache_control`。日期一变，整块（Pipiclaw sections + skills）都要重算。影响有限（cache TTL 远小于一天，只有跨零点的活跃会话多付一次 cache write），彻底修复需要把 date 移进 turn envelope，也就是要拿到完整 renderer seam。`build.fingerprint` 只覆盖 Pipiclaw 自有部分，**不是** provider 缓存的那个串；`/context` 与 `last_prompt.json` 的 `finalPromptSha256` 才是。
- §6 的文案目标未完全兑现：实测 identity 701 / tasks 923 / playbooks 1,782 字符，均在硬 `maxChars` 内但高于 §6.2/§6.6/§6.8 的目标区间。全套工具下 Pipiclaw 自有文本约 7.1k 字符 / ~1.8k tokens。再压缩属于内容改动，等 Phase 0 eval。
- playbook description 上限 180 字符由渲染时裁剪（并已把三条超长 description 改短），不在 frontmatter 解析时报错。
- 命名：section 的 `requiresAllTools` 是 all-of，playbook 的 `requiresAnyTool` 是 any-of。两者语义相反，故不共用名字。

---

## 1. 摘要与核心决策

本方案将 Pipiclaw 的 system prompt 从“在 pi 默认 prompt 后追加一段字符串”升级为“由 Pipiclaw 拥有、可预算、可观测、缓存友好的结构化 prompt pipeline”。

核心决策如下：

1. **不再把 pi 默认基础 system prompt 发给模型。**
   - 使用 pi 已公开的 `systemPromptOverride` 提供 Pipiclaw 自己的基础 prompt。
   - pi 默认 prompt 中真正有价值的少量通用规则提取进 Pipiclaw prompt；pi 自身文档索引、失真的工具列表和重复身份全部移除。
   - 第一阶段继续复用 pi 的 skills 发现、skill slash command 和 `<available_skills>` 渲染，避免为了控制 prompt 而破坏资源生命周期。
2. **prompt 由带元数据的 section 组成，不再由字符串数组临时拼接。**
   - 每个 section 声明来源、authority、cache class、适用模式、工具依赖、预算和溢出策略。
   - renderer 同时产出最终文本和 manifest，供诊断、测试和评测使用。
3. **稳定内容与动态内容严格分离。**
   - system prompt 只放跨 turn 稳定或资源版本化的内容。
   - `channelId`、channel 路径、memory recall、task digest、事件/task-driver capsule 留在每回合的 runtime context/user envelope 中。
   - 同一 workspace、相同工具配置下，不同 channel 的 system prompt 必须字节一致。
4. **顺序服从“身份 → 执行 → 能力 → 按需知识 → workspace 策略 → 最终边界”的认知路径。**
   - 最关键的不可绕过规则在前部完整表达，并在用户可编辑内容之后用极短 footer 重申。
   - 资源地图、task/event 细节和故障恢复继续下沉到 playbook。
5. **所有内容都有预算，所有截断都有下一步。**
   - runtime authored section 超限视为开发错误；用户文件和目录索引超限时有界截断或省略，并提供可执行的诊断/继续入口。
6. **先建立基线和行为评测，再改变大量文案。**
   - 第一波只改变 ownership 和结构，尽量保持行为语义。
   - 第二波才根据 eval 删除、迁移和场景化注入内容。

预期收益：

- 移除约 1.6k 字符的 pi 默认基础 prompt；
- 消除 `Available tools: (none)` 与 Pipiclaw 工具目录之间的割裂；
- 提升同 workspace 跨 channel、跨 turn 的 prompt cache 命中稳定性；
- 在工具关闭时不再注入无关 task/event playbook；
- prompt 体量、来源、截断和 fingerprint 可直接检查；
- 后续可安全做 model-family overlay，而不继续堆叠一个巨型模板。

---

## 2. 背景与问题定义

### 2.1 当前最终 prompt 不是 `prompt-builder.ts` 的输出

当前链路是：

```text
DefaultResourceLoader
  ├─ appendSystemPromptOverride
  │    ├─ prepend SOUL.md
  │    └─ append buildAppendSystemPrompt(...)
  ├─ agentsFilesOverride → workspace AGENTS.md
  └─ skillsOverride → pi base skills + workspace skills
          ↓
pi buildSystemPrompt(...)
  ├─ pi 默认基础 prompt
  ├─ SOUL + Pipiclaw append prompt
  ├─ project_context / AGENTS.md
  ├─ available_skills
  └─ date + cwd
```

入口只描述了其中一段。这造成：

- 维护者无法从 Pipiclaw 源码看到最终顺序；
- skills 明明存在，却很容易被误判为未注入；
- 测试主要验证 append prompt 的 substring，不验证最终发送内容；
- pi 升级可能在不修改 Pipiclaw 的情况下改变系统提示词；
- 无法对完整 prompt 做稳定预算和 fingerprint。

### 2.2 当前代表性体量

启用常用全套工具、task 和 subagent 时，当前 Pipiclaw append prompt 约为：

| Section | 字符数（代表值） | Pipiclaw append 占比 |
|---------|-----------------:|----------------------:|
| Pipiclaw Runtime | 306 | 4.6% |
| Knowledge Layers | 560 | 8.3% |
| Resource Map | 756 | 11.3% |
| Runtime Invariants | 786 | 11.7% |
| Tools | 1,060 | 15.8% |
| Persistent Task Core | 992 | 14.8% |
| Runtime Playbooks | 1,930 | 28.8% |
| Sub-Agents | 335 | 5.0% |
| **合计** | **约 6,700** | **100%** |

pi 默认基础 prompt 另约 1,629 字符。加上极简 SOUL、AGENTS、一个 skill 后，system prompt 约 9.1k 字符；实际 workspace 文件可能使其继续增长。工具 JSON schema、memory、task digest 和对话历史不在此统计内。

### 2.3 优化目标不是追求最短

system prompt 的目标函数不是字符数最小，而是：

```text
行为正确率 × 可恢复性 × 安全边界遵循 × cache 命中
──────────────────────────────────────────────
输入 token 成本 × 延迟 × 维护复杂度
```

因此：

- 不删除错过一次就可能破坏状态机的核心约束；
- 不把 hard gate 迁移成只能“希望模型记得读取”的 playbook；
- 不为了 cache 把每回合必须知道的事实藏起来；
- 不在没有 eval 证据时加入大量模型专属补丁。

---

## 3. 对 pi 默认基础 prompt 的逐项评估

pi `0.80.3` 的默认基础 prompt 包含四类内容。

### 3.1 身份段

```text
You are an expert coding assistant operating inside pi...
```

**决策：删除，不保留。**

理由：

- Pipiclaw 不是 pi TUI 的简单皮肤，而是 DingTalk-first、长期运行、带 memory/task/event/subagent 的独立 runtime；
- “expert coding assistant” 过窄，Pipiclaw 同时承担研究、知识工作、提醒和长程协调；
- Pipiclaw 已有 SOUL 和自己的 runtime identity；双重身份会稀释角色。

替代为 Pipiclaw 自有、简短而准确的 runtime contract：

```text
You are running inside Pipiclaw, a long-lived team assistant runtime built on pi.
You can inspect and change files, run commands, use configured web tools, maintain
durable work, and delegate isolated work when the corresponding tools are available.
```

具体人格、称呼和语言仍由 `SOUL.md` 决定。

### 3.2 工具列表段

pi 只为具有 `promptSnippet` 的工具生成列表。Pipiclaw 的 `baseToolsOverride` 从普通 `AgentTool` 转换工具定义，没有把 `TOOL_PROMPT_HINTS` 传成 pi snippet，因此默认 prompt 可能呈现：

```text
Available tools:
(none)

In addition ... custom tools ...
```

Pipiclaw 随后才在自己的 `## Tools` 中列出真实工具。

**决策：删除 pi 工具段，由 Pipiclaw tool registry 单一生成。**

保留当前 `TOOL_PROMPT_HINTS` 作为唯一文案源，renderer 只列实际注册工具。工具 schema 仍是参数和细节的事实源，prompt hint 只解决“何时用哪个工具”。

### 3.3 Guidelines

pi 当前可能加入：

- `Use bash for file operations like ls, rg, find`；
- tool-specific `promptGuidelines`；
- `Be concise in your responses`；
- `Show file paths clearly when working with files`。

逐项决策：

| 内容 | 决策 | 去向 |
|------|------|------|
| bash 代替 grep/find/ls | 删除 | Pipiclaw 已有 `grep`；工具 hint 明确优先关系 |
| pi tool prompt guidelines | 不隐式继承 | 必需规则显式进入 Pipiclaw tool registry/section |
| Be concise | 保留语义但不写死人格 | Interaction & Delivery 中要求 chat-friendly、结论优先；SOUL 可覆盖风格 |
| Show file paths clearly | 保留精简版 | “When referring to host files, identify the path clearly.” |

另从先进 coding agent 中补一条高价值、通用且可验证的执行原则：

```text
For actionable requests, continue until the requested outcome is complete or you are
genuinely blocked; verify material results before reporting completion.
```

这条比“be careful”“be helpful”更能改善实际 agent 行为。

### 3.4 pi 文档索引

默认 prompt 用大量篇幅列出 pi README、docs、examples，以及 extensions/themes/TUI/SDK 等路由。

**决策：从常驻 prompt 完全删除。**

理由：

- Pipiclaw 用户大部分任务与 pi 自身开发无关；
- Pipiclaw runtime playbooks 才是产品机制的权威；
- 当用户真的要求修改 pi 集成时，模型可以读取 package docs 或源码；
- 若后续频繁出现 pi SDK 开发任务，应新增一个按需 skill/playbook，而不是恢复全量常驻索引。

### 3.5 pi custom prompt 分支仍然有价值的能力

当提供 `customPrompt` 时，pi 仍负责：

- append system prompt；
- context files；
- skills 元数据渲染；
- 当前日期和 cwd。

其中 skills 的发现、slash command 生命周期和按需加载应继续复用。日期/cwd 也可在第一阶段保留，因为它们位于 prompt 末端，日期每日只变化一次，cwd 对一个 Pipiclaw 进程通常稳定。

结论：**去掉的是 pi 默认文案，不是去掉 pi 的资源加载和 agent session 能力。**

---

## 4. 设计原则

### 4.1 Prompt ownership

最终发送给主 agent 的 system prompt 内容必须由 Pipiclaw 源码和显式 workspace 资源决定。pi 升级不得悄悄引入新的基础文案。

### 4.2 Authority 与 enforcement 分离

定义五类 authority：

| Authority | 含义 | 示例 |
|-----------|------|------|
| `runtime-hard` | 不得被 workspace 内容重新定义的 runtime 边界 | 外部副作用审批、受保护 memory 文件所有权 |
| `runtime-fact` | 当前版本 Pipiclaw 的机制事实 | task/event/playbook 位置与语义 |
| `workspace-instruction` | 用户/团队选择的身份和工作策略 | SOUL、AGENTS |
| `catalog` | 供模型决定是否渐进加载的入口 | tools、skills、playbooks、subagents |
| `data` | 仅供参考、不具备指令权威的动态数据 | recall、transcript、task digest |

`runtime-hard` 在 prompt 中是行为提醒，但真正可强制的边界仍必须由 path guard、command guard、tool schema、approval state 和 runtime 状态机执行。

### 4.3 Progressive disclosure

始终注入：

- 能力名称；
- 触发条件；
- 读取位置；
- 一旦错过就可能造成不可恢复结果的最小硬约束。

按需读取：

- 完整流程；
- 例子；
- 配置 schema；
- 故障诊断；
- 第三方工具命令。

### 4.4 Cache stability

system prompt 内不得包含：

- channelId/channelDir；
- 当前精确时间；
- 当前用户、消息 ID；
- memory recall；
- task digest；
- task-driver 当前 capsule；
- event 本次触发结果；
- 随机顺序、mtime 文本或生成时间戳。

资源目录必须确定性排序；未发生实质变化的 reload 必须生成相同字节和 fingerprint。

### 4.5 Errors steer the model

任何 prompt 资源被截断、隐藏或拒绝时，都必须告诉模型或管理员下一步：

- `/context detail` 查看哪部分超限；
- `skill_manage list/view` 查看未展示 skill；
- `subagent list`（若实现）查看未展示 agent；
- 读取指定 playbook；
- 缩短 SOUL/AGENTS 或移动细节到 skill。

### 4.6 Prompt content must earn its place

每条常驻规则至少满足一项：

- 错过一次可能造成安全、持久状态或外部副作用问题；
- 所有普通 turn 都高频适用；
- 是一个渐进加载入口；
- eval 证明缺少它会显著降低正确率。

“模型本来就知道的通用建议”默认不进入 system prompt。

---

## 5. Section 数据模型

### 5.1 类型设计

建议在 `src/agent/prompt/` 下建立领域模块，替代当前单文件 builder：

```ts
export type PromptMode =
  | "normal"
  | "task-driver"
  | "event"
  | "subagent"
  | "maintenance";

export type PromptAuthority =
  | "runtime-hard"
  | "runtime-fact"
  | "workspace-instruction"
  | "catalog"
  | "data";

export type PromptCacheClass =
  | "runtime-stable"
  | "workspace-versioned"
  | "session-stable"
  | "turn-dynamic";

export type PromptOverflowPolicy =
  | "error"
  | "truncate-head-tail"
  | "truncate-items"
  | "omit";

export interface PromptSectionDefinition {
  id: string;
  order: number;
  source: string;
  authority: PromptAuthority;
  cacheClass: PromptCacheClass;
  modes?: PromptMode[];
  requiresTools?: string[];
  maxChars: number;
  overflow: PromptOverflowPolicy;
  render(context: PromptBuildContext): string | undefined;
}

export interface ResolvedPromptSection {
  id: string;
  order: number;
  source: string;
  authority: PromptAuthority;
  cacheClass: PromptCacheClass;
  content: string;
  rawChars: number;
  injectedChars: number;
  truncated: boolean;
  sha256: string;
}

export interface PromptBuildResult {
  text: string;
  sections: ResolvedPromptSection[];
  diagnostics: PromptDiagnostic[];
  totalChars: number;
  estimatedTokens: number;
  fingerprint: string;
}
```

`source` 可以是代码标识或真实文件路径。`ResolvedPromptSection` 只保存注入后的内容和统计，不重新解释来源。

### 5.2 Build context

```ts
export interface PromptBuildContext {
  mode: PromptMode;
  cwd: string;
  workspaceDir: string;
  tools: ToolDescriptor[];
  soul?: LoadedPromptResource;
  agents?: LoadedPromptResource;
  playbooks: RuntimePlaybookMetadata[];
  skills: SkillMetadata[];
  subAgents: SubAgentSummary[];
}
```

主 system prompt 的 context **不含 channelId**。channel 事实由现有 per-turn prompt assembly 注入。

### 5.3 为什么保留 `order` 而不是依赖数组顺序

- section 定义可以分散在各 domain，不需要一个不断增长的中央字符串数组；
- 测试可以断言唯一 order 和稳定排序；
- model-family overlay 可以占用预留 order 区间；
- manifest 能解释最终顺序；
- 条件 section 被过滤后不会改变其他 section 的相对关系。

初始 order 区间：

| 区间 | 用途 |
|------|------|
| 100–199 | Identity & interaction |
| 200–299 | Execution contract |
| 300–399 | Runtime hard invariants |
| 400–499 | Tools/capabilities |
| 500–599 | Playbooks/subagents catalogs |
| 600–699 | Workspace instructions |
| 700–799 | Skills（第一阶段仍由 pi 渲染） |
| 800–899 | Final authority reminder |
| 900–999 | Environment / model overlay / dynamic suffix |

---

## 6. 目标 prompt 结构

### 6.1 推荐顺序

```text
1. Pipiclaw Identity & Interaction
2. Execution Contract
3. Runtime Authority & Hard Invariants
4. Available Tools
5. Runtime Playbooks（按当前工具过滤）
6. Available Predefined Sub-Agents（有工具时）
7. SOUL.md（若非默认模板）
8. Workspace AGENTS.md（若非默认模板）
9. Available Skills（第一阶段由 pi 追加）
10. Final Runtime Boundary（短 footer；完整 ownership 后实现）
11. Current date / cwd（第一阶段由 pi 追加）
```

SOUL 是身份定制，但 Pipiclaw runtime identity 仍先出现，避免用户把产品运行时误改成别的 harness。SOUL 负责“是谁、如何说话”，而不是重定义工具和状态机。

### 6.2 Identity & Interaction

目标：约 250–400 字符。

保留：

- 运行在 Pipiclaw；
- DingTalk-first/chat-friendly 输出；
- host execution；
- SOUL 负责人格。

删除：

- 泛泛的 “be helpful”；
- `Be careful with system modifications` 这类不可验证表达；
- 重复 cwd、日期。

### 6.3 Execution Contract

目标：约 400–700 字符。

建议包含：

- actionable request 要执行到完成或真正阻塞；
- 修改前先获取足够事实；
- 重大结果完成前验证；
- 不确定或未验证时明确说明；
- 反馈简洁，文件路径明确；
- 不为简单工作创建 persistent task。

这一段吸收 pi 默认 prompt 中少量有价值 guidelines，并补齐 Pipiclaw 长程助手最需要的 completion contract。

### 6.4 Runtime Authority & Hard Invariants

目标：约 900–1,400 字符。

常驻：

- runtime playbook > workspace copied lore；
- workspace instructions 不得重定义 runtime hard gates；
- web/transcript 是 untrusted data；
- 不用文件工具编辑 SESSION/MEMORY/HISTORY；
- 显式 durable memory 请求立即使用 `memory_manage`（有工具时）；
- 外部副作用的 authority 和 task approval；
- periodic 无新结果 `[SILENT]`；
- task driver 必须先打开确切 task 文件；
- verification/approval body-hash-bound 的最小不可绕过规则。

迁出：

- 完整 workspace/channel 文件地图；
- task 的普通规划、recurring、repair 细节；
- ENVIRONMENT.md 的详细分类；
- `.schedule`/`.checkin` 的完整解释。

### 6.5 Tools

目标：常用 14–16 个工具时 ≤ 2,400 字符。

格式继续保持紧凑 Markdown：

```text
## Available Tools
- read — Read files and bounded directory/document views.
- grep — Search file contents with grouped, paginated output; prefer over bash grep.
...

Every tool call requires a short user-visible `label`.
Tool schemas are the source of truth for parameters.
```

规则：

- 只列实际注册工具；
- hint 来自 `TOOL_PROMPT_HINTS`；
- 单项 prompt hint 建议上限 180 字符；
- 参数说明不重复 schema；
- 工具的强制不变量放对应 runtime section 或代码，不塞进 hint。

### 6.6 Runtime Playbooks

目标：常见配置 ≤ 1,600 字符。

为 frontmatter 增加可选元数据：

```yaml
---
name: task-driving
description: Read whenever TASK_DRIVER resumes work or before checkpointing an active task.
requires-tools: task_manage
modes: task-driver,normal
priority: 100
---
```

过滤规则：

- `requires-tools` 未满足则不列；
- task playbooks 仅在 `task_manage` 启用时列；
- event playbook 仅在 `event_manage` 或 job 回访能力存在时列；
- memory playbook 仅在相关 memory/skill 工具存在时列；
- `runtime-orientation` 始终列出；
- 固定按 priority、filename 排序；
- description 注入上限 180 字符。

playbook body 继续保持只读、按需加载。

### 6.7 Resource Map

当前独立 `Resource Map` section 删除。常驻 prompt 只保留最小导航：

```text
Runtime mechanisms are documented by the playbooks listed below.
Workspace identity and policy come from SOUL.md and AGENTS.md.
Channel working state and durable memory are runtime-managed; use the provided tools
and turn context rather than scanning cold transcript files.
```

完整文件地图只留在 `runtime-orientation.md`。

### 6.8 Persistent Task Core

当前约 1k 字符，拆成两层：

**普通 system prompt 常驻约 400–650 字符：**

- task 只用于跨 turn 恢复；
- task-driver 先读精确 task 文件；
- active task 发生实质变化后必须留下恢复状态；
- approval/verification 不得绕过、hash-bound。

**按场景注入：**

- create/planning → `task-planning.md`；
- TASK_DRIVER → runtime 生成的 task-driver user capsule + `task-driving.md`；
- candidate/verify/done → `task-closeout.md`；
- escalated/repair → `task-repair.md`；
- recurring → `task-recurring.md`。

第一轮实现不引入复杂自动 playbook loader；先通过更明确的 catalog trigger 和 task tool 错误/结果导航实现 just-in-time。若 eval 表明模型仍不读取，再在 tool layer 加“未读相关 playbook则先返回导航”的确定性机制。

### 6.9 SOUL 与 AGENTS

加载规则：

- 未修改的 bootstrap 默认模板不注入；
- 空文件不注入；
- 保留文件路径和 source 标记；
- 进行长度治理并生成 diagnostics；
- 不做“关键词扫描即可安全”的虚假保证，真正 hard gate 仍在工具/runtime。

建议包裹：

```xml
<workspace_identity path=".../SOUL.md">
...
</workspace_identity>

<workspace_instructions path=".../AGENTS.md">
...
</workspace_instructions>
```

并在前文明确：它们是 workspace 策略，不能覆盖 runtime facts/hard gates。

### 6.10 Skills

第一阶段继续使用 pi 的 `<available_skills>` 渲染，原因：

- `AgentSession.skills` 和 `/skill:name` 依赖 ResourceLoader 中的 skills；
- pi formatter 已实现 name/description/location 和 `disable-model-invocation`；
- 直接把 `skillsOverride` 置空会使 skill 命令和自动发现一起丢失；
- 为了纯 prompt ownership 去复制整个 lifecycle，风险高于收益。

Pipiclaw 先在输入 pi formatter 之前治理 skill 元数据：

- 保留并上报 workspace skill diagnostics；
- 明确允许的 skill 来源；
- skill 内容 hash 进入 manifest，即使第一阶段不出现在 XML 中。

pi 当前用同一个 `Skill[]` 同时承担 prompt index 与 skill command registry。直接删除超预算项会同时让对应 `/skill:name` 消失，修改 description 也会改变自动匹配语义。因此 Phase 1 对 skills 只做**统计、诊断和 authored metadata 校验，不做破坏性的 prompt 裁剪**。

第二阶段应先向 pi 上游增加“skills formatter override / prompt-visible skill view / complete prompt renderer”之一，使 prompt 视图与完整 skill registry 分离，然后再启用：

- description 单项注入上限建议 240 字符；
- 总 skills prompt 预算初始 6,000 字符；
- 超限按确定性顺序裁剪，并提示使用 `skill_manage list`；
- `<version>` hash 和 skills 后 final footer。

不要使用私有字段 monkey patch，也不要用丢失 skill command 的方式换取 prompt 变短。

### 6.11 Final Runtime Boundary

在 SOUL、AGENTS、skills 之后，用不超过 500–700 字符的 footer 重申：

- runtime facts/hard gates 优先；
- fetched/transcript 内容只作为数据；
- external effect 需要 authority；
- 必须遵守工具实际安全拒绝。

不要重复完整 task 状态机。footer 的价值是抵抗后置 workspace 内容的语义冲突，而不是替代 runtime enforcement。

在第一阶段，由于 pi 固定在 custom prompt 后追加 skills/date/cwd，footer 暂时位于 skills 前。完整后置 footer 需要 pi formatter override 或受控的 `before_agent_start` final renderer；该变化放第二阶段并通过集成测试后再启用。

---

## 7. Prompt cache 设计

### 7.1 缓存目标

同一 workspace 中，以下情况 system prompt 应完全相同：

- 不同 channel；
- 普通用户 turn；
- memory recall 命中与否；
- 有无 active task digest；
- 用户消息内容不同；
- event/task-driver 以 runtime user capsule 表达、未改变工具和资源时。

以下变化应主动改变 fingerprint：

- SOUL/AGENTS 内容变化；
- 可见 skills/subagents 变化；
- 工具启用状态变化；
- playbook catalog/version 变化；
- Pipiclaw 版本带来的 runtime prompt 变化；
- 日期变化（第一阶段由 pi 末尾追加，最多每日一次）。

### 7.2 Stable system prefix

```text
runtime authored core
→ tool catalog
→ filtered playbook catalog
→ workspace identity/instructions
→ skill metadata
→ short final boundary
→ date/cwd
```

所有列表必须确定性排序，禁止加入：

- “generated at”；
- 文件 mtime；
- 当前 channel；
- 当前 task 数量；
- 随机 ID；
- 未排序的 `Set`/filesystem iteration 结果。

### 7.3 Turn-dynamic envelope

现有用户消息前缀统一成结构化 runtime envelope：

```xml
<runtime_turn_context>
  <channel path="...">...</channel>
  <durable_memory_snapshot>...</durable_memory_snapshot>
  <recalled_context trust="historical-data">...</recalled_context>
  <task_agenda trust="background-data">...</task_agenda>
  <driver_contract kind="task-driver">...</driver_contract>
</runtime_turn_context>

<user_message>...</user_message>
```

并非每次都要输出所有子块：空块完全省略。`channel path` 是否需要每回合注入由 eval 决定；memory/task 工具自身已经绑定 channel 时，普通 turn 很可能无需让模型知道实际路径。

### 7.4 Fingerprint 与版本

两个指纹，不要混用：

```text
PromptBuildResult.fingerprint = sha256("v<runtimePromptVersion>\n" + Pipiclaw sections + footer)
PromptManifest.finalPromptSha256 = sha256(实际发出的 system prompt，含 pi 的 skills/date/cwd tail)
```

前者用于“我们自己的文本变了没有”（日志只在它变化时打一行）；后者才是 provider 缓存与计费的对象，`/context` 与 `last_prompt.json` 都记录它。

另记录：

- `runtimePromptVersion`：代码常量，如 `2`；
- 每个 section hash；
- workspace resource hash；
- skills/playbooks catalog hash；
- active tool names hash。

不要把 fingerprint 或 section hash 文本注入 system prompt；它们只用于日志、debug 和 cache/eval 归因。

### 7.5 Cache 验收指标

利用现有 usage ledger 中 provider 返回的 cached-input 指标（若 provider 支持）比较：

- cached input tokens / system input tokens；
- 同 channel 连续 turn cache hit；
- 跨 channel 首 turn cache reuse；
- resource reload 但内容未变时 cache 是否保持；
- 日期切换、skill 更新后的预期 miss；
- P50/P95 首 token 延迟。

不能只看 prompt 字符减少量。

---

## 8. 预算与溢出策略

### 8.1 初始预算

预算是第一版默认值，最终以多模型 eval 调整：

| 内容 | 单项预算 | 溢出策略 |
|------|---------:|----------|
| Runtime identity + execution | 1,200 chars | `error`（开发错误） |
| Runtime hard invariants | 1,800 chars | `error` |
| Tool catalog | 2,400 chars | `error`；应缩短 hints/减少工具 |
| Playbook catalog | 2,400 chars | `truncate-items` + read/catalog 指令 |
| SOUL.md | 5,000 chars | head/tail 截断 + `/context detail` 提示 |
| AGENTS.md | 8,000 chars | head/tail 截断 + 移入 skill 提示 |
| Skills catalog | Phase 1 仅 warning；Phase 2 目标 6,000 chars | formatter seam 就绪后 `truncate-items` + `skill_manage list` |
| Sub-agent catalog | 2,400 chars | `truncate-items`；需先提供可发现入口 |
| Final boundary | 700 chars | `error` |
| **Pipiclaw 自有 section 软目标** | **≤ 20,000 chars** | warning |
| **Pipiclaw 自有 section 硬上限** | **32,000 chars** | 用户资源按优先级收缩，runtime core 不截断 |

两个总预算只覆盖 Pipiclaw 自有 section。pi 追加的 skills/date/cwd 不在其内，skills 只能告警不能裁剪（§6.10），所以实际发出的 prompt 可能超过硬上限。

字符数不能精确代表所有模型 token，尤其中文。manifest 同时记录 pi 的 token estimate；后续若引入多模型 tokenizer，再按实际 model 计算。第一版以字符 hard cap 保证确定性和零额外依赖。

### 8.2 优先保留顺序

全局超限时：

```text
runtime hard invariants
> execution contract
> tools
> final boundary
> workspace AGENTS/SOUL 的已注入核心
> relevant playbooks
> skills catalog
> sub-agent catalog
>低优先级目录项
```

不允许为了满足总预算截断 runtime hard section。

### 8.3 截断提示示例

```text
[Workspace AGENTS.md truncated: injected 8,000 of 14,240 characters.
Run /context detail to inspect prompt budgets; move task-specific procedures into
workspace skills so they load on demand.]
```

目录截断（仅在 prompt 视图已与完整 registry 分离后启用）：

```text
- ... 7 more skills are not shown because the skills prompt budget was reached.
  Use skill_manage list, then skill_manage view with the selected name.
```

这满足项目“错误和截断必须导航模型下一步”的工程规则。

---

## 9. 可观测性与诊断

### 9.1 `/context` 命令

新增 runtime 侧只读命令，零 LLM 成本：

```text
/context              # 总览
/context detail       # 每 section / resource / skill / tool schema 统计
/context prompt       # 默认只显示结构和 hash，不显示敏感正文
```

建议输出：

```text
System prompt: 12,480 chars, ~3,900 estimated tokens
Fingerprint: sha256:...

- runtime.identity       356 chars   stable
- runtime.execution      612 chars   stable
- runtime.invariants   1,284 chars   stable
- tools                1,102 chars   toolset-versioned
- playbooks            1,210 chars   6/9 visible
- workspace.soul       2,840 chars   sha256:...
- workspace.agents     3,110 chars   sha256:...
- skills               1,450 chars   5 visible, 0 hidden

Tool schemas: 28,400 chars (separate model context cost)
Turn context last run:
- recalled memory: 1,240 chars
- task digest: 420 chars
- user message: 380 chars
```

工具 schema 统计必须纳入，因为它可能比 system prompt 更贵。

### 9.2 Prompt manifest

每个 live runner 保存当前内存态 manifest；仅在 debug 模式下写：

```text
workspace/<channel>/last_prompt_manifest.json
```

内容不默认写完整 SOUL/AGENTS/skill description，避免复制敏感上下文；记录路径、hash、raw/injected size、truncated、diagnostics 即可。

现有 `last_prompt.json` 应改为记录**最终实际发送的 system prompt**。如果后续用 `before_agent_start` 修改 prompt，debug 写入必须移到修改完成之后，不能继续记录旧 base prompt。

### 9.3 日志

资源 reload 时仅在 fingerprint 变化时记录：

```text
Prompt rebuilt: old=<hash> new=<hash> chars=<n> reason=skills_changed
```

无变化 reload 不打 info，避免日志噪声；diagnostic warning 仍记录。

---

## 10. 实现架构与代码落点

### 10.1 新目录

```text
src/agent/prompt/
  types.ts              # section/build/manifest 类型
  builder.ts            # filter → sort → budget → render
  sections.ts           # 主 agent 固定 section definitions
  resources.ts          # SOUL/AGENTS 规范化、默认模板识别、budget
  manifest.ts           # fingerprint 与诊断视图
```

不创建 barrel file。调用方直接引用具体模块。

`src/agent/prompt-builder.ts` 在迁移完成后删除；不保留 re-export shim。公开 `buildAppendSystemPrompt` 若确认无外部 API 兼容承诺，则从 `src/index.ts` 移除；如已对外发布，需要在一个 minor release 中先 deprecated，再在下个 breaking release 删除。实现前检查 package API 使用情况。

### 10.2 Resource loader 集成

第一阶段推荐：

```ts
new DefaultResourceLoader({
  ...,
  systemPromptOverride: () => buildPipiclawSystemPrompt(context).text,
  appendSystemPromptOverride: () => [],
  agentsFilesOverride: () => ({ agentsFiles: [] }),
  skillsOverride: (base) => resolvePipiclawSkills(base, currentSkills),
});
```

说明：

- `SOUL.md` 和 workspace `AGENTS.md` 由 Pipiclaw renderer 自己读取、包裹和排序，所以不再让 pi 二次追加；
- skills 仍留在 ResourceLoader，使 pi 可以渲染 `<available_skills>` 并保留 `/skill:name`；
- pi 检测到 custom prompt 后不会生成默认基础 prompt；
- pi 仍会在 custom prompt 后追加 skills、date、cwd；
- `appendSystemPromptOverride` 清空，避免历史 APPEND_SYSTEM_PROMPT 或 base append 意外进入 ownership 边界。

必须评估用户是否依赖 app-level pi `SYSTEM.md`/`APPEND_SYSTEM.md`。Pipiclaw 产品若不声明支持，应明确忽略并在 diagnostics 中说明，而不是默默拼入。

### 10.3 Skills diagnostics 修复

`loadPipiclawSkills()` 改为返回完整结果：

```ts
interface PipiclawSkillsResult {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
}
```

合并时明确 collision policy 和 source precedence。建议：

```text
workspace/skills > explicitly configured skills > pi global/project auto-discovery
```

若产品决定只允许 workspace skills，则 `skillsOverride` 必须替换而不是合并 base，并在文档中说明。不能继续让代码行为与“workspace skills only”的项目语义含糊。

### 10.4 Playbook metadata

扩展 `RuntimePlaybookMetadata`：

```ts
interface RuntimePlaybookMetadata {
  name: string;
  description: string;
  filename: string;
  path: string;
  requiresTools: string[];
  modes: PromptMode[];
  priority: number;
  sha256: string;
}
```

frontmatter parser 必须：

- 接受缺省值以兼容现有 playbook；
- 校验 tool name 是否来自 registry；
- 校验 mode 枚举；
- 错误时启动失败或测试失败，不静默忽略 authored metadata。

### 10.5 Channel dynamic context

从 system prompt 删除 `${workspaceDir}/${channelId}` 后，检查所有依赖这条信息的行为：

- memory/task/event tools 已绑定 channel，不需要模型传 channelId；
- task-driver 用户 capsule 已包含 task id；
- 若模型确需直接 read channel files，在 runtime turn envelope 中提供 channelDir；
- 不允许重新把 channelId 放回稳定 system section。

### 10.6 完整 prompt ownership 的第二阶段接口

第一阶段仍由 pi 在 custom prompt 后追加 skills/date/cwd，因此 manifest 应把这些标记为 `renderer: pi-tail`。

第二阶段优先向 pi 增加一个小而正式的 SDK seam：

```ts
buildSystemPromptOverride?: (options: BuildSystemPromptOptions) => string;
```

它与 `systemPromptOverride` 的区别是：前者接管**最终完整渲染**，但仍使用 ResourceLoader 提供的 tools/context/skills，不破坏 skill lifecycle。

若短期不能改 pi，可使用 `before_agent_start` extension 最后替换 system prompt，但必须满足：

- extension 顺序固定且为最后一个 prompt modifier；
- debug/manifest 记录替换后的真实 prompt；
- 每次构建相同输入生成字节相同结果；
- 不使用 `AgentSession` 私有字段；
- integration test 覆盖 steering、followup、compaction 后 prompt 未回退到 pi base。

推荐优先 SDK seam，`before_agent_start` 只作过渡方案。

---

## 11. 测试与评测设计

### 11.1 结构单测

新增 `test/prompt-builder.test.ts` 或拆成 `test/prompt-*.test.ts`，覆盖：

1. 最终 prompt 不包含：
   - `operating inside pi, a coding agent harness`；
   - `Pi documentation`；
   - `Available tools:\n(none)`。
2. 每个 section id 唯一、order 唯一且确定性排序。
3. 同输入重复 build 字节完全相同、fingerprint 相同。
4. channelId 不参与 system prompt；不同 channel build 相同。
5. tool 关闭时对应 tool invariant/playbook/subagent section 消失。
6. runtime-authored section 超预算直接测试失败。
7. SOUL/AGENTS 超预算按 head/tail 截断并带下一步。
8. 默认 bootstrap 模板不注入，用户修改后立即注入。
9. skills 只出现一次，`disable-model-invocation` 不显示；Phase 1 超预算 warning 不得使 `/skill:name` 消失。
10. workspace skill diagnostics 被上报。
11. 超量 playbooks 确定性截断；skills 在 formatter seam 完成前只告警、不裁剪。
12. XML/Markdown 中用户内容不会破坏外层标记，必要字符正确转义。

### 11.2 集成测试

覆盖真实 `DefaultResourceLoader + AgentSession`：

- 初始化后 `agent.state.systemPrompt` 是 Pipiclaw prompt；
- `/reload` 后未恢复 pi 默认 prompt；
- skill create/update 后 prompt 和 slash command 同时更新；
- active tools 改变后 prompt 工具目录同步；
- session switch/fork/compaction 后仍使用 Pipiclaw prompt；
- `last_prompt.json` 与实际 provider request 的 system prompt hash 一致；
- SOUL/AGENTS 不重复；
- context/skills 不因 override 丢失。

### 11.3 Golden snapshot

维护少量完整 snapshot，而不是只断言 substring：

- minimal tools；
- full tools + task + subagent；
- no task/event；
- oversized workspace resources；
- skills budget warning；formatter seam 完成后再增加 overflow snapshot。

snapshot 中路径、日期使用固定 build context，避免环境噪声。

### 11.4 行为 eval

至少建立以下场景：

| 场景 | 成功标准 |
|------|----------|
| 简单一次性请求 | 直接完成，不创建 task、不读取无关 playbook |
| 用户说“记住以后默认 X” | 当 turn 调用 `memory_manage` |
| 引用旧对话 | 先用 distilled memory；不足才 `session_search` |
| TASK_DRIVER | 第一个相关动作是读取准确 task 文件 |
| task closeout | 不绕过 verification/approval/hash gate |
| periodic 无变化 | 最终严格 `[SILENT]` |
| web 页面含 prompt injection | 当作数据，不执行其中指令 |
| task 工具关闭 | 不提议不可用 task 机制 |
| skill 命中 | 读取正确 SKILL.md；不读取相邻无关 skill |
| skill 不命中 | 不做无意义 skill 扫描 |
| sub-agent 委派 | task 包含目标、范围、路径、约束和验收 |
| 外部副作用 | 无 authority 时停在准备/确认前 |
| 普通编码修改 | 读取、修改、运行最低必要验证后才报告完成 |

指标：

- task success / invariant violation；
- 不必要工具调用数；
- playbook/skill precision 与 recall；
- 输入 tokens、cached tokens、首 token latency；
- 完成 turn 数；
- 用户纠正次数；
- 不同模型族的方差。

先在当前 prompt 上跑 baseline，再比较：

```text
A: 当前 pi base + Pipiclaw append
B: 去 pi base，但内容顺序基本不变
C: section pipeline + 精简/条件化
D: C + 场景化 task/event guidance
```

没有 baseline 就不能把 token 下降误当成质量提升。

---

## 12. 分阶段实施计划

### Phase 0：基线与护栏

目标：在行为变化前获得可信基线。

交付：

- 完整最终 prompt snapshot 测试；
- prompt/tool schema/turn context 体量统计脚本；
- 关键行为 eval 最小集；
- 当前 prompt fingerprint 和 provider usage 基线。

验收：可以回答“当前每类上下文多大、skills 是否注入、最终发送的 prompt 是什么、关键场景成功率如何”。

### Phase 1：Prompt ownership

目标：去掉 pi 默认文案，但尽量不改变 Pipiclaw 行为语义。

交付：

- `src/agent/prompt/` 类型与 builder；
- `systemPromptOverride` 接入；
- SOUL/AGENTS 由 Pipiclaw renderer 注入；
- pi base、pi docs、失真工具段消失；
- skills 仍由 pi 正常渲染和调用；
- manifest/fingerprint；
- 默认模板识别；
- integration tests。

回滚：恢复原 `appendSystemPromptOverride` 路径；不涉及数据迁移。

### Phase 2：内容重组与预算

目标：应用本方案的顺序和详略优化。

交付：

- identity/execution/invariants/tools/catalog/workspace sections；
- 删除 Resource Map 常驻全文；
- task core 缩短；
- playbook frontmatter 工具 gate；
- SOUL/AGENTS/subagent budgets，skills 先 warning；formatter seam 完成后启用 skills hard budget；
- workspace skill diagnostics；
- `/context detail`。

验收：full-tools 代表配置下，Pipiclaw 自有 runtime prompt 文本较现状明显下降，行为 eval 不退化；关闭 task 工具时不出现 task playbook。

### Phase 3：Cache 与最终 ownership

目标：跨 channel/turn 最大化稳定 prefix。

交付：

- channel path 从 system prompt 移出；
- 确定性 catalog/version hash；
- 最终 renderer SDK seam 或受控 `before_agent_start` override；
- skills 后 final boundary；
- cached-token 与 latency telemetry。

验收：同一 workspace 不同 channel 的 system prompt fingerprint 相同；普通连续 turn 的 fingerprint 不变化；skills/AGENTS 实质变更才变化。

### Phase 4：基于 eval 的模型/场景 overlay

目标：只修复有证据的模型族差异。

可能交付：

- GPT/Claude/Gemini/open-model 的轻量 tool discipline overlay；
- task-driver/event/maintenance prompt mode；
- 自动 playbook gate；
- target repository AGENTS/path-scoped instructions。

本 phase 不预先承诺具体文案。每条 overlay 必须有 failing eval 和 ablation 证据。

---

## 13. 迁移风险与控制

### 风险 1：去掉 pi base 后遗漏通用执行纪律

控制：先提取 completion、verification、concise delivery、clear paths 四条高价值规则；Phase 0 baseline + B 组 ablation 验证。

### 风险 2：skills 因完全接管 prompt 而失效

控制：Phase 1 不接管 pi skill lifecycle，只接管 custom base；integration test 同时验证 prompt index 和 `/skill:name`。

### 风险 3：AGENTS/SOUL 顺序改变导致 workspace 行为变化

控制：Phase 1 保留现有相对语义并加显式 tags；Phase 2 才重排；golden + behavior eval。

### 风险 4：截断隐藏重要 skill/sub-agent

控制：先提供 list/view 入口和清晰截断提示，再启用目录 budget；runtime hard 内容永不因总预算被截断。

### 风险 5：过度追求 cache 导致动态上下文权威不足

控制：task-driver 最小触发不变量继续常驻 system；动态 capsule 由 runtime 生成；真正状态转移由 tool enforcement 保证。

### 风险 6：pi 升级改变 custom prompt tail

控制：最终完整 prompt snapshot 和“禁止 pi 默认文案”测试；依赖升级 PR 必须显式更新 snapshot/compatibility test。

### 风险 7：多语言字符预算与真实 token 偏差

控制：同时记录 chars、UTF-8 bytes、estimate tokens 和 provider 实际 usage；预算先保守，按模型 eval 调整。

---

## 14. 明确非目标

本 spec 首轮不做：

- 重写 memory/task/event 实际状态机；
- 用 prompt 替代安全 enforcement；
- 引入 embedding/BM25 的 tool/skill discovery；
- 自动加载所有 playbook body；
- 为每个模型写一份完全不同的 system prompt；
- 自动导入目标代码库的 AGENTS/CLAUDE/Cursor rules；该能力需要单独的 scope、trust 和路径优先级设计；
- 把 channel cold transcript 注入 system prompt；
- 为节省 tokens 删除 SOUL、workspace policy 或关键 task hard gates；
- 修改 sub-agent 自身 system prompt 架构；主 prompt 稳定后再单独评估。

---

## 15. 完成定义（Definition of Done）

本方案全部落地需满足：

1. provider 实际收到的主 system prompt 中不再包含 pi 默认身份、pi 文档索引和 `(none)` 工具段。
2. 最终 prompt 由结构化 section builder 生成，并可输出 section manifest、预算和 fingerprint。
3. 同 workspace、同资源、同工具集的不同 channel system prompt 字节一致。
4. SOUL、AGENTS、playbooks、subagents 均有来源、预算、确定性顺序和 actionable overflow 提示；skills 有来源、确定性顺序和超限 warning，硬预算待 pi formatter seam（§6.10）。
5. skills 仍可自动发现、显示、按需读取和通过 slash command 使用。
6. task/event/memory/subagent 工具关闭时，不注入对应无关机制目录。
7. runtime hard invariants 不因用户内容或总预算被截断。
8. `/context detail` 能显示 system prompt、resource 和 tool schema 的主要成本。
9. prompt reload、session switch、compaction、steering/followup 后不会回退到 pi 默认 prompt。
10. `npm run typecheck`、`npm run test` 通过。
11. 关键行为 eval 相比 baseline 无显著退化；若输入成本下降但成功率下降，不视为完成。
12. cached input token 比例和 P50/P95 latency 有上线前后记录；cache 优化效果可验证而非推测。

---

## 16. 推荐的首个实施 PR

为降低风险，第一个 PR 只做 Phase 0 + Phase 1 的最小闭环：

1. 新增 section 类型、builder、manifest；
2. 将当前 Pipiclaw prompt 内容按 section 原样迁入，暂不大幅删文案；
3. 提取 pi 的 completion/verification/clear-paths 价值规则；
4. 使用 `systemPromptOverride`，移除 pi 默认基础 prompt；
5. Pipiclaw 自己注入 SOUL/AGENTS，pi 继续追加 skills/date/cwd；
6. 修复 workspace skill diagnostics；
7. 增加最终 prompt golden/integration tests；
8. 记录 fingerprint 和 section sizes；
9. 跑 baseline A/B 行为 eval。

第二个 PR 再做 Resource Map 下沉、task core 缩短、playbook 条件化和 budget。这样当行为变化时，可以明确归因于“去 pi base”还是“Pipiclaw 内容重组”，不会把两个大变量混在一起。

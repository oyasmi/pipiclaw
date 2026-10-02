# Tool Registry 设计方案

| 字段 | 值 |
|------|------|
| 分支 | `tools-hardening` |
| 状态 | DRAFT |
| 日期 | 2026-07-04 |
| 关联实现 | `src/tools/index.ts`, `src/subagents/tool.ts`, `src/agent/prompt-builder.ts`, `src/agent/channel-runner.ts` |
| 前置 | 批次 A（`fix(tools): harden tool layer`）已修复 prompt/工具漂移、bash 语义、schema、输出等具体问题 |

---

## 背景

批次 A 修掉了工具层的具体 bug，但没有触碰**根因**：工具清单没有单一事实来源，散落在四处靠人肉同步。

1. `src/tools/index.ts` 的 `createPipiclawTools` —— 主 agent 工具集的手工装配 + 逐工具的 config 门控（`web.enable === false ? [] : [...]` 等）。
2. `src/subagents/tool.ts` 的 `createToolSet` / `createNamedToolSet` —— 子代理工具集的**第二份**手工装配（read/bash/edit/write + 可选 web）。
3. `src/agent/prompt-builder.ts` 的 `## Tools` 段落 —— 批次 A 已改为从传入的工具集生成，但 hint 文案仍是 prompt-builder 内的独立 `TOOL_HINTS` map，与工具定义分离。
4. 新增一个工具，理论上要同时改 1/2/3（以及 `config.ts` 的门控字段）。

批次 A 引入的跨层契约测试能拦住 1↔3 的漂移，但 2（子代理工具集）仍是独立的第二份装配，且 hint 仍有两个来源。

## 目标

引入一个**声明式工具注册表**作为叶子工具（read/bash/edit/write/web_*/session_search/memory_save/skill_*）的单一事实来源，从它派生：

- 主 agent 工具集（`createPipiclawTools`）
- 子代理工具集（`src/subagents/tool.ts` 内部）
- prompt 工具段落的 hint 文案
- 一个注册表契约测试（名字唯一、hint 齐全、主集/子集派生正确）

在**不重写安全守卫、不改 config 解析**的前提下完成——那些是更大的、可独立推进的后续项（见"非目标 / 后续"）。

## 非目标（本 spec 不做，记为后续）

- **工具中间件管道**（`wrapTool`：守卫/审计/截断/遥测收敛为可组合的层，为 hooks 和审批策略留位）。价值高但侵入安全关键代码，风险大，单独立项。
- **`config.ts` schema 化**（330 行手写 merge → TypeBox 驱动）。注册表**消费** config，不拥有 config 解析；两者解耦，可分别推进。
- **MCP 客户端**。注册表设计时把"工具来源不止本地代码"纳入考虑（`ToolRegistration` 是纯数据 + 工厂闭包，未来 MCP 工具是另一个 provider），但本 spec 不实现。
- **read 行号 / Read-before-Edit 约束**。产品行为增强，与注册表正交。

---

## 设计

### 统一构建上下文

所有工厂签名各异（`createReadTool(executor, opts)`、`createWebSearchTool({...})` 等）。注册表用一个统一的 `ToolBuildContext` 承载任意工具可能需要的依赖，每个注册项的 `create(ctx)` 闭包负责从 ctx 适配到具体工厂：

```ts
interface ToolBuildContext {
  executor: Executor;
  securityConfig: SecurityConfig;
  securityContext: SecurityRuntimeContext;
  channelId: string;
  channelDir: string;
  workspaceDir: string;
  workspacePath: string;
  webConfig?: PipiclawWebToolsConfig;     // 主集=toolsConfig.tools.web；子集=options.webConfig
  toolsConfig?: PipiclawToolsConfig;       // 仅主集需要（门控 session_search/memory_save/skills）
  bashDefaultTimeoutSeconds?: number;      // 子集传 config.bashTimeoutSec；主集不传（用 bash 内建 300s 默认）
  getCurrentModel?: () => Model<Api>;
  getAvailableModels?: () => Model<Api>[];
  resolveApiKey?: (model) => Promise<string>;
  getSessionSearchSettings?: () => PipiclawSessionSearchSettings;
  memoryCandidateStore?: MemoryCandidateStore;
}
```

主集专用的依赖（`getCurrentModel` 等）在 ctx 中是可选的：子代理路径不构建那些工具，故不提供。`create` 闭包用一个 `req(value, name)` 助手在缺失时**大声抛错**，把静默 undefined 变成明确失败。

### 注册项

```ts
interface ToolRegistration {
  name: string;
  promptHint: string;                              // prompt ## Tools 段落的单行说明
  availableToSubagents: boolean;                   // 是否进入子代理工具集
  enabledBy?: (ctx: ToolBuildContext) => boolean;  // config 门控；缺省=总是启用
  create: (ctx: ToolBuildContext) => AgentTool<any>;
}
```

`TOOL_REGISTRY: ToolRegistration[]` 按主集顺序声明 11 个叶子工具（read/bash/edit/write/web_search/web_fetch/session_search/memory_save/skill_list/skill_view/skill_manage）。

门控等价于现状（`enabledBy` 的 `!== false` 反演现有的 `=== false ? []`）：
- web_*：`ctx.webConfig != null && ctx.webConfig.enable !== false`（子集无 webConfig 时不构建，避免 `createWebSearchTool` 拿到 undefined）
- session_search / memory_save / skills：读 `ctx.toolsConfig?.tools.*`

### 派生

```ts
function buildToolSet(ctx, { forSubagent }): AgentTool[] {
  return TOOL_REGISTRY
    .filter(r => (!forSubagent || r.availableToSubagents) && (!r.enabledBy || r.enabledBy(ctx)))
    .map(r => r.create(ctx));
}
```

- **主集**：`createPipiclawTools` = `[...buildToolSet(mainCtx, {}), createSubAgentTool({...})]`。`subagent` 工具仍显式追加——它是特例（可递归、不进子集、需 runtimeContext），且不放进注册表可避免 `registry → subagents/tool` 的循环导入（子集构建反过来 `import { buildToolSet }`，形成环）。
- **子集**：`src/subagents/tool.ts` 用 `buildToolSet(subagentCtx, { forSubagent: true })` 替换 `createToolSet`/`createNamedToolSet`，再经既有 `filterToolsByName` 应用白名单。子集顺序 read/bash/edit/write/web_search/web_fetch，与现状一致。

### Prompt hint 单一来源

注册表导出 `TOOL_PROMPT_HINTS: Record<string, string>`（11 个叶子 + `subagent` 常量）。`channel-runner` 把它附到传给 prompt 的 descriptor 上（`{name, description, hint}`）。`prompt-builder` 渲染 `hint ?? firstSentence(description)`——`firstSentence` 兜底未知工具（未来 MCP 工具无 hint 时）。prompt-builder 内部不再持有 `TOOL_HINTS`/`DEFAULT_TOOL_ORDER`，也不 import 注册表（保持纯粹，依赖方向 agent→tools 由 channel-runner 承担）。

### 契约测试

- 注册表内 name 唯一；每个注册项都有非空 promptHint。
- 现有 `test/tools-index.test.ts` 的跨层契约测试（注册集 ↔ prompt）继续生效。
- 新增：`buildToolSet(forSubagent)` 只含 `availableToSubagents` 的工具，且不含 `subagent`。

## 风险

- **循环导入**：靠"subagent 不入注册表"从结构上根除（单向 `subagents/tool → registry`）。
- **子集行为漂移**：web 门控从 `options.webConfig && enable!==false` 改为 `ctx.webConfig != null && enable!==false`——语义等价；子集 bash 超时经 `bashDefaultTimeoutSeconds` 透传 `config.bashTimeoutSec`，与现状一致。用现有 `subagent-phase1` 测试兜底。
- **主集工厂调用参数**：bash 的 `defaultTimeoutSeconds` 仅在 ctx 提供时才放进 options（主集不放），保持 `tools-index.test.ts` 的精确断言不破。
- `createPipiclawBaseTools`（公共便捷入口，仅创建 4 个文件工具）保持独立，不经注册表——它是不同的 public 入口，4 个工具名的轻微重复可接受，换取零 API 破坏。

# Tool Registry 实施计划

| 字段 | 值 |
|------|------|
| 分支 | `tools-hardening` |
| 状态 | 批次 A + 注册表 已实现 |
| 日期 | 2026-07-04 |

## 已完成

### 批次 A —— 工具层加固（commit `fix(tools): harden tool layer`）

具体 bug 与摩擦点修复，无新抽象：

- prompt `## Tools` 段落及 web-safety / session_search / memory_save / sub-agents 指引改为从**实际注册的工具集**生成，消除默认配置下宣传不存在的 web 工具、以及漏列 memory_save 的漂移。
- bash：非零退出码作为正常结果内联返回（不再抛错）；全量输出经 executor 落盘（docker 下路径可达）；内建 300s 默认超时。
- schema：`skill_manage.action` / `subagent.contextMode|memory` / `memory_save.kind` / `session_search.roleFilter` 改 enum union；`read.offset|limit` / `web_search.count` / `session_search.limit` / `bash.timeout` 加整数边界。
- 输出：`skill_view` 返回原文并按共享截断上限封顶；`skill_list` / `session_search` 停止 pretty-print。
- `edit` 增加 `replaceAll`。
- 删除未注册、DingTalk 不支持的 `attach` 工具。
- `_baseToolsOverride` 私有字段访问收敛到带告警的助手。

### 注册表（commit `refactor(tools): declarative tool registry`）

- 新增 `src/tools/registry.ts`：`TOOL_REGISTRY`（11 个叶子工具）+ `buildToolSet(ctx, {forSubagent})` + `TOOL_PROMPT_HINTS`。
- `createPipiclawTools` 改为 `buildToolSet(mainCtx)` + 追加 `subagent`。
- `src/subagents/tool.ts` 的两份手工装配（`createToolSet`/`createNamedToolSet`）→ `buildToolSet(subagentCtx, {forSubagent:true})`。
- prompt hint 单一来源：`channel-runner` 从 `TOOL_PROMPT_HINTS` 附加到 descriptor，`prompt-builder` 不再持有 hint map。
- 新增 `test/tool-registry.test.ts` 契约测试；`test/tools-index.test.ts` 跨层契约测试继续生效。

## 后续（本 spec 非目标，按优先级）

1. **工具中间件管道** `wrapTool(tool, middlewares)`：守卫/审计/截断/**遥测**收敛为可组合层，为 Claude Code 式 hooks（PreToolUse/PostToolUse）和 Codex 式审批策略留位。遥测数据用于按真实调用迭代工具 description（Anthropic《Writing tools for agents》方法论）。—— 侵入安全关键代码，需独立评审。
2. **`config.ts` schema 化**：330 行手写 merge → TypeBox 驱动 + 自动 diagnostics。新工具配置接入成本降为"加一个 schema 字段"。
3. **MCP 客户端**：注册表已把"工具来源不止本地代码"纳入设计，MCP 工具作为另一个 provider 接入，命名预留 `mcp__server__tool`。
4. **read 行号（`cat -n`）/ Read-before-Edit 约束**：产品行为增强，与注册表正交。

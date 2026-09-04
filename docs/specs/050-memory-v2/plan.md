# 050 实施计划

设计见 [design.md](./design.md)。四个阶段，每个阶段结束时 `npm run check` 与 `npm run test:e2e` 必须绿，且每个阶段都能独立发布——P1 结束后系统已经可用，P2–P4 是收尾。

## 阶段总览

| 阶段 | 交付 | 可独立发布 | 主要删除 |
|---|---|---|---|
| P1 存储与注入 | `memory/` + 索引 + 三个工具 + 首轮注入（含压缩后重注入）+ 迁移 | 是（反思 pass 仍用旧提炼 prompt 适配） | `recall.ts` 打分层、`bootstrap.ts`、`candidates.ts`、`metadata.ts` |
| P2 日志与反思 | `journal/` + 单一反思 pass + 单 job 调度 | 是 | `session.ts`、`consolidation.ts` 的 cleanup/fold、两个 job、`probation.ts`、`promotion.ts` |
| P3 周边 | `/memory` 命令、子代理 `memory: index`、review-log 收缩、settings 退役 | 是 | `/memory recent`、`memoryRecall.*`、`sessionMemory.*` |
| P4 质量证据 | evals 集 + 文档 | — | `docs/memory.md` 的道歉段 |

## P1 存储与注入

### 新文件

| 文件 | 职责 | 参考现有 |
|---|---|---|
| `src/memory/store.ts` | 读写 `memory/<name>.md`（frontmatter 解析/序列化）、列出条目、生成并原子写 `MEMORY.md` 索引、mtime 缓存、墓碑读写、名字校验与去冲突 | `files.ts` 的原子写与墓碑；`shared/markdown-sections.ts` |
| `src/memory/index-budget.ts` | D4：按 units 预算决定注入哪些条目、生成省略行；工作区 `MEMORY.md` 按 H2 段截断 | `bootstrap.ts` 的双维预算裁剪与段选择；`shared/prompt-units.ts` |
| `src/memory/search.ts` | 分词器（从 `recall.ts` 搬 `tokenizeRecallText` + `chinese-words.ts`）、description 的 Jaccard 查重、`memory_search` 的搜索实现（频道 memory + journal + 工作区 `MEMORY.md` 段落，只读） | `recall.ts:333-495` |
| `src/memory/migrate.ts` | 第 5 节的迁移；`.memory-v1/` 搬移；`.migrated-v2` 标记 | `files.ts:parseChannelMemoryEntries`（修正缩进子弹规则后作为迁移专用解析器保留在此文件内） |
| `src/memory/render.ts` | `<memory_bootstrap>` 及其三个子段的包装文本 | `recall.ts:renderRecallResult` 的不可信声明；`bootstrap.ts` 的 `<durable_memory_snapshot>` |

### 改动

| 文件 | 改动 |
|---|---|
| `src/tools/memory-manage.ts` | `memory_save` 参数改为 D3；查重改用 `search.ts` 的 Jaccard；`memory_forget` 按 name；`memory_search` 走 `search.ts`；name 校验拒绝任何含路径分隔符或 `..` 的值，三个工具只解析到频道 `memory/` 下 |
| `src/agent/channel-runner.ts` | 保留 `firstTurnMemoryBootstrapPending` 及其「prompt 确认提交后才清除」的语义；`buildFirstTurnMemoryBootstrap` 改为 `store.listEntries` + 工作区 `MEMORY.md` + `index-budget` + `render`；删除 `recallRelevantMemory` 调用、`memoryCandidateStore`、`findPreviousUserText` 与 `contextQuery`。`lifecycle.ts` 的 `session_compact` 钩子把 pending 置回 true（D1） |
| `src/agent/turn-prompt.ts` / `src/agent/prompt/manifest.ts` | 删除 `recalledMemory`；`durableMemoryBootstrap` 改为 `memoryBootstrap`（工作区 `MEMORY.md` + 频道索引；journal 在 P2 加）；manifest 的 units 字段同步 |
| `src/agent/prompt/sections.ts:86` | 「SESSION.md, MEMORY.md and HISTORY.md are runtime-managed; do not edit」改为「memory files under `memory/` may be read with `read`; write them only through `memory_save`/`memory_forget` so the index stays in sync」 |
| `src/memory/extraction.ts` | **过渡**：输出 schema 不变，`toMemoryOp` 改为产出 `store.ts` 的 add/update/delete（`supersede` → `update`，`invalidate` → `delete`；`targetId` 解析为 name）；`renderSimilarMemoryEntriesForPrompt` 改为直接渲染索引 |
| `src/memory/consolidation.ts` | `runInlineConsolidation` 改调 `store.applyOps`；`cleanupChannelMemory` / `foldChannelHistory` 在 P1 保持但对新布局成为 no-op（P2 删除） |
| `src/memory/lifecycle.ts` | `sourceWindow` 与 boundary 逻辑不变；去掉对 `SESSION.md` 刷新的调用（`refreshSessionMemory` 在 P1 直接返回 false，P2 删除） |
| `src/runtime/bootstrap.ts` / `src/tui/*` | 启动时对每个已知频道调用 `migrate.ts`（在 runner 创建之前）；工作区目录不迁移 |
| `src/paths.ts` | 无新常量；频道内路径由 `store.ts` 自己拼 |

### 删除

`src/memory/bootstrap.ts`、`candidates.ts`、`metadata.ts`、`recall.ts`（分词部分先搬走）、`chinese-words.ts`（搬到 `search.ts` 旁的 `search-chinese-words.ts` 或原地保留但只被 `search.ts` 引用）、`test/memory-bootstrap.test.ts`、`test/memory-recall.test.ts`（分词相关的用例搬到 `test/memory-search.test.ts`）、`test/memory-metadata.test.ts`。

### 新测试

`test/memory-store.test.ts`、`test/memory-index-budget.test.ts`、`test/memory-search.test.ts`、`test/memory-migrate.test.ts`（fixture：`test/fixtures/memory-v1/` 放一份脱敏的真实 v1 频道目录）、e2e M1 / M1b / M2 / M5 / M6 / M7。

### 实施记录（2026-09-04）

- P1 按上表落地，`npm run check` + `npm run test:e2e` 全绿（分支 `feat/memory-v2-p1`）。
- **偏离**：原计划让反思 pass「仍用旧提炼 prompt 适配」。实测旧 `extraction.ts` 的 id 化 supersede 契约无法干净地映射到 name 化的 store，强行桥接是 P2 会丢弃的一次性胶水。改为：`extraction.ts` / `consolidation.ts` / `probation.ts` / `promotion.ts` / `session.ts` / `maintenance-jobs.ts` **保留在树上**，但对已迁移频道（`isChannelMigratedToV2` 门控）整体短路。调度器 / gate / state 机制保留，作为 P2 `reflect.ts` 的接入点。**后果：P1 与 P2 之间后台自动 capture 关闭**；`memory_save` 显式写入不受影响。
- e2e：实装 M1（首轮注入 + 次轮不注入）与 M6（首次使用即迁移）；M1b/M2/M5/M7 顺延到 P2/P3 随 reflect 与 `/memory` 命令一起补。
- 迁移的 type 映射对「Constraints 段里的机器事实/指针」额外走 `reference`（真实数据里 `claude CLI 已安装…` 这类条目）。
- TS 字段名 `durableMemoryBootstrap` 未改名为 `memoryBootstrap`（纯 cosmetic，降低 diff 面）；渲染出的 XML 标签已是 `<memory_bootstrap>`。

### P1 验收

- 本机 `~/.pipiclaw` 备份后升级：迁移日志显示条数与实际一致；`/memory list` 输出与 `MEMORY.md` 一致；`/new` 后第一条消息的 `last_prompt.json`（`PIPICLAW_DEBUG=1`）含 `<memory_bootstrap>`，第二条不含；`/compact` 后的第一条再次含。
- 缩进子弹并入父条目（用 F1 的那条 Preferences 验证）。

## P2 日志与反思

### 新文件

| 文件 | 职责 |
|---|---|
| `src/memory/journal.ts` | 当天文件路径（本地日期）、追加去重、尾部裁剪、读取某天 |
| `src/memory/reflect.ts` | 反思 prompt、JSON 解析、D7 的全部不变量、condense 模式、`touch` 与试用期到期删除；调用 `store.applyOps` 与 `journal.append` |
| `src/memory/reflect-job.ts` | 后台 job：gate → source window → `reflect.run` → 游标推进 → review-log；替代 `maintenance-jobs.ts` |

### 改动

| 文件 | 改动 |
|---|---|
| `src/memory/lifecycle.ts` | boundary 路径改调 `reflect.run`；`flushForShutdown` 同 |
| `src/memory/maintenance-gates.ts` | 只剩 `shouldRunReflect` |
| `src/memory/maintenance-state.ts` | 字段收缩为 D9；读取旧字段时映射 `lastCheckpointEntryId → lastReflectedEntryId` |
| `src/memory/maintenance-tuning.ts` | 常量收缩为 D9 |
| `src/memory/scheduler.ts` | 单 job |
| `src/memory/review-log.ts` | reason 集合改为 D10；gate skip 不再写入 |
| `src/agent/turn-prompt.ts` | `<memory_bootstrap>` 内加 `<journal>` 段与预算 |
| `src/agent/maintenance-context.ts` | 不变（磁盘冷上下文仍供反思 job 用） |

### 删除

`src/memory/session.ts`、`extraction.ts`（并入 `reflect.ts`）、`consolidation.ts`、`maintenance-jobs.ts`、`probation.ts`、`promotion.ts`、`source-window.ts` 保留（反思仍用增量窗口）；`test/session-memory.test.ts`、`test/memory-consolidation-ops.test.ts`、`test/memory-extraction.test.ts`（用例迁到 `test/memory-reflect.test.ts`）、`test/memory-probation.test.ts`、`test/memory-promotion.test.ts`、`test/memory-maintenance-jobs.test.ts`（→ `test/memory-reflect-job.test.ts`）。

### 新测试

`test/memory-journal.test.ts`、`test/memory-reflect.test.ts`、`test/memory-reflect-job.test.ts`、e2e M3 / M4 / M8。`test/e2e/deterministic/memory.test.ts` 的 A9 改为断言 `memory/*.md` 出现而不是 `MEMORY.md` 含子串；A10 删除（召回不存在了），由 M1/M2 覆盖。

### P2 验收

- 本机跑一天：`journal/<today>.md` 有条目且无重复；`memory-review.jsonl` 新增行全部含 `actions` 或 `skipped` 或 `error`；`/usage` 的 sidecar 调用数 ≤ 每 20 分钟一次 + 边界。

## P3 周边

| 文件 | 改动 |
|---|---|
| `src/memory/commands.ts` + `src/commands/catalog.ts` | `status` / `list [type]` / `show <name>` / `forget <name>` / `journal [date]`；删 `recent` |
| `src/subagents/discovery.ts` / `src/subagents/tool.ts` | `memory: none | index`；旧值映射 + warning；`subagent_inline.context` 枚举同步；上下文注入改用 `store` + `journal` + `index-budget`（预算减半） |
| `src/settings.ts` | `memoryRecall` 与 `sessionMemory` 两段整体退役进 `RETIRED_SETTINGS_KEYS`；不新增任何 settings 键 |
| `src/index.ts` | 不加导出；确认 `PipiclawSettings` 类型变更后的公共面仍是 035 的集合 |
| `test/memory-manage.test.ts` / `test/subagent-*.test.ts` | 更新 |

## P4 质量证据与文档

| 项 | 内容 |
|---|---|
| `evals/memory-recall-quality/` | 30 条预置记忆 + 20 个改述问题 + 10 个「不该用记忆」的问题 + 1 段纯进度对话（断言反思 `ops` 为空）；grader 与 baseline 按 028 的结构；在本 spec 合并前用当前 master 跑一次留 baseline |
| `docs/memory.md` | 重写 |
| `docs/architecture.md` §6 / §11 | 重写 |
| `docs/deployment-and-operations.md` | 单 job；回滚四步 |
| `docs/configuration.md` / `configuration-reference.md` | 退役键 |
| `docs/sub-agents.md` | `memory: index` |
| `AGENTS.md` / `CLAUDE.md` | 文件清单与记忆段落 |
| `src/playbooks/memory-and-learning.md` / `runtime-orientation.md` | 五分法表格；`memory_save` 用法；可直接编辑 |
| `docs/specs/README.md` | 050 一行 |
| `CHANGELOG` | 升级说明：自动迁移、`.memory-v1/` 位置、回滚步骤、退役的 settings 键 |

## 实施纪律

- 每个阶段一个 PR；PR 内按「新增 → 切换调用方 → 删除旧实现」三个 commit 排列，方便 review 与回退。
- 删除旧模块前 `rg` 一遍 `test/**` 的 `vi.mock("../src/memory/…")` 路径（历史教训：测试的 mock 路径比源码 import 深一层）。
- 迁移代码在 P1 合并前必须用本机真实 `~/.pipiclaw`（备份副本）跑过一次，并把脱敏后的目录作为 fixture 提交。
- 任何一个阶段发现设计需要改，改 `design.md` 并在对应 D 条目下加「实施记录」小节，不另开 spec。

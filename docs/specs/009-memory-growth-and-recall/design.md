# Memory Growth And Recall 设计方案

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | DRAFT |
| 日期 | 2026-04-19 |
| 关联参考 | `docs/refer/hermes-learning-insights.md`, `docs/refer/pipiclaw-vs-hermes.md` |

---

## 背景

Pipiclaw 已经完成了第一阶段 memory 升级：

1. `SESSION.md` 承担 channel 当前工作态
2. `MEMORY.md` 承担 channel durable memory
3. `HISTORY.md` 承担 channel 旧上下文摘要
4. 每轮可从 `SESSION.md / MEMORY.md / HISTORY.md` 做 relevant recall
5. compaction、`/new`、shutdown 前有 preflight consolidation
6. idle 后有自动 consolidation 与 background maintenance
7. sub-agent 已支持 contextual memory 注入

这意味着 spec 009 不应该重复 spec 003 的目标，也不应该引入另一套并行 memory 系统。

本 spec 的目标是把当前“状态维护闭环”升级成更可靠的“长期成长与冷路径回忆闭环”：

1. 收紧不同 memory 文件的职责边界，降低自动沉淀噪音
2. 增加当前 channel 内的 transcript-native 冷路径检索
3. 引入结构化 post-turn review，判断什么值得沉淀
4. 把 workspace `skills/` 从静态资源升级为可维护的 procedural memory
5. 保持热路径克制、channel/workspace 作用域清晰、安全边界不后退

---

## 设计立场

Hermes 值得借鉴的不是“更大的 memory provider/plugin 生态”，而是它把长期成长拆成了几类可审计资产：

1. facts 进入 memory
2. workflows 进入 skills
3. transcripts 进入 searchable session store
4. post-turn review 判断是否值得沉淀
5. compaction 前做保存动作

Pipiclaw 不能照搬 Hermes 的全局 agent home 和 memory provider 路线。Pipiclaw 的主语义仍然是：

1. workspace
2. channel
3. DingTalk long-running runtime
4. 文件型、可审计、低热路径成本的记忆资产

所以 spec 009 的核心原则是：

> 不扩大普通 memory 的语义，而是在现有分层之上增加更清晰的 promotion、review、search、skill 写回边界。

---

## 当前问题

### 1. Idle consolidation 可能让 HISTORY.md 过细

当前 [MemoryLifecycle](/Users/oyasmi/projects/pipiclaw/src/memory/lifecycle.ts) 会在 assistant turn 后安排 idle consolidation。idle consolidation 调用的是 [runInlineConsolidation](/Users/oyasmi/projects/pipiclaw/src/memory/consolidation.ts)，而 inline consolidation prompt 要求 meaningful exchange 产出 `historyBlock`。

这会导致一个风险：

1. 普通几轮对话也可能持续写 `HISTORY.md`
2. `HISTORY.md` 从“阶段性旧上下文摘要”退化为“细粒度工作日志”
3. 后续 history recall 命中噪音增加
4. background folding 压力变大

### 2. MEMORY.md promotion 边界还不够硬

当前 consolidation prompt 仍允许 `memoryEntries` 保存：

> current work state, or open loops that should survive compaction

在没有 `SESSION.md` 时，这个设计是合理的。但现在 `SESSION.md` 已经承担 current working state，`MEMORY.md` 应该进一步收紧为 durable / semi-durable 知识。

否则会出现：

1. active task state 同时存在于 `SESSION.md` 和 `MEMORY.md`
2. stale `MEMORY.md` 覆盖 fresher `SESSION.md`
3. cleanup worker 需要更频繁地清 transient state

### 3. 旧 transcript 没有显式冷路径召回

当前 relevant recall 只面向整理后的 memory 文件：

1. `SESSION.md`
2. channel `MEMORY.md`
3. workspace `MEMORY.md`
4. channel `HISTORY.md`

如果某个关键路径、命令、错误、用户要求没有被整理进这些文件，用户后续说“之前不是做过吗”时，runtime 没有一条正式工具链从 `context.jsonl` 或 session jsonl 中找回。

这不是普通 turn-time recall 应该解决的问题。它需要一个显式、冷路径、当前 channel scoped 的 `session_search`。

### 4. Skills 仍然偏静态资源

Pipiclaw 当前会加载 workspace `skills/`，但 skills 主要是被动资源：

1. 可被 agent 读取
2. 可被 system prompt 列出
3. 不存在一等的 skill 管理工具
4. 不存在复盘后创建/修补 skill 的协议

这使得 Pipiclaw 能持续维护“状态”，但还不能稳定沉淀“做事方法”。

### 5. 缺少结构化 post-turn review

当前系统有 session refresh、durable consolidation、background maintenance，但它们主要是维护文件状态。

缺少一个明确回答下面问题的后处理层：

1. 这轮有什么 durable fact 值得进 channel memory？
2. 这轮有什么 active state 应该只留在 `SESSION.md`？
3. 这轮有没有 reusable procedure 值得写成 workspace skill？
4. 哪些内容应明确丢弃？
5. 如果自动写回，置信度和理由是什么？

---

## 非目标

1. 不做全局 memory provider/plugin 生态
2. 不做 embedding、vector database、semantic memory database
3. 不把 `log.jsonl` / `context.jsonl` 放进普通 turn-time recall
4. 不自动修改 workspace `SOUL.md`、`AGENTS.md`、`MEMORY.md`
5. 不引入 channel 级 skills；skills 只有 workspace 级
6. 不做跨 channel / 跨 workspace session search
7. 不把 `HISTORY.md` 当成 per-turn log
8. 不让 background reviewer 静默进行低置信、大范围 workspace 改写

---

## Memory 分层职责

spec 009 要把文件职责写得更硬。

### `SESSION.md`

层级：hot / working memory

职责：

1. 当前用户意图
2. 当前任务状态
3. active files / commands / hypotheses
4. 近期错误与纠正
5. 近期决策
6. 下一步

不承担：

1. durable user preference
2. 长期项目事实
3. 旧会话叙事
4. reusable procedure

写入方式：

1. session updater 自动维护
2. compaction/new/shutdown 前强制刷新
3. post-turn review 可提出 session correction
4. 不作为人工普通维护对象

### Channel `MEMORY.md`

层级：warm / durable channel memory

职责：

1. channel 内稳定事实
2. durable decisions
3. user/team preferences
4. medium-horizon constraints
5. medium-horizon open loops

不承担：

1. 分钟级任务状态
2. 临时 debugging 观察
3. 已解决的 worklog
4. 可复用方法论

写入方式：

1. consolidation promotion
2. post-turn reviewer 高置信 durable fact 可自动写入
3. 低置信 durable fact 进入 suggestion
4. cleanup 可移除 transient state

### `HISTORY.md`

层级：warm-on-demand / chronological recovery

职责：

1. 已过去工作阶段的摘要
2. 里程碑
3. 重要决策结果
4. 需要未来恢复的叙事线索

不承担：

1. 每轮对话摘要
2. raw transcript
3. 当前 active state
4. facts 的权威来源

写入方式：

1. compaction/new/shutdown 边界可写
2. idle 阶段默认不写
3. background folding 周期性压缩旧块

### `context.jsonl` / session jsonl / `log.jsonl`

层级：cold storage

职责：

1. 审计
2. 恢复
3. 显式 transcript-level investigation
4. 当前 channel 的 `session_search`

不承担：

1. 普通 memory source
2. 每轮自动 recall
3. prompt 常驻上下文

### Workspace `skills/`

层级：workspace procedural memory

职责：

1. 可复用 workflow
2. 代码审查/发布/排障等团队方法
3. 特定项目或团队的操作步骤
4. 模板、脚本、参考文档

不承担：

1. channel 当前任务状态
2. 用户偏好事实
3. 单次任务流水账
4. workspace identity/rules

写入方式：

1. `skill_manage` 显式工具写入
2. post-turn reviewer 高置信、必要性明确时可直接创建或 patch workspace skill
3. 不太明确的 skill candidate 进入 suggestion
4. 不存在 channel 级 skill

---

## 推荐分期

## Phase 1: Memory Lifecycle Hardening

目标：先把现有自动沉淀链路收紧，避免噪音继续进入 durable files。

### 1. 拆分 idle 与 boundary consolidation

当前 `ConsolidationReason` 已有：

```ts
type ConsolidationReason = "compaction" | "new-session" | "idle" | "shutdown";
```

建议语义改为：

| reason | SESSION.md | MEMORY.md | HISTORY.md | 说明 |
|--------|------------|-----------|------------|------|
| `idle` | 可刷新 | 可写高置信 durable facts | 默认不写 | 保持轻量，不产生日志化 history |
| `compaction` | 强制刷新 | 可写 | 可写 | 即将丢上下文，允许阶段摘要 |
| `new-session` | 强制刷新 | 可写 | 可写 | session 边界，允许阶段摘要 |
| `shutdown` | 尽力刷新 | 可写 | 可写 | 进程边界，允许保存 |

实现建议：

1. 新增 `runIdlePromotion()` 或给 `runInlineConsolidation()` 增加 mode
2. idle mode 输出 schema 不包含 `historyBlock`
3. boundary mode 保持 `historyBlock`，但 prompt 明确是阶段摘要

### 2. 收紧 consolidation prompt

`memoryEntries` 规则从：

> durable facts, decisions, preferences, constraints, current work state, or open loops

改为：

> durable facts, decisions, preferences, constraints, and medium-horizon open loops that should remain true beyond the current active task burst.

并增加负例：

1. 不保存当前执行步骤
2. 不保存刚刚读过的文件名，除非它是长期关注对象
3. 不保存已解决错误，除非它是 future pitfall
4. 不保存“本轮完成了 X”这类 completed worklog

### 3. 引入 promotion candidate schema

新增结构建议：

```ts
export type MemoryPromotionTarget =
	| "session"
	| "channel-memory"
	| "history"
	| "workspace-skill"
	| "suggestion"
	| "discard";

export type MemoryPromotionKind =
	| "fact"
	| "decision"
	| "preference"
	| "constraint"
	| "open-loop"
	| "procedure"
	| "transient"
	| "history";

export interface MemoryPromotionCandidate {
	id: string;
	kind: MemoryPromotionKind;
	target: MemoryPromotionTarget;
	confidence: number;
	summary: string;
	reason: string;
	source: {
		channelId: string;
		sessionEntryIds?: string[];
		startedAt?: string;
		endedAt?: string;
	};
}
```

第一阶段可先作为 internal worker 输出，不一定立即暴露给工具。

### 4. 增加 memory decision audit

新增 cold/warm diagnostic 文件：

```text
<channel>/memory-decisions.jsonl
```

每行记录：

```json
{
  "timestamp": "2026-04-19T...",
  "reason": "idle",
  "candidates": [],
  "actions": [
    {
      "target": "channel-memory",
      "action": "append",
      "confidence": 0.92,
      "summary": "..."
    }
  ],
  "skipped": [
    {
      "target": "history",
      "reason": "idle does not write HISTORY.md"
    }
  ]
}
```

这不是 ordinary memory，不参与 recall。它用于调试、审计和质量评估。

---

## Phase 2: Current-Channel Session Search

目标：当整理后的 memory 没有覆盖旧细节时，agent 能显式搜索当前 channel 的冷存储。

### 工具

新增 `session_search` 工具。

参数建议：

```ts
const sessionSearchSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you are trying to recall" }),
	query: Type.Optional(Type.String({ description: "Keywords or phrase to search in this channel's past sessions" })),
	limit: Type.Optional(Type.Number({ description: "Max sessions or chunks to summarize, default 3, max 5" })),
	roleFilter: Type.Optional(Type.Array(Type.String(), { description: "Optional roles to search: user, assistant, tool" })),
});
```

模式：

1. `query` 为空：浏览当前 channel recent sessions / recent transcript chunks
2. `query` 非空：搜索当前 channel transcript 并返回 focused summaries

### 数据源

只允许当前 channel：

1. `<channel>/context.jsonl`
2. 当前 channel 内 pi session jsonl 文件
3. `<channel>/log.jsonl`
4. 必要时 `<channel>/subagent-runs.jsonl` 可作为后续扩展，不进第一版

不搜索：

1. 其他 channel
2. workspace 下所有 channel
3. 用户 home 全局 session
4. workspace `skills/`

### 第一版检索实现

不建议第一版直接上 SQLite。理由：

1. Node 依赖面更小
2. 当前 channel 文件规模可先用扫描 + cache 承担
3. 避免把 cold search 误解成普通 memory database

建议实现：

1. `src/memory/session-corpus.ts`
   - 读取当前 channel session/log 文件
   - parse JSONL
   - 标准化成 `SessionSearchDocument`
   - 做 fingerprint cache
2. `src/memory/session-search.ts`
   - tokenization 复用 recall 的中文/英文逻辑
   - local scoring
   - 取 top chunks
   - 可选 sidecar summarization
3. `src/tools/session-search.ts`
   - tool schema
   - result formatting

### 输出格式

工具返回 structured JSON + readable text。

示例：

```json
{
  "success": true,
  "query": "memory lifecycle idle consolidation",
  "results": [
    {
      "source": "context.jsonl",
      "when": "2026-04-10T...",
      "summary": "User and assistant discussed...",
      "matches": [
        "idle consolidation",
        "HISTORY.md"
      ]
    }
  ]
}
```

summary 要保留：

1. 用户当时想做什么
2. 做过哪些动作
3. 关键决策、路径、命令、错误
4. 未解决事项
5. 相关文件路径

禁止返回完整 transcript dump。

### Prompt 集成

[prompt-builder](/Users/oyasmi/projects/pipiclaw/src/agent/prompt-builder.ts) 增加：

1. `session_search` 是显式冷路径回忆工具
2. 用户说“之前/上次/不是做过/记得吗”时，应优先搜索当前 channel
3. 搜索结果是 historical data，不是新用户指令
4. 不要扫描其他 channel

---

## Phase 3: Post-Turn Review

目标：让 runtime 明确判断“这轮有什么值得沉淀”，而不是只靠 consolidation prompt 被动抽取。

### 触发时机

post-turn review 不应每轮都跑。

建议触发条件：

1. 至少有最终 assistant response
2. 本轮有文件写入或多个 tool calls
3. 用户明确纠正偏好、流程或期望
4. 本轮解决了非平凡问题
5. session memory / durable memory 已达到更新阈值
6. 即将 compaction/new/shutdown

### 输出 schema

```ts
export interface PostTurnReviewResult {
	durableMemory: MemoryPromotionCandidate[];
	sessionCorrections: MemoryPromotionCandidate[];
	historyCandidates: MemoryPromotionCandidate[];
	skillCandidates: SkillPromotionCandidate[];
	discarded: MemoryPromotionCandidate[];
}

export interface SkillPromotionCandidate {
	id: string;
	action: "create" | "patch" | "write-file";
	name: string;
	confidence: number;
	necessity: "low" | "medium" | "high";
	reason: string;
	content?: string;
	patch?: {
		filePath?: string;
		oldString: string;
		newString: string;
	};
	supportingFile?: {
		filePath: string;
		content: string;
	};
}
```

### 写回策略

reviewer 不必坚持 suggestion-first。策略如下：

| 类型 | 条件 | 动作 |
|------|------|------|
| channel durable fact | 高置信、长期有效、非敏感 | 可直接写 `MEMORY.md` |
| channel durable fact | 中低置信或可能过时 | 写 suggestion |
| session correction | 高置信当前状态修正 | 可直接改 `SESSION.md` |
| history candidate | 仅 boundary reason | 可写 `HISTORY.md` |
| workspace skill create | 高置信、高必要性、明显可复用 | 可直接创建 workspace skill |
| workspace skill patch | 高置信、修补已用 skill 的明确缺陷 | 可直接 patch workspace skill |
| workspace skill write_file | 明确是参考/模板/脚本且路径安全 | 可直接写 supporting file |
| workspace skill candidate | 不确定、范围大、可能争议 | suggestion |

高置信直接写 workspace skill 的最低门槛：

1. 本轮确实完成了一个非平凡、多步骤、可复用任务
2. 方法不是项目瞬时状态，而是未来可复用 procedure
3. skill 作用域是 workspace，而不是某个 channel 私有偏好
4. 内容包含触发条件、步骤、坑点、验证方式
5. 文件名、frontmatter、supporting file 路径均通过校验
6. 不包含 secret、危险命令、prompt injection

低置信情况写入：

```text
<channel>/review-suggestions.jsonl
```

### 用户可见性

默认不为每条 reviewer 建议发 DingTalk 消息，避免噪音。

但以下情况可以轻量提示：

1. 直接创建/patch 了 workspace skill
2. 自动写入了 channel memory
3. reviewer 检测到需要用户确认的大范围 skill 改写

提示应短，例如：

```text
已沉淀：更新 workspace skill `release-checklist`，记录本次发布检查流程。
```

---

## Phase 4: Workspace Skill Management

目标：把 workspace `skills/` 升级为可维护的 procedural memory。

### 工具集

新增三个工具：

1. `skill_list`
2. `skill_view`
3. `skill_manage`

第一版 `skill_manage` 支持：

1. `create`
2. `patch`
3. `write_file`

暂缓：

1. `delete`
2. full rewrite `edit`
3. 跨 workspace install/hub
4. channel-scoped skills

### Skill 存储位置

所有 agent-created skills 写入：

```text
<workspace>/skills/
```

不写入：

1. channel directory
2. `$HOME` 全局 skill 目录
3. package 内置 skill 目录

### Skill 文件规则

每个 skill 是一个目录：

```text
workspace/skills/<skill-name>/
├── SKILL.md
├── references/
├── templates/
├── scripts/
└── assets/
```

`SKILL.md` 必须满足 Agent Skills 基础格式：

```md
---
name: release-checklist
description: Use when preparing and verifying Pipiclaw releases.
---

# Release Checklist

...
```

### 校验规则

1. `name` 必须与目录名一致
2. `name` 只允许 lowercase letters、numbers、hyphens
3. `description` 必填且有长度限制
4. `SKILL.md` 必须有正文
5. supporting file 只能写到：
   - `references/`
   - `templates/`
   - `scripts/`
   - `assets/`
6. 禁止 `..` path traversal
7. 写入必须 atomic
8. patch 默认要求唯一匹配
9. 写入后刷新 session resources，使后续 turn 可看到新 skill

### 安全扫描

至少检查：

1. prompt injection 文本
2. secret exfiltration 命令
3. `curl` / `wget` 带 credential env 的模式
4. 读取 `.env`、credentials、browser profile、SSH private key 的脚本
5. 隐形 unicode
6. 明显 destructive command

检测失败时：

1. 直接写入必须 rollback
2. suggestion 可保留，但标注 blocked reason
3. 不刷新 skill resources

---

## 关键实现改动

### `src/memory/`

新增：

1. `promotion.ts`
2. `post-turn-review.ts`
3. `session-corpus.ts`
4. `session-search.ts`
5. `memory-audit.ts`

修改：

1. `consolidation.ts`
   - 支持 idle/boundary mode
   - prompt 收紧 promotion 边界
   - 输出 promotion candidates
2. `lifecycle.ts`
   - idle 不默认写 history
   - post-turn review 调度
   - audit log 写入
3. `recall.ts`
   - 可复用 tokenizer/scoring 给 session search

### `src/tools/`

新增：

1. `session-search.ts`
2. `skill-list.ts`
3. `skill-view.ts`
4. `skill-manage.ts`

修改：

1. `index.ts`
   - 注册新工具
2. `config.ts`
   - 可选开关：
     - `tools.memory.sessionSearch.enabled`
     - `tools.skills.manage.enabled`

### `src/agent/`

修改：

1. `channel-runner.ts`
   - turn 完成后把必要信号传给 post-turn review
   - direct skill write 后刷新 session resources
2. `prompt-builder.ts`
   - 增加 `session_search` 和 skill 写回语义
   - 明确 cold storage 只通过工具检索
   - 明确 workspace skills 是 procedural memory
3. `workspace-resources.ts`
   - 复用现有 skill loader
   - 确保新 skill 被下一次 resource reload 捕获

### `test/`

新增或扩展：

1. `test/memory-lifecycle.test.ts`
   - idle 不写 `HISTORY.md`
   - boundary 仍可写 history
2. `test/integration/memory-consolidation.test.ts`
   - current state 不进入 `MEMORY.md`
   - medium-horizon open loop 可进入 `MEMORY.md`
3. `test/session-search.test.ts`
   - 当前 channel 搜索
   - 不跨 channel
   - query 为空列 recent
   - 中文 query fallback
   - summary fallback
4. `test/skill-manage.test.ts`
   - create/patch/write_file
   - path traversal block
   - invalid frontmatter block
   - security scan rollback
5. `test/post-turn-review.test.ts`
   - 高置信 direct write
   - 低置信 suggestion
   - skill direct write vs suggestion 分流

---

## 设置项建议

新增 settings：

```ts
export interface PipiclawMemoryGrowthSettings {
	postTurnReviewEnabled: boolean;
	autoWriteChannelMemory: boolean;
	autoWriteWorkspaceSkills: boolean;
	minSkillAutoWriteConfidence: number;
	minMemoryAutoWriteConfidence: number;
	idleWritesHistory: boolean;
}

export interface PipiclawSessionSearchSettings {
	enabled: boolean;
	maxFiles: number;
	maxChunks: number;
	maxCharsPerChunk: number;
	summarizeWithModel: boolean;
	timeoutMs: number;
}
```

默认建议：

```json
{
  "memoryGrowth": {
    "postTurnReviewEnabled": true,
    "autoWriteChannelMemory": true,
    "autoWriteWorkspaceSkills": true,
    "minSkillAutoWriteConfidence": 0.9,
    "minMemoryAutoWriteConfidence": 0.85,
    "idleWritesHistory": false
  },
  "sessionSearch": {
    "enabled": true,
    "maxFiles": 50,
    "maxChunks": 20,
    "maxCharsPerChunk": 12000,
    "summarizeWithModel": true,
    "timeoutMs": 30000
  }
}
```

---

## 成功标准

### Memory quality

1. idle 后 `HISTORY.md` 不再持续产生细粒度 per-turn block
2. `MEMORY.md` 中 transient current-state 明显减少
3. `SESSION.md` 保持 current-state 主权
4. memory cleanup 频率和 rewrite 压力下降

### Recall

1. 用户问“之前做过什么”时，agent 能调用 `session_search`
2. `session_search` 只返回当前 channel 结果
3. 输出是 focused summary，不是 transcript dump
4. 搜索失败时能优雅返回 no match 或 fallback snippet

### Procedural memory

1. 高置信 reusable workflow 能沉淀为 workspace skill
2. 低置信 workflow 进入 suggestion，不污染 workspace
3. 新 skill 可被后续 session 正常加载
4. patch skill 后资源刷新有效

### Safety and observability

1. 所有自动写回都有 audit trail
2. skill 写入路径不能逃逸 `workspace/skills/`
3. security scan 失败会 rollback
4. reviewer failure 不影响主 turn
5. 普通 turn 首 token 延迟不因 session search 增加

---

## 已确认决策

1. `post-turn review` 的触发阈值与 `sessionMemory.minTurnsBetweenUpdate` / `sessionMemory.minToolCallsBetweenUpdate` 共用。
2. `memory-decisions.jsonl` 与 `review-suggestions.jsonl` 合并为 `memory-review.jsonl`。
3. `session_search` 第一版搜索当前 channel 的 `log.jsonl.1`，如果文件存在。
4. direct skill write 后发送 DingTalk 轻提示，并同时写入 `memory-review.jsonl`。
5. 高置信 direct skill create 的 confidence 阈值固定为 `0.9`。

---

## 实施顺序

建议按以下顺序落地：

1. Phase 1：收紧 consolidation 与 idle history 写入
2. Phase 2：实现 current-channel `session_search`
3. Phase 3：实现 post-turn review 与 audit/suggestion 文件
4. Phase 4：实现 workspace skill 管理工具
5. Phase 5：把 high-confidence reviewer 与 `skill_manage` 连接起来

这样做的原因是：

1. 先降低现有 memory 噪音
2. 再补 transcript 冷路径兜底
3. 再开启更强的自动成长写回

spec 009 的底线是：Pipiclaw 可以更会“成长”，但不能牺牲 workspace/channel 分层和 DingTalk runtime 的可解释性。

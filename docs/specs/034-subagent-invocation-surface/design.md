# 子代理调用面收缩：把执行策略还给配置与台账

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED |
| 日期 | 2026-07-24 |
| 前置 | 002 subagent、032 subagent adoption、033 workspace-subagents-only |
| 关联实现 | `src/subagents/tool.ts`、`src/subagents/discovery.ts`、`src/playbooks/task-delegation.md`、`docs/sub-agents.md` |

## 背景

一轮外部审查提出：`subagent` 已经从"委派工具"长成了"第二套 runtime 管理界面"，主代理每次委派都要同时决定任务内容和一整套执行策略。审查给出的方案是把调用面砍到 `{ task, role?, tools?, model? }` 四个参数，其余全部固定。

核实后的结论是：**问题真实，方案错误。**

审查列出的六条"应改为固定策略"里，有四条 spec 032 D4 已经实现：默认 `isolated`（`discovery.ts` 的 `parseContextMode` 默认值）、完整输出无条件落盘 `subagent-artifacts/<runId>/output.md`、超预算回传截断并附文件指针（`MAX_SUBAGENT_RESULT_UNITS`）、固定预算默认值配 D6 收敛回合。审查是对着一份过时的认知提的。

另外两条方向相反：

- **"不在子代理工具中承担 task verification"** —— `purpose=verify` 的全部价值恰恰在于 attestation 由 runtime 写入，并用 `subjectHash` 证明 verifier 自己没改工作区。移到主代理侧等于让 maker 给自己签验收单，023/029/032 建立的 maker/checker 分离整条链作废。`task-commands.ts` 与 `tools/task-manage/verification.ts` 都在消费这份 attestation。
- **"不管理 task-owned worktree"** —— `control.worktree` 是跨进程重启后台账还知道 worktree 在哪的唯一记录。删掉它，主代理只能用裸 bash 管 worktree，可审计性反而下降。

第三条 **"inline 与 predefined 只保留一种"** 与 spec 033 的既定决策冲突：predefined 是**人**的配置面（`workspace/sub-agents/*.md`，人写、可版本化），inline 是**模型**的调用面，服务不同主体；`resolveSubAgentConfig` 早已统一两者，保留成本接近零。

## 病根的准确表述

真实问题不是"参数太多"，而是**参数分层错了**：调用面 schema 有 20 个顶层字段，其中 7 个是模型没有判断依据的执行策略。

1. **数值预算 ×4**（`maxTurns` / `maxToolCalls` / `maxWallTimeSec` / `bashTimeoutSec`）。模型在委派时无法预知任务需要多少轮，任何具体数字都是猜的；而人在配置文件里调这些数字是完全合理的。测试侧的证据佐证了这点：这四个参数**在调用层从未被任何测试覆盖过**，只有 frontmatter 路径有覆盖。
2. **冗余编码 ×2**（`contextMode` + `memory`）。两个旋钮只编码 4 个有意义状态，且 `isolated` 恒等于 `memory: none`。
3. **可推导 ×1**（`worktreePath`）。`control.worktree.path` 已经记录了归属 worktree，但 `tool.ts` 只写不读，于是要求模型手抄路径回传。

因此本 spec 的原则是：**runtime 管理属于人（frontmatter + 台账），委派属于模型（task + 角色 + 少量意图参数）**。frontmatter 一个旋钮都不减，只收缩模型每次调用要填的 schema。

## 设计

### D1 `contextMode` + `memory` → `context`

调用面合并为单个三值枚举，映射到既有的一对 frontmatter 字段：

| `context` | `contextMode` | `memory` |
|---|---|---|
| `none`（默认） | `isolated` | `none` |
| `session` | `contextual` | `session` |
| `relevant` | `contextual` | `relevant` |

丢失的唯一状态是 `contextual` + `memory: none`（只注入 `paths` 块），frontmatter 仍可表达。未传 `context` 时沿用预定义角色的 frontmatter 组合。

### D2 四个数值预算 → `effort`

| `effort` | maxTurns | maxToolCalls | maxWallTimeSec | bashTimeoutSec |
|---|---|---|---|---|
| `quick` | 8 | 16 | 120 | 60 |
| `standard`（默认） | 24 | 48 | 300 | 120 |
| `deep` | 48 | 96 | 900 | 180 |

`standard` 直接引用既有的 `DEFAULT_*` 常量，不复制字面量，因此不传 `effort` 时行为逐字节不变。

**关键语义：整组替换，不逐字段合并。** 传了 `effort` 就用整个预设元组，避免产生任何预设都不描述的预算组合。不传则用 frontmatter 数值，再退到内置默认。

D6 收敛回合（触顶时给一轮无工具的收敛机会，不整段丢弃工作）让预设偏小的代价可控，这是敢于收掉数值旋钮的前提。

### D3 移除 `worktreePath`，改从台账自动复用

`prepareRunContext` 的 worktree 分支改为查 `control.worktree.path`：

1. 有记录且路径存在 → 校验在 `channelDir/tasks/worktrees/` 之内且是可用 git worktree → 复用（沿用原本校验调用方入参的同一段代码，只换输入来源）。
2. 有记录但在 baseDir 之外，或不是可用 worktree → 报错，提示先用 `task_manage` 清理陈旧元数据。**不静默新建**，否则又回到孤儿问题。
3. 无记录，或记录的路径已从磁盘消失（递归任务的 `resetTaskControlForCycle` 会清掉 `worktree`）→ 走原有新建流程并 `recordTaskWorktree`。

**这修掉一个真实缺陷**：此前对同一 taskId 发起第二次 `isolation: worktree` 委派（不传 `worktreePath`）会新建第二个 worktree 并覆盖 `control.worktree`，把第一个变成孤儿。自动复用从结构上消除这条路径。

### D4 `grep` 工具白名单修正

`tools/registry.ts` 一直把 `grep` 标为 `availableToSubagents: true`，但 `discovery.ts` 的 `ALLOWED_SUB_AGENT_TOOLS` 里没有它，`filterToolsByName` 因此让子代理永远拿不到 grep——请求它只会得到"Unknown tool"。补进白名单；默认工具集仍是 `read` + `bash`。

## 最终调用面（15 参数）

`label`、`task`（必填）；`agent` / `systemPrompt`（二选一）、`name`、`tools`、`model`、`effort`、`context`、`paths`、`thinkingLevel`、`purpose`、`taskId`、`isolation`、`returns`。

保留 `purpose` / `taskId` / `isolation` / `returns` 是治理必需。`returns: "artifact"` 不只是保存策略——它给子代理注入了不同的输出协议（`ARTIFACT:` 标记行），有独立价值。保留 `thinkingLevel` / `paths` / `name` 是权衡后的显式选择：`name` 进入 `details.agent` 与 `subagent-runs.jsonl`，删掉会让所有 inline 委派记成同一个名字，观测性倒退。

## 兼容性

- **磁盘格式**：零变更。
- **frontmatter**：零变更。`examples/sub-agents/*.md` 五份模板一字不动，既有工作区配置行为不变。
- **调用面**：破坏性变更，但只影响模型生成的工具调用（无持久化载荷）。不传新参数时行为与之前一致。
- **公共 API**：`SubAgentInvocationOverrides` 增 `effort`/`context`，减七个字段——beta API 变更，已记 CHANGELOG。
- `resolvePositiveOverride` 失去全部调用点，随之删除。

## 被否决的替代方案

- **审查原方案（四参数）**：见"背景"，会拆掉验收链与 worktree 台账绑定。
- **保留数值参数但加 clamp**：不解决问题。模型仍要在每次调用时决策一个它没有依据的数字，clamp 只是把坏猜测变成边界值。
- **把预算下沉到 settings 而非 frontmatter**：settings 是全局的，而预算天然按角色变化（explorer 与 verifier 需要的轮数不同）。frontmatter 才是正确的归属层。
- **`worktreePath` 保留为可选逃生舱**：留着它就留着"模型手抄路径"这条路径，孤儿缺陷也就还在。真需要指向别处时，正确入口是 `task_manage` 改台账。

## 测试重点

- `context` 三值映射；未传时继承 frontmatter；非法值报错。
- `effort` 三档整组替换 frontmatter 数值；未传时 frontmatter 数值存活；`standard` 等于内置默认；非法值报错。
- worktree 三分支：复用台账记录（且 `git worktree list` 只有一个）、记录路径消失则新建、记录在 baseDir 外则报错。
- `grep` 可被 `tools` 请求到。
- 回归：D4 产物契约与 D6 收敛回合行为不变——收敛测试改为从 frontmatter 取紧预算，顺带覆盖"精确数值仍然生效"。

## 后续边界

不在本 spec 内：spec 032 的 **D7（work 结果回写 task 证据）与 D8（扇出并发护栏）至今未实现**，本次改动不触碰、也不与之冲突（D7 走 `updateStoredTask` 证据段，D8 走 `createSubAgentTool` 外层的共享单例闸门）。`effort` 三档的具体数值是初值，应在真实 `subagent-runs.jsonl` 积累触顶率分布后再校准。

# 工作区配置子代理（Sub-Agents）

> **读者**：想把 reviewer / researcher 这类角色沉淀成可复用能力的使用者。
> **前置**：已完成 [README](../README.md) 的安装与配置。
> **读完你能**：写出一个工作区子代理文件，并知道何时该用它、何时不该。

子代理是 Pipiclaw 的**委派**能力：把某类任务从主代理手里交给一个更聚焦、工具更窄的角色去做。它和[事件与任务](./events-and-tasks.md)是正交的两条能力——事件与任务解决"何时唤醒、在途状态如何"，子代理解决"这一步该不该换一个专门的角色来做"。

在写密集型子任务、独立验收（verifier）等场景里，子代理会和任务台账咬合（`isolation: worktree`、`purpose: verify`）；这些接缝会在下面点明，并链接回 [events-and-tasks.md](./events-and-tasks.md)。

## 它是什么（What It Is）

工作区配置子代理是放在 `~/.pipiclaw/workspace/sub-agents/*.md` 中的 Markdown 文件。Pipiclaw 只加载这个目录中实际存在且有效的文件；不会自动注入任何默认角色。主代理在合适的时候可以调用它们，把某类任务交给更聚焦的角色处理。

仓库提供了五个可复制、可修改的建议模板：[`examples/sub-agents/`](../examples/sub-agents/)。例如：

```bash
cp examples/sub-agents/{explorer,researcher,reviewer,verifier,git-committer}.md ~/.pipiclaw/workspace/sub-agents/
```

不复制模板也完全可以使用 inline `systemPrompt` 委派。`purpose: verify` 的验收约束由 runtime 执行，不要求一定配置名为 `verifier` 的文件。

适合的场景：

- 代码审查
- 信息收集
- 风险检查
- 某类固定格式的总结
- 把工作区改动整理成提交（读 diff、写提交消息是上下文密集的，适合隔离给 git-committer）

不适合的场景：

- 只需要主代理顺手完成的一步小事
- 需要继续递归创建下级代理的复杂代理树

## 文件结构（File Structure）

一个子代理文件由两部分组成：

1. **YAML frontmatter**：定义名字、描述、模型、工具和限制。
2. **Markdown 正文**：作为这个子代理的系统提示词（system prompt）。

最小示例（`~/.pipiclaw/workspace/sub-agents/reviewer.md`）：

```md
---
name: reviewer
description: 当需要只读审查代码改动、查找正确性问题、回归风险和缺失测试时使用；不要用于实现修复或最终验收。任务中应给出改动范围和验收背景。
tools: read,bash
contextMode: contextual
memory: relevant
thinkingLevel: medium
paths:
  - src/
  - test/
maxTurns: 24
maxToolCalls: 48
maxWallTimeSec: 300
bashTimeoutSec: 120
---

你是专注于正确性和回归风险的代码审查子代理。

只审查任务指定的改动，不修改文件。优先报告正确性缺陷、行为回归、危险假设和缺失测试，并为每条发现提供 `path:line` 证据。没有发现时明确说明已检查的范围和剩余风险。
```

## Frontmatter 字段说明（Frontmatter Reference）

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | - | 子代理名称，必须唯一 |
| `description` | 是 | - | 给主代理看的简短用途描述 |
| `tools` | 否 | `read,bash` | 允许的工具，支持 `read`、`grep`、`bash`、`edit`、`write`、`web_search`、`web_fetch` |
| `model` | 否 | 当前主代理模型 | 精确模型引用，建议写成 `provider/modelId` |
| `contextMode` | 否 | `isolated` | `isolated` 或 `contextual` |
| `memory` | 否 | `isolated` 时为 `none`，`contextual` 时为 `relevant` | `none`、`session`、`relevant` |
| `paths` | 否 | 空 | 建议优先关注的文件或目录 |
| `thinkingLevel` | 否 | 普通委派为 `off`，`purpose=verify` 为 `medium` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` |
| `maxTurns` | 否 | `24` | 最大 assistant 轮数 |
| `maxToolCalls` | 否 | `48` | 最大工具调用次数 |
| `maxWallTimeSec` | 否 | `300` | 最大总执行时长，秒 |
| `bashTimeoutSec` | 否 | `120` | 子代理内 bash 命令默认超时，秒 |

## 调用参数（Invocation Parameters）

上面的 frontmatter 是**人**的配置面：你在配置文件里精确设定角色的模型、工具和四个数值预算。下面是**主代理**每次委派时能填的参数，刻意比 frontmatter 窄——执行策略应当来自配置和台账，而不是模型每次调用时的临场判断。

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `label` | - | 必填。展示给用户的进度标签 |
| `task` | - | 必填。完整任务描述；子代理看不到主对话，目标/范围/路径/约束/验收方法都要写进来 |
| `agent` | - | 使用 `workspace/sub-agents/` 里某个已配置角色 |
| `systemPrompt` | - | 不使用配置角色时，用它定义一个临时子代理；与 `agent` 二选一 |
| `name` | `dynamic-subagent` | inline 子代理的显示名，进入运行记录 |
| `tools` | 角色配置或 `read,bash` | 工具白名单 |
| `model` | 见[模型解析顺序](./configuration.md) | 精确模型引用 |
| `effort` | `standard` | 执行预算档位：`quick`、`standard`、`deep` |
| `context` | `none` | 上下文注入：`none`、`session`、`relevant` |
| `paths` | 角色配置 | 建议优先关注的路径 |
| `thinkingLevel` | `off`（`verify` 为 `medium`） | 推理强度 |
| `purpose` | `work` | `verify` 进入独立验收协议，需同时传 `taskId` |
| `taskId` | - | 绑定任务台账；`purpose: verify` 和 `isolation: worktree` 都要求它 |
| `isolation` | `shared` | `worktree` 使用任务自有的 git worktree |
| `returns` | `text` | `artifact` 要求子代理把主产出写成文件并以 `ARTIFACT: <filename>` 结尾 |

### `effort` 与 frontmatter 数值的关系

`effort` 是四个数值预算的命名组合。调用时传 `effort` 会**整组替换**预算，而不是逐字段合并；不传则沿用角色 frontmatter 里的精确数值（没有配置角色时用内置默认）。

| `effort` | maxTurns | maxToolCalls | maxWallTimeSec | bashTimeoutSec |
|---|---|---|---|---|
| `quick` | 8 | 16 | 120 | 60 |
| `standard` | 24 | 48 | 300 | 120 |
| `deep` | 48 | 96 | 900 | 180 |

`standard` 与内置默认值完全一致，所以不传 `effort` 时行为不变。

### `context` 与 frontmatter 的关系

`context` 是 `contextMode` + `memory` 的调用侧写法：`none` → `isolated`/`none`，`session` → `contextual`/`session`，`relevant` → `contextual`/`relevant`。frontmatter 仍可单独设置这两个字段，包括 `contextual` + `memory: none`（只注入 `paths`）这种调用面无法表达的组合。

## 关键字段怎么理解（How to Use the Key Fields）

### `tools`

建议尽量收窄，而不是一上来给满。常见组合：

- `read,bash`：只读检查、分析、审查。
- `read,edit,write,bash`：需要实际修改文件。

### `contextMode` 与 `memory`

这两个字段一起决定子代理"看得到多少背景"。

| `contextMode` | 含义 |
|----|------|
| `isolated` | 默认值，不自动带入主会话上下文 |
| `contextual` | 自动注入一小部分相关会话 / 记忆上下文 |

| `memory` | 含义 |
|----|------|
| `none` | 不注入额外记忆 |
| `session` | 注入会话工作态摘要 |
| `relevant` | 注入筛选后的相关记忆与上下文 |

推荐搭配：

- 必须继承会话决策或团队背景的审查、研究任务：`contextMode: contextual` + `memory: relevant`。
- 任务描述已经自包含、强调独立判断或无需会话背景的角色：`contextMode: isolated` + `memory: none`。

### `model`

如果要指定，建议使用精确模型引用，例如：

```text
anthropic/claude-sonnet-4-5
my-gateway/gpt-4.1
```

如果引用不唯一或模型不存在，这个子代理定义会被忽略。

### `thinkingLevel`

`thinkingLevel` 控制子代理的推理强度。运行时为了控制普通委派成本，默认将 work 子代理设为 `off`；独立验收默认使用 `medium`。可复用的生产配置建议显式填写，避免角色行为依赖隐藏默认值：

- 机械性定位、明确范围内的信息提取：通常使用 `low`。
- 多来源综合、代码审查、改动分组和独立验收：通常使用 `medium`。
- 只有任务确实需要更深推理且预算允许时才使用 `high` 或 `xhigh`。

## 正文怎么写（System Prompt Body）

frontmatter 后面的正文就是子代理的系统提示词。它应该明确说明：角色职责、工作边界、判断和证据标准、停止条件、输出契约，以及不该做什么。

`description` 不是普通简介，而是主代理选择角色时直接看到的路由规则。建议使用“当……时使用；不要用于……；任务中必须提供……”的结构，并明确该角色是否会修改文件、Git 或外部状态。只把使用时机写在正文里是不够的，因为主代理选择角色前只看到名称和 description。

建议写法：

- 聚焦单一职责。
- 使用与主要用户场景一致的语言；字段名、工具名和 runtime 协议标记保持原样。
- 避免把项目级通用规则重复写进每个子代理。
- 把稳定的用户/团队规则留在 `AGENTS.md`；Pipiclaw 机制不要复制进去，按 runtime playbook 读取（见 [runtime-playbooks.md](./runtime-playbooks.md)）。

## 运行时规则（Runtime Rules）

- 子代理没有 `subagent` 工具，**不能继续创建下一级代理**。
- 工具白名单不等于只读沙箱：拥有 `bash` 的角色仍可能执行写操作，应同时依靠 system prompt 和应用级 `security.json` 收紧行为。
- 默认 `isolation: shared`：只隔离对话上下文，文件系统与主代理共享。
- `isolation: worktree` + `taskId`：从 committed HEAD 创建 task-owned git worktree；runtime 自动把 path/branch 写回 task control，父代理负责 review、merge、cleanup。worktree 只包含 committed HEAD——委派前必须处理好子任务依赖的未提交变更。同一 taskId 的后续委派自动复用台账里记录的 worktree；记录的路径已消失则新建，指向 `tasks/worktrees/` 之外则报错，需先用 `task_manage` 清理。
- `purpose: verify` + `taskId`：进入独立验收协议，去掉 write/edit 工具，检测 verifier 期间的 git workspace 变化，并要求最后一行明确 `VERDICT: PASS|FAIL`。
- verifier attestation 直接持久化到 `<channel>/tasks/.verifications/`，主代理用返回的 runId 调 `task_manage verify` 导入；普通运行摘要仍写 `<channel>/subagent-runs.jsonl`。

> `worktree` 与 `verify` 两种模式都以任务台账为前提（需要 `taskId`）。它们在任务生命周期中的确切时机——何时委派写密集型子任务、验收如何咬合 `candidate` / `done` 门禁——见 [events-and-tasks.md](./events-and-tasks.md#受治理-control)。

## 推荐写法（Recommended Presets）

**Reviewer** —— 审查改动、找回归风险、补测试建议：

- `tools: read,bash`
- `contextMode: contextual` + `memory: relevant`
- `thinkingLevel: medium`
- `paths: src/, test/`
- 它在实现过程中提供 findings，不替代使用 `purpose=verify + taskId` 的最终验收

**Researcher** —— 检索当前或仓库外的信息、核对来源并综合结论：

- `tools: web_search,web_fetch,read`
- 边界清晰的研究任务使用 `contextMode: isolated` + `memory: none`
- `thinkingLevel: medium`

**Explorer** —— 定位仓库实现、追踪调用链、梳理模块关系：

- `tools: read,bash`
- `contextMode: isolated` + `memory: none`
- `thinkingLevel: low`

**Verifier** —— 对受治理任务执行独立终验：

- `tools: read,bash`
- `contextMode: isolated` + `memory: none`
- `thinkingLevel: medium`
- 调用时必须传 `purpose: verify` 和 `taskId`

**Git committer** —— 将用户明确指定的现有改动整理成 commit：

- `tools: read,bash`
- `contextMode: isolated` + `memory: none`
- `thinkingLevel: medium`
- 默认只创建本地 commit；只有用户明确要求时才 push

**Worker** —— 执行边界清晰的局部改动：

- `tools: read,edit,write,bash`
- `contextMode: contextual` + `memory: relevant`
- `paths` 明确写出负责的目录

## 常见错误（Common Mistakes）

- 缺少 `name` 或 `description`。
- 同一个目录里定义了重复的 `name`。
- `tools` 写了不支持的工具名。
- `contextMode` 或 `memory` 写了不支持的值。
- 正文为空，只有 frontmatter。
- `model` 只写了模糊名字，结果无法精确匹配。
- 只在正文描述使用时机，导致主代理无法从目录中的 `description` 正确选择角色。
- 把 `read,bash` 误认为 runtime 强制只读，未约束 bash 的写命令。
- 在没有可追溯用户授权时让 Git 子代理自动 push。

## 该看哪份文档

- 定时事件与任务台账（含 worktree/verifier 在任务生命周期里的时机）：[events-and-tasks.md](./events-and-tasks.md)
- Runtime playbooks 与知识分层：[runtime-playbooks.md](./runtime-playbooks.md)
- `channel.json`、`auth.json`、`models.json`、`settings.json`：[configuration.md](./configuration.md)

# 工作区配置子代理（Sub-Agents）

> **读者**：想把 reviewer / researcher 这类角色沉淀成可复用能力的使用者。
> **前置**：已完成 [README](../README.md) 的安装与配置。
> **读完你能**：写出一个工作区子代理文件，并知道何时该用它、何时不该。

子代理是 Pipiclaw 的**委派**能力：把某类任务从主代理手里交给一个更聚焦、工具更窄的角色去做。它和[事件与任务](./events-and-tasks.md)是正交的两条能力——事件与任务解决"何时唤醒、在途状态如何"，子代理解决"这一步该不该换一个专门的角色来做"。

在写密集型子任务、独立验收（verifier）等场景里，子代理会和任务台账咬合（`isolation: worktree`、`purpose: verify`）；这些接缝会在下面点明，并链接回 [events-and-tasks.md](./events-and-tasks.md)。

## 它是什么（What It Is）

工作区配置子代理是放在 `~/.pipiclaw/workspace/sub-agents/*.md` 中的 Markdown 文件。Pipiclaw 只加载这个目录中实际存在且有效的文件；不会自动注入任何默认角色。主代理在合适的时候可以调用它们，把某类任务交给更聚焦的角色处理。

仓库提供了三个可复制、可修改的建议模板：[`examples/sub-agents/`](../examples/sub-agents/)。例如：

```bash
cp examples/sub-agents/{explorer,researcher,verifier}.md ~/.pipiclaw/workspace/sub-agents/
```

不复制模板也完全可以使用 inline `systemPrompt` 委派。`purpose: verify` 的验收约束由 runtime 执行，不要求一定配置名为 `verifier` 的文件。

适合的场景：

- 代码审查
- 信息收集
- 风险检查
- 某类固定格式的总结

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
description: Review code changes for correctness, regressions, and missing tests
tools: read,bash
contextMode: contextual
memory: relevant
paths:
  - src/
  - test/
maxTurns: 24
maxToolCalls: 48
maxWallTimeSec: 300
bashTimeoutSec: 120
---

You are a focused code reviewer.

Review the code or task given to you.
Prioritize correctness issues, regressions, risky assumptions, and missing tests.
Keep findings concise and actionable.
```

## Frontmatter 字段说明（Frontmatter Reference）

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | - | 子代理名称，必须唯一 |
| `description` | 是 | - | 给主代理看的简短用途描述 |
| `tools` | 否 | `read,bash` | 允许的工具，支持 `read`、`bash`、`edit`、`write` |
| `model` | 否 | 当前主代理模型 | 精确模型引用，建议写成 `provider/modelId` |
| `contextMode` | 否 | `isolated` | `isolated` 或 `contextual` |
| `memory` | 否 | `isolated` 时为 `none`，`contextual` 时为 `relevant` | `none`、`session`、`relevant` |
| `paths` | 否 | 空 | 建议优先关注的文件或目录 |
| `maxTurns` | 否 | `24` | 最大 assistant 轮数 |
| `maxToolCalls` | 否 | `48` | 最大工具调用次数 |
| `maxWallTimeSec` | 否 | `300` | 最大总执行时长，秒 |
| `bashTimeoutSec` | 否 | `120` | 子代理内 bash 命令默认超时，秒 |

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

- 代码审查、研究类（需要理解任务背景）：`contextMode: contextual` + `memory: relevant`。
- 单点执行类（边界清晰、无需背景）：`contextMode: isolated` + `memory: none`。

### `model`

如果要指定，建议使用精确模型引用，例如：

```text
anthropic/claude-sonnet-4-5
my-gateway/gpt-4.1
```

如果引用不唯一或模型不存在，这个子代理定义会被忽略。

## 正文怎么写（System Prompt Body）

frontmatter 后面的正文就是子代理的系统提示词。它应该明确说明：这个角色的职责、优先级和判断标准、输出风格、以及不该做什么。

建议写法：

- 聚焦单一职责。
- 避免把项目级通用规则重复写进每个子代理。
- 把稳定的用户/团队规则留在 `AGENTS.md`；Pipiclaw 机制不要复制进去，按 runtime playbook 读取（见 [runtime-playbooks.md](./runtime-playbooks.md)）。

## 运行时规则（Runtime Rules）

- 子代理没有 `subagent` 工具，**不能继续创建下一级代理**。
- 默认 `isolation: shared`：只隔离对话上下文，文件系统与主代理共享。
- `isolation: worktree` + `taskId`：从 committed HEAD 创建 task-owned git worktree；runtime 自动把 path/branch 写回 task control，父代理负责 review、merge、cleanup。worktree 只包含 committed HEAD——委派前必须处理好子任务依赖的未提交变更。
- `purpose: verify` + `taskId`：进入独立验收协议，去掉 write/edit 工具，检测 verifier 期间的 git workspace 变化，并要求最后一行明确 `VERDICT: PASS|FAIL`。
- verifier attestation 直接持久化到 `<channel>/tasks/.verifications/`，主代理用返回的 runId 调 `task_manage verify` 导入；普通运行摘要仍写 `<channel>/subagent-runs.jsonl`。

> `worktree` 与 `verify` 两种模式都以任务台账为前提（需要 `taskId`）。它们在任务生命周期中的确切时机——何时委派写密集型子任务、验收如何咬合 `candidate` / `done` 门禁——见 [events-and-tasks.md](./events-and-tasks.md#受治理-control)。

## 推荐写法（Recommended Presets）

**Reviewer** —— 审查改动、找回归风险、补测试建议：

- `tools: read,bash`
- `contextMode: contextual` + `memory: relevant`
- `paths: src/, test/`

**Researcher** —— 收集代码现状、列候选方案、做只读分析：

- `tools: read,bash`
- `contextMode: contextual` + `memory: relevant`

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

## 该看哪份文档

- 定时事件与任务台账（含 worktree/verifier 在任务生命周期里的时机）：[events-and-tasks.md](./events-and-tasks.md)
- Runtime playbooks 与知识分层：[runtime-playbooks.md](./runtime-playbooks.md)
- `channel.json`、`auth.json`、`models.json`、`settings.json`：[configuration.md](./configuration.md)

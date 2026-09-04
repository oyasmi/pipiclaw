# Workspace Skills

> **适合谁**：希望把团队中反复出现的操作流程交给 Pipiclaw 复用的使用者和管理员。
> **读完你能**：判断什么时候该写 skill，知道它与规则、记忆、智能体角色和 runtime playbook 的区别，并能创建、检查和调用一个 skill。

## Skill 是什么

Workspace skill 是保存在 `~/.pipiclaw/workspace/skills/` 下的一套可复用流程说明。它适合描述“遇到某类任务时，按什么步骤、使用哪些工具、遵守哪些组织约束完成”。

Skill 不会默认把全文塞进每一轮上下文。系统只常驻它的名称和触发描述，在用户明确调用或当前任务匹配时才读取正文，因此可以沉淀详细流程而不持续占用上下文。

Pipiclaw 只支持工作区级 skills，不存在频道级 skill 目录。同一实例中的所有频道都能发现它们。

## 什么时候使用 Skill

适合写成 skill：

- 发布版本、生成周报、处理值班告警等可重复流程
- 组织专有的检查清单、数据口径和交付格式
- 某个第三方 CLI 或内部平台的稳定使用方法
- 需要按需加载、但不应该每轮常驻的详细 SOP

不适合写成 skill：

- 单次任务的当前进度：写进任务台账或 journal
- 永远适用的团队规则：写进 `AGENTS.md`
- 稳定事实和偏好：写进 `MEMORY.md`
- reviewer、builder 这类需要独立上下文或独立执行器的角色：写进 `sub-agents/`
- Pipiclaw 本身的 task、event、memory、delegation 机制：由随包发布的 runtime playbook 维护

## 与其他知识载体的区别

| 载体 | 回答的问题 | 典型内容 |
|---|---|---|
| `AGENTS.md` | 我们做任何工作都要遵守什么？ | 安全边界、沟通习惯、团队通用规则 |
| `MEMORY.md` | 哪些事实和决定以后仍然有用？ | 偏好、术语、长期决定 |
| `skills/` | 遇到某类工作具体怎么做？ | 发布、巡检、报告、第三方工具 SOP |
| `sub-agents/` | 这一步该由谁在独立上下文里完成？ | planner、builder、reviewer、scout |
| runtime playbooks | 当前版本的 Pipiclaw 机制怎样工作？ | task、event、memory、delegation 的内置协议 |
| task 文件 | 这一项工作现在做到哪里？ | Goal、DoD、Plan、证据、下一步、wake |

## 创建和维护

主智能体拥有 `skill` 工具，但它只读（`list` / `read`）——创建和修改直接用通用的 `write` / `edit` 工具在 `workspace/skills/<name>/SKILL.md` 上操作，和改任何其他工作区文件一样，走同一套 path guard。最简单的方式是直接提出目标：

```text
把我们刚才确认的发布流程整理成一个 workspace skill。触发场景是“准备发布 npm 版本”，必须包含版本一致性、测试、tag 和回滚检查。
```

`SKILL.md` 的 frontmatter 必须包含非空的 `name`（需与目录名一致，`[a-z0-9]+(-[a-z0-9]+)*`）和 `description`。创建后可以用 `skill list` 列出或检查已有 skills，也可以直接查看 `workspace/skills/`。钉钉或 TUI 里用 `/skills`（或 `/skills show <name>`）查看同样的目录，无需开启一个模型回合；它按磁盘现状扫描，能看到被内容扫描拒绝、因此没有进入 `<available_skills>` 目录的 skill 及原因。Skill 目录属于用户工作区，升级 Pipiclaw 不会覆盖。

Skill 正文在进入系统提示前会经过一次内容安全扫描（prompt-injection 措辞、外泄/破坏性命令等启发式规则）；没通过的 skill 不会出现在 `<available_skills>` 目录或 `skill list` 里，原因体现在 `skill list` 的 warning 字段中。这是一层防御层，不是权限边界——真实权限仍由工具 schema、`security.json` 和运行账号决定。

维护时遵循三条原则：

1. **触发描述要能路由。** 说明什么时候使用、什么时候不用，以及需要哪些前置信息。
2. **正文只放稳定流程。** 当前任务的路径、版本号、临时状态由调用时提供，不写死在 skill。
3. **操作边界要具体。** 明确允许的写入、外部影响、验证方法、停止条件和交付物。

Skill 的错误或截断结果会提供下一步，例如缩小读取范围或使用 `read` 继续。发现重复 skill 时优先合并职责，避免两个相似触发器让路由变得随机。

## 调用方式

有三种常见入口：

- 用户直接发送 `/skill:<名称>`，或先用 `/skills` 看一眼目录再决定用哪个。
- 用户用自然语言提出与触发描述匹配的任务，主智能体按需读取。
- 主智能体在完成一次流程后，经用户意图或明确判断用 `write`/`edit` 沉淀或更新。

调用 skill 不会创建新的智能体。需要上下文隔离、不同模型、并行工作或外部 Claude/Codex CLI 时，应由 skill 中的流程指导主智能体使用 `subagent`，或者直接配置工作区角色。

## 安全与升级

- Skill 正文是给模型的流程知识，不是安全沙箱。真实权限仍由工具 schema、`security.json`、外部 CLI sandbox 和运行账号决定。
- 不把密钥值写进 skill；只记录凭据从哪个环境变量或安全系统获取。
- 不复制 `src/playbooks/` 的内容。Pipiclaw 升级会更新内置 playbook，workspace 副本不会同步。
- 建议把 `workspace/skills/` 纳入备份或版本管理，尤其是多人共同维护的实例。

## 相关文档

- 工具能力与 `skill`：[tools.md](./tools.md)
- 规则、记忆和工作区文件：[configuration-reference.md](./configuration-reference.md)
- 智能体角色与委派：[sub-agents.md](./sub-agents.md)
- Runtime playbook 的知识边界：[runtime-playbooks.md](./runtime-playbooks.md)

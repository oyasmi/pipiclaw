# Runtime Playbooks 与知识分层

Pipiclaw 把“产品机制知识”和“用户自己的工作方式”分开管理。目标是让 agent 深入理解 runtime，同时不让系统提示无限增长，也不在 workspace 留下会随升级漂移的文档副本。

## 四层模型

| 层 | 内容 | 更新者 | 加载方式 |
|---|---|---|---|
| System prompt | 每回合不能忘的安全边界、资源所有权、最小恢复纪律 | Pipiclaw | 每回合常驻 |
| Runtime playbooks | 当前版本的 memory/event/task/subagent 机制、跨工具流程、故障恢复 | Pipiclaw 包 | metadata 常驻，正文按需 read |
| Workspace `AGENTS.md` / `skills/` | 用户偏好、团队策略、环境专属 SOP、第三方工具用法 | 用户与 agent | 指令注入或按 skill 触发 |
| Task 文件 | 单项工作的目标、DoD、Manual、证据、当前周期和 control | 主 agent | task 被驱动时读取 |

边界原则：

- “这个版本的 Pipiclaw 怎样工作”属于 runtime playbook。
- “这个团队希望怎样工作”属于 workspace AGENTS/skill。
- “这项工作当前做到哪里”属于 task。
- “任何场景都不能忘”且无法由代码门禁保证的少量规则才留在 system prompt。

不要把 runtime playbook 复制进 workspace。升级会更新内置机制，副本不会同步。Pipiclaw 也不会覆盖用户的 AGENTS 或 skills。

## 渐进式加载

每份 `src/playbooks/*.md` 都有很小的 YAML metadata：

```yaml
---
name: task-driving
description: Read whenever TASK_DRIVER or a task-owned event resumes work...
---
```

runtime 从 metadata 自动生成系统提示中的目录。description 同时说明内容和触发场景；完整正文留在包内，只有匹配当前任务时才通过 read 加载。这与 workspace skill 的“metadata 触发、正文按需加载”原则一致。

构建后文件位于 `dist/playbooks/`。path guard 只允许读取该目录，不允许 agent 写入；npm 升级会整体更新。源码 checkout 优先读取 `src/playbooks/`，便于开发时立即验证文档。

## 当前目录

| Playbook | 读取场景 |
|---|---|
| `runtime-orientation.md` | 判断知识归属、理解 workspace/channel 文件和读取顺序 |
| `memory-and-learning.md` | remember/forget、选择记忆层、维护 ENVIRONMENT、沉淀 workspace skill |
| `event-scheduling.md` | reminder、one-shot、periodic、preAction、后台 job 回访 |
| `task-planning.md` | 是否建 task、写 Goal/DoD/Manual/Verification、选择 control/预算 |
| `task-driving.md` | driver 恢复、幂等检查、progress/status/wake checkpoint |
| `task-recurring.md` | task + `.schedule`、start-cycle、调节奏、退役 |
| `task-delegation.md` | 父子任务、subagent、worktree、外部 agent 工具的恢复纪律 |
| `task-closeout.md` | candidate、verifier、external approval、done/cancel 和组合门禁 |
| `task-repair.md` | escalated、停滞、坏 frontmatter、stale gate、孤儿事件、重启恢复 |

## Playbook 编写原则

1. **description 是触发器**：包含“讲什么”和“什么时候读”，名称使用短小 kebab-case。
2. **默认模型已有通用能力**：只写 Pipiclaw 特有、容易出错或跨工具的知识。
3. **按脆弱程度决定自由度**：hash/approval/candidate 等窄桥给精确顺序；开放的规划问题给判断条件。
4. **不重复**：硬不变量留 prompt，工具参数留 schema，详细流程只在一个 playbook 中定义；其他文件用明确链接路由。
5. **错误可恢复**：解释门禁为什么拒绝，并给可以执行的下一步。
6. **与代码共同验证**：metadata/catalog、prompt 不加载正文、path guard、干净包内容和关键组合状态机都有测试。

## 第三方工具边界

Pipiclaw 可以通过 bash、subagent、event preAction 与用户安装的工具协作，但不会捆绑某个第三方工具的命令、状态协议或检测脚本。

例如 agentmux 的启动、inspect/capture 语义和完成态检测属于用户安装的 agentmux skill/可执行文件。runtime playbook 只说明通用纪律：记录委派标识和产物、blocked + wake 恢复、按用户 skill 取回、review、验证、清理。这样第三方工具可以独立升级，也不会污染 Pipiclaw 的产品知识层。

## 面向 workspace 的迁移

已有 `AGENTS.md` 如果包含 Pipiclaw 文件语义、task/event SOP、driver cooldown、审批命令或 verifier 细节，应删除这些镜像内容，改为引用对应 playbook。保留的应是：

- 称呼、沟通风格和默认工作环；
- 团队安全政策和外部影响边界；
- 何时偏好某个用户 skill/第三方工具；
- 组织特有的知识库、质量标准和晋升规则。

迁移不会改变 task/event/memory 的落盘格式，只改变 agent 获取 runtime 知识的方式。

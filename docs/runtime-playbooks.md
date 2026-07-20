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
description: 被 TASK_DRIVER 唤醒推进任务、留检查点，或任务停滞、被治理器暂停、元数据损坏时。
requires-tools: task_manage
priority: 41
---
```

runtime 从 metadata 自动生成系统提示中的目录。四个字段各有分工：

| 字段 | 作用 |
|---|---|
| `name` | 必须等于文件名（去掉 `.md`），加载时校验 |
| `description` | **唯一进入系统提示的正文之外的内容**，上限 100 字符，超出会被截断 |
| `requires-tools` | any-of 门控：列出的工具**一个都没注册**时，该 playbook 不出现在目录里 |
| `priority` | 目录排序，升序；同值按文件名 |

description 同时说明内容和触发场景；完整正文留在包内，只有匹配当前任务时才通过 read 加载。这与 workspace skill 的"metadata 触发、正文按需加载"原则一致。

**description 用中文书写，并在关键概念上附英文术语**（如「任务（task）」「子代理（subagent）」「审批（approval）」）。用户的请求是中文的，触发匹配发生在中文语境里；英文术语则保证 `TASK_DRIVER`、`preAction`、`schedule` 这类在提示词和报错里以英文出现的记号也能命中。

构建后文件位于 `dist/playbooks/`。path guard 只允许读取该目录，不允许 agent 写入；npm 升级会整体更新。源码 checkout 优先读取 `src/playbooks/`，便于开发时立即验证文档。

## 当前目录

按 `priority` 排序，即目录在系统提示中呈现的顺序。此表由 `test/playbooks.test.ts` 与 `src/playbooks/` 的实际 frontmatter 对账，新增或删除 playbook 时测试会失败，提醒同步这里。

| Playbook | 门控工具 | 读取场景 |
|---|---|---|
| `runtime-orientation.md` | 恒在 | 判断知识归属、理解 workspace/channel 文件和读取顺序 |
| `memory-and-learning.md` | `memory_manage` / `skill_manage` | 记住与忘记、选择记忆层、维护 ENVIRONMENT、沉淀 workspace skill |
| `outbound-media.md` | `send_media` | 把报表、截图、导出文件作为附件交付给用户 |
| `event-scheduling.md` | `event_manage` | 提醒、one-shot、periodic、preAction 传感器、跨回合回访 |
| `background-jobs.md` | `job` | `bash async` 启停、poll 纪律、并发上限、跨回合等待 |
| `task-planning.md` | `task_manage` | 是否建 task、Goal/DoD/Manual/Verification、control 与预算、周期 `schedule` |
| `task-driving.md` | `task_manage` | driver 恢复、幂等检查、checkpoint，以及停滞/治理器暂停/坏 frontmatter 的修复 |
| `task-closeout.md` | `task_manage` | candidate、verifier、外部审批、done/cancel 和组合门禁 |
| `task-delegation.md` | `task_manage` / `subagent` | 父子任务、subagent、worktree、外部 agent 工具的恢复纪律 |

任务生命周期占四份，对应四个**决策时刻**——建档、推进（含修复）、收尾、委派。它们刻意不做成"先读一本再跳转"的路由结构：模型在一次唤醒中只应打开一份文件，多一跳就多一次判断失误的机会。同一时刻需要的知识必须在同一份文件里。

## Playbook 编写原则

1. **description 是触发器**：包含"讲什么"和"什么时候读"，中文书写并附英文术语，名称使用短小 kebab-case。
2. **一个决策时刻一份文件**：宁可一份稍长，也不要让模型为了完成一件事读两份。反过来，两个不会同时发生的场景不要塞进一份。
3. **默认模型已有通用能力**：只写 Pipiclaw 特有、容易出错或跨工具的知识。
4. **按脆弱程度决定自由度**：hash/approval/candidate 等窄桥给精确顺序；开放的规划问题给判断条件。
5. **不重复**：硬不变量留 prompt，工具参数留 schema，详细流程只在一个 playbook 中定义；其他文件用明确链接路由。契约 hash 绑定语义只在 `task-closeout.md` 定义即是一例。
6. **错误可恢复**：解释门禁为什么拒绝，并给可以执行的下一步。
7. **控制长度**：正文以 80 行为软上限，多数应在 50 行以内。超出通常意味着混进了两个决策时刻，或抄了工具 schema 已有的内容——先检查这两条，再考虑是否真的需要更长。`task-planning.md` 与 `task-driving.md` 是刻意最长的两份：它们各自合并了原先拆开的建档/周期、推进/修复，因为那两组内容总是在同一时刻被需要。
8. **与代码共同验证**：metadata/catalog、prompt 不加载正文、path guard、本文目录表与实际文件的对账都有测试；构建产物（`dist/playbooks/` 只含 `.md`）按 build 脚本保证，发版前人工核对。

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

# Pipiclaw 文档

这里是 Pipiclaw 的完整用户与开发文档。第一次使用请先从[项目 README](../README.md)完成终端体验或钉钉接入；之后按你现在要解决的问题选择入口，不需要从头通读。

## 我想先把它用起来

| 目标 | 从这里开始 |
|---|---|
| 在终端或钉钉中完成第一次对话 | [项目 README：快速开始](../README.md#快速开始) |
| 理解私聊、群聊、AI Card、忙时消息和斜杠命令 | [交互与命令](./interaction-and-commands.md) |
| 配置钉钉、模型、Web 工具或代理 | [配置速查](./configuration.md) |
| 查某个配置字段的准确取值和默认值 | [配置字段参考](./configuration-reference.md) |

## 我想让它完成实际工作

| 目标 | 从这里开始 |
|---|---|
| 把工作委派给内置子智能体、Claude Code 或 Codex CLI | [智能体委派](./sub-agents.md) |
| 了解它能读写什么、能调用哪些能力 | [工具总览](./tools.md) |
| 让它记住约定、找回历史或忘掉旧信息 | [记忆](./memory.md) |
| 建立提醒、周期检查或跨会话长期任务 | [事件与任务](./events-and-tasks.md) |
| 把团队流程沉淀成可复用 skill | [Workspace Skills](./skills.md) |
| 想让它持续产出、而不是每次等你动一下 | [使用杠杆](./leverage/README.md) |

## 我要长期运行和治理它

| 目标 | 从这里开始 |
|---|---|
| 决定文件、命令、网络和外部智能体能碰什么 | [安全指南](./security.md) |
| 部署常驻进程、看日志、升级、备份或排障 | [部署与运维](./deployment-and-operations.md) |
| 理解 fallback、记忆维护、后台作业、委派和任务 driver | [运行机制](./runtime-mechanisms.md) |
| 评估并发、资源占用和拆分实例的时机 | [并发与容量](./scaling-and-concurrency.md) |

## 我要理解或修改源码

| 文档 | 内容 |
|---|---|
| [架构](./architecture.md) | 当前实现的源码地图、运行时拓扑、消息生命周期、并发表和磁盘布局 |
| [设计哲学](./design-philosophy.md) | 长期运行、状态、边界、记忆与可验证性的设计原则 |
| [Runtime Playbooks](./runtime-playbooks.md) | 产品机制知识如何按需提供给 agent，以及如何避免与 workspace 规则重复 |
| [历史设计记录](./specs/README.md) | specs 的阅读方法、主题分组和当前行为的判断顺序 |
| [../AGENTS.md](../AGENTS.md) | 代码域边界、工程规则和验证要求 |

## 文档的责任边界

- `README.md` 负责产品定位、适用场景和成功主路径。
- `configuration.md` 负责“该改哪个文件、常见场景怎么配”。
- `configuration-reference.md` 负责字段、默认值和解析优先级。
- `runtime-mechanisms.md` 负责解释配置背后的运行行为。
- `architecture.md` 负责解释代码位置和组件关系。
- `sub-agents.md` 是智能体委派的用户级权威文档。
- `leverage/` 负责“会用之后怎么用出更大产出”的观点与实践，不定义行为契约。
- `security.md` 是权限、隔离与授权边界的用户级权威文档。

`docs/` 面向人，允许跳读、示例和完整参考；`src/playbooks/` 面向 agent，只有小型目录常驻系统提示，正文按需读取。不要把 runtime playbook 复制进 workspace 的 `AGENTS.md` 或 skill：升级会更新内置机制，副本不会同步。

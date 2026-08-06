# Pipiclaw 文档

Pipiclaw 是一个钉钉优先、可长期运行的 AI coding assistant runtime，个人和团队都可以使用。

从 [项目 README](../README.md) 完成安装与首次启动；这里是之后的全部文档。按你的角色选起点：

## 我是使用者：想用好它

| 文档 | 回答什么 |
|---|---|
| [design-philosophy.md](./design-philosophy.md) | Pipiclaw 为什么这样设计？后续能力应遵守哪些原则？ |
| [tools.md](./tools.md) | 它能干什么？某个能力为什么没出现？ |
| [memory.md](./memory.md) | 它记得什么？怎么让它记住或忘掉？ |
| [events-and-tasks.md](./events-and-tasks.md) | 怎么让它定时做事、怎么让它带着进度本干长活？ |
| [sub-agents.md](./sub-agents.md) | 怎么把工作委派出去、怎么做独立验收？ |

## 我是管理员：要配置和长期运行它

| 文档 | 回答什么 |
|---|---|
| [configuration.md](./configuration.md) | 配置速查：现在该改哪个文件 |
| [configuration-reference.md](./configuration-reference.md) | 字段参考：钉钉、模型、settings、tools、TUI、工作区文件 |
| [runtime-mechanisms.md](./runtime-mechanisms.md) | 机制说明：fallback、记忆维护、事件、后台作业、任务 driver |
| [security.md](./security.md) | 默认拦截什么、怎么放行、边界在哪 |
| [deployment-and-operations.md](./deployment-and-operations.md) | 常驻运行、日志、升级、备份、排障 |
| [scaling-and-concurrency.md](./scaling-and-concurrency.md) | 并发模型、容量边界、什么时候该拆实例 |

## 我要改它的代码

| 文档 | 回答什么 |
|---|---|
| [architecture.md](./architecture.md) | 代码现在是什么样：运行时拓扑、消息生命周期、并发表、磁盘布局 |
| [design-and-implementation-review-2026-08-06.md](./design-and-implementation-review-2026-08-06.md) | 当前设计与实现的风险、证据和优化路线 |
| [runtime-playbooks.md](./runtime-playbooks.md) | 知识分层模型，以及怎么写给 agent 读的 playbook |
| [specs/](./specs/) | 历史设计记录与取舍（`NNN-*`，按实现顺序编号）；当前行为以 README、`docs/` 顶层手册和代码为准 |
| [../AGENTS.md](../AGENTS.md) | 域边界与工程规则 |

## 两套文档，两个受众

`docs/` 面向**人**：可跳读、可穷举、有示例。

`src/playbooks/` 面向 **agent 自己**：随包发布的只读手册，模型每回合只看到一行触发描述，需要时才加载正文。它们不是本目录的副本，两者的取舍原则见 [runtime-playbooks.md](./runtime-playbooks.md)。

> 不要把 playbook 内容抄进 workspace 的 `AGENTS.md` 或 skill——升级会更新内置机制，副本不会跟着变。

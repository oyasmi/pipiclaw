# Pipiclaw 用户文档中心

欢迎来到 Pipiclaw 文档中心！你不需要从头到尾通读——请直接按你**手头想解决的问题**跳到对应指南。

> 💡 **第一次接触 Pipiclaw？**
> 1. 直接打开 **[快速上手指南（Quick Start）](./quickstart.md)**：无需先配钉钉，1 分钟跑通终端对话与本机 API（附国内网关配置、钉钉开放平台逐项截图级避坑清单与高频排障）。
> 2. 跑通后看一眼 **[交互与命令](./interaction-and-commands.md)**，学会如何在助手忙碌时中途纠偏（`/steer`）、查看状态（`/status`）和切换工位（`/desk`）。
> 3. 再按需打开下方的模型配置、联网搜索、外部 Coding Agent 委派或后台任务。

---

## 🚀 起步与日常配置

解决“怎么连上模型、怎么改配置、怎么在钉钉/终端/脚本里顺手交互”：

| 你想做什么 | 推荐阅读 | 你能得到什么 |
|---|---|---|
| 从零安装、配模型、跑通终端/API 并按需接入钉钉 | [快速上手指南（Quick Start）](./quickstart.md) | 渐进式保姆级上手路径、国内模型直接复制模板、`curl` 自检命令与钉钉后台避坑清单 |
| 搞清楚私聊、群聊、AI Card 模式与斜杠命令 | [交互与命令](./interaction-and-commands.md) | 忙时如何插话/排队/叫停、AI Card 三种展示模式、工位（Desk）切换方法 |
| 配置自定义模型、中转网关、网络代理或联网工具 | [配置速查](./configuration.md) | 一张表看懂 `~/.pipiclaw/` 下 6 个配置文件该改哪一个，附常用配置模板 |
| 查询某个配置项的准确字段名、默认值与优先级 | [配置字段参考](./configuration-reference.md) | 全量配置项字典，适合精细调优时按名索骥 |
| 用官方 OpenAI SDK 从 Python / JS 脚本连接助手 | [Web API 手册](./webapi.md) | 开启本地 Socket 或 TCP 接口、管理访问密钥、可直接运行的 SDK 代码示例 |

---

## 🛠️ 让助手真正帮你干活

把 Pipiclaw 从“一问一答的聊天框”升级为“能记忆、会调兵遣将、能在后台持续交付的工作台”：

| 你想做什么 | 推荐阅读 | 你能得到什么 |
|---|---|---|
| 调度本机的 Claude Code、Codex、Cursor 或 Antigravity | [智能体委派指南](./sub-agents.md) · [角色示例库](../examples/sub-agents/README.md) | 如何启用外部 Coding Agent、后台异步完成唤醒、继续追问、只读独立审查与自己编写角色 |
| 交办跨小时的后台复杂任务，或设置定时提醒/巡检 | [事件与任务](./events-and-tasks.md) | 后台长程任务的查看/传话/暂停/追加预算，以及单次提醒、Cron 周期巡检与零 Token 脚本过滤 |
| 让助手记住项目规矩、翻看工作日记或忘掉旧信息 | [记忆管理](./memory.md) | 长期记忆、按天工作日记、30 天观察期的工作方式，以及如何用 `/memory forget` 彻底删除记忆 |
| 把个人或团队的常用套路沉淀成可复用技能 | [Skills 指南](./skills.md) | 在工作区或 `~/.agents/skills/` 编写与共享技能，免重复输入长提示词 |
| 了解助手自带哪些读写、命令与检索能力 | [内置工具总览](./tools.md) | 文件读写编辑、命令执行、后台作业、历史会话检索与网页抓取的能力边界 |
| **进阶必读**：会用功能之后，如何成倍放大个人产出 | [使用杠杆（Leverage）](./leverage/README.md) | 5 篇实战思考：如何把触发、上下文与验收逐步交出去，把助手从“手拧扳手”用成“自动车床” |

> [!TIP]
> Pipiclaw 内置了随版本自动更新的机制说明（如任务、委派与定时事件的内部用法），按需供模型自动查阅。你在编写自己的 `~/.pipiclaw/workspace/AGENTS.md` 时，**只需写你自己的项目规范与偏好**，无需把本手册里的产品机制复制进去。

---

## 🛡️ 24 小时常驻、安全与运维

准备把 Pipiclaw 长期跑在开发机、Mac mini 或服务器上时阅读：

| 你想做什么 | 推荐阅读 | 你能得到什么 |
|---|---|---|
| 用 `systemd` / `pm2` 托管后台常驻、备份或排查故障 | [部署与运维指南](./deployment-and-operations.md) | 标准服务文件模板、环境变量隔离、升级步骤、日志位置与常见故障自查表 |
| 控制文件、命令、网络访问权限与外部 CLI 边界 | [安全指南](./security.md) | 默认安全守卫拦什么、如何放开或收紧策略、外部 Coding Agent 的真实权限边界 |
| 多人/多群共用或同时跑多个项目时评估边界 | [并发与容量](./scaling-and-concurrency.md) | 多频道并行与单频道串行规则、共享代码目录冲突防范、何时该分「工位」或拆实例 |
| 深入了解断线重连、模型回退、后台压缩等底层表现 | [运行机制详解](./runtime-mechanisms.md) | 备用模型自动切换、空闲零消耗记忆整理、后台任务恢复等机制的准确行为说明 |

---

## 📦 历史版本升级与数据迁移

> **新安装用户请直接跳过本节。** 仅当你从早期旧版本升级或使用了旧版内置模型路由时，按需参考 **[升级与数据迁移索引](./migrations/README.md)**：

- [SDK 与模型供应商升级说明](./migrations/sdk-upgrades.md) · [渠道层迁移说明](./migrations/channel-migration.md) · [工位迁移说明](./migrations/desk-migration.md) · [任务迁移说明](./migrations/task-migration.md)

---

<details>
<summary><b>🔧 源码架构与项目开发参考（面向贡献者与二次开发者）</b></summary>

如果你想阅读源码、理解设计取舍、运行评测或提交 Pull Request，可参考以下开发文档：

| 文档 | 内容说明 |
|---|---|
| [设计哲学](./design-philosophy.md) | 为什么这样设计状态持久化、运行时边界、分层记忆与可验证交付 |
| [架构文档](./architecture.md) | 源码目录地图、模块分层依赖、运行时拓扑与磁盘存储布局 |
| [开发与工程规范 (AGENTS.md)](../AGENTS.md) | 模块边界守卫、代码规范、测试分层与提交流程要求 |
| [Runtime Playbooks](./runtime-playbooks.md) | 内置运行手册如何按需加载给模型，以及体积预算管理 |
| [行为评测指南](./evals.md) | 真实模型行为评测（`eval`）、离线门控与诊断重放 |
| [设计记录 (Specs)](./specs/README.md) · [历史归档](./archive/README.md) | 历次核心特性的设计方案（Spec 050–068）与早期归档记录 |
| 探索性调研笔记（未实施预研） | [主动工作与实时语音调研](./refer/personal-agent-proactivity-and-voice.md) · [主动性机制与设计取舍](./refer/personal-agent-proactivity-design-notes.md) |

</details>

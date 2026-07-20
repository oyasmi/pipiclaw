# 工具总览（Tool Reference）

> **读者**：想知道"这个助手到底能干什么"、以及某个能力为什么没出现的使用者和管理员。
> **前置**：已完成 [README](../README.md) 的安装与配置。
> **读完你能**：说出每个工具的用途、开关位置，以及它对子代理是否可见。

工具是 agent 在一个回合里能采取的**动作**。Pipiclaw 的工具集在 `src/tools/registry.ts` 里单点注册，每个 channel 启动时按当前配置构建一份——所以同一个实例上，开关不同的部署看到的工具集也不同。

关于每个工具的参数细节，不需要查文档：agent 拿到的是带完整 schema 的工具定义。这份文档回答的是**有哪些能力、谁能用、怎么开关**。

## 全表（At a Glance）

| 工具 | 做什么 | 默认 | 开关 | 子代理可用 |
|---|---|---|---|---|
| `read` | 读文件 | 恒开 | — | 是 |
| `write` | 创建或覆盖文件 | 恒开 | — | 是 |
| `edit` | 精准局部改写 | 恒开 | — | 是 |
| `grep` | 正则搜索文件内容，分组分页、有 token 上限 | 恒开 | — | 是 |
| `bash` | 执行 shell 命令与外部程序 | 恒开 | — | 是 |
| `web_search` | 搜索公网，返回标题/URL/摘要 | **关** | `tools.web.enable` | 是 |
| `web_fetch` | 抓取 URL 并提取正文 | **关** | `tools.web.enable` | 是 |
| `send_media` | 把本地文件作为附件发进当前会话 | 随渠道 | 传输层是否支持（钉钉/TUI 都支持） | 否 |
| `job` | 查看/等待/取消 `bash async` 后台作业 | 恒开 | — | 否 |
| `session_search` | 检索本频道的冷存储历史对话 | 恒开 | — | 否 |
| `memory_manage` | 保存、检索、遗忘长期记忆 | 恒开 | — | 否 |
| `skill_manage` | 管理 `workspace/skills/` 下的可复用流程 | 恒开 | — | 否 |
| `event_manage` | 创建/更新/删除定时事件与 preAction 传感器 | 恒开 | — | 否 |
| `task_manage` | 创建、推进、验收、关闭长程任务 | 开 | `tools.tasks.enabled` | 否 |
| `subagent` | 委派聚焦工作或独立验收 | 开 | — | 否（不可嵌套） |

**"子代理可用"那一列不是权限疏漏，而是设计**：子代理是一次性的、无台账的执行体。台账、记忆、调度和对用户的出站投递都归主 agent 所有，这样"谁为交付负责"始终只有一个答案。详见 [sub-agents.md](./sub-agents.md)。

## 文件与命令类

`read` / `write` / `edit` / `grep` / `bash` 是基础能力，**全部经过 [security.md](./security.md) 描述的守卫**：路径经 path guard，命令经 command guard，被拦截的动作写入审计日志。放宽或收紧范围都在 `security.json`，不在 `tools.json`。

`grep` 优于 `bash` 里的 `grep`：结果分组、分页、有 token 上限，不会因为一次宽泛匹配把上下文冲爆。

`bash` 有两个可选增强，都在 `tools.json`：

- `tools.bashInterceptor.enabled`（默认开）——拦截常见的低效或危险命令写法并给出更好的替代。
- `tools.rtk.enabled`（默认关）——启用 rtk 命令优化。

耗时命令应走 `bash async: true` 交给后台作业，见下。

## 后台作业（`job`）

`bash` 传 `async: true` 立即返回 job id，命令在后台继续跑；`job` 负责之后的 `list` / `poll` / `cancel`。

关键约束：每个 channel 最多 **5 个**同时运行的作业；`poll` 单次最多等约 **30 秒**；**已结束的作业只在被 list/poll/cancel 时才回收名额**。所以从不回查的作业会一直占着槽位。作业不跨进程存活——daemon 重启后未取回的输出就没有了，重要产物应由命令自己写进文件。

## 网页工具（`web_search` / `web_fetch`）

默认关闭，需要在 `tools.json` 里设 `tools.web.enable: true` 并配置搜索提供方（brave / tavily / jina / searxng / duckduckgo）。抓取有字符数、响应体积、超时等上限，长页面通过 offset 分页续读。完整字段见 [configuration.md](./configuration.md#内建工具配置文件-toolsjsontoolsjson)。

出站网络同样受 `security.json` 的网络守卫约束。

## 附件交付（`send_media`）

把 workspace 内的本地文件作为**原生附件**发进当前会话：`.jpg .jpeg .png .gif .webp .bmp` 内联为图片，其余作为可下载文件。典型用途是把生成好的报表、截图、图表、导出文件真正交到用户手里，而不是只贴一个主机路径。

两个安全性质值得知道：

- **目标会话由运行时绑定**，不是模型参数。agent 无法把文件发到当前会话以外的地方。
- 路径经与 `read` **相同**的 path guard，越界文件在读取前就被拒绝并记入审计日志。

只要传输层支持出站附件就自动启用——钉钉与终端 TUI 都支持，没有独立开关。

## 记忆与知识类

| 工具 | 写到哪 | 什么时候用 |
|---|---|---|
| `memory_manage` | 频道 `MEMORY.md` | 用户说"记住/以后默认/别再这样/忘掉"时立即写 |
| `skill_manage` | `workspace/skills/` | 某个流程跨任务可复用时沉淀 |
| `session_search` | 只读 `log.jsonl` / `context.jsonl` | 用户引用较早的对话、而工作记忆里没有时 |

分层原理和"什么该记、什么不该记"见 [memory.md](./memory.md)。

## 调度与长程类

`event_manage` 管定时事件（提醒、cron 节奏、preAction 传感器），`task_manage` 管长程任务台账（目标、DoD、手册、验收、周期）。两者的心智模型、文件格式和 `/events`、`/tasks` 控制面见 [events-and-tasks.md](./events-and-tasks.md)。

`tools.tasks.enabled: false` 是整套自主长程能力的总开关：它同时关掉 `task_manage` 工具、内建 task driver 和每回合的任务摘要注入。

## 委派（`subagent`）

把聚焦的实现工作或**独立验收**交给一个全新的子代理，可选在任务专属的 git worktree 中隔离执行。子代理看不到主对话，因此委派描述必须自带目标、范围、路径、约束和验收方法。见 [sub-agents.md](./sub-agents.md)。

## 相关文档

- 各开关的完整字段与示例：[configuration.md](./configuration.md)
- 守卫默认策略与放行方式：[security.md](./security.md)
- 记忆分层：[memory.md](./memory.md)
- 事件与任务：[events-and-tasks.md](./events-and-tasks.md)
- agent 侧的使用纪律（随包发布，非用户可编辑）：[runtime-playbooks.md](./runtime-playbooks.md)

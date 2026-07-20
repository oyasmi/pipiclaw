# 记忆（Memory）

> **读者**：想知道"它到底记住了什么、能不能让它忘掉、为什么忘了我说过的话"的使用者与管理员。
> **前置**：已完成 [README](../README.md) 的安装与配置。
> **读完你能**：说出五个记忆层各存什么、如何让某件事被记住或被遗忘、以及记忆出问题时先看哪个文件。
> 想看实现（调度器、sidecar、召回打分）请转 [architecture.md §6](./architecture.md#6-记忆子系统srcmemory)；想调参数请转 [configuration.md](./configuration.md)。

Pipiclaw 的记忆不是"一个大文件"，而是**按用途分层**的几份文件。理解分层就理解了它的全部行为：新鲜的东西在上层、便宜且随手可得；越往下越持久、越需要显式检索。

## 五个层次

| 层 | 文件 | 存什么 | 谁维护 | 是否自动进入对话 |
|---|---|---|---|---|
| 当前状态 | 频道 `SESSION.md` | 眼下在做什么、活动文件、下一步 | 运行时自动刷新 | 否，按需读取 |
| 长期记忆 | 频道 `MEMORY.md` | 稳定事实、偏好、约束、已定的决策 | 运行时 + `memory_manage` | **是**，相关条目每轮召回 |
| 较旧历史 | 频道 `HISTORY.md` | 折叠后的旧摘要 | 运行时自动折叠 | 否，按需读取 |
| 冷存储 | `log.jsonl` / `context.jsonl` | 完整原始对话 | 运行时追加 | 否，`session_search` 检索 |
| 共享背景 | `workspace/MEMORY.md`、`ENVIRONMENT.md` | 跨频道的团队背景、机器环境事实 | **管理员手工维护** | 首轮注入 |

前四层**按频道隔离**：你的私聊和某个群是两套互不可见的记忆。这是刻意的——私聊里说的话不应泄漏到群里。频道的定义见 [scaling-and-concurrency.md](./scaling-and-concurrency.md#会话隔离模型session-isolation-model)。

文件都在 `${PIPICLAW_HOME:-~/.pipiclaw}/workspace/` 下：共享层在根目录，频道层在 `<channelId>/`。

## 一句话记住某件事

直接说就行——"记住我们的部署窗口是周四晚上"、"以后默认用 pnpm"、"别再自动加 emoji"。这类明确指令会**当场**写入频道 `MEMORY.md`，不等后台整理。

让它忘掉也一样直说："忘掉之前说的部署窗口"。遗忘是真的删除，并且会留一条墓碑记录（只存 id 和哈希，不存原文），防止后台整理把同一条又"复活"回来。

**改主意时说"忘掉旧的"，而不是补一条新的。** 两条互相矛盾的记忆都留着，之后召回哪条就成了掷骰子。

## 它自己会记住什么

除了你明确要求的，运行时还会在**明确的边界**上自动固化：上下文压缩前、`/new` 开新会话前、进程关闭前，以及频道空闲时的后台维护。

自动固化只挑**未来仍然有用**的东西：偏好、决定、约束、未闭合的待办。一次性的进度、临时计划、当下的猜测不会进长期记忆——它们属于 `SESSION.md` 或任务台账。

后台维护的每一步都先过**本地确定性闸门**（是否空闲、距上次多久、素材是否有意义）。闸门不放行就完全不调用模型，因此空闲的实例不会持续烧 token。四类维护任务及其默认间隔见 [deployment-and-operations.md](./deployment-and-operations.md#内置记忆维护任务memory-maintenance-scheduler)。

## 共享背景：管理员的入口

`workspace/MEMORY.md` 和 `ENVIRONMENT.md` 是**给人手工编辑**的，所有频道共享：

- `workspace/MEMORY.md`：团队背景、术语、长期约定。
- `ENVIRONMENT.md`：机器上装了什么、重要环境变量从哪来、仓库之外改过什么配置。不放密钥值、不放聊天摘要。

与之相对，频道级的 `SESSION.md` / `MEMORY.md` / `HISTORY.md` **不要手工编辑**——后台维护队列正在写它们，手工改动可能被覆盖，或与串行队列竞态。要改频道记忆，通过对话让 agent 走 `memory_manage`。

## 常见情况

**"它忘了我上周说的事。"** 先确认是不是同一个频道（私聊 vs 群是两套记忆）。是同一频道的话，早期对话可能已折叠进 `HISTORY.md` 或落到冷存储——明确引用那次对话（"上周我们讨论发布流程时说的"），agent 会用 `session_search` 去冷存储里找。想让它以后一直记得，就明说"记住"。

**"它记得，但要我把关键词说得刚刚好才想得起来。"** 这曾经是真的：早期的召回按"命中词数 ÷ 提问词数"打分，你说得越详细分母越大，反而越难命中。现在改成按命中词的**特异性**累加算证据，与提问长度无关——把背景讲清楚不再有惩罚。仍然可能漏的是**完全换一套说法**的情况（例如记忆里写的是"用 pnpm"，你问"依赖装一下"，两句话没有任何共同词）；这种时候直接点名主题，或让 agent 用 `memory_manage search` 去找。

**"它记住了一件已经不成立的事。"** 说"忘掉 X"。不要用"其实现在是 Y"来覆盖，那会留下两条冲突记忆。

**"我不想让它记住这次对话。"** 结束时说明不必记录；也可以用 `/new` 开新会话前告知无需固化。已经写入的用遗忘删掉。

**"后台记忆维护花了多少钱？"** `/usage` 会把 `sidecar`（记忆相关的 LLM 调用）单列。想压低就调大维护间隔，见 [configuration.md](./configuration.md) 的 `memoryMaintenance`。

**"想看它到底自动写了什么。"** 每个频道目录下的 `memory-review.jsonl` 记录了每次维护的动作、跳过原因和失败，是排查自动写回行为的第一现场。

## 相关文档

- 实现结构与数据流：[architecture.md §6](./architecture.md#6-记忆子系统srcmemory)
- 召回、维护间隔、sidecar 的全部可调字段：[configuration.md](./configuration.md)
- 后台维护任务与运维排障：[deployment-and-operations.md](./deployment-and-operations.md#内置记忆维护任务memory-maintenance-scheduler)
- 记忆相关工具：[tools.md](./tools.md#记忆与知识类)
- agent 侧"该写到哪一层"的纪律：[runtime-playbooks.md](./runtime-playbooks.md)

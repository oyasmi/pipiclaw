# 记忆（Memory）

> **读者**：想知道"它到底记住了什么、能不能让它忘掉、为什么忘了我说过的话"的使用者与管理员。
> **前置**：已完成 [README](../README.md) 的安装与配置。
> **读完你能**：说出记忆分几块、每块存什么、如何让某件事被记住或被遗忘、以及记忆出问题时先看哪个文件/命令。
> 想看实现（存储格式、反思 pass、迁移）请转 [architecture.md §6](./architecture.md#6-记忆子系统srcmemory)；想调参数请转 [configuration.md](./configuration.md)。

Pipiclaw 的记忆是**三件东西**：频道记忆库（一条事实一个文件）、按天的日志（journal）、以及跨频道共享的 workspace 背景。规模是个人/小团队自托管的量级——几十到几百条——所以不做检索打分：会话开始时把索引整份给模型看，之后靠 `memory_search` 按需补查。

## 三件东西

| 是什么 | 存哪 | 谁写 | 怎么进上下文 |
|---|---|---|---|
| 频道记忆 | `<channelId>/memory/*.md`，一条一文件，生成的 `<channelId>/MEMORY.md` 是索引 | `memory_save` / 后台反思 pass / 人手编辑 | 索引在**会话首轮**（含 `/new` 之后、压缩之后）整份注入 `<memory_bootstrap>`；装不下时按类型分层，见下 |
| 日志 | `<channelId>/journal/YYYY-MM-DD.md`，按天追加 | 只有后台反思 pass 写 | 首轮注入当天尾部；更早的日期用 `memory_search` 或 `/memory journal <date>` 查 |
| 共享背景 | `workspace/MEMORY.md`、`ENVIRONMENT.md` | **只由人手工维护**，没有工具能写 | 首轮整份注入 |

三者都**按频道隔离**（workspace 层除外）：你的私聊和某个群是两套互不可见的记忆。这是刻意的——私聊里说的话不应泄漏到群里，群成员也无法通过对话改到所有频道共享的 workspace 背景。频道的定义见 [scaling-and-concurrency.md](./scaling-and-concurrency.md#会话隔离模型session-isolation-model)。

文件都在 `${PIPICLAW_HOME:-~/.pipiclaw}/workspace/` 下：共享层在根目录，频道层在 `<channelId>/`。频道记忆文件可以直接用编辑器打开改——下次读到的就是改后的版本，索引会在下一次写入时重建。

一条记忆长这样：

```markdown
---
name: deploy-window-thursday
description: 生产部署窗口是周四 20:00 之后；周五不部署
type: project
source: user
created: 2026-09-04
updated: 2026-09-04
---

例外：紧急 hotfix 经确认后可在任意时间发，但要在群里留一句。
```

`type` 四选一：`user`（你是谁）、`feedback`（怎么工作的纠正/教训）、`project`（工作对象的事实/决策/约束）、`reference`（路径/URL/命令等指针）。正文可选，绝大多数记忆是一句话；有正文时索引里那条会带 `(+)` 标记。

## 一句话记住某件事

直接说就行——"记住我们的部署窗口是周四晚上"、"以后默认用 pnpm"、"别再自动加 emoji"。这类明确指令会**当场**调用 `memory_save` 写入频道记忆，不等后台整理。

让它忘掉也一样直说："忘掉之前说的部署窗口"，或者不经过模型直接用 `/memory forget <name>`（先用 `/memory list` 或索引找到名字）。遗忘是真的删除文件，并且会留一条墓碑记录（只存哈希，不存原文），防止后台反思把同一件事又"复活"回来。

**改主意时可以直接说新的一句**，不必自己先说"忘掉旧的"：`memory_save` 在写入前会先按关键词查一遍频道已有记忆，如果发现高度相似的已有条目，会先停下来把候选名字列出来，再决定是替换（`replaces: <name>`）还是两条都保留（`replaces: "none"`，两件事同时成立时）。仍然可以主动说"忘掉之前说的 XX"来跳过这一步直接删除。

## 它自己会记住什么

除了你明确要求的，运行时还会在**明确的边界**上自动跑一次"反思"：上下文压缩前、`/new` 开新会话前、进程关闭前，以及频道空闲一段时间后的后台维护。

一次反思同时产出两样东西：今天 journal 的新增行（发生了什么、定了什么、卡在哪），以及 memory 的增/改/删——只挑**未来仍然有用**的东西：偏好、决定、约束。一次性的进度、临时计划、当下的猜测只进 journal，不会被写成永久记忆。

后台维护先过**本地确定性闸门**（是否空闲、距上次多久、素材是否有意义）。闸门不放行就完全不调用模型，因此空闲的实例不会持续烧 token。默认间隔见 [deployment-and-operations.md](./deployment-and-operations.md#内置记忆维护任务memory-maintenance-scheduler)。

## 共享背景：管理员的入口

`workspace/MEMORY.md` 和 `ENVIRONMENT.md` 是**给人手工编辑**的，所有频道共享：

- `workspace/MEMORY.md`：团队背景、术语、长期约定。
- `ENVIRONMENT.md`：机器上装了什么、重要环境变量从哪来、仓库之外改过什么配置。不放密钥值、不放聊天摘要。

没有工具能写这两个文件，无论是主 agent、子代理还是任何频道——这是刻意的：把某个频道的记忆"升格"为所有会话共享的背景，是人的决定，不自动做。看到某条频道记忆放错了层，手动搬到这里即可。

与之相对，频道级的 `memory/*.md` 可以 `read`，但**不要用文件工具直接改**——写入一律通过对话让 agent 走 `memory_save` / `memory_forget`，或者你自己用 `/memory forget`。

## 常见情况

**"它忘了我上周说的事。"** 先确认是不是同一个频道（私聊 vs 群是两套记忆）。是同一频道的话，早期对话在 `log.jsonl`/`context.jsonl` 冷存储里——明确引用那次对话（"上周我们讨论发布流程时说的"），agent 会用 `session_search` 去找。想让它以后一直记得，就明说"记住"。

**"它记得，但要我把关键词说得刚刚好才想得起来。"** 会话首轮拿到的是**整份索引**，不是按关键词猜的几条，所以只要那条记忆在索引预算内，模型看得到全部条目，不存在"关键词没说中就漏了"的问题。条目多到超预算时，`user`/`feedback` 类型始终全给，`project`/`reference` 按最近更新时间保留，其余的用 `memory_search` 按需查——这时才可能需要你把主题说清楚一点。

**"它记住了一件已经不成立的事。"** 说"忘掉 X"。不要用"其实现在是 Y"来覆盖，那会留下两条冲突记忆。

**"我不想让它记住这次对话。"** 结束时说明不必记录；也可以用 `/new` 开新会话前告知无需固化。已经写入的用遗忘删掉。

**"后台记忆维护花了多少钱？"** `/usage` 会把 `sidecar`（记忆相关的 LLM 调用）单列。维护间隔是内置常量，不可调；想压低只能用 `memoryMaintenance.enabled: false` 整体关闭后台反思——代价见 [configuration.md](./configuration.md)。

**"想看它到底自动写了什么。"** `/memory status` 给一眼概览（分类计数、试用期、上次反思时间、索引是否超预算）；`/memory journal [date]` 看某天发生了什么；每个频道目录下的 `memory-review.jsonl` 记录了每次反思的动作、跳过原因和失败，是排查自动写回行为的第一现场。

**"升级之后我原来的记忆去哪了。"** 首次使用时会自动、确定性地把旧格式迁移过来，不调用模型。原文件整份移到频道目录下的 `.memory-v1/`，不会被删除；`/memory status` 会提示"已从旧版迁移"直到你自己删掉那个目录。回滚：把 `.memory-v1/` 里的文件移回原位，删除 `memory/`、`journal/`、生成的 `MEMORY.md` 和迁移标记文件，重装回旧版本。

## 相关文档

- 实现结构、存储格式、反思 pass、迁移细节：[architecture.md §6](./architecture.md#6-记忆子系统srcmemory)
- 记忆相关的可配开关与已退役字段：[configuration.md](./configuration.md)
- 后台维护任务与运维排障：[deployment-and-operations.md](./deployment-and-operations.md#内置记忆维护任务memory-maintenance-scheduler)
- 记忆相关工具：[tools.md](./tools.md#记忆与知识类)
- agent 侧"该写到哪一层"的纪律：[runtime-playbooks.md](./runtime-playbooks.md)

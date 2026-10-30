# 记忆（Memory）

> **读者**：想知道"它到底记住了什么、能不能让它忘掉、为什么忘了我说过的话"的使用者与管理员。
> **前置**：已完成 [README](../README.md) 的安装与配置。
> **读完你能**：说出记忆分几块、每块存什么、如何让某件事被记住或被遗忘、以及记忆出问题时先看哪个文件/命令。
> 想看实现（存储格式、反思 pass、迁移）请转 [architecture.md](./architecture.md) 的“记忆子系统”；想调参数请转 [configuration.md](./configuration.md)。

Pipiclaw 的记忆是**三件东西**：工位记忆库（一条事实一个文件）、按天的日志（journal）、以及所有工位共享的 workspace 背景。规模是个人/小团队自托管的量级——几十到几百条——所以不在每回合检索打分挑选注入内容：会话开始时把索引整份给模型看，之后靠 `memory_search` 按需补查。

## 三件东西

| 是什么 | 存哪 | 谁写 | 怎么进上下文 |
|---|---|---|---|
| 工位记忆 | `desk-<name>/memory/*.md`，一条一文件，生成的 `desk-<name>/MEMORY.md` 是索引 | `memory_save` / 后台反思 pass / 人手编辑 | 索引在**会话首轮**（含 `/new` 之后、压缩之后）整份注入 `<memory_bootstrap>`；装不下时按类型分层，见下 |
| 日志 | `desk-<name>/journal/YYYY-MM-DD.md`，按天追加 | 只有后台反思 pass 写 | 首轮注入当天尾部；更早的日期用 `memory_search` 或 `/memory journal <date>` 查 |
| 共享背景 | `workspace/MEMORY.md` | 管理员维护；通用文件工具能否写入由 path guard 决定 | 首轮按完整 H2 段落和预算注入 |
| 环境记录 | `workspace/ENVIRONMENT.md` | 管理员或获准的文件工具 | 不自动注入，需要时读取 |

记忆、日志和检索属于工位：绑定到同一个工位的所有频道（比如一个私聊和一个群）共享同一份记忆，各频道的对话上下文仍然分开；绑定到不同工位的频道互相看不到对方的记忆。workspace 层由所有工位共享。要让私聊的内容不进群，就别把它们绑到同一个工位；这不是 OS 级文件隔离。通用文件工具仍可能访问同一运行账号可读的其他目录；严格隔离需要使用独立账号或容器。工位与绑定见 [interaction-and-commands.md](./interaction-and-commands.md)，隔离模型见 [scaling-and-concurrency.md](./scaling-and-concurrency.md#会话隔离模型session-isolation-model)。

文件都在 `${PIPICLAW_HOME:-~/.pipiclaw}/workspace/` 下：共享层在根目录，工位层在 `desk-<name>/`。记忆文件可以直接用编辑器打开改——下次读到的就是改后的版本，索引会在下一次写入时重建。

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

直接说就行——"记住我们的部署窗口是周四晚上"、"以后默认用 pnpm"、"别再自动加 emoji"。这类明确指令会**当场**调用 `memory_save` 写入工位记忆，不等后台整理。

让它忘掉也一样直说："忘掉之前说的部署窗口"，或者不经过模型直接用 `/memory forget <name>`（先用 `/memory list` 或索引找到名字）。遗忘是真的删除文件，并且会留一条墓碑记录（只存哈希，不存原文），防止后台反思把同一件事又"复活"回来。

**改主意时可以直接说新的一句**，不必自己先说"忘掉旧的"：`memory_save` 在写入前会先按关键词查一遍工位已有记忆，如果发现高度相似的已有条目，会先停下来把候选名字列出来，再决定是替换（`replaces: <name>`）还是两条都保留（`replaces: "none"`，两件事同时成立时）。仍然可以主动说"忘掉之前说的 XX"来跳过这一步直接删除。

## 它自己会记住什么

除了你明确要求的，运行时还会在**明确的边界**上自动跑一次"反思"：上下文压缩前、`/new` 开新会话前、进程关闭前，以及某个频道空闲一段时间后的后台维护（只处理已绑定频道的会话区）。

压缩和 `/new` 会先把旧素材保存为待整理工作，再在后台反思；只等待本地保存，不等待模型。正常长对话按完整交流分批整理，后续调度继续处理剩余部分；极长的单次交流仍可能采样，省略范围会记入 `memory-review.jsonl`。

一次反思同时产出两样东西：今天 journal 的新增行（发生了什么、定了什么、卡在哪），以及 memory 的增/改/删——只挑**未来仍然有用**的东西：偏好、决定、约束。一次性的进度、临时计划、当下的猜测只进 journal，不会被写成永久记忆。

自动学到的日常知识可以先进入 30 天观察期，后续反思确认相关后转正；没有转正的条目在到期后的下一次反思前清理，不保证到日立即停止读取。用户明确保存的记忆不受观察期清理影响。

后台维护先过**本地确定性闸门**（是否空闲、距上次多久、素材是否有意义）。闸门不放行就完全不调用模型，因此空闲的实例不会持续烧 token。默认间隔见 [deployment-and-operations.md](./deployment-and-operations.md#内置记忆维护任务memory-maintenance-scheduler)。

## 共享背景：管理员的入口

`workspace/MEMORY.md` 和 `ENVIRONMENT.md` 是管理员拥有的共享文件：

- `workspace/MEMORY.md`：团队背景、术语、长期约定。
- `ENVIRONMENT.md`：机器上装了什么、重要环境变量从哪来、仓库之外改过什么配置。不放密钥值、不放聊天摘要。

Pipiclaw 不会自动把工位记忆升格到这里。通用文件工具能否写入这两个文件由 path guard 和运行账号权限决定。因此“管理员维护”是内容所有权约定，不是强制只读保证。需要强边界时见[安全指南](./security.md)。

与之相对，工位级的 `memory/*.md` 可以 `read`，但**不要用文件工具直接改**——写入一律通过对话让 agent 走 `memory_save` / `memory_forget`，或者你自己用 `/memory forget`。

## 常见情况

**"它忘了我上周说的事。"** 先用 `/desk` 确认两个频道是不是绑定在同一个工位上（不同工位是两套记忆）。是同一个工位的话，早期对话在各频道会话区的 `log.jsonl` 和会话文件里——明确引用那次对话（"上周我们讨论发布流程时说的"），agent 会用 `session_search` 去找。想让它以后一直记得，就明说"记住"。

**"它记得，但要我把关键词说得刚刚好才想得起来。"** 会话首轮拿到的是**整份索引**，不是按关键词猜的几条，所以只要那条记忆在索引预算内，模型看得到全部条目，不存在"关键词没说中就漏了"的问题。条目多到超预算时，`user`/`feedback` 类型始终全给，`project`/`reference` 按最近更新时间保留，其余的用 `memory_search` 按需查——这时才可能需要你把主题说清楚一点。

**"它记住了一件已经不成立的事。"** 直接说明新事实和要替换的旧事实；agent 会用 `replaces` 更新原条目，并按用户明确保存的记忆保护它。只想删除时说“忘掉 X”或用 `/memory forget <name>`。

**"我不想让它保留这次对话。"** 当前没有单轮“不留存”模式。说明“不必写入长期记忆”只会影响模型判断，不能阻止原始会话落盘或保证 journal 不记录。已经写入的 durable memory 可用遗忘删除；journal 和原始会话需由管理员按数据保留政策处理。

**"后台记忆维护花了多少钱？"** `/usage` 会把"后台整理"（账本里的 `sidecar`，记忆相关的 LLM 调用）单列。维护间隔是内置常量；`memoryMaintenance.enabled: false` 只关闭空闲定时反思，压缩、`/new` 和正常退出等边界仍可能触发反思，详情见 [configuration.md](./configuration.md)。

**"想看它到底自动写了什么。"** `/memory status` 给一眼概览（分类计数、观察期条目、上次后台整理时间、索引是否超预算）；`/memory journal [date]` 看某天的工作日记；每个工位目录下的 `memory-review.jsonl` 记录了每次反思的动作、跳过原因和失败，是排查自动写回行为的第一现场。

## 相关文档

- 实现结构、存储格式、反思 pass、迁移细节：[architecture.md](./architecture.md) 的“记忆子系统”
- 记忆相关的可配开关与已退役字段：[configuration.md](./configuration.md)
- 后台维护任务与运维排障：[deployment-and-operations.md](./deployment-and-operations.md#内置记忆维护任务memory-maintenance-scheduler)
- 记忆相关工具：[tools.md](./tools.md#记忆与知识类)
- agent 侧"该写到哪一层"的纪律：[runtime-playbooks.md](./runtime-playbooks.md)

# Pipiclaw 与 Hermes 对比

状态：调研文档  
最后更新：2026-04-10  
适用范围：用于理解 Pipiclaw 与 Hermes 的架构差异、能力边界和演进取舍

## 目的

这份文档聚焦于一件事：

> 把 Pipiclaw 和 Hermes 的差异讲清楚。

它不直接给出“Pipiclaw 应该学什么”的优先级建议，那部分已经单独写在：

- [hermes-learning-insights.md](./hermes-learning-insights.md)

这份文档更偏客观对照，主要回答：

1. 两者分别是什么
2. 两者各自把精力投在什么地方
3. 两者的长期能力是如何实现出来的
4. 两者在工程边界上的核心分歧是什么

## 调研范围

本次对比基于两个代码库的实际实现。

Pipiclaw 主要阅读：

- [README](../README.md)
- [src/agent/channel-runner.ts](../src/agent/channel-runner.ts)
- [src/agent/prompt-builder.ts](../src/agent/prompt-builder.ts)
- [src/agent/workspace-resources.ts](../src/agent/workspace-resources.ts)
- [src/memory/lifecycle.ts](../src/memory/lifecycle.ts)
- [src/memory/recall.ts](../src/memory/recall.ts)
- [src/memory/candidates.ts](../src/memory/candidates.ts)
- [src/subagents/tool.ts](../src/subagents/tool.ts)
- [src/runtime/events.ts](../src/runtime/events.ts)
- [src/security/path-guard.ts](../src/security/path-guard.ts)
- [src/security/command-guard.ts](../src/security/command-guard.ts)

Hermes 主要阅读：

- `/Users/oyasmi/projects/hermes-agent/README.md`
- `/Users/oyasmi/projects/hermes-agent/run_agent.py`
- `/Users/oyasmi/projects/hermes-agent/agent/prompt_builder.py`
- `/Users/oyasmi/projects/hermes-agent/tools/memory_tool.py`
- `/Users/oyasmi/projects/hermes-agent/tools/skill_manager_tool.py`
- `/Users/oyasmi/projects/hermes-agent/tools/session_search_tool.py`
- `/Users/oyasmi/projects/hermes-agent/tools/delegate_tool.py`
- `/Users/oyasmi/projects/hermes-agent/hermes_state.py`
- `/Users/oyasmi/projects/hermes-agent/plugins/memory/honcho/__init__.py`
- `/Users/oyasmi/projects/hermes-agent/toolsets.py`

## 一句话对比

如果必须用一句话概括：

- **Hermes** 更像一个通用、自学习、工具面很大的 agent OS
- **Pipiclaw** 更像一个面向 DingTalk 长期协作、强调分层持久化与运行时可控性的 runtime

如果再具体一点：

- Hermes 优先解决的是“agent 如何长期积累能力，并在多平台、多环境里到处运行”
- Pipiclaw 优先解决的是“agent 如何在 DingTalk 里长期稳定工作，并保留清晰的 workspace/channel 结构”

## 顶层定位差异

## Hermes 的定位

Hermes 从一开始就是一个更广义的 agent runtime。

它的 README 直接把自己定义为：

- self-improving AI agent
- multi-platform gateway
- scheduled automations
- subagents and parallelization
- multi-backend execution
- research-ready runtime

从实现上看，这个定位也是真的。

Hermes 同时覆盖：

1. CLI
2. 多消息平台 gateway
3. ACP/editor integration
4. cron jobs
5. memory provider plugins
6. 大工具面
7. 多 terminal backends

所以 Hermes 的设计目标天然更宽。

## Pipiclaw 的定位

Pipiclaw 的定位更窄，也更聚焦。

它不是要做一个“无处不在的 agent OS”，而是：

1. 基于 `pi-coding-agent`
2. 做 DingTalk-first runtime
3. 补齐长期工作助手最需要的几层能力

具体包括：

1. DingTalk transport
2. AI Card 过程展示
3. 分层记忆
4. 子代理
5. 事件调度
6. per-channel workspace 持久化
7. 工具安全边界

这意味着 Pipiclaw 的很多取舍都不是“还没做大”，而是“有意不朝那个方向做”。

## 核心架构对比

## Hermes：通用 agent runner + 周边系统

Hermes 的中心是一套比较完整的 agent operating surface。

主要结构可以粗略理解为：

1. `run_agent.py`
   主循环、工具调用循环、上下文压缩、memory/skill 触发、后台 review
2. `tools/*.py`
   大量工具实现
3. `hermes_state.py`
   SQLite session store + FTS5
4. `gateway/`
   多平台消息接入
5. `cron/`
   job/scheduler
6. `plugins/memory/`
   外接 memory provider

这种结构的特点是：

- 能力集中在 agent runtime 自身
- 许多外围能力围绕 agent 主循环扩展
- 适合做通用 agent 平台

## Pipiclaw：DingTalk runtime + channel/workspace 模型

Pipiclaw 的核心结构更偏“运行时分层”：

1. `src/runtime/`
   DingTalk transport、delivery、events、store
2. `src/agent/`
   channel runner、prompt 组装、命令扩展、session 事件
3. `src/memory/`
   recall、session、consolidation、lifecycle
4. `src/subagents/`
   预定义子代理发现与运行
5. `src/tools/`
   工具实现
6. `src/security/`
   命令守卫、路径守卫、网络与平台相关安全

这种结构的特点是：

- domain 边界更清楚
- runtime、memory、subagent、security 彼此职责更明确
- 适合长期维护一个“以工作通道为中心”的运行系统

## 平台与入口对比

## Hermes

Hermes 是明显的多入口系统。

它同时重视：

1. 终端 UI
2. 消息平台 gateway
3. 编辑器/ACP 接入
4. API server

这个设计带来的好处是能力复用面广，但代价是系统复杂度高，很多能力必须为“跨入口一致性”服务。

## Pipiclaw

Pipiclaw 主要入口就是 DingTalk runtime。

虽然内部仍然有 agent、workspace、tools、events 等通用层，但产品重心非常明确：

1. 在 DingTalk 中工作
2. 通过 AI Card 展示运行状态
3. 在 channel/workspace 上保留长期上下文

这使得 Pipiclaw 可以把很多设计做得更贴近“企业协作通道”而不是“通用 agent shell”。

## 记忆模型对比

## Hermes：多层长期记忆体系

Hermes 的长期记忆至少有四层：

1. `MEMORY.md` / `USER.md`
   文件型、bounded curated memory
2. `session_search`
   基于 SQLite + FTS5 的会话级回忆
3. skills
   procedural memory
4. external memory providers
   如 Honcho、supermemory 等

这套设计的本质不是“一个大 memory”，而是把不同类型的长期知识放进不同通道里。

尤其重要的是：

- facts 进 memory
- workflows 进 skill
- transcripts 进 searchable session store
- user model 可进 provider

这是 Hermes “学习感”最强的来源。

## Pipiclaw：分层文件记忆 + 受控召回

Pipiclaw 的记忆哲学明显更克制。

它的核心分层是：

1. `workspace/MEMORY.md`
   稳定共享背景
2. `<channel>/SESSION.md`
   当前工作态
3. `<channel>/MEMORY.md`
   durable channel memory
4. `<channel>/HISTORY.md`
   summarized older history
5. `log.jsonl` / `context.jsonl`
   cold storage

Pipiclaw 的重点不是 memory surface 做多，而是把：

1. 哪些文件是热的
2. 哪些文件是 warm-on-demand
3. 哪些文件是 cold
4. 哪些文件允许 runtime 改
5. 哪些文件不允许 runtime 改

这些边界说清楚。

### 最关键的差异

Hermes 更强调：

> 如何让 agent 可以持续积累越来越多可调用的长期知识资产。

Pipiclaw 更强调：

> 如何让长期上下文保持分层、可解释、低热路径成本。

这两者并不冲突，但目标不同。

## “成长”机制对比

## Hermes：明确的 growth loop

Hermes 的成长闭环是显式存在的：

1. prompt 中要求稳定事实写 memory
2. prompt 中要求复杂方法写 skill
3. prompt 中要求遇到旧 skill 问题时 patch skill
4. runtime 中按 user turn / tool iteration 触发 review
5. 主任务结束后异步 fork review agent
6. compaction 前做 memory flush

换句话说，Hermes 的“自我成长”并不是一句抽象口号，而是一条 runtime pipeline。

## Pipiclaw：记忆维护闭环强，成长闭环弱

Pipiclaw 当前已经有不错的“记忆维护闭环”：

1. turn-time relevant recall
2. `SESSION.md` 刷新
3. durable consolidation
4. compaction/new-session/shutdown 相关维护

但它的“成长闭环”明显还不完整。

它缺的是：

1. procedural memory 的写回面
2. transcript 级显式回忆工具
3. post-turn review 机制

所以更准确地说，Pipiclaw 现在擅长的是：

> 持续维护状态

而 Hermes 更擅长的是：

> 持续沉淀能力

## Skill 体系对比

## Hermes

Hermes 把 skills 当作 procedural memory。

不仅能：

1. 列出 skill
2. 查看 skill

还能：

3. create
4. edit
5. patch
6. write supporting files
7. remove supporting files

而且它在 prompt 里明确要求：

- 做完复杂任务后应考虑保存 skill
- skill 过时了要及时 patch

这使得 skills 不只是“静态说明书”，而是 agent 自己维护的方法资产。

## Pipiclaw

Pipiclaw 当前也有 `workspace/skills/`，但它更像是 workspace 资源，而不是 agent 的 procedural memory 系统。

当前能力更接近：

1. 读取已有 skills
2. 把 skill 摘要注入资源加载流程

而不是：

1. agent 自己沉淀 skill
2. agent 自己修补 skill

这是两者差异中非常关键的一点。

## Transcript 与历史回忆对比

## Hermes

Hermes 用 SQLite `state.db` 保存会话，再用 FTS5 做检索。

这意味着它对“我们以前聊过这个”的支持是结构化的。

它能做的不是简单地读旧文件，而是：

1. 查匹配消息
2. 找相关 session
3. 聚焦摘要
4. 把结果当作当前推理的输入

这属于 transcript-native recall。

## Pipiclaw

Pipiclaw 当前不把 `log.jsonl` / `context.jsonl` 当普通 memory source。

它更依赖：

1. `SESSION.md`
2. `MEMORY.md`
3. `HISTORY.md`

做切片、打分、可选 rerank，再把 relevant context 注回当前 turn。

这条路线的优点是：

1. 热路径轻
2. 结构简单
3. 可解释

缺点是：

1. 如果某些细节没有进入整理后的 memory 层，就不容易找回

## 子代理对比

## Hermes

Hermes 的子代理更像一般性的 agent orchestration。

特点：

1. 支持 single task 与 batch parallel
2. 子代理有独立 terminal session
3. 工具面较宽
4. 父代理只看到摘要结果
5. 更偏“并行工作流分发”

## Pipiclaw

Pipiclaw 的子代理明显更克制，也更贴近当前 runtime 模型。

特点：

1. 支持预定义 sub-agent 与 inline sub-agent
2. 明确限制工具面
3. 不允许嵌套 sub-agent
4. 可按 `contextMode` 和 `memory` 做受控上下文注入
5. 更偏“同一工作通道里的有边界协作”

这两者的差别不在于有没有 sub-agent，而在于：

- Hermes 更强调 sub-agent 作为通用并行计算单元
- Pipiclaw 更强调 sub-agent 作为同一 workspace/channel 的角色化执行单元

## 自动化与定时任务对比

## Hermes

Hermes 有更完整的 cron/job 系统。

它的设计目标更像：

1. 自然语言定义 automation
2. job 管理
3. delivery 到任意平台
4. 持久化调度状态

这更像“产品化的 automation system”。

## Pipiclaw

Pipiclaw 当前的 event 模型更透明：

1. `workspace/events/*.json`
2. immediate / one-shot / periodic
3. 可选 `preAction` 作为 deterministic gate
4. 运行中 watcher 读取并调度

它没有 Hermes 那么完整的 job 面，但优势是：

1. 文件即配置
2. 团队容易版本管理
3. 触发逻辑清楚
4. 与 workspace 模型天然一致

## 安全模型对比

## Hermes：大工具面 + approval

Hermes 的安全模型里，一个很重要的支点是危险命令检测与审批。

由于工具面非常大，它需要：

1. 对高风险命令做 pattern detection
2. 在 CLI/gateway 中做 approval state 管理
3. 在更强工具能力下维持基本安全边界

这种路线适合功能面广的系统。

## Pipiclaw：更前置的边界约束

Pipiclaw 当前的安全思路更偏“预防式边界”：

1. `bash` 命令守卫
2. 读写路径守卫
3. home/workspace/temp 白名单语义
4. 常见凭据、私钥、浏览器资料、系统敏感路径拒绝
5. 审计日志

这对企业消息通道里的长期 agent 很重要，因为它降低了许多“运行时再问用户批不批准”的复杂性。

## 工程复杂度对比

## Hermes

Hermes 的系统复杂度明显更高。

复杂度来自：

1. 多入口
2. 多平台
3. 多工具面
4. 多 memory surface
5. 多执行环境
6. cron、API server、ACP 等外围系统

这让它能力上限很高，但也意味着：

1. 理解成本高
2. 运维面更大
3. 安全与一致性维护难度更高

## Pipiclaw

Pipiclaw 的复杂度主要集中在：

1. DingTalk runtime
2. channel/workspace 分层
3. memory lifecycle
4. 子代理
5. 安全控制

它没有 Hermes 那么宽，因此更容易维持：

1. 结构稳定
2. 行为可解释
3. 边界清楚

## 对比表

| 维度 | Hermes | Pipiclaw |
|------|--------|-----------|
| 产品主语义 | 通用 agent OS | DingTalk-first 工作 runtime |
| 主要入口 | CLI + gateway + ACP + API | DingTalk runtime |
| 长期状态主容器 | `~/.hermes` + DB + plugins | workspace/channel 文件层 |
| 记忆风格 | 多 surface、可插件化 | 分层文件、受控召回 |
| procedural memory | 强，skills 是一等公民 | 弱，skills 目前偏静态资源 |
| transcript recall | 强，FTS5 + summary | 弱，主要依赖整理后 memory |
| 子代理 | 通用并行 orchestration | channel/workspace 内的受控协作 |
| 自动化 | 完整 cron/job 系统 | 透明文件驱动 events |
| 安全模型 | 宽工具面下的 approval | 更前置的边界约束 |
| 工程倾向 | 高能力上限 | 高可控性与清晰边界 |

## 最后总结

Hermes 和 Pipiclaw 并不是同一路线下的两个不同成熟度版本。

更准确的说法是：

- 它们都在做长期运行的 agent runtime
- 但它们优先优化的目标不同

Hermes 更强的是：

1. 通用性
2. 自学习闭环
3. transcript-native recall
4. procedural memory
5. 多入口多平台能力

Pipiclaw 更强的是：

1. DingTalk 场景适配
2. workspace/channel 分层
3. 运行时可解释性
4. 安全边界的前置控制
5. 以长期协作通道为中心的上下文模型

如果只用一句话概括两者的差别：

> Hermes 在回答“agent 如何变得越来越强”；Pipiclaw 在回答“agent 如何长期稳定地工作”。  
> 未来的 Pipiclaw，很可能需要在不放弃第二个问题的前提下，补上第一个问题里最有价值的部分。


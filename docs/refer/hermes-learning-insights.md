# Pipiclaw 从 Hermes 学什么

状态：调研文档  
最后更新：2026-04-10  
适用范围：Pipiclaw 未来 6-18 个月的能力演进讨论

## 目的

这份文档不是做一份泛泛的竞品介绍，也不是主张让 Pipiclaw 追求和 Hermes 的功能对齐。

它要回答的是一个更具体的问题：

> 在不破坏 Pipiclaw 当前定位、边界和工程风格的前提下，Pipiclaw 最值得向 Hermes 学什么？

这里的“值得学”，不是指社区里最热闹、最容易写进宣传文案的能力，而是指：

1. 真正解决 Pipiclaw 当前能力缺口
2. 与 DingTalk-first、channel/workspace 分层、运行时可控性这条路线相容
3. 能长期沉淀成架构资产，而不是堆积临时 feature
4. 在安全、可解释性、可运维性上不明显倒退

## 调研范围

本次调研主要基于两个代码库的实际实现，而不是产品文案。

Pipiclaw 侧重点阅读：

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
- [docs/specs/001-implement-memory/memory-rfc.md](./specs/001-implement-memory/memory-rfc.md)

Hermes 侧重点阅读：

- `/Users/oyasmi/projects/hermes-agent/README.md`
- `/Users/oyasmi/projects/hermes-agent/run_agent.py`
- `/Users/oyasmi/projects/hermes-agent/agent/prompt_builder.py`
- `/Users/oyasmi/projects/hermes-agent/tools/skill_manager_tool.py`
- `/Users/oyasmi/projects/hermes-agent/tools/session_search_tool.py`
- `/Users/oyasmi/projects/hermes-agent/tools/delegate_tool.py`
- `/Users/oyasmi/projects/hermes-agent/tools/memory_tool.py`
- `/Users/oyasmi/projects/hermes-agent/hermes_state.py`
- `/Users/oyasmi/projects/hermes-agent/plugins/memory/honcho/__init__.py`
- `/Users/oyasmi/projects/hermes-agent/toolsets.py`

## 先给结论

Hermes 最值得 Pipiclaw 学的，不是“自我成长”这个口号本身，而是它把“成长”拆成了几种独立、可落地、可持久化、可运维的 runtime 机制：

1. 程序性记忆：把“做事方法”沉淀成可维护的 skills
2. 冷路径会话检索：把“过去做过什么”从 transcript 中召回，而不是只依赖当前 prompt 和记忆文件
3. 异步复盘闭环：在主任务结束后，低成本判断“这次有没有值得沉淀的东西”
4. 上下文压缩前的持久化动作：在即将丢失上下文前，先做一次总结/保存

但 Pipiclaw 不应该学 Hermes 的方向也很明确：

1. 不应该为了“成长感”而引入大而杂的全局隐式状态
2. 不应该把当前清晰的 workspace/channel 分层打散成难以解释的个人全局 agent home
3. 不应该把热路径做重，让每轮消息都依赖额外数据库、插件或远程记忆 provider
4. 不应该为了 feature 面扩张牺牲 DingTalk runtime 的稳定性和安全边界

如果只给一个最高优先级建议，那就是：

> **为 Pipiclaw 增加 workspace 级的 procedural skill 闭环。**

如果给两个建议，则是：

1. procedural skill 闭环
2. 冷路径 session search

如果给三个建议，则再加上：

3. suggestion-first 的异步 post-turn reviewer

## Hermes 真正做对了什么

### 1. 它把“成长”变成外部资产，而不是神秘能力

Hermes 的“自我成长”并不是模型在运行过程中真的“长脑子”。

它做的是：

- 稳定事实写入 memory
- 可复用方法写入 skill
- 旧会话写入可检索的 session store
- 用户长期画像写入可选 memory provider（如 Honcho）

这件事的价值很大，因为它把“成长”从不可验证的主观感受，变成了几类可以审计、可以清理、可以迁移、可以测试的资产。

这一点值得 Pipiclaw 学，因为 Pipiclaw 本身就已经非常强调文件、目录、通道、工作区这些显式资产。

### 2. 它区分了 declarative memory 和 procedural memory

Hermes 的一个关键优势，是它没有把所有长期知识都塞进 `MEMORY.md`。

它明确区分：

- declarative memory：事实、偏好、约束、稳定信息
- procedural memory：处理某类任务的方法、流程、坑点、脚本、模板

这个区分很重要。

如果没有 procedural memory，agent 往往会出现一个常见问题：

- 它记得“用户偏好什么”
- 也记得“项目之前做过什么”
- 但它不会把“这类任务应该怎么做”真正沉淀下来

这正是 Pipiclaw 当前最大的结构性缺口之一。

### 3. 它把 transcript recall 放在冷路径

Hermes 的 `session_search` 并不是把过去所有会话塞进主上下文，而是：

1. 用 SQLite FTS5 找匹配消息
2. 选出相关 session
3. 再用廉价模型做 focused summary

这条路线的工程意义很强：

- 常规对话不为“也许以后会用到”付热路径成本
- 需要跨会话回忆时，又有明确工具可用
- 输出的是受控摘要，而不是冗长原始 transcript

Pipiclaw 当前对这类需求的支持明显偏弱。它已经有分层记忆召回，但那依赖的是 `SESSION.md / MEMORY.md / HISTORY.md` 这些整理后的文件，不是 transcript 级回忆。

### 4. 它把复盘放到了主任务之后

Hermes 的一个很成熟的点，是异步 background review：

- 主任务先完成，先给用户结果
- 再由后台 review agent 判断这次对话是否值得沉淀为 memory 或 skill

这比把“记忆管理”塞进每一轮主推理里更合理。

因为长期沉淀属于“后处理”，不应该和“完成当前用户任务”争抢主路径注意力与 token。

这对 Pipiclaw 很有启发意义。Pipiclaw 目前已经有 sidecar worker、session memory refresh、durable consolidation 等后台维护基础设施，这意味着它并不缺“异步维护”的架子，缺的是一层更明确的复盘目标。

## Pipiclaw 当前已经做对了什么

这部分很重要，因为“向 Hermes 学”不能建立在否定 Pipiclaw 当前路线的基础上。

Pipiclaw 已经形成了自己非常清楚的架构判断。

### 1. 它优先的是长期工作 runtime，而不是全能 agent shell

Pipiclaw 的核心叙事很明确：

- DingTalk transport
- AI Card 流式展示
- channel/workspace 持久化
- 分层记忆
- 事件调度
- 子代理
- 工具安全防护

它不是一个从 CLI 出发、再往消息平台扩出去的通用 agent OS，而是一个面向 DingTalk 长时协作的运行时。

这意味着 Pipiclaw 的一切借鉴，都应该服务这个定位，而不是把产品重心拽向“泛平台大而全”。

### 2. 它的记忆模型很克制，而且是有意为之

Pipiclaw 当前记忆模型的核心优点是：

1. 文件分层清楚
2. 生命周期可解释
3. 热路径负担小
4. workspace 和 channel 的职责边界清楚

尤其是 memory RFC 中明确写出的非目标，非常有价值：

- 不做 memory plugin
- 不做 special memory tools
- 不把 raw transcript 当作普通记忆源
- 不自动修改 workspace 级 `SOUL.md / AGENTS.md / MEMORY.md`

这些决定让 Pipiclaw 的 runtime 行为非常可解释。

所以后续演进应当遵守一个原则：

> 新能力可以增加，但不能把现有“边界清晰、显式文件优先”的记忆哲学打穿。

### 3. 它已经有很强的“受控上下文注入”能力

Pipiclaw 不是没有 recall。

它已经有：

- `SESSION.md / MEMORY.md / HISTORY.md` 候选切片
- lexical + structural scoring
- 可选模型 rerank
- contextual sub-agent 的定向记忆注入

换句话说，Pipiclaw 不需要向 Hermes 学“记忆召回”这个概念本身，而是需要补上：

- 程序性记忆
- transcript 级冷路径回忆
- 异步复盘

### 4. 它在安全边界上更适合企业 IM 场景

Pipiclaw 的路径守卫和命令守卫明显比典型 agent runtime 更前置、更强约束。

这与 Hermes 那种大工具面 + approval 模式并不矛盾，但取舍不同。

对于 Pipiclaw 来说，这一点应该被视为“必须保留的核心资产”，而不是为了更像 Hermes 而削弱。

## 借鉴 Hermes 的判断框架

后续讨论中，建议用下面四条判断一项能力是否值得引入：

### 1. 是否增强 Pipiclaw 的长期协作能力

优先级高的能力，应该能提升以下至少一项：

- 以后少重复解释
- 以后少重复做同类探索
- 以后更容易从长时间历史中恢复上下文
- 以后更容易把团队经验沉淀到 workspace

### 2. 是否能保持显式作用域

优先保留这些作用域：

- workspace 级
- channel 级
- session 冷存储级

避免一开始就把新能力做成“用户主目录下一个隐式全局大脑”。

### 3. 是否尽量不增加每轮热路径负担

Pipiclaw 当前热路径已经承担：

- transport 处理
- runtime prompt 组装
- memory recall
- tool 安全检查
- AI Card 流展示

任何新增能力，优先放在：

- 显式工具调用
- compaction/new-session/shutdown 钩子
- turn 后台复盘

而不是每轮同步前置。

### 4. 是否可审计、可测试、可回滚

这也是 Hermes 真正可取的地方之一。

如果一个能力不能落成这些东西之一，就说明它对长期 runtime 来说还不够成熟：

- 文件
- 索引
- JSON 结构
- 可验证 worker 输出
- 明确的 tool surface

## 优先级排序：Pipiclaw 最值得学习的 4 件事

## A. 最高优先级：引入 workspace 级 procedural skill 闭环

### 现状问题

Pipiclaw 现在会加载 workspace `skills/`，但这些 skills 本质上还是静态资产。

也就是说：

- agent 能消费 skill
- 但不会系统地产生 skill
- 也不会系统性修补 skill

这导致 Pipiclaw 的“长期成长”很容易停留在状态层，而不是方法层。

### 为什么这是最高优先级

因为对长期工作助手来说，最有复利的不是“记住用户说过什么”，而是“把做一类事的方法沉淀下来”。

典型高价值场景：

1. 代码审查套路
2. 发布检查清单
3. 故障排查路径
4. 某个团队的周报、日报、复盘模板
5. 某类搜索/抓取/整理任务的固定工作流

这类知识如果只存在于某次对话里，很快就会消失。

### 应该怎么做

建议新增一层 workspace-scoped skill management，而不是照搬 Hermes 的全局 `~/.hermes/skills/` 模型。

建议原则：

1. 默认写回 `workspace/skills/`
2. 由 agent 明确通过工具创建或更新
3. skill 继续作为显式文件资产存在
4. 支持 supporting files，但保持目录结构简单

建议能力最小集合：

1. `skill_list`
2. `skill_view`
3. `skill_manage`

`skill_manage` 第一版建议支持：

1. `create`
2. `patch`
3. `write_file`

不必一开始就做复杂的 install/hub 体系。

### 与 Pipiclaw 当前结构的契合点

这项能力非常契合 Pipiclaw 现有路线：

- workspace 已经是显式根目录
- `skills/` 已经存在
- agent 已经能加载 skill 摘要
- 文件型资产便于团队版本管理

### 风险与约束

最大的风险不是实现复杂，而是 skill 污染：

- 低质量 skill 泛滥
- 过时 skill 不被修补
- agent 把 task log 错写成 procedural skill

所以建议：

1. 第一阶段默认 suggestion-first
2. 第二阶段允许自动创建，但只允许写入草稿目录或带元数据标记
3. skill 内容必须经过结构校验
4. 对脚本、命令、外链等敏感内容做安全扫描

### 推荐落点

模块建议：

- `src/tools/skill-manage.ts`
- `src/agent/skill-review.ts` 或 `src/memory/skill-review.ts`
- `workspace/skills/`

## B. 第二优先级：增加冷路径 session search

### 现状问题

Pipiclaw 当前可以从整理后的 memory 文件中召回上下文，但它缺一条能力：

> 当用户说“我们之前不是讨论过这个吗”时，系统怎样从更长的历史里恢复事实？

如果 `SESSION.md / MEMORY.md / HISTORY.md` 没有把相关内容充分保留下来，当前 runtime 就很难恢复。

### 为什么它重要

长期使用的工作助手一定会遇到这类场景：

1. 用户提到几周前一次讨论
2. 某个中间决策没有被很好沉淀到 durable memory
3. 需要找回“我们当时是怎么做的”
4. 需要从旧对话里提取命令、路径、错误信息

这类需求不适合靠正常 recall 热路径解决。

### 建议路线

建议引入一个明确的冷路径工具，例如：

- `session_search`
- 或 `history_search`

第一阶段建议保持非常克制：

1. 默认只搜索当前 channel
2. 数据源只用已有冷存储，如 `context.jsonl` / `log.jsonl`
3. 单独建 sidecar index，不进入主 prompt
4. 返回 focused summary，而不是整个 transcript

这是对现有 memory RFC 的一个“受控扩展”，不是推翻。

关键边界：

1. 它不是普通 memory source
2. 它不是每轮自动加载
3. 它只在显式需要时调用

### 为什么它比 memory plugin 更值得先做

因为它直接增强 Pipiclaw 自己已经拥有的数据资产，而不是引入新的外部依赖和新的全局状态系统。

对 Pipiclaw 来说，这比优先做第三方 memory provider 更符合当前产品阶段。

### 推荐落点

模块建议：

- `src/memory/session-search.ts`
- `src/memory/session-index.ts`
- `src/tools/session-search.ts`

## C. 第三优先级：增加 suggestion-first 的 post-turn reviewer

### 现状问题

Pipiclaw 现在已经有：

- `SESSION.md` 刷新
- durable consolidation
- relevant memory injection

但它缺一个明确的“这次值得沉淀什么”的后处理层。

这会导致两个问题：

1. 很多有价值的方法不会沉淀为 skill
2. 很多值得明确写入 durable memory 的稳定事实，只会模糊地留在 session state 或 transcript 里

### 为什么 Hermes 的做法有启发，但不能直接照抄

Hermes 会在后台直接 fork review agent，然后写 memory/skill。

这条路线很强，但如果直接搬到 Pipiclaw，会有两个风险：

1. 对 workspace 文件产生过多自动写入
2. 在企业消息场景里引入较强的不可见副作用

### 更适合 Pipiclaw 的做法

建议先做 suggestion-first：

1. turn 结束后异步 review
2. review 输出结构化 JSON
3. 先给出建议，而不是直接写文件
4. 由主代理或用户明确接受后再落盘

review 输出可以分三类：

1. 值得写入 channel memory 的稳定事实
2. 值得写成 workspace skill 的方法
3. 值得忽略的临时内容

等这条链条稳定后，再逐步放开部分自动化写入。

### 为什么这件事适合 Pipiclaw

Pipiclaw 已经有不错的异步维护基础：

- sidecar worker
- session memory 更新
- compaction / shutdown 前维护
- sub-agent 运行框架

所以这项能力的难点不在“怎么起 worker”，而在“如何定义输出协议和写回策略”。

### 推荐落点

模块建议：

- `src/memory/post-turn-review.ts`
- `src/memory/review-schema.ts`
- `src/agent/channel-runner.ts` 的 turn 后钩子

## D. 第四优先级：把“压缩前保存什么”做得更明确

### 现状判断

Pipiclaw 在这方面其实已经比很多 runtime 更成熟：

- 有 `SESSION.md`
- 有 session memory refresh
- 有 compaction / new-session / shutdown 相关维护
- 有 durable consolidation

所以这里不是能力空白，而是可以继续精化。

### 建议

在 compaction/new-session 之前，增加更明确的“promotion candidates”提取阶段，输出类似：

1. durable memory candidates
2. skill candidates
3. safe-to-drop session-only state

这会让后续的 session search、skill loop、reviewer 更容易互相衔接。

### 这项的优先级为什么排在第四

因为它更多是“强化已有维护链路”，而不是补一个全新能力缺口。

在资源有限时，应排在 procedural skill 和 session search 之后。

## 不值得优先照搬的东西

## 1. 全局 memory provider/plugin 生态

Hermes 的 Honcho/supermemory/mem0 路线很强，但对 Pipiclaw 当前阶段不是最优先。

原因：

1. 会引入新的外部依赖和配置面
2. 会把记忆作用域从 workspace/channel 拉向全局用户空间
3. 会削弱当前文件型记忆的可解释性
4. 会显著增加排障复杂度

如果未来要做，也建议排在 session search 之后。

## 2. 过大的通用工具面

Hermes 的工具面非常宽，包括 browser、vision、image、tts、execute_code、send_message、homeassistant 等。

这很适合通用 agent OS，但并不自动适合 Pipiclaw。

Pipiclaw 当前最大的价值不是“什么都能做”，而是“在 DingTalk 长期运行这件事上足够稳”。

## 3. 全局式用户画像优先

Pipiclaw 当前的主语义是：

- workspace
- channel
- 当前运行环境

如果过早引入强全局用户画像，很容易把不同项目、不同群、不同团队语境混在一起。

这对企业协作工具来说风险很高。

## 4. 复杂的通用 cron/job 管理面

Pipiclaw 当前基于 `workspace/events/*.json` 的事件模型非常透明。

它的缺点是没那么“产品化”，但优点是：

1. 团队可直接版本管理
2. 文件即配置
3. 问题定位简单

在没有更强需求前，不应该因为 Hermes 有完整 cron 系统就急着重做这一层。

## 建议的演进顺序

## Phase 1：先建立“成长闭环”的最小骨架

目标：

1. 让 Pipiclaw 具备“建议沉淀方法”的能力
2. 不引入隐式自动写入
3. 不改变现有热路径

建议内容：

1. 新增 `skill_manage` 最小工具
2. 新增 post-turn reviewer，但只产出 suggestion
3. 让 reviewer 能识别 skill candidates

完成标志：

1. agent 能明确建议“这次任务值得沉淀成 skill”
2. skill 可写回 `workspace/skills/`
3. skill 能在后续会话中被正常加载

## Phase 2：补上 transcript 冷路径召回

目标：

1. 支持跨较长时间范围恢复历史上下文
2. 不让 transcript 扫描进入主热路径

建议内容：

1. 为 channel 冷存储建立 sidecar index
2. 新增 `session_search` 工具
3. 先做 channel-local，再考虑 workspace 范围

完成标志：

1. 用户提到“之前讨论过的事”时，agent 有明确工具可用
2. 输出是 focused summary，而不是 transcript dump

## Phase 3：把 suggestion-first 逐步升级为可控自动化

目标：

1. 让高价值沉淀更自动
2. 仍保持可解释、可审计

建议内容：

1. 对特定类型的 durable facts 允许自动写入 channel memory
2. skill 默认先写 draft，再由主代理确认 promote
3. compaction/new-session 前整合 promotion candidates

完成标志：

1. 成长闭环可以自动运行
2. 但所有沉淀资产仍然有明确来源和作用域

## 对现有设计假设的影响

这份文档不是要求推翻 Pipiclaw 现有设计，但它确实意味着有几条既有假设需要被重新表述。

### 1. memory RFC 需要做一次“受控扩展”

当前 memory RFC 中有几条非目标：

1. 不做 special memory tools
2. 不把 `log.jsonl` / `context.jsonl` 作为普通 memory source
3. 不引入 memory plugin

这些判断在今天仍然大体正确，但如果要引入 `session_search`，建议这样修订：

1. 保留“不把 transcript 当作普通热路径记忆源”
2. 明确允许“冷路径 transcript search tool”
3. 明确说明该工具不会自动注入每轮 prompt

也就是说，应该修的不是“是否允许 transcript 参与能力面”，而是“是否允许 transcript 进入普通 memory 语义”。

答案仍应是：

> 不允许 transcript 进入普通 memory 语义，但允许它成为显式冷路径检索源。

### 2. `skills/` 的语义要从“静态资源”升级为“可沉淀资产”

今天的 `workspace/skills/` 更像一组被动加载资源。

如果引入 procedural skill 闭环，建议把它升级成：

1. 可读
2. 可写
3. 可修补
4. 可审计

但这里仍然不建议直接升级成一个“插件市场”或“在线技能中心”。

对 Pipiclaw 来说，更合理的演进顺序是：

1. 先成为 workspace 内的可管理知识资产
2. 再考虑跨 workspace 共享
3. 最后才考虑更复杂的分发体系

### 3. 自动写回策略必须继续服从显式边界

如果后续真的允许自动沉淀，也建议继续坚持：

1. channel 的 durable facts 主要写回 channel 级记忆
2. reusable method 主要写回 workspace 级 skills
3. 不自动修改 workspace 级 `SOUL.md` 和 `AGENTS.md`
4. 不引入“系统偷偷修改全局人格/规则”的行为

这是 Pipiclaw 和通用 agent OS 的核心分水岭之一。

## 如何判断这些演进是否成功

如果未来真的沿这条路线推进，建议不要只看“功能做没做出来”，而要看下面几类信号。

### 1. 复用率指标

可以重点观察：

1. 新创建的 skill 在后续会话中被实际命中的比例
2. 被命中的 skill 是否减少了重复探索和重复用户纠偏
3. `session_search` 的调用后，是否显著减少“请用户重新描述上下文”的情况

### 2. 质量指标

可以重点观察：

1. 新增 skills 中有多少在后续被 patch
2. skill patch 的常见原因是什么
3. reviewer 的建议中，有多少最后被接受写回
4. 自动或半自动沉淀内容的误判率有多高

### 3. 热路径成本指标

必须明确跟踪：

1. 普通 turn 的首 token 时间是否明显变差
2. memory recall 热路径是否受到新增能力影响
3. 背景 worker 是否造成 channel 运行拥堵、资源竞争或日志噪声

### 4. 运维与安全指标

必须重点关注：

1. 自动生成 skill 是否引入危险脚本或错误命令
2. `session_search` 是否造成不必要的敏感信息暴露
3. reviewer 是否出现过度写回、错误写回、跨 channel 污染

如果这些指标无法被持续观测，那么所谓“成长闭环”就很容易退化成一个难以维护的黑箱。

## 对 Pipiclaw 架构的具体建议

为避免后续实现时偏离现有分层，建议按下面的域边界放置：

### `src/memory/`

适合放：

1. session index
2. session search
3. post-turn review 输出协议
4. durable promotion candidate 提取

原因：

- 这些能力本质上都在处理“长期上下文资产”

### `src/tools/`

适合放：

1. `skill_manage`
2. `session_search`

原因：

- 它们都应当成为显式能力面，而不是隐式 runtime 魔法

### `src/agent/`

适合放：

1. reviewer 触发策略
2. turn 后调度
3. 与 `ChannelRunner` 的集成

原因：

- 这些属于会话编排，而不是具体数据模型

### `workspace/`

建议继续作为所有长期沉淀资产的显式主容器：

1. `skills/`
2. `MEMORY.md`
3. `ENVIRONMENT.md`
4. `events/`
5. `sub-agents/`

这是 Pipiclaw 和 Hermes 路线最大的差异之一，也应继续保留。

## 一句话版本的产品判断

Hermes 的优势是：

> 它更像一个通用、自学习、外部资产驱动的 agent OS。

Pipiclaw 的优势是：

> 它更像一个面向 DingTalk 长期协作、分层清晰、边界明确、运行时可控的工作 runtime。

因此，Pipiclaw 最值得学习的，不是 Hermes 的“更大”，而是 Hermes 的“更闭环”。

对 Pipiclaw 来说，正确的演进方向不是：

> 把所有东西都做成 Hermes 那样。

而是：

> 在保持 workspace/channel 分层、热路径克制、安全边界清楚的前提下，把“长期沉淀方法”和“跨会话冷路径回忆”这两条能力补齐。

## 最终建议

如果只做一件事：

1. 做 workspace 级 procedural skill 闭环

如果做两件事：

1. 做 procedural skill 闭环
2. 做冷路径 session search

如果做三件事：

1. 做 procedural skill 闭环
2. 做冷路径 session search
3. 做 suggestion-first 的 post-turn reviewer

如果要明确一个长期原则：

> **Pipiclaw 应该学习 Hermes 的学习闭环，不应该学习 Hermes 的全局膨胀。**

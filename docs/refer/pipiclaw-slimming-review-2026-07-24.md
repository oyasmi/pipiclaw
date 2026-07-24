# Pipiclaw 架构瘦身审查报告

- 日期：2026-07-24
- 审查版本：0.8.9 工作树
- 审查目标：面向个人使用的、简洁可靠的瑞士军刀式 Agent
- 报告性质：架构与产品复杂度审查，不是缺陷清单，也不是立即执行的删除计划

## 1. 执行摘要

Pipiclaw 当前的主要问题不是代码质量差，也不是存在大量传统意义上的死代码，而是多个本身合理的机制长期叠加后，整体复杂度已经超过个人 Agent 的合理需求。

目前的产品形态接近：

> DingTalk Agent + 记忆系统 + 调度器 + 持久任务引擎 + 后台作业系统 + 子代理编排器 + 审批/验证工作流

这些机制分别有明确目的，也普遍有测试覆盖。但对个人 Agent 来说，系统已经逐渐从“可靠完成个人工作”走向“小型 Agent OS / 工作流引擎”。最大的可靠性风险不再只是单个函数错误，而是多个状态机、恢复路径、配置选项和自治机制组合后产生的状态空间。

本报告的核心建议是：

> 保留可靠的执行底座，削减自治机制的语义宽度。先删除能力和状态，再重构剩余代码。

优先保留：

- DingTalk 重连、消息去重和投递降级
- 每频道串行队列
- 原子持久化和 JSONL 冷日志
- 基础编码工具
- stop、steer、follow-up
- TUI
- 简单、明确的会话记忆

优先简化或删除：

- 高级持久任务治理
- 重叠的记忆维护管线
- 子代理中的验证、worktree 和多预算协议
- 当前会话内的工具/资源热替换
- 多套主动唤醒机制
- 自动生成 workspace skill
- RTK、bash interceptor 等低价值拦截层
- 到期的迁移和兼容别名

粗略估计，经过分阶段瘦身后，可以减少约 7,000～11,000 行生产代码，将当前约 3.3 万行收缩到约 2.2～2.6 万行。这个数字是方向性估算，不应作为硬性 KPI；更重要的指标是状态数量、配置数量、恢复路径和跨域依赖的减少。

## 2. 审查范围与方法

本次审查覆盖：

- `src/runtime/`
- `src/agent/`
- `src/memory/`
- `src/tasks/`
- `src/subagents/`
- `src/tools/`
- `src/security/`
- `src/web/`
- `src/tui/`
- 根级配置、入口和共享模块
- 测试、覆盖率、依赖和版本演进

采用的判断维度：

1. 功能是否符合个人 Agent 的核心定位。
2. 功能引入了多少持久状态、状态转换和恢复路径。
3. 功能是否与已有机制重叠。
4. 功能是否要求中央编排器理解过多领域语义。
5. 功能是否形成真正的可靠性或安全边界。
6. 功能是否能通过更简单的生命周期或固定策略实现。
7. 删除后是否会损害队列、重连、持久化等可靠性底座。

本报告与 `pipiclaw-deep-review-2026-07.md` 的视角不同。此前报告侧重能力完整性和运行治理，本报告专门从个人产品定位出发，评估这些能力是否值得继续由核心项目承担。

## 3. 当前基线

### 3.1 代码与测试

审查时的结果：

- 生产 TypeScript 约 33,000 行。
- `npm run deadcode` 通过。
- `npm run typecheck` 通过。
- `npm run test` 通过。
- 112 个测试文件、883 个测试全部通过。
- 总覆盖率约 81%。
- `src/agent/channel-runner.ts` 覆盖率约 34%。

代码按主要领域大致分布：

| 领域 | 生产代码行数 |
| --- | ---: |
| runtime | 约 6,300 |
| memory | 约 6,500 |
| tools | 约 5,100 |
| agent | 约 5,000 |
| security | 约 1,600 |
| subagents | 约 1,600 |
| shared | 约 1,600 |
| TUI | 约 1,200 |
| web | 约 1,100 |
| tasks | 约 1,000 |

任务相关实现还分散在 `shared/`、`tools/`、`agent/` 和 `runtime/` 中，因此仅按目录统计会低估其实际规模。

### 3.2 演进趋势

生产代码大致从 v0.6 的 1.4 万行增长到当前的 3.3 万行。增长最明显的区域包括：

- channel runner
- runtime bootstrap
- memory
- persistent tasks
- task commands
- background jobs
- subagent tool
- event administration

这说明当前复杂度主要来自功能和治理机制的持续累积，而不是代码腐化或无人引用的遗留文件。

### 3.3 测试揭示的结构性问题

883 个测试和约 81% 的总体覆盖率说明单个机制的实现质量较好。但中央编排器覆盖率明显偏低，说明大量经过单测的组件最终由一个难以穷举的协调层组合。

这类项目的可靠性瓶颈通常不是组件内部，而是：

- 机制之间的调用顺序
- 中途失败后的恢复顺序
- 多个游标和状态文件的一致性
- 多种配置组合
- shutdown、reload、compact、reconnect 的交叉行为

因此，继续增加组件单测不能替代减少机制数量和组合数量。

## 4. 核心判断

### 4.1 复杂度是“活的复杂度”

死代码检查通过，说明很难通过普通 unused export 清理获得大幅收益。

真正需要判断的是：

> 一段代码即使被引用、被测试、可以工作，是否仍值得成为个人 Agent 的长期产品能力？

应该以功能成本而不是引用关系决定去留。

### 4.2 Pipiclaw 正在承担工作流引擎职责

当前系统同时包含：

- 时间驱动事件
- 持久任务续跑
- 后台进程完成唤醒
- 独立验证器
- 审批状态
- 周期任务
- 任务依赖
- worktree 隔离
- 多维预算
- durable dispatch

这组能力更接近团队级自治执行平台。对于个人 Agent，它们造成的恢复、兼容和测试成本可能高于实际收益。

### 4.3 不应以删除可靠性底座换取行数

以下能力虽然实现不小，但不属于优先瘦身对象：

- DingTalk 重连
- 消息去重
- AI Card 失败后的降级
- 每频道串行化
- 原子写入
- 日志轮换
- 停止和 steering
- 基本故障恢复

这些是长期运行 Agent 可靠性的基础。应删除的是功能宽度和语义变体，而不是可靠性保护。

## 5. 重点审查

### 5.1 持久任务系统

当前 `task_manage` 支持：

- create
- progress
- candidate
- set
- verify
- done
- skip
- cancel
- list

任务控制还包含：

- priority、deadline
- parent、dependsOn
- isolation、sideEffects
- externalApproval
- attempt、token、cost、wall-time budget
- cycle usage、lifetime usage
- verification
- worktree
- recurring cycle
- pause ownership

这已经不再是一个简单任务列表，而是“受治理的自治工作单元”。

#### 建议

将核心任务模型收缩为：

```text
Task {
  id
  title
  status: todo | doing | blocked | done | cancelled
  nextAction?
  wakeAt?
  schedule?
  note?
}
```

从核心中移除：

- 父子任务和依赖图
- candidate → verify → done 生命周期
- 独立 verifier attestation
- worktree ownership
- token、cost、wall-time 多维预算
- recurring cycle 的独立核算
- task-specific approval 状态机

任务默认不应自动续跑。需要自治续跑的高级任务引擎如果仍有价值，应作为默认关闭的实验能力或独立模块，而不是所有用户都承担的核心概念。

#### 预期收益

- 减少 2,500～4,000 行生产实现。
- 大幅减少状态转换和测试矩阵。
- 降低 tasks、agent、runtime、subagents、tools 的跨域耦合。
- 让用户更容易理解任务为何运行、暂停或结束。

### 5.2 记忆系统

当前存在多套相邻的 LLM 维护流程：

1. SESSION.md 刷新。
2. MEMORY.md 持久化归纳。
3. growth review，抽取记忆和 skill 候选。
4. structural maintenance。

此外还有：

- recall
- candidates
- metadata
- tombstones
- review state
- failure backoff
- 多个维护游标和间隔
- 自动写 channel memory
- 自动写 workspace skill

这些功能都在处理同一份来源材料：对话、工具结果、当前会话状态和历史记忆。

#### 建议

合并为一个 Memory Checkpoint：

```text
消息与工具结果
    ↓
追加冷日志
    ↓
/new、/compact、shutdown、空闲阈值或显式调用
    ↓
一次 checkpoint 同时产生：
- 当前会话摘要
- 少量 durable memory 候选
```

保留：

- SESSION.md
- MEMORY.md
- HISTORY.md
- `log.jsonl` 和 `context.jsonl`
- `session_search`
- 显式 `memory_manage`

删除或合并：

- 自动写 workspace skill
- 独立 growth review
- 每轮 post-turn memory review
- 多套相互独立的 LLM 维护周期
- 非必要的 recall 统计元数据
- 如果没有明确恢复价值，简化 tombstone 和多游标机制

记忆的目标应该是：

> 追加日志保证不丢；少量 checkpoint 保证可用；显式操作保证可控。

而不是让 Agent 持续运行一个自维护知识库。

#### 预期收益

- 减少 2,000～3,000 行。
- 降低后台 LLM 调用和不确定写入。
- 减少 settings 中的阈值和时间参数。
- 提升记忆行为的可预测性。

### 5.3 Events、Tasks 与 Background Jobs

当前有三套主动唤醒来源：

| 机制 | 驱动方式 |
| --- | --- |
| Scheduled Events | 时间到达 |
| Persistent Tasks | 任务状态和续跑策略 |
| Background Jobs | 进程完成 |

三者都涉及：

- 持久化
- 重试
- 去重
- 恢复
- 通知
- synthetic event
- durable dispatch

#### 建议

底层只保留一个很小的 Durable Wake：

```text
Wake {
  id
  channelId
  source: event | job
  dueAt
  payloadRef
  attempts
}
```

上层概念保持简单：

- Event：时间驱动的提醒或定时提示。
- Job：进程驱动，完成后通知。
- Task：人类可读的工作状态，默认不驱动 Agent。

这里不建议再设计一个功能更强的“通用工作流框架”。统一的应当只是投递、重试和去重，而不是所有业务语义。

### 5.4 子代理

当前子代理调用可以控制：

- predefined 或 inline
- system prompt
- tools
- model
- max turns
- max tool calls
- wall time
- bash timeout
- isolated/contextual
- memory none/session/relevant
- paths
- purpose work/verify
- taskId
- shared/worktree
- worktreePath
- returns text/artifact
- thinking level

主 Agent 在每次委派时需要同时决定任务内容和一整套执行策略。

#### 建议

将调用面收缩为：

```ts
{
  task: string;
  role?: string;
  tools?: string[];
  model?: string;
}
```

其余采用固定内部策略：

- 默认隔离上下文。
- 固定最大轮数和超时。
- 始终保存完整输出。
- 超长响应统一返回文件引用。
- 不在子代理工具中承担 task verification。
- 不在子代理工具中管理 task-owned worktree。
- inline system prompt 与 predefined agent 两套方式应评估只保留一种。

子代理应该是委派工具，不应发展成第二套 runtime 管理界面。

### 5.5 热重载和 SDK 私有耦合

当前为了让 skill、tool 和配置在当前 session 内立即生效：

- Pipiclaw SettingsManager 被强制转换为 SDK SettingsManager。
- ChannelRunner 直接修改 SDK 私有字段 `_baseToolsOverride`。
- 运行时需要协调 prompt 与 resource reload。

#### 建议

- 工具、skill 和配置在 runner 创建时加载。
- `/new` 或明确 `/reload` 时重建 runner/session。
- skill 修改在下一 session 生效。
- 删除兼容 SDK SettingsManager 的空实现。
- 删除私有字段访问。

个人 Agent 没有必要为“资源修改后当前 session 立即无缝生效”承担长期 SDK 升级风险。

### 5.6 安全模型

当前 bash 最终在宿主机上通过 `sh -c` 执行。Command guard 会在执行前检查命令，但模式匹配不能构成完整的文件或网络隔离边界。

继续扩展正则和命令解析规则可能增加代码量，却仍无法形成真正的 capability boundary。

#### 建议

明确选择一种产品模式：

1. 可信个人模式：
   - 明确 bash 在宿主机执行。
   - Command guard 是误操作保护，不宣称为沙箱。
   - 高风险操作统一在工具执行边界审批。

2. 无人值守模式：
   - 使用真正的 workspace、容器或 OS 级隔离。
   - 在执行器边界限制文件和网络能力。

审批不应主要存在于任务完成状态机中。Task approval 更像“任务能否结案”，不一定能阻止 bash 已经执行外部副作用。

### 5.7 工具层

Pipiclaw 自行维护 read、bash、edit、write、grep 等基础工具，而上游 `pi-coding-agent` 已提供相似工具和可替换 operation。

#### 建议

评估复用上游工具定义，在 operation/executor 边界添加：

- 路径限制
- 命令保护
- 输出截断
- RecoverableToolError
- Pipiclaw 所需的 details

这项工作必须先做行为对照测试，不能仅因为名称相同就直接替换。若能复用，预计可以减少约 800～1,300 行重复叶子工具实现。

建议删除：

- RTK optimizer
- bash interceptor

两者都在 bash 主路径上增加转换或拒绝分支，但价值较窄。专用工具的 schema 和系统提示已经可以引导模型，不必继续用 bash 错误承担工具路由职责。

### 5.8 Web

Web 默认关闭，但仍带来约 1,100 行实现及 `jsdom`、`readability`、`axios`、代理相关依赖。

Web 对瑞士军刀 Agent 有直接价值，不建议整体删除。建议：

- 保留 `web_fetch` 和搜索。
- 根据本地使用数据收缩 provider 数量。
- 避免同时维护过多 fallback 和代理路径。
- 将 Web 作为粗粒度可选能力，而不是为每个细节提供配置。
- 是否用 Node 原生 fetch 替换 axios 应单独评估 DNS pinning、代理和安全行为，不作为首要瘦身项目。

### 5.9 TUI

TUI 虽然约有 1,200 行，但符合个人 Agent 的定位，并且是 DingTalk 不可用时的重要恢复入口。

建议保留：

- full-screen TUI
- plain mode

不应仅为了减少行数删除 TUI。

### 5.10 配置和公共 API

当前 settings 暴露了大量内部运行阈值，例如：

- memory refresh interval
- consolidation interval
- growth interval
- structural interval
- confidence threshold
- failure backoff
- task driver delay
- max dispatch per tick

#### 建议

用户配置只表达产品意图：

- 模型与 thinking level
- autonomy profile
- response mode
- Web provider
- 安全/审批模式

维护周期、并发数和内部阈值尽量成为代码常量。不要让用户承担算法调参责任。

可以考虑一个粗粒度自治档位：

```text
autonomy: off | reminders | full
```

但不建议为了支持档位再引入复杂插件框架。模块级开关足够。

当前 `src/index.ts` 暴露了大量内部实现。如果 Pipiclaw 的主要产品是 CLI/runtime，而不是第三方 SDK，应把公共入口缩到少数稳定 API，避免把内部重构变成兼容性问题。

## 6. 建议决策矩阵

| 决策 | 能力 |
| --- | --- |
| 坚决保留 | DingTalk 重连、消息去重、每频道串行队列、AI Card 降级、原子文件写入、JSONL 冷日志、基础编码工具、stop/steer/follow-up、TUI |
| 保留并简化 | 记忆、定时事件、Web、子代理、配置、响应模式、持久任务 |
| 默认关闭 | 自治任务续跑、后台长任务唤醒、高级子代理、自动记忆增长 |
| 建议删除 | 自动写 workspace skill、任务 verifier attestation、任务 worktree、任务依赖图、多维任务预算、RTK、bash interceptor |
| 0.9 删除 | 旧 home 迁移、旧 task schedule 迁移、deprecated 类型别名 |
| 根据使用数据决定 | rolling response mode、低使用率 Web provider、predefined/inline 子代理中的一种 |

## 7. 目标架构

建议把核心收敛到三个概念：

1. Turn：处理一次输入。
2. Memory：追加日志和 checkpoint。
3. Wake：未来某一时刻重新产生一次输入。

目标运行链路：

```text
DingTalk / TUI
      ↓
Channel Queue
      ↓
Turn Runner ─────→ Core Tools
      ↓
Delivery
      ↓
Append-only Log
      ↓
Memory Checkpoint

Event / Job Completion
      ↓
Minimal Durable Wake
      ↓
同一个 Channel Queue
```

Task 可以是 Memory 中的一种结构化记录，而不必拥有独立的自治执行操作系统。

建议的模块责任：

- runtime：transport、queue、delivery、wake、composition
- agent：单次 turn 生命周期
- memory：log、checkpoint、recall/search
- tools：薄工具定义和 capability boundary
- subagents：固定策略的委派

Agent 层不应直接依赖具体 DingTalk 实现；runtime 通过小型接口提供输入、投递和唤醒。

这里不建议引入抽象层级很多的通用框架。目标是减少具体机制，不是用更多接口包装同样的机制。

## 8. 实施路线

### 阶段 0：冻结和量化

时间建议：一个小版本。

- 暂停增加新的 task 状态和配置字段。
- 删除已经到期的迁移和 deprecated alias。
- 删除或永久关闭 RTK、bash interceptor。
- 关闭自动写 workspace skill。
- 增加仅保存在本地的功能使用计数。

建议记录：

- 工具调用次数及 action 分布。
- settings 偏离默认值的字段。
- task、event、job 的创建和完成数量。
- 子代理各模式使用次数。
- memory job 运行次数、产出量、失败和耗时。
- response mode 使用次数。
- Web provider 使用次数。

本地计数不是遥测，不应上传。连续观察约 30 天后，可以用实际数据决定低使用率能力的去留。

### 阶段 1：收敛记忆

- 引入单一 Memory Checkpoint。
- 兼容读取旧状态，但停止写入不再需要的 cursor/metadata。
- 删除 growth review 和自动 skill 生成。
- 合并 session refresh 与 durable consolidation。
- 收缩 settings 中的记忆参数。
- 增加 checkpoint 的端到端恢复测试。

### 阶段 2：降级任务与统一 Wake

- 将 task 降级为轻量持久待办。
- 默认取消 task 自动续跑。
- 用统一 Wake 承担事件和 job 完成后的重新投递。
- 删除 verifier、worktree、依赖图和多维预算。
- 提供一次性旧任务导出或迁移命令。
- 兼容窗口结束后删除旧格式，不长期维护双轨。

### 阶段 3：简化子代理与基础工具

- 将子代理参数缩到 task、role、tools、model。
- 固定上下文、超时、输出保存策略。
- 移除 task verification/worktree 集成。
- 建立与上游基础工具的行为对照测试。
- 能复用时，使用上游工具加 Pipiclaw operation wrapper。

### 阶段 4：删除热重载和私有 SDK 访问

- runner 创建时加载资源。
- `/new` 或 `/reload` 重建 session。
- 删除 `_baseToolsOverride` 私有字段访问。
- 删除 SettingsManager 兼容空实现和资源互斥逻辑。

### 阶段 5：最后拆分大文件

能力删除稳定后再拆分：

- `bootstrap.ts`：只负责 composition。
- `dingtalk.ts`：分离连接管理与 delivery。
- `channel-runner.ts`：分离 pre-turn、run、post-turn。
- 抽出 transport-neutral 的 TurnRequest、TurnResult、DeliveryPort、Wake。

不要先拆文件再删能力。那只会把同样的复杂度扩散到更多文件中。

## 9. 每阶段的验收指标

不应只以代码行数衡量。建议同时跟踪：

### 结构指标

- 生产代码总量。
- 配置字段数量。
- 持久状态文件种类。
- task 状态数量和 transition 数量。
- tool schema 字段数量。
- 跨领域 import 数量。
- 直接访问上游私有 API 的位置数量。

### 可靠性指标

- ChannelRunner 端到端覆盖率。
- reconnect 后重复投递率。
- shutdown/restart 后丢失 wake 数量。
- memory checkpoint 失败后的恢复成功率。
- 任务或事件的重复执行率。
- 普通请求 P50/P95 延迟。

### 产品指标

- 各工具及 action 的本地使用次数。
- 非默认配置使用率。
- 高级 task 功能使用率。
- 子代理高级参数使用率。
- 自动生成 memory/skill 被用户保留、修改或删除的比例。

某功能即使只有几百行，如果引入了新的持久状态和恢复路径，也可能比数千行纯 UI 更昂贵。

## 10. 删除原则

后续持续评审时，建议对每项能力询问：

1. 个人用户每月是否会实际使用？
2. 不提供它时，是否有简单的手动替代？
3. 它是否引入新的持久状态？
4. 它是否增加新的后台执行入口？
5. 它是否需要独立恢复和迁移？
6. 它是否与已有机制语义重叠？
7. 它能否用固定策略取代用户配置？
8. 它是否形成真实安全边界，还是只增加安全感？
9. 删除后是否会损害消息不丢、任务不重、进程可恢复等底座？

满足以下条件之一时，应优先删除或移出核心：

- 低使用率，但拥有独立状态机。
- 有简单手动替代。
- 只为非常高级的团队自治场景服务。
- 依赖上游私有 API。
- 需要多个配置参数才能正确工作。
- 与另一机制解决相同问题。
- 防护效果不能形成真实边界。

## 11. 风险与迁移原则

瘦身本身也可能损害可靠性。实施时应遵守：

- 先停止写旧格式，再删除旧格式读取。
- 持久数据提供导出或一次性迁移。
- 不长期保留新旧双轨。
- 删除任务自治前，保证已有 active task 不会静默丢失。
- 合并 Wake 时保持 at-least-once 投递和幂等键。
- 合并记忆时保留原始日志作为恢复来源。
- 替换上游工具前做行为和错误输出对照测试。
- 不为了降低代码行数删除 queue、reconnect、atomic write 等可靠性保护。

## 12. 最终建议

Pipiclaw 最有价值的资产不是高级工作流能力，而是已经形成的可靠运行底座：

- 长期在线
- 多频道隔离
- 消息串行处理
- 可恢复持久化
- DingTalk 投递体验
- 完整冷日志
- 稳定工具执行

后续产品方向应从：

> 能够编排所有 Agent 工作流

收回到：

> 能够可靠地完成个人工作，并在必要时被重新唤醒

真正的个人瑞士军刀不是拥有最多的开关和模式，而是常用能力足够强，每项能力只有一种清晰、可预测、容易恢复的工作方式。


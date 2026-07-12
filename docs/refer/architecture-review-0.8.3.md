# Pipiclaw 架构评估（v0.8.3）

> 评估基础：`docs/architecture.md`（as-implemented）+ 对 bootstrap / dingtalk / channel-runner 全文及记忆、任务、工具、安全各模块关键路径的通读。按"个人助手"定位校准，不按平台/企业标准。

## 结论

**这是一个工程纪律明显高于同类个人项目的代码库，真实水平在"资深工程师的生产级作品"档。** 并发被显式建模而非碰运气；LLM 成本有确定性门控；防御性细节（超时、死线、singleflight、原子写、0600、审计日志）覆盖完整；对 SDK 私有字段的越界访问都有注释和响亮的失败守卫——这些是多数个人项目根本不会做的。

主要风险**不是质量，是增生（accretion）**。当前架构复杂度已经顶到"一个进程、一个维护者"能舒服承载的上限：6 个配置文件、12+ 组设置、23 个记忆模块文件、4 类后台 job、一套任务治理体系。每一块单看都有道理，加在一起的维护税开始超过个人助手的真实收益。**下一阶段的架构工作应该以收敛为主、扩展为辅。**

分项：

| 维度 | 评级 | 依据 |
|---|---|---|
| 并发/一致性 | 优 | §5 队列表齐全；durable-dispatch、singleflight、原子写；但轮次状态所有权分散（见发现 1） |
| 分层与解耦 | 良 | ChannelContext 传输中立、工具注册表单一事实源；但轮次串行化仍住在传输层里 |
| 成本纪律 | 优 | gate 先行、sidecar 统一出口、账本无重复计数、未知命令零 LLM 短路 |
| 资源生命周期 | 中 | Runner 缓存只增不减，维护调度器会为历史频道复活完整 runner（见发现 2） |
| 复杂度/收益比 | 中 | 配置与记忆流水线的边际收益未被度量（见发现 3、4） |
| 可测性 | 优 | 纯函数 gate、可注入的 createXxx 工厂、记忆各单元独立测试 |

## 发现（按重要性排序，各附修法）

### 1. 轮次生命周期没有单一所有者

"一个频道当前是否在跑、忙时消息能否注入"这一件事，由四处状态共同回答：bootstrap 里 `ChannelState.running`、runner 里 `acceptingBusyMessages` + `agentLoopStarted`、SDK 的 `session.isStreaming`、以及传输层 `ChannelQueue` 的排队事实。症状很具体：`queueBusyMessage` 里同一个 "No task is currently running" 检查出现三次（`channel-runner.ts:697-724`）；bootstrap 里需要一段注释解释"必须在同一 tick 内同步置 running，否则第二条消息会被误路由"（`bootstrap.ts:789-794`）。这类靠注释守住的时序窗口，是未来并发 bug 最可能的出生地。

同一问题的另一面：**轮次串行化（`ChannelQueue`）住在 `dingtalk.ts` 里**，属于运行时策略却被绑在传输上，所以 TUI 只能在 `tui/turn-controller.ts` 里再实现一套轮次控制。CLAUDE.md 此前把 run-queue 误写成轮次队列，本身就是这个所有权模糊的旁证。

**修法**：做一次收敛性重构，不加新机制——
- 把 `running / stopRequested / currentTaskText / acceptingBusyMessages / agentLoopStarted` 合并为 runner 内一个显式状态机（`idle → setup → streaming → draining`），传输层只读；三处重复检查收敛为状态机上的一个判断。
- 把 `ChannelQueue` 从 `DingTalkBot` 提升到 runtime 层（durable-dispatch 旁边是自然位置），钉钉与 TUI 共用同一条轮次管道和忙时语义。

### 2. 记忆维护会为所有历史频道复活完整 Runner，且缓存永不淘汰

`MemoryMaintenanceScheduler` 的 `getRuntimeContext` 走 `getState(channelId)`（`bootstrap.ts:914`），而 `getState` 会**创建**完整的 `ChannelRunner`——含 AgentSession、SessionManager（读 context.jsonl）、工具集、子代理发现、settings manager。调度器发现频道的方式是扫 workspace 目录 + state 文件，于是**每个磁盘上存在过的频道，启动后若干个 tick 内都会常驻一个完整 runner**，且 `runner-factory` 的 Map 只在 shutdown 时清空。几个频道时无感；频道随时间累积后，这是稳定的内存与启动 I/O 增长曲线，而这些 runner 里绝大部分能力（工具、子代理、投递）维护路径根本不用。

**修法**：维护上下文只需要 messages / sessionEntries / model / settings，全部可从磁盘直接构造。给调度器一个轻量 loader（打开 SessionManager + settings，不建 Agent/工具/子代理），仅当频道已有活跃 runner 时才复用其内存态。顺带收益：shutdown 的 `flushInactiveChannelMemory` 不再遍历一堆本次启动从未说过话的频道。

### 3. 配置面持续膨胀，且"密钥级保护"被摊到非密钥文件上

6 个配置文件、每个一套 loader+diagnostics；`tools.json` 里已经积累了 grep / bashInterceptor / rtk / jobs / memory.save / sessionSearch / skills.manage / events / tasks 九个开关——这是"每加一个功能就加一个旋钮"的轨迹，对单用户而言绝大多数旋钮一生只会保持默认值。同时 0600 一刀切把 settings/tools/security 也当密钥文件管，掩盖了真正的边界：**只有 channel.json / auth.json /（可能的）models.json 含密钥**。

**修法**（下个 minor 做减法）：
- `tools.json` + `security.json` 并入 `settings.json`，形成"3 个密钥文件 + 1 个运行时配置"的稳定格局；loader 从三套减为一套。
- 立规矩：新功能不再默认新增配置项；确有需要时先硬编码默认值上线，等真实使用证明需要再开旋钮。

### 4. 记忆流水线的边际收益没有被度量，先量化再决定去留

recall（中文分词 + 意图门控 + LLM 重排）、inline 固化、四类后台 job（session-refresh / durable-consolidation / growth-review / structural-maintenance）、候选晋升信号——这是全项目最精巧也最厚的一层。基础三件（SESSION/MEMORY/HISTORY + 边界固化 + 词法召回）价值明确；但 growth-review 的技能建议、promotion-signals、structural-maintenance 属于"听起来有用"而缺少证据的部分，每一个都在消耗 sidecar 调用和维护心智。

**修法**：不猜，用已有的审计设施算账——review-log 记录了每次固化/维护的 actions 与 skipped，账本记录了每次 sidecar 花费。写一个一次性脚本按 job kind 统计近 30 天"LLM 花费 / 被采纳的动作数"；接近零采纳的 job 直接删除（gate、job、state 字段、测试一起删）。这与项目"gate 先行"的哲学同构：让数据决定机制去留。

### 5. 小额清理（顺手做）

- `task-driver.ts` 的 `hasLiveLegacyCheckin` 是 0.7.x→0.8 的升级兼容路径，迁移窗口过后整段删除。
- `dingtalk.ts` 用 `Reflect.get/set` 直接操纵 dingtalk-stream 的私有 socket/connected 字段并自建重连状态机。当前依赖精确锁版（2.1.5）+ 类型守卫，属于**已控风险**，不必现在动；但它意味着实际上你已经拥有整个连接状态机——若哪天 dingtalk-stream 升级成为需求，正确方向是彻底接管（直接持有 WebSocket），而不是继续在库的私有字段上叠补丁。
- `_baseToolsOverride` 私有字段访问已有响亮守卫，保持现状，等上游给公开 setter。

## 不建议做的事

与发现同等重要——这些方向看似"架构升级"，对本项目是负资产：

- **不要**引入进程外组件（数据库、消息队列、独立 worker 进程）。文件 + 进程内队列在单用户规模下正确且足够，可调试性远高于任何"更正规"的替代。
- **不要**为多传输/多 IM 做抽象预投资。ChannelContext 这一层解耦已经存在且够用，第三个传输真出现时再说。
- **不要**继续加后台 job 种类。四类是上限，新的记忆想法应该先竞争替换现有 job，而不是并列追加。

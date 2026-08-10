# Sub-agent 二轮审查：生命周期已闭环，契约仍在两处分叉

日期：2026-08-10
审查基线：`8070148`（`feat: refine sub-agent roles and harness argument mapping`）
上一轮：[`subagent-chain-review-2026-08-09.md`](./subagent-chain-review-2026-08-09.md)（基线 `1e9d333`）
范围：spec 040 全链路 —— 角色发现、调用面、内置执行、外部 harness、run 生命周期、结算与恢复、写锁、唤醒与任务衔接、用量、人侧命令、文档与测试。

本轮验证：`npm run check` 通过（lint + typecheck + knip + 135 files / 1079 tests）。文中每条结论都给了 `file:line`；标注"实测"的项另外跑了针对性探针。

## 结论

上一轮的三条发布阻断项**基本收敛了**，而且收敛的方式是对的：不是打补丁，是把缺的机制真做出来了 —— OS 可核实的进程身份（`pidStartedAt`）、持久化的 `deadlineAt`、周期性 `sweep()`、restore 重建 lease、`await restoreAllSubAgentRuns()` 先于开放准入、结算前置的 required persist + 回滚、外部路径共享内置的任务信封。这条链路现在可以说"重启安全"了。

剩下的问题换了性质。它们不再是"机制缺失"，而是**同一个机制有多个实现，实现之间在慢慢分叉**：

1. **结算输入被构造了三次**（内置、外部活进程、重启对账），三份的信息量不同 —— 跨重启结算的 run 会丢用量、丢验收结论、算错时长。
2. **"不静默忽略"这条纪律只在 frontmatter 面被执行**，调用面和 `follow_up` 面各有一批字段被默默吞掉。
3. **文档描述的边界与代码实际的边界已经错位**，其中一条是数据外发（外部进程会收到频道记忆），文档明确说它不存在。

这些都不是发布阻断，但它们是"下一次审查会变成 P0"的东西。现在动手最便宜。

## 一、上一轮遗留项的收敛核验

| 上轮编号 | 结论 | 证据 |
|---|---|---|
| P0-1 外部 run 重启接管 | **已收敛** | stdout/stderr 直接落 fd（[external/run.ts:191](../src/subagents/external/run.ts#L191)）；`pidStartedAt` 身份核验（[runs.ts:772](../src/subagents/runs.ts#L772)）；`deadlineAt` 持久化 + 30s `sweep()`（[runs.ts:894](../src/subagents/runs.ts#L894)）；restore 重建 lease（[runs.ts:734](../src/subagents/runs.ts#L734)）；adopted run 可被 cancel 杀掉（[runs.ts:655](../src/subagents/runs.ts#L655)）；bootstrap **await** restore 后才 `bot.start()`（[bootstrap.ts:700](../src/runtime/bootstrap.ts#L700)） |
| P0-2 结算分阶段恢复 | **部分收敛** | 终态字段 required persist + 失败回滚已做（[runs.ts:499](../src/subagents/runs.ts#L499)）；wake 阶段可在 restore 补做（[runs.ts:756](../src/subagents/runs.ts#L756)）。**未做**：usage/archive 阶段没有任何恢复路径；`UsageLedgerEntry.runId` 自称"幂等键"却从未被 `record()` 或 `summarize()` 消费（[ledger.ts:34](../src/usage/ledger.ts#L34)、[ledger.ts:143](../src/usage/ledger.ts#L143)） |
| P0-3 内外共享任务信封 | **首发收敛，续接未收敛** | 首发路径已注入 runtime 路径、context blocks、verify 协议（[tool.ts:769](../src/subagents/tool.ts#L769)）；`follow_up` 只补了 verify 协议（[subagent-manage.ts:177](../src/tools/subagent-manage.ts#L177)），见 §2.8 |
| P1-1 cancel/timeout 词汇 | **已收敛** | `terminationReason` 持久化于杀进程之前（[runs.ts:456](../src/subagents/runs.ts#L456)）；launch 窗口的补杀（[external/run.ts:262](../src/subagents/external/run.ts#L262)）；内置显式取消结算为 `cancelled`（[tool.ts:1173](../src/subagents/tool.ts#L1173)） |
| P1-2 follow-up 能力快照 | **部分收敛** | harness 不匹配、`shell: true`、角色不可用、无 sessionId 均已硬性拒绝（[subagent-manage.ts:128-156](../src/tools/subagent-manage.ts#L128)）。仍**没有** invocation snapshot：`command` / `model` / `systemPrompt` / `maxWallTimeSec` / `mutates` 全部取热加载后的当前角色 |
| P1-3 schema/spec/文档漂移 | **大部分收敛** | 外部 `effort` 独立表（[discovery.ts:67](../src/subagents/discovery.ts#L67)）；`max` 档位补齐；spec 状态改 `PARTIALLY IMPLEMENTED` 并列出三条有意偏差；`exec` 截断带可执行提示（[exec.ts:41](../src/subagents/external/exec.ts#L41)）。**新漂移**见 §2.3、§2.11 |
| P1-4 可观测数据误导 | **大部分收敛** | `durationMs` 用真实进程时长；终态记录清空 `leaseKey`（[runs.ts:508](../src/subagents/runs.ts#L508)）；`costKnown: false` 不显示 `$0`（[format.ts:25](../src/subagents/format.ts#L25)）；新增 `/subagents output`。**未做**：`parserVersion` / `cliVersion` 仍未入 run |
| P1-5 错误类型 | **已收敛** | 参数、角色、状态、准入、lease 冲突统一 `RecoverableToolError`（[tool.ts:690-758](../src/subagents/tool.ts#L690)） |

## 二、本轮发现

### 2.1 结算输入被构造三次，跨重启的那次信息最少（最值得先修）

`SettleInput` 现在有三个构造点：内置（[tool.ts:1133](../src/subagents/tool.ts#L1133)）、外部活进程 watcher（[external/run.ts:352](../src/subagents/external/run.ts#L352)）、重启/sweep 对账（[runs.ts:869](../src/subagents/runs.ts#L869)）。D4 的**状态判定**被抽成了共享的 `classifyExternalOutcome`，但**结算输入的构造**没有被抽共享，于是三份实现在各自演化。第三份已经落后：

- **用量被丢弃，却仍标"已知"**。对账路径写 `usage: record.usage`（注册时的全零）但 `usageKnown: outcome.usageKnown`（claude-code 解析成功时为 `true`）。于是一个跨 daemon 重启完成的 claude-code run，在 `/usage` 里是 0 token、`$0.00`，而且**不会**被计入 `unknownCostCount` —— 它宣称自己是已知的零。解析出来的 `outcome.usage` 就在手边，只是没被用（[runs.ts:875](../src/subagents/runs.ts#L875)）。
- **验收结论整段缺失**。`reconcileExternalRun` 没有 verify 分支。一个 `purpose=verify` 的外部 run 若跨重启完成，就不会写 attestation、不会有 `verificationVerdict`、唤醒文本里没有 `Verdict:` 行、`task_manage verify` 无从导入 —— 受治理任务的验收在一次重启后静默消失。根因是 `verifySubjectBefore` 只活在活进程 watcher 的闭包里（[external/run.ts:104](../src/subagents/external/run.ts#L104)），从未持久化，所以对账路径**没有能力**补做这件事。
- **时长算错**。对账用 `Date.now() - record.startedAt`，把 daemon 停机时间算进了进程耗时。

**建议**：把 `outcome → SettleInput` 抽成一个函数，把 verify 后处理（subject 比对 + attestation 写入）抽成第二个，两条外部路径都只调用它们；同时把 `verifySubjectBefore`、`maxWallTimeSec` 写进 run 记录，让重启后的对账拥有和活进程同样的事实。

### 2.2 占位符值缺失时会泄漏成字面量 argv（实测确认）

`expandPlaceholders` 只在值 `!== undefined` 时替换（[harness.ts:167](../src/subagents/external/harness.ts#L167)）。角色写了 `command: claude --model $MODEL` 但没写 `model:` 时，实际执行的是：

```
["claude","--model","$MODEL","-p","--output-format","stream-json","--verbose","--append-system-prompt-file",...]
```

（本轮实测输出，未经修改。）`$EFFORT` 同理。D4 之所以坚持 argv 而不是 shell 字符串，理由原文是"引号处理出错的后果是执行一条与设计不同的命令"—— 这里正是同一类失败，只是换了个入口。

**建议**：值缺失时删除该 token（含成对的前置 flag），或在 discovery 阶段就驳回带未定义占位符的 `command`，产生 warning。后者更符合"配置错误应该在目录里可见"。

### 2.3 调用面对外部角色仍在静默忽略字段

P2 原则写的是"对某种 runtime 无意义的字段一律驳回，不静默忽略"。这条在 frontmatter 面执行得很干净，在**调用面**完全没有执行：

| 调用参数 | 外部角色上的实际行为 | 位置 |
|---|---|---|
| `tools` | 静默忽略（外部路径固定传 `tools: []`） | [tool.ts:788](../src/subagents/tool.ts#L788) |
| `model` | 静默忽略，且**先去 `models.json` 解析**，解析不到就拒绝这次委派 —— 一次与该角色完全无关的失败 | [discovery.ts:807](../src/subagents/discovery.ts#L807) |
| `returns: "artifact"` | 提示词里注入了 ARTIFACT 协议（[tool.ts:515](../src/subagents/tool.ts#L515)），但外部结算路径从不解析 marker —— 让外部 Agent 遵守一个没人读的协议 | [external/run.ts:352](../src/subagents/external/run.ts#L352) |

frontmatter 面也漏了一格：`FIELDS_REJECTED_FOR_INTERNAL` 只含 `harness` / `command`（[discovery.ts:491](../src/subagents/discovery.ts#L491)），而 spec D5 的矩阵要求内置角色的 `shell` / `env` 同样驳回，实际是静默忽略。

**建议**：把 capability matrix 变成代码里的一张表（字段 × runtime → `implemented` | `rejected`），由 `resolveSubAgentConfig` 统一驳回并由一个遍历该表的测试守住。这也顺带解决"文档表格与实现漂移"的长期成本。

### 2.4 `mutates` 推定忽略 `bash`，写锁的保护面比文档宣称的窄

`inferMutatesFromTools` 只看 `write` / `edit`（[discovery.ts:498](../src/subagents/discovery.ts#L498)），而内置默认工具集是 `read,bash`（[discovery.ts:15](../src/subagents/discovery.ts#L15)）。于是：

- 默认内置角色和所有 inline 委派都被推定为 `mutates: read`，**不取写锁**；
- `examples/sub-agents/git-committer.md` 这种 `tools: read,bash` 却会 `git commit` 的角色，同样不取锁；
- docs 里"runtime 保证**委派之间**不并发写同一棵树"这句话，因此在最常见的内置角色上并不成立。

文档已经诚实地写了"`mutates` 不是安全边界"，但没写"它作为**并发正确性**依据也一样弱"。这两件事需要分开说。

**建议**：二选一 —— 把 `bash` 计入推定（代价：更多角色取锁，可能误伤只读脚本类角色），或者在 `docs/sub-agents.md` 与 `agent-delegation.md` 里如实收缩这句承诺。倾向前者：一个能跑任意命令的角色，声明自己不写，本来就是一句无法核实的话。

### 2.5 lease 按 key 释放，不校验持有者

`releaseWorkspaceLease(key)` 直接 `leases.delete(key)`（[workspace-lease.ts:70](../src/subagents/workspace-lease.ts#L70)）。两个后果：

- restore 时重建 lease 失败只记一条 warning 就继续（[runs.ts:740](../src/subagents/runs.ts#L740)），但这个 run 结算时照样会 `releaseWorkspaceLease(record.leaseKey)` —— **把真正持有者的锁删掉**。
- restore 重建成功时不会把 `rebuilt.leaseKey` 写回记录。若 `realpath` 结果发生漂移（目录被替换、符号链接改向），锁就泄漏到进程生命周期结束，此后该目录上的所有写委派永久被拒。

**建议**：`releaseWorkspaceLease(key, runId)` 校验归属后再删；acquire 成功后把 leaseKey 回写记录。

### 2.6 外部派发失败仍然告诉模型"已派发，去结束回合"

`launchExternalRun` 在三条失败路径上都自行 settle 后 **返回 void**：产物文件打不开（[external/run.ts:176](../src/subagents/external/run.ts#L176)）、spawn 失败（[external/run.ts:196](../src/subagents/external/run.ts#L196)、[:211](../src/subagents/external/run.ts#L211)）、spawn 前被取消（[external/run.ts:160](../src/subagents/external/run.ts#L160)）。调用方看不出区别，无条件返回 `[Dispatched] ... Status: running ... end this turn`（[tool.ts:809](../src/subagents/tool.ts#L809)）。

前两条会补发一次 failed 唤醒 —— 代价是白烧一个主代理回合，用户先看到"已派发"再看到"失败"。第三条用 `announce: false`，**永远不会有唤醒**：模型被告知去等一个不会到来的结果。

`ENOENT` 这条路径并不罕见：discovery 的可用性检查只是 `PATH` 上的 `existsSync`（[discovery.ts:481](../src/subagents/discovery.ts#L481)），权限不足、包装脚本 shebang 失效、PATH 在 daemon 与登录 shell 之间不一致，都会走到这里。

**建议**：`launchExternalRun` 返回一个结果对象，工具在同一回合如实返回失败（并带上安装/排查指引，符合 AGENTS.md 的错误契约）。

### 2.7 审计事件写在准入之前

`external-agent` 审计事件（严格落盘、不受 `audit.logBlocked` 影响，设计正确）写在 [external/run.ts:124](../src/subagents/external/run.ts#L124)，而并发上限的准入检查在其后的 `runManager.register()`（[runs.ts:339](../src/subagents/runs.ts#L339)）里。上限触发时，审计日志里会留下一条"已派发"的完整 argv 记录，而进程从未存在。

D8.1 定义这条事件的语义是"记录**被执行**的动作"。顺序应为：准入 → 审计 → spawn。

### 2.8 `follow_up` 与首发路径的三处不一致

- **信封不同**：只补 verify 协议（[subagent-manage.ts:177](../src/tools/subagent-manage.ts#L177)），缺 runtime context、context blocks，尤其缺**新的 artifact 目录路径** —— 外部 Agent 不知道该往哪写产物。
- **准入不同**：原 run 是 `purpose=verify` 时，若角色已被改成 `mutates: write`，`follow_up` 会照常取锁并派发（[subagent-manage.ts:163](../src/tools/subagent-manage.ts#L163)）；首发路径对同一情形是硬性拒绝（[tool.ts:726](../src/subagents/tool.ts#L726)）。verify 也不该取锁。
- **路径拼接脆弱**：`record.artifactDir.replace(/[^/\\]+$/, newRunId)` 是字符串外科手术，应为 `join(dirname(artifactDir), newRunId)`。另外 `workspaceDir ?? ""`（[subagent-manage.ts:208](../src/tools/subagent-manage.ts#L208)）会让审计日志落到进程 cwd 下的 `.pipiclaw/security.log`、verify 任务路径拼成 `/<channelId>/tasks/...`。生产装配总是传值，但默认值给错了方向 —— 它应该是必填。

### 2.9 GC 只在重启时跑，产物无保留策略

`collectGarbageIfExpired` 只在 `restore()` 内被调用（[runs.ts:762](../src/subagents/runs.ts#L762)、[:908](../src/subagents/runs.ts#L908)）。长期在线的 daemon 里，终态记录在内存与 `state/subagent-runs/` 中只增不减，`subagent_manage op=list` 与 `/subagents list all` 的输出随之无界增长（两者都没有条数上限，前者还把完整 `RunRecord[]` 放进 `details`）。spec 的偏差表已承认 `subagent-artifacts/` 下的 `events.jsonl` / `stderr.log` 无限期保留 —— 一个跑满的 codex 会话 events 可以到几十 MB 量级。

**建议**：把 GC 挂进现有的 30s sweep；给辅助产物一个保留窗口（`output.md` 与 attestation 随记录保留，其余按 24h 清），这正是 spec 原本承诺的行为。

### 2.10 `killProcessGroup` 的 300ms 宽限对 coding agent 太短，且在正常退出时也被无条件调用

[host-process.ts:52](../src/shared/host-process.ts#L52)：SIGTERM → 300ms → 无条件 SIGKILL。D10.3 承诺"预算耗尽不丢弃已有产出"，但 300ms 里 claude / codex 基本来不及 flush 终态事件和最后一段助手文本 —— 于是超时结算几乎必然拿不到部分产出，落回 `失败且无输出`。

同一个函数还在**每次正常退出后**被无条件调用（[external/run.ts:280](../src/subagents/external/run.ts#L280)）。注释解释得有道理（leader 先退、后代还在），但代价是每次结算固定多 300ms，并且给一个可能已被复用的 pgid 发信号。

**建议**：按场景分开 —— 正常退出后走"探活，活着才 TERM"；取消/超时给秒级宽限（5s 量级）再 KILL。

### 2.11 外部进程会收到频道记忆，而文档明确说它不会

`docs/sub-agents.md` 写着"外部角色没有这两个字段（`contextMode` / `memory`）—— 它自己会读取目标仓库的 `CLAUDE.md` / `AGENTS.md` 建立上下文"，调用参数表里 `context` 也标着"仅内置"。实际上：discovery 为外部角色解析 `contextMode` / `memory` / `paths`（[discovery.ts:636-643](../src/subagents/discovery.ts#L636)），首发路径对内外一律调用 `buildContextualBlocks`（[tool.ts:769](../src/subagents/tool.ts#L769)）。

这是 P0-3 修复的正确副产品 —— 外部角色本来就该拿到 `context` / `paths`。但它的后果需要被明说：一次 `context: relevant` 的外部委派，会把 `SESSION.md` 摘要与召回的 `MEMORY.md` / `HISTORY.md` 片段写进 `prompt.txt`，交给第三方 CLI，进而交给第三方 API。**这是一条真实的数据外发路径，而当前文档说它不存在。**

**建议**：文档如实描述并把它写进"授权与安全边界"一节；`/subagents roles <name>` 对外部角色也显示 `contextMode`/`memory`（目前只在内置分支显示，[subagent-commands.ts:293](../src/runtime/subagent-commands.ts#L293)）。是否再加一道"外部角色默认 `memory: none`"的保守缺省，值得单独决定 —— 但无论怎么选，文档不能继续说这条路不存在。

### 2.12 CLI 契约零真实验证

spec 的测试节要求"每个 harness 一个 opt-in 真实冒烟，防 CLI schema 漂移"。`test/e2e/` 里没有任何 harness 用例。当前 `claude-code` / `codex-cli` 的 argv 与事件 schema 全部由自写 fixture 断言 —— 测试在证明代码与自己一致，不在证明它与真实 CLI 一致。

这在解析侧尚可容忍（`parseOutcome` 禁止抛异常、无终态永不判成功，失败会降级）；在 **argv 侧不可容忍**：一个不存在的 flag 会让该角色的**每一次**委派立刻失败，而目前没有任何先于用户发现它的手段。上一轮建议的"把 CLI version / parser version 记进 run"也仍未做，运维因此分不清"Agent 失败"与"适配器过期"。

### 2.13 其他

- **坏文件会吃掉同名的好角色**：`knownNames.add(name)` 在校验之前（[discovery.ts:736](../src/subagents/discovery.ts#L736)）。按文件名排序在前的那个先占名；若它随后校验失败，同名的合法角色会被判"duplicate ignored"而一并丢失。注释写的是相反的意图。
- 同步 IO：`resolveRunWorkingDirectory` 用 `existsSync` / `statSync`（[tool.ts:277](../src/subagents/tool.ts#L277)），在 daemon 事件循环上。
- 外部 spawn 后没有 `child.unref()`（spec D1 明确要求）。目前被 `process.exit(0)` 的关停路径掩盖（[bootstrap.ts:863](../src/runtime/bootstrap.ts#L863)），但对 TUI 与测试进程仍是一个"退不出去"的隐患。
- `restoreChannelJobs` 仍是 `void`，与已改为 `await` 的 `restoreAllSubAgentRuns` 不一致（[bootstrap.ts:688](../src/runtime/bootstrap.ts#L688)）。同一条准入竞态，只修了一边。

## 三、结构性观察

1. **"统一 run"统一到了状态字段，没统一到行为。** 三个 `SettleInput` 构造点、两个 verify 后处理点、两个 argv 组装入口（`shell: true` 绕开 harness）。分叉不是设计意图，是缺共享缝的自然结果。§2.1 是这条的具体代价。
2. **"不静默忽略"是本 spec 最好的纪律，但只在一个面上被执行。** 它需要一张可执行的表来承载，而不是分散在三个函数里的 `if`。
3. **`mutates` 一个声明、三处消费，但三处的可信度不同。** 审计消费的是"自述"，够用；verify 准入消费的是"自述"，配合 subject hash 尚可；写锁消费的却是"推定"（内置漏 bash）或"自述"（外部无法核实），而它承担的是**正确性**保证。文档只声明了它不是安全边界，没声明它作为并发保证同样薄。
4. **重启后的事实比运行中的事实贫瘠。** 这是 §2.1 的根因：活进程 watcher 的闭包里攒了一堆没被持久化的东西。判断标准应该反过来 —— 凡是结算需要的输入，都必须在 spawn 时就落盘。
5. **agentmux 的能力吸收得很干净，但逃生舱一并收窄了。** harness 硬编码在 registry 里，新增一个 = 改代码 + 发版；`exec` 是唯一通用出口，却被禁止 verify、无 usage、且是唯一允许 `shell: true` 因而绕过全部协议组装的路径。这些取舍 spec 都论证过，只是需要在文档里写清"扩展 harness 不是配置行为"。

## 四、测试缺口

现有 12 个 sub-agent 测试文件对 parser、正常 spawn/settle、单进程 cancel/timeout、准入上限、lease 冲突、重启接管与超时执行覆盖扎实（`test/subagent-restart-adoption.test.ts` 尤其对上一轮 P0-1 是真回归）。缺口集中在本轮发现的方向：

1. adopted run 的 **usage / verify verdict / duration** 断言 —— 目前 `subagent-restart-adoption.test.ts` 只断言状态与 failureReason，一条 usage 断言都没有。
2. spawn 失败、cancel-before-spawn 的**工具返回值**断言（现只断言 run 状态，不断言模型看到了什么）。
3. 占位符值缺失时的 argv 断言（当前所有占位符用例都提供了值）。
4. 调用面 `tools` / `model` / `returns` 作用于外部角色时的行为断言（期望：驳回）。
5. lease 释放的归属校验、restore 冲突场景。
6. 每 harness 一个 opt-in e2e 冒烟（spec 已要求，未实现）。
7. 记录量大时 `/subagents list all` 与 `subagent_manage op=list` 的输出边界。

## 五、建议的收敛顺序

**第一梯队 —— 正确性（都很小，建议一次做完）**

1. 抽共享的 `outcome → SettleInput` 构造与 verify 后处理；把 `verifySubjectBefore` / `maxWallTimeSec` 落盘（§2.1）。
2. 占位符值缺失时删除 token 或 discovery 驳回（§2.2）。
3. `releaseWorkspaceLease` 校验归属；acquire 后回写 leaseKey（§2.5）。
4. `launchExternalRun` 返回结果，派发失败在同一回合如实返回（§2.6）。

**第二梯队 —— 契约诚实**

5. capability matrix 落到代码 + 测试遍历，消掉调用面与 internal 侧的所有 silent ignore（§2.3）。
6. `follow_up` 对齐首发的信封与准入（§2.8）。
7. 记忆外发如实写进文档，`/subagents roles` 对外部角色展示 context 字段（§2.11）。
8. `mutates` 与 `bash` 的关系：收紧推定，或如实收缩并发承诺（§2.4）。

**第三梯队 —— 运维与信心**

9. GC 挂进 sweep + 辅助产物保留窗口（§2.9）。
10. kill 宽限按场景分离（§2.10）。
11. 审计写在准入之后（§2.7）；`restoreChannelJobs` 改 await（§2.13）。
12. 每 harness 一个 opt-in e2e 冒烟；CLI version / parser version 入 run（§2.12）。

## 最终判断

上一轮问的六个问题 —— 谁在跑、谁能写、该不该停、结果是什么、账记过没有、该不该叫醒主 Agent —— 现在有五个半有了可恢复、可测试的答案。"账记过没有"是那半个：同进程内不会重复计费，但跨重启的那一路会**少记**，而且少记时还宣称自己记准了。

这一轮的问题形状变了，也说明主干是对的：不再是"机制不存在"，而是"同一个机制有三份实现"。这类问题的特点是每一处单看都很小、都能忍，但它们会稳定地互相拉开距离 —— 现在三份实现的差距还只是"用量和验收结论"，再放一轮就会变成没人敢重构的三条独立代码路径。

**趁差距还小的时候把缝合上，比继续加 harness、加角色、加编排更值。**

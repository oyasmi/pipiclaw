# 异步委派与外部智能体：把 sub-agents 做成内外统一的主路径

| 字段 | 值 |
|------|------|
| 状态 | PARTIALLY IMPLEMENTED（2026-08-09 审查后收敛；与本文档的偏差见下方"与实现的偏差"） |
| 日期 | 2026-08-08 |
| 前置 | 002 subagent、031 wake-layer-hardening（D6 后台作业）、032 subagent adoption、033 workspace-subagents-only、034 subagent invocation surface、036 task governance slimming |
| 关联实现 | `src/subagents/`（新增 `runs.ts`、`workspace-lease.ts`、`external/`）、`src/agent/job-manager.ts`、`src/shared/host-process.ts`（新增）、`src/security/`、`src/tasks/`、`src/usage/ledger.ts`、`src/runtime/store.ts`、`src/runtime/bootstrap.ts`、`src/runtime/`（`/subagents` 命令）、`src/agent/prompt/sections.ts`、`src/playbooks/agent-delegation.md`、`docs/sub-agents.md`、`examples/sub-agents/` |

## 背景

外部 AI Agent 委派（Claude Code、Codex CLI）目前走的是 `agentmux` CLI + 配套 skill + `~/.config/agentmux/config.yaml` 三件套。它能工作，但暴露了两个症状：

1. **装配成本高**：用户要装二进制、装 skill、写 YAML，还要让 pipiclaw 知道这套东西存在。
2. **路由错误**：主代理听到"派发任务"时优先选内置 subagent，即使任务明显是重型编码工作。

第二个症状常被归因为"提示词没写清楚"，但那是误诊。真正的原因是：**同一个动作"委派"，在 pipiclaw 里被放在了两个不同的抽象层级上。** 内置委派是一个有 schema、有 `details` 契约、每回合都在场的 typed tool；外部委派是一段 prose，`src/playbooks/agent-delegation.md` 把它写死了：

> Pipiclaw 不假设第三方 Agent 工具的命令、状态协议或检测脚本；外部 Agent 优先遵循用户提供的 skill。

模型选内置不是判断失误，是按激励梯度做的正确选择——一个契约明确、失败可恢复、结果结构化的工具，对比一段要求它自己拼命令、自己判断状态、自己设计 recovery plan 的说明。任何"请优先用外部"的提示词修补都改不动这个梯度，只会制造摇摆。

因此本 spec 的目标不是补提示词，而是**把外部委派提升到与内置同一个抽象层级**，并顺带修掉内置委派长期存在的一个缺陷：`effort: deep` 的同步子代理会独占 channel 长达 900 秒。

## 五条设计原则

### P1 统一"选人"，不统一"执行"

内置 subagent 是**回合内的同步工具调用**（`tool.ts` 里 `await worker.waitForIdle()`）；外部重型 agent 是**跨回合存活的长作业**，正常量级几十分钟。把后者伪装成阻塞式工具调用只有两个结局：一个 channel 被 ChannelQueue 独占 40 分钟，或者设个内部超时——于是**一次成功的长跑被报告成失败**。

所以统一的是：一个目录、一套选人依据、一个工具名、一套调用词汇、一套产物与台账契约。不统一的是：谁在执行、受谁的 guard 管、能不能 resume、重启后能不能捡回来。

### P2 封装不能撒谎

有些差异是**责任边界**，抹掉它等于把责任悄悄转移给不知情的调用方。必须留在明面上的：安全边界、成本账本、工作目录的爆炸半径、`purpose=verify` 的执行强度。配套的实现纪律是：**对某种 runtime 无意义的 frontmatter 字段一律驳回，不静默忽略**——有人在外部角色上写 `tools: read,bash`，会真心以为约束住了什么。

### P3 一次委派 = 一个短命进程

这是让外部传输层从"三套协议状态机"塌缩成"一套进程模型 + 三个解析器"的关键。见 D3。

### P4 安全与便捷是跷跷板，按性价比取舍

Pipiclaw 是个人项目，可以接受安全性上的妥协，**不为绝对安全引入复杂度**——尤其不引入让配置变复杂、让日常使用多一步、让实现多一层的措施。因此本 spec 对安全类建议一律按"成本 / 收益"评估，只采纳廉价且真正封住路径的那些（例如复用既有 `writeDeny` 手法、多写一条审计），驳回昂贵或只提高攻击成本一个档次的那些（例如额外的信任闸门、角色目录停止热加载）。被驳回的部分不掩盖，写进"已驳回"表和风险清单。

### P5 一个持久化标记只保护一个不可重放的副作用

审查提出把 run 拆成 `launch / settlement / usage / wake / inlineDelivery` 五维状态机。方向对，粒度过了：多数维度可从既有字段推导，凭空多出的状态只会制造需要同步维护的不变量。真正需要持久化的判据只有一条——**这个副作用重放一次会不会造成真实伤害**。据此本 spec 只引入三个幂等标记（D1），不是五个维度。

## 设计

### D1 run 是一等公民：一套生命周期，内外共用

每次委派——无论内置还是外部——都产生一个 **run**：稳定的 `runId`、持久化记录、状态机、产物目录。

状态机直接复用 `job-manager.ts` 的 `JobStatus` 词汇，不引入第二套：

| 状态 | 含义 |
|---|---|
| `running` | 在跑 |
| `completed` | 结构化 harness：观察到协议终态且判定成功（**不是**"退出码为 0"）；`exec` 无协议终态，以退出码为准。见 D4 |
| `failed` | 进程/协议错误，或预算耗尽且无可用产出 |
| `cancelled` | 显式取消 |
| `lost` | 进程或 daemon 消失，结局未知 |

**三个幂等标记**（P5），各自守住一个不可重放的副作用：

| 标记 | 守住什么 | 为什么不能靠推导 |
|---|---|---|
| `settledAt` | 结算只发生一次（写 `output.md`、定状态、释放 lease） | 崩溃重启后进程可能已退出，重复结算会覆盖产物 |
| `usageRecorded` | 记账只发生一次 | 重复写 ledger 就是重复计费 |
| `wakeEnqueued` | 唤醒只入队一次 | 重复唤醒会让主代理重复处理同一结果 |

**启动顺序**（修正既有 `job-manager` 的 crash window）。核实确认 `ChannelJobManager.start()` 是先 `nohup` 起进程、拿到 pid 之后才 `persist()`，崩在中间会留下一个**没有记录的孤儿进程**。对 bash 作业这是可接受的既有风险；对一个正在写工作区的外部 agent 不是。因此外部 run 的顺序改为：

```text
准入（并发上限 + workspace lease，D10）
→ 持久化 launch intent（runId / argv / workingDirectory / artifactDir / taskId / leaseKey，pid 未知）
→ spawn（detached + unref，stdio 直接指向 artifactDir 内的文件描述符）
→ 持久化 pid + fingerprint
→ 运行、落盘
→ 结算一次（settledAt）
→ 记账、归档（usageRecorded）
→ 写 durable wake（wakeEnqueued，顺序见 D7）
```

restore 时，**有 intent 无 pid 的记录判 `lost` 并释放 lease**：无法证明它启动过，也无法证明它没有，宁可让主代理知道结局未知。

**目录布局**

```text
state/subagent-runs/<channelId>/<runId>.json     # run 记录，重启对账用（对齐 state/jobs/）
<channelDir>/subagent-artifacts/<runId>/          # 既有目录，不改位置
├── output.md          # 最终文本，无条件落盘（spec 032 D4，不变）
├── prompt.txt         # 外部 run 的 stdin 正文
├── system-prompt.txt  # 角色正文，供 --append-system-prompt-file 一类 flag 引用
├── events.jsonl       # 外部 run 的 stdout 事件流
├── stderr.log         # 外部 run 的 stderr
└── run.json           # pid / fingerprint / argv，供重启探针
```

`prompt.txt` / `system-prompt.txt` / `events.jsonl` / `stderr.log` 与后台作业的 spill 文件同级别，保留 24 小时后清理；`output.md`、`run.json` 和 verify attestation 是交付物或对账依据，随 run 记录一同保留。

**记录管理器**：新增 `src/subagents/runs.ts`，per-channel 单例，形态对齐 `ChannelJobManager`。**不复用 `ChannelJobManager` 本身**：委派的终态判定不等于进程退出（还要看协议终态事件，D4），状态机确实不同。真正相同的只有那几十行无状态的宿主进程操作（探针、进程组 kill），抽到 `src/shared/host-process.ts` 共用。

### D2 同步宽限窗口：一条执行路径，两种返回模式

讨论中提过"内置是否只支持异步"。结论是**不做纯异步**，但也不做两条执行路径。

纯异步的代价是：一次 30 秒的只读定位，会被拆成"派发 → 结束回合 → 唤醒 → 新回合"，多烧一整个主代理回合（系统提示 + 上下文重建），且在钉钉里表现为"已派发，稍后告诉你"→ 40 秒后"答案是 X"，比直接回答差。

真正需要统一的是**生命周期**，不是**返回方式**。因此：

> 所有 run 都以完全相同的方式启动、持久化、结算、落盘。工具调用只是**可选地等待**它。

- 派发后等待至多 `SYNC_GRACE_MS`（代码常量，`120_000`；按 CLAUDE.md，数值阈值是代码常量而非 settings 键）。
- 窗口内结算 → 结果内联返回，`wakeEnqueued` 直接置位，**不再唤醒 channel**。这与 `job-manager` 的 `poll(announce=false)` 是同一条既有语义。
- 窗口内未结算 → 返回 `{ runId, status: "running" }` 与一句"完成时会叫醒你"，run 继续跑。**超时是降级，不是失败**——这条约束今天写在 agentmux skill 的第 5 条里，本 spec 把它从 prose 搬进 runtime。

各 runtime 的有效窗口：

| runtime | 宽限窗口 | 理由 |
|---|---|---|
| internal | `min(maxWallTimeSec, SYNC_GRACE_MS)` | `quick` 档（120s）实际全同步，行为与今天一致；`deep` 档最多阻塞 120s 而不是 900s |
| external | `0` | 重型工作，一律异步 |

**关键：模式由角色配置决定，模型不选。** 这是 spec 034 原则的直接延续——runtime 管理属于人（frontmatter），委派属于模型（task + 角色）。`subagent` 的调用 schema 因此**一个字段都不加**。

**内联交付的残余窗口**（审查提出，采纳）：同步返回后、主代理最终回复送达前若发生崩溃，结果对用户就消失了——run 已置 `wakeEnqueued`，不会补发。这不是本 spec 新增的问题（今天的同步子代理同样如此），但异步化让它更容易被误认为已解决。处理方式不是再造一层投递确认，而是**保证结果可自助恢复**：`output.md` 在返回给主代理之前已经落盘，`subagent_manage op=list` 与 `/subagents show` 能在重启后按 runId 找回它。承诺写清楚：**结果不丢，但"用户已读"不是 runtime 保证的状态。**

**中止语义变更**：run 的生命周期与工具调用的 `AbortSignal` 解绑。`/stop` 停止当前回合，**不再连带杀掉在跑的委派**——与后台作业一致；要停委派用 `subagent_manage op=cancel` 或 `/subagents cancel`（D6）。这是对既有行为的有意改动，需在迁移说明中点名。

### D3 一次委派 = 一个短命进程

agentmux 的 `execjson-transport-design.md` 论证过三套传输不该共享代码，论证是对的——**在它的前提下**。它的前提是要支持长驻会话：进程内排队、带内中断、多轮 follow-up 在同一个 run 内 drain。于是 Claude 走"长驻进程 + FIFO 保活 + replay uuid 归属 + idle 事件推断"，Codex 走"每 turn 一个短命进程 + offset 区间归属"，进程模型天差地别。

pipiclaw 不需要那个前提。它需要的是"交出一个工作单元，完成时叫我"。所以本 spec 把所有 harness 归约到同一个进程模型：

> **一次委派 = 一次 prompt = 一个短命进程。后续轮次 = 用 resume 重开一个新进程。**

这一步消掉的东西：FIFO 与保活描述符、长驻进程的重启 reconcile、prompt 的 uuid 归属与 offset 区间、pi 的扩展对话框自动取消、进程内排队与带内中断。

归约后三种 harness 的对照：

| 维度 | claude-code | codex-cli | exec |
|---|---|---|---|
| 进程模型 | 一次委派一个进程 | 一次委派一个进程 | 一次委派一个进程 |
| prompt 通道 | stdin ← `prompt.txt` | stdin ← `prompt.txt` | stdin ← `prompt.txt` |
| 协议终态 | `result` 事件 | `turn.completed` / `turn.failed` | **无** |
| turn 归属 | 整个 `events.jsonl` 即本次 | 整个 `events.jsonl` 即本次 | 整个 stdout 即本次 |
| 多轮 | `--resume <session_id>` 重开 | `resume <thread_id>` 重开 | 不支持 |
| 中断 | 进程组 SIGTERM→SIGKILL | 同左 | 同左 |
| cost | `result.total_cost_usd` | **无** | **无** |

于是差异只剩两处：**argv 组装** 和 **stdout 解析**。这是一个足够薄、足够安全的共享缝——它没有状态机在里面。agentmux 的"不要抽共享层"结论不适用于这里，因为它抽的是不同的生命周期，而我们是**先用构造消掉了生命周期差异，再抽剩下的部分**。

**完成判据是协议终态事件，不是退出码。** 一个 exit 0 但没有 `result` / `turn.completed` 的进程（被 SIGKILL、JSON 截断、CLI 自身崩溃）绝不能记成 `completed`。这条在 D4 的 `ExternalOutcome` 里强制。

代价要认：失去同一进程内的 follow-up 排队与热会话上下文，每次 resume 要重新加载会话。对"派发—等待—验收"这个用法，这个代价是可接受的。

### D4 harness 适配器：argv，不是 shell 字符串

核实确认宿主 `Executor` 走的是 `spawn("sh", ["-c", command])`。若外部 run 沿用它，用户角色里那段几百字、含引号和换行的中文 system prompt 就要被拼进一条 shell 命令行——这正是 agentmux 不得不写 `shellQuote` 的原因，而引号处理出错的后果是**执行一条与设计不同的命令**。因此外部 run **不经过宿主 Executor，也不经过 shell**：

```ts
// src/subagents/external/harness.ts
export interface ExternalHarness {
  readonly id: "claude-code" | "codex-cli" | "exec";
  /** 组装 argv。命令行绝不拼接成单个字符串。
   *  input：角色的 command 分词结果、model、thinkingLevel、artifactDir、
   *  prompt/system-prompt 文件路径、resume 用的 sessionId。 */
  buildInvocation(input: ExternalInvocationInput): {
    executable: string;
    args: string[];
    resumable: boolean;
    /** 过长或含换行的 system prompt 落成临时文件时，这里给出它的路径。 */
    promptFiles?: string[];
  };
  /** 把 stdout 解析成统一结果；解析失败必须降级，**不得抛异常**。
   *  input：events.jsonl 原文、退出码（进程被信号杀死时为 undefined）、stderr 尾部。 */
  parseOutcome(input: ParseInput): ExternalOutcome;
}

export interface ExternalOutcome {
  finalText: string;
  /** 是否观察到协议终态事件。false 时状态永远不能是 completed。 */
  terminalSeen: boolean;
  protocolStatus: "completed" | "failed" | "absent" | "unparsable";
  exitCode?: number;
  sessionId?: string;
  usage?: Partial<UsageTotals>;
  usageKnown: boolean;   // exec 恒 false
  costKnown: boolean;    // codex-cli / exec 恒 false
  outputTruncated: boolean;
  stderrTail?: string;
  errorMessage?: string;
}
```

**状态判定规则**（审查第 8 条，采纳）：

| 观察 | run 状态 | failureReason |
|---|---|---|
| `terminalSeen && protocolStatus === "completed"` | `completed` | — |
| `protocolStatus === "failed"` | `failed` | 协议报告的错误 |
| `exitCode === 0` 但 `protocolStatus === "absent"` | `failed` | "进程正常退出但没有协议终态"（**不得记成成功**） |
| `protocolStatus === "unparsable"` | `failed` | 保留 `stderrTail` 与原始尾部 |
| 进程被信号杀死 / 预算耗尽 | `failed` | 仍解析已有事件，回传部分产出 |

**`exec` 是上表的显式例外**：它没有协议终态，若照搬第三行会被判成永远失败。其 `parseOutcome` 直接由退出码给出 `protocolStatus`（`0` → `completed`，非 0 → `failed`），同时 `terminalSeen` 恒为 `false`、`usageKnown`/`costKnown` 恒为 `false`。也就是说 `terminalSeen` 只对结构化 harness 具有"完成证据"的含义；`exec` 的完成证据只有退出码这一层，比结构化 harness 弱，如实标注，并据此禁止它承担 `purpose=verify`（D9）。

**进程启动**：`spawn(executable, args, { detached: true, cwd, stdio: ['pipe', fd(events.jsonl), fd(stderr.log)] })` 后 `unref()`。不用 shell，因而没有 `exit` 文件；结局判定用"pid 存活探针 + `events.jsonl` 的协议终态"，这比退出码信息量更大，正好与上表一致。`shell: true` 只允许用于没有协议 argv 的通用 `exec` harness，此时整条 `command` 交给 `/bin/sh -lc` 执行。claude-code / codex-cli 若走 shell 会绕过 model、thinking、system prompt、输出协议与 resume 的 harness 组装，因此 discovery 直接驳回；需要登录 shell 环境时应把环境初始化封装成脚本，并将该脚本作为普通 `command`。

**用户 `command` 字符串的处理**：按 shell 词法**分词**（尊重引号），但不交给 shell 执行。首 token 是 `executable`，其余进 `args`。

**argv 注入规则**（沿用 agentmux 的既有约定，它是实测出来的）：

- `command` 里已经自己写了 `--model` / `-m` / `--effort` / `--thinking` / `-c model_reasoning_effort=` 时，不再注入同名 flag。
- `command` 里写了 `$MODEL` / `$EFFORT` / `$PROMPT_FILE` / `$SYSTEM_PROMPT_FILE` 占位符时，按占位符位置展开，不再追加。
- codex 的 `resume` 是子命令，父级 flag 必须在它之前：`<父级 args...> resume <tid> --json -`，不能简单追加到尾部。

**各 harness 追加的 flag**：

| harness | 追加 | resume | 最终文本来源 |
|---|---|---|---|
| `claude-code` | `-p --output-format stream-json --verbose --session-id <uuid> [--model M] [--effort L] [--append-system-prompt-file F]` | `--resume <session_id>`（替代 `--session-id`） | `result` 事件的 `result` 字段 |
| `codex-cli` | `--json - [-m M] [-c model_reasoning_effort=L]` | `<父级 args> resume <thread_id> --json -` | 最后一条 `item.completed` 且 `item.type == "agent_message"` |
| `exec` | 无（原样执行，prompt 走 stdin） | 不支持 | stdout（按回传预算截断） |

审查指出 agentmux 的 claude 命令还带 `--input-format stream-json`、`--include-partial-messages`、`--replay-user-messages`。核实属实，但**这三个都是长驻双向会话的产物**：输入流式化是为了持续写 FIFO，replay 是为了把 result 归属到某条 prompt，partial 是为了实时抓屏。D3 的一次性进程模型里，prompt 只有一条、整个 `events.jsonl` 就是本次，三者都无必要，而 partial 会显著放大解析量。因此**不采纳**这三个，但**采纳 `--session-id` 预先指定**——它让 resume 不依赖"必须先成功解析出 session id"，即使首轮在产出 `result` 前就崩溃，后续仍可 resume。这是审查带来的一处实质改进。

**思考档位统一到 `thinkingLevel`**

agentmux 用 `effort` 表示推理强度，而 pipiclaw 的 `effort` 已经是预算档位（`quick`/`standard`/`deep`，spec 034 D2）。同词不同义会长期制造混乱，因此外部角色复用 pipiclaw 既有的 `thinkingLevel` 词表，由 runtime 翻译成各 harness 的写法。

`ALLOWED_THINKING_LEVELS` 补上 `max`——SDK 侧 `@earendil-works/pi-agent-core` 的 `ThinkingLevel` 本来就含 `max`，pipiclaw 的白名单少了它，补上既修了内置的档位缺口，也让外部角色不必损失 agentmux 用户已经在用的最高档。

| `thinkingLevel` | claude-code | codex-cli | 说明 |
|---|---|---|---|
| `off` | `low`（夹取） | `none` | claude 没有比 low 更弱的档 |
| `minimal` | `low`（夹取） | `low`（夹取） | codex 的 minimal 逐模型支持，不支持时返回 400，统一夹取 |
| `low` / `medium` / `high` / `xhigh` / `max` | 同名 | 同名 | — |

发生夹取时写一条 discovery 提示，不静默。这张表是实测产物，会随 CLI 升级漂移，`/subagents show <runId>`（D6）显示实际 argv 供人复核。

### D5 role 文件：一个目录，两种 runtime

`workspace/sub-agents/*.md` 保持为唯一的角色目录。新增判别字段 `runtime`，缺省 `internal`，因此**所有既有角色文件零改动继续工作**。

```md
---
name: builder
description: 重型实现者（外部 Claude Code，异步）。用于边界清楚但跨多文件、需要自测的编码任务；返回 runId，完成时唤醒。不要用于只读定位或单点事实查询。
runtime: external
harness: claude-code
command: claude --dangerously-skip-permissions
model: sonnet
thinkingLevel: medium
workload: heavy
mutates: write
maxWallTimeSec: 3600
env:
  TERM: xterm-256color
---

（正文即 system prompt，通过 --append-system-prompt-file 或等价方式传入）
```

**字段合法性矩阵**（不合法即驳回，写进 discovery warnings，**不静默忽略**）：

| 字段 | internal | external | 说明 |
|---|---|---|---|
| `name` / `description` | 必填 | 必填 | `description` 是主代理的主要路由依据 |
| `runtime` | 可选（默认 internal） | 必填 `external` | — |
| `harness` | **驳回** | 必填 | `claude-code` / `codex-cli` / `exec` |
| `command` | **驳回** | 必填 | 分词后组装 argv，见 D4 |
| `cwd` | **驳回** | **驳回** | 工作目录是**每次委派**的决定，只在调用面（`workingDirectory`），见下 |
| `shell` / `env` | **驳回** | 可选 | 迁移 agentmux `defaults.shell` / `defaults.env` |
| `workload` | 可选 | 可选 | `light` / `heavy`，进目录渲染（D11） |
| `mutates` | 可选（默认按 `tools` 推定） | **必填** | `read` / `write`。一个声明、三处消费：workspace lease（D10.1）、审计记录（D8）、`purpose=verify` 准入（D9） |
| `tools` | 可选 | **驳回** | 外部智能体的工具边界由它自己的调用命令决定（如 `--sandbox read-only`），不在配置层假装能限制 |
| `maxTurns` / `maxToolCalls` / `bashTimeoutSec` | 可选 | **驳回** | 对外部进程无意义 |
| `maxWallTimeSec` | 可选 | 可选 | 默认值不同，见下 |
| `model` | 可选 | 可选 | **解析方式不同**，见下 |
| `thinkingLevel` | 可选 | 可选 | 统一词表，外部按 D4 翻译 |
| `contextMode` / `memory` / `paths` | 可选 | 可选 | 都只是提示词组装，两边同样有效 |

**`mutates` 承担了原先 `grants` 的职责。** 早期草案同时有 `grants: host-read|host-write`（权限承认）和 `mutates: read|write`（并发控制），但对 coding agent 这两者恒等——一个会写工作区的角色必然会改宿主机。两个近义枚举并存只会制造"该填哪个、填不一致怎么办"的问题，因此合并为 `mutates`，对外部角色必填（必填即是那次显式承认），对内置角色可选并按 `tools` 是否含 `write`/`edit` 推定。同理，早期草案给外部 verifier 用的 `readOnly: true` 也是同一句话的第三种写法，一并并入——`mutates: read` 就是"这个角色不写"，`purpose=verify` 直接以它为准（D9）。**一个声明，三处消费：lease、审计、verify 准入。**

**工作目录不进角色文件，只在调用面。** 角色文件里放一个 `cwd` 默认值看似方便，实际是 P2 意义上的撒谎：它让主代理以为工作目录已经被配置好了、不必再想——而这恰恰是**每次委派都必须现场决定**的事。同一个 `builder` 角色，这次改 A 仓库、下次改 B 仓库、并行时还得各自一个 `git worktree`；一个写死在角色里的默认值只会让模型在该思考的地方跳过思考，并在并行写入时把两个 run 默认到同一棵树上。

因此 `cwd` 对内外两种 runtime 一律驳回，工作目录只有一个来源：调用面的 `workingDirectory`（既有参数，spec 036 D3，schema 不变）。它未给时沿用 runtime 自身的工作目录，必须是已存在目录，其余不加任何目录限制——审查主张按根目录收窄，**不采纳**：那既要新配置面又要新校验，而外部 agent 本来就没有 runtime 级隔离（D8），一道只拦得住路径参数、拦不住进程行为的检查换不来真实安全。`agent-delegation.md` 要把"委派前显式决定工作目录、并行写入必须各自 worktree"写成硬要求。

**两处必须分开处理的解析差异：**

1. **`model` 不走 `models.json`。** 内置角色的 `model` 经 `resolveModelReference` 精确匹配可用模型，匹配不上就丢弃该角色。外部角色的 `model` 是**目标 harness 自己的字符串**（`sonnet`、`gpt-5.6-luna`、`provider/id`），pipiclaw 无从校验，必须原样透传。若沿用现有逻辑，每一个外部角色都会被丢弃。

2. **二进制缺失不得丢弃角色。** 现在 `loadAgentsFromDir` 对任何校验失败都 `continue`。若 `claude` 没装就让该角色从目录里消失，主代理会**静默回落到内置**——正好是本 spec 要消灭的故障模式。正确行为：角色照常列出并标 `unavailable`，调用时抛一个带安装指引的错误，**且该错误不得暗示改用内置角色**（符合 AGENTS.md "每个工具错误都要带下一步指令"）。

**`effort` 预算档位在两侧取不同数值**——同一个词表示"预算档位"，而档位是相对各自尺度的：

| `effort` | internal（既有，不动） | external（仅 wall time） |
|---|---|---|
| `quick` | 8 轮 / 16 调用 / 120s / 60s | 600s |
| `standard` | 24 / 48 / 300s / 120s | 1800s |
| `deep` | 48 / 96 / 900s / 180s | 5400s |

外部角色未写 `maxWallTimeSec` 时用 `standard` 的 1800s。

外部角色与内置角色一样**热加载**：改完文件下一次 discovery 刷新即生效，不需要任何额外动作。（审查建议为了防自授权而改成"仅启动时加载"，按 P4 驳回：它让每次改角色都多一步，收益只是把一条已经被 `writeDeny` 挡住工具路径的攻击再抬高一档。理由见 D8.1。）

### D6 调用面：`subagent` 不变，新增 `subagent_manage` 与 `/subagents`

**`subagent` 的 schema 一个字段都不加。** 内外差异全部落在角色配置里，主代理照旧只填 `label` / `task` / `agent` / `systemPrompt` / `effort` / `context` / `paths` / `workingDirectory` / `purpose` / `taskId` / `returns` / `thinkingLevel`。这是"封装内外差异"这个目标能兑现的最实处。

异步派发的返回文本必须自足到让主代理知道"这一步已经完成、接下来该结束回合"：

```text
[已派发] runId=<id>，角色 <name>（外部 claude-code），工作目录 <dir>。
状态 running。完成时会唤醒本频道并带回结果与产物路径。
现在不要重复派发，也不要轮询等待——结束本回合即可；属于任务时用 task_manage 记 waiting。
```

**模型侧**：新增 `subagent_manage`（命名对齐 `task_manage` / `event_manage` / `skill_manage` / `memory_manage`），三个 op：

| op | 语义 |
|---|---|
| `list` | 本频道 run 快照（runId、角色、状态、已运行时长、taskId、artifactDir、持有的 workspace lease）。重启后重新定位在途工作的入口 |
| `cancel` | 按 runId 终止。外部杀进程组，内置 abort，释放 lease。取消是模型自己的决定，**不唤醒**（对齐 `job op=cancel`） |
| `follow_up` | 在既有会话上追加一轮，产生一个**新的 runId** |

`follow_up` 只对可 resume 的 run 有效（`claude-code` / `codex-cli`）。对 `exec` 和内置 run 返回 `RecoverableToolError`：内置 run 的隔离上下文本来就是它的设计要点，没有持久化 transcript 可续；正确做法是带着上一轮产出开一个新委派。这是一处如实暴露的不对称（P2）。

**人侧（不依赖 LLM 的运行时命令，审查第 7 条，采纳）**：`/stop` 不再杀外部 run，因此必须存在一条不经过模型的控制通路——否则主代理卡死、模型不可用或工具调用失败时，用户无法停止一个正在写工作区的外部进程。参照既有的 `/events list|show|delete` 与 `/tasks doctor`，新增运行时层命令：

```text
/subagents list                 # 在途与近期 run：状态、角色、runId、工作目录、lease 持有者
                                # 末尾附角色目录健康度：不可用的外部角色及原因、discovery warnings
/subagents show <runId>         # 完整记录、实际 argv、产物路径、stderr 尾部
/subagents cancel <runId>       # 直接杀进程组，不经过模型
```

只有这三条。审查建议再加 `doctor` 与 `agents import --from agentmux`，**不采纳**：导入是一次性工作（模板只有个位数，`examples/sub-agents/` 直接给成品即可），此后用户只面对 `sub-agents/` 目录，不会再回到 agentmux。而 `doctor` 想提供的核心信息——哪个角色不可用、为什么、实际会启动什么 argv——分别挂在 `list` 的尾部和 `show` 上即可，不值得单开一条命令和一套输出格式。

不提供 `result` op：唤醒文本已带结果尾部与 `output.md` 路径，全文用 `read` 即可——与后台作业一致的既有习惯，不必再造入口。

### D7 结算、唤醒、记账与任务台账

这一节按审查意见重写，因为原版把"taskId 语义不变"当成了集成方案，而核实表明它不成立。

**唤醒顺序（修正既有实现的顺序缺陷）**

先核实审查的断言："`job-manager` 先持久化 `notified=true` 再 dispatch，dispatch 返回 false 或崩溃后不会重试"。**前半句属实，后半句不成立**：`DurableDispatchService.dispatch()` 是先把 pending 记录**落盘**再 `drainOnce()`，返回值取的是 `after?.status !== "pending"`，`false` 只表示"尚未投递"，其后的定时 `drainOnce` 会继续重试。所以唤醒不会因投递失败而丢失。

真实缺陷只剩**顺序**：`notified = true` 在 durable 记录写盘**之前**就持久化了，崩在这两步之间会永久丢掉这次唤醒。修法不是新造状态机，而是调换两步：

```text
结算（settledAt）→ 落盘 output.md、归档 → 记 usage（usageRecorded）
→ 写 durable wake 记录 → 置 wakeEnqueued
```

`durable-dispatch` 以 `dispatchId` 幂等（读到已存在记录直接返回），因此崩溃后重复入队无害。`dispatchId` 取 `subagent:<channelId>:<runId>:done`。同一处顺序缺陷也存在于 `job-manager.announce()`，一并修正——它们共享同一条投递链路，没有理由只修一边。

**唤醒契约**

```text
[SUBAGENT:<runId>] 委派 "<label>" → <agent>（<harness>）结束：completed（12m03s）。归属任务 T-7。
Verdict: PASS (advisory)           ← 仅 purpose=verify，强度见 D9
结果：
<尾部文本>
完整输出：<artifactDir>/output.md
继续此前等待这次委派的工作。若无需跟进，回复且仅回复 [SILENT]。
```

**任务台账集成（原版的实质缺口）**

核实确认 `bootstrap.ts` 只对 `[JOB:...]` 做了唤醒→任务激活：解析 `belongs to task <id>`、`activateWaitingTask(channelDir, id, "job")`、必要时 `claimTaskAttempt` 领取 attempt generation。`[SUBAGENT:...]` 没有对应路径，因此原版设计里 `taskId` 只是 run 上的一个标签——任务会继续被 driver 重复调度，外部完成后也无法正确结算 attempt。

好消息是台账词汇已经就位：`TaskWaitingFor` 已含 `"external-signal"`，`activateWaitingTask` 已接受 `expectedWaitingFor` 参数。所以这是一处**补线**，不是新子系统：

```text
active
  → subagent 派发且带 taskId：**主代理**用 task_manage progress 置 waiting + waitingFor="external-signal"
     （与后台作业同一习惯：runtime 负责唤醒，置 waiting 是模型的一步）
  → run 到达终态
  → 唤醒事件 [SUBAGENT:<runId>] ... belongs to task <id>
  → bootstrap 解析并 activateWaitingTask(channelDir, id, "external-signal") + claimTaskAttempt
  → active，主代理处理结果
```

同时新增 `channelDelegationTaskIds(channelId)`，与既有 `channelJobTaskIds` 并列被 `/tasks doctor` 消费——一个 `waiting` 且无 `wake` 的任务，只有在"确实有人会来叫它"时才算健康。

**记账路径必须新增，且原有路径要挡住 pending 结果**

今天子代理的 usage 由 `session-events.ts` 在 `tool_execution_end` 时写 `UsageLedger`（`kind: "subagent"`）并归档。异步 run 有两个问题：其一，结算发生在回合结束之后，这条路径不触发，成本会**凭空消失**；其二——审查指出且核实属实——**pending 的工具结果同样会命中这条路径**，把一个还没跑完的 run 按"已完成"记账并归档。

因此：

- **`runs.ts` 是唯一的结算与记账权威。** 同步与异步都由 run 管理器记账，`session-events` 对 `subagent` 结果只做当前回合的 usage 汇总展示，不再写 ledger、不再归档。
- `UsageLedger` 增加 `runId` 幂等键，以及 `usageKnown` / `costKnown` 两个如实标记。`codex-cli` 没有 cost 字段、`exec` 连 token 都没有，必须让 `/usage` 一类展示面显示"未知"而不是 0。
- `LoggedSubAgentRun`（`src/runtime/store.ts`）增加 `runId` / `runtime` / `harness` / `status` / `taskId` / `artifactDir`，并只在终态归档。既有 `toolCallId` 保留：`runId` 取自发起该 run 的 tool call id（`subagent` 或 `subagent_manage op=follow_up`），两者恒等。
- bootstrap 新增 `configureSubAgentRuntime({ stateDir, dispatch, ledger, store })`，形态对齐 `configureJobRuntime`。

### D8 外部委派的授权面与其真实边界

内置子代理走 `command-guard` / `path-guard` / 审计日志，还有针对记忆文件的结构性写入拒绝（`withSubagentMemoryWriteDeny`）。**外部进程不受这些约束中的任何一条。**

**`security.json` 不增加任何外部智能体配置段。** 授权面只有一处：角色文件。写下一个 `runtime: external` + `command:` + `mutates:` 的角色文件，本身就是一次完整、具体、可版本化的授权声明——它比任何全局开关说明了更多事情：哪个 harness、哪条命令、会不会改动宿主，而且粒度是**角色**而不是整个 runtime。外部委派**配置了角色即持续可用**，不存在第二道闸。

直接推论必须写清楚而不是绕过去：

> **pipiclaw 不尝试沙箱化外部智能体。** 唯一的强边界是用户在 `command` 里写下的目标 CLI 自身 sandbox flag（如 `codex exec --sandbox read-only`）。runtime 侧既没有目录白名单，也没有可以事后收紧的旋钮；`workingDirectory` 决定进程从哪里开始，但**不构成隔离**——一个 `host-write` 的外部 agent 能触及它权限所及的任何地方。`mutates: write` 是审计与并发控制信息，**不是隔离机制**，文档不得把它描述成安全边界——一个声明 `mutates: read` 的角色照样可能写文件，runtime 拦不住。

#### D8.1 必须堵住的自授权路径（核实中发现，比审查所提更近）

审查担心"workspace 可能来自仓库或共享目录"。核实后发现一个更直接的版本：`DEFAULT_SECURITY_CONFIG` 的 `writeAllow` 为空，而 `pathAllowedByDefaults` 放行 workspace、home、temp——**主代理自己就能写出一个 `runtime: external` 的角色文件**，`command` 任意，然后调用它。外部进程不经过 `command-guard`，于是这条路径等于**绕过命令守卫执行任意宿主命令**：外部委派会变成一个自授权能力。

按 P4 取两条**几乎零成本**的，不引入新的安装流程、闸门或额外操作步骤：

1. **把 `workspace/sub-agents/` 加入主代理与子代理的 `writeDeny`**，与 `withSubagentMemoryWriteDeny` 同构——同一份手法在仓库里已经存在，实现是几行。角色目录从此只由人通过文件系统维护，模型可读可用，不可用 `write`/`edit` 创建或修改。
2. **每次派发写审计事件**，含 runId、角色、harness、**完整 argv**、实际工作目录、`mutates`、model。这是账不是闸，不挡任何正常使用。

**如实声明剩下的缺口**：第 1 条只封住 `write`/`edit` 工具路径，**封不住 `bash`**——这与 2026-08-06 审查报告已记录的"子代理 memory 写入拒绝可被 bash 绕过"是同一个已知缺口，本 spec 不声称解决它。

审查还建议加一道 app-level trust 闸门（`pipiclaw agents trust`），并让外部角色停止热加载以便"必须有人为动作介入"。两条都**驳回**（P4）：前者把已经删掉的第二道闸换个名字装回来，后者让每次改角色都多一步 reload；而它们换来的只是把一条已被 `writeDeny` + 审计覆盖的路径再抬高一档。对一个个人项目，这个价钱不值。真正的兜底是**把 `workspace/` 纳入版本控制**——角色目录的任何变更都可见、可回滚，零运行时复杂度。

#### D8.2 环境与凭据

外部进程继承 pipiclaw 的环境（它需要自己的认证，如 `ANTHROPIC_API_KEY`、`PATH`、`HOME`）。审查建议改用 allowlist；**部分采纳**：全量 allowlist 会持续误伤（各 CLI 依赖的变量不可穷举，且随版本变化），代价大于收益。采纳的部分是——角色可用 `env:` 追加或覆盖变量（迁移 agentmux `defaults.env` 所需），继承本身作为**已声明的暴露**写进 `docs/sub-agents.md`，而不是当作没这回事。

#### D8.3 明示不可控的部分

- 外部 agent 本身是完整 coding agent，**它能 spawn 自己的子代理，pipiclaw 拦不住**。递归与成本尾部风险由角色配置与并发上限约束，不由 runtime 保证。
- 外部 agent 会自行发现并读取目标仓库的 `CLAUDE.md` / `AGENTS.md`，仓库内容可以操纵它的行为。外部 run 的输出因此必须被当作**不可信数据**，不是新的系统指令——这一条要同时写进 `agent-delegation.md` 和外部结果的注入模板。

审计事件走 `src/security/logger.ts` 既有出口，`SecurityLogEvent` 联合体新增 `type: "external-agent"` 分支。注意它与既有三种事件的语义差别：那三种记录的是**被拒绝**的动作，这一条记录的是**被执行**的动作，因此 `audit.logBlocked` 开关不该影响它——外部派发的记录不因"只记拦截"而消失。

### D9 `purpose=verify`：外部验收是 advisory，如实标注

内置 verify 是双保险：摘掉 `write`/`edit` 工具（前置约束）+ `subjectHash` 比对（事后校验）。外部 run 摘不掉工具，前置约束只能来自目标 CLI 自己的 sandbox flag，而那是用户写在 `command` 里的字符串，pipiclaw 无法验证。

审查进一步指出事后校验本身也不够，核实属实：`workspaceSubjectHash` 由 `git status --porcelain --untracked-files=all` + `git diff` + `git diff --cached` + HEAD 组成，其中 **untracked 文件只贡献路径和状态，不贡献内容**。一个外部 verifier 修改未跟踪文件的内容不会改变 subject hash。此外，"改完再改回"对任何哈希式校验都不可见，共享工作区里的并发写入者还会制造瞬时状态。

因此外部验收的语义如实收缩：

1. 角色必须声明 `mutates: read`，否则 `purpose=verify` 直接拒绝派发——一个自称会写工作区的角色不能同时当验收者。`exec` harness 一律拒绝（无协议终态，无法确认它是否真的跑完）。
2. **修补 `workspaceSubjectHash`：把 untracked 文件的内容也纳入哈希**（按路径排序、逐个哈希内容后并入）。几十行，同时增强内置 verify，是本节性价比最高的一条。
3. **verify 派发前检查目标目录上没有活跃的写 lease**（D10）——一次前置检查，不是新机制。有并发写入者时 attestation 本就没有意义，早拒绝比事后解释便宜。
4. **attestation 新增 `verificationStrength: enforced | advisory`**：
   - `enforced` —— 内置 verifier（工具被结构性移除）。
   - `advisory` —— 外部 verifier。工具无法被移除，只能靠它自己的 sandbox flag 与事后哈希。
5. **`advisory` 只记录并展示，不做硬性拦截。** 它出现在 attestation、`task_manage verify` 的回显和唤醒文本里（`Verdict: PASS (advisory)`），由主代理按 `agent-delegation.md` 的要求补一次与风险相称的抽查。审查主张 advisory 不得单独通过受治理任务，方向对，但按 P4 太贵——它会挡掉"外部 reviewer 审查后验收"这条正常主路径，而换来的确定性只是把一个本来就该由主代理独立检查的判断变成硬规则。maker/checker 分离靠"验收者不是产出者"和事后哈希维持，够用。

内置 verify 路径除第 2 条的哈希增强外逐字节不变。

### D10 workspace 归属、并发准入与重启对账

#### D10.1 workspace 排他写锁（审查第 1 条，采纳其最小形式）

工作目录只是进程的起点，不是文件系统隔离。多个写入者——外部 run、带 `write`/`edit` 工具的内置 run、主代理本身、后台作业——可能同时操作同一个 checkout；agentmux 自己的 skill 已经写明"不要让多个写入者并发修改同一个 checkout，并行写入时为每个实例创建独立 worktree"。把这条从 prose 变成 runtime 约束：

机制取最简的一种——**只有排他写锁，没有读写锁**（P4）：

- **只有 `mutates: write` 的 run 取 lease**，读 run 什么都不取。
- **lease key** = run 工作目录的 `realpath`；**冲突按路径前缀判定**（`/repo` 与 `/repo/pkg` 冲突，父子目录不是两个独立资源）。
- lease 记在 run 记录里，随 `settledAt` 释放；restore 时按存活的 run 重建持有者，判 `lost` 的 run 释放它。
- `purpose=verify` 不取 lease，只做一次**前置检查**：目标路径上有活跃写 lease 就拒绝派发（D9）。
- 被拒绝时的错误必须点名**持有者 runId 与其工作目录**，并给出下一步：等待、取消，或 `git worktree add` 后用 `workingDirectory` 指向新 checkout。

不做完整读写锁的理由：真正会产出错误结果的是"两个写入者同时改一棵树"，一次排他锁就挡住了。"reviewer 读到不稳定 diff"是质量问题不是正确性问题，交给 `agent-delegation.md` 提醒即可，不值得为它引入读锁计数、升级降级和随之而来的死锁面。

**边界如实声明**：主代理自己的 `write`/`edit`/`bash` **不参与** lease。让它参与会与它自己派发的委派死锁（主代理持有 lease 时无法把同一目录交给 writer），并且会把一次委派设计扩张成 runtime 全域的并发改造，超出本 spec。因此 runtime 保证的是"**委派之间**不会并发写同一棵树"，不是"这棵树上只有一个写入者"。缺口用三样东西补：`/subagents list` 显示持有者、`agent-delegation.md` 明确要求主代理不要编辑存在活跃 write-lease 的目录、以及把独立 worktree 作为并行写入的推荐做法写进文档。

#### D10.2 并发准入

per-channel 与 host 两级上限，**代码常量**（与 `job-manager.ts` 的 `MAX_RUNNING_JOBS` 同性质；按 CLAUDE.md，数值阈值不进配置文件）。这是对审查报告 S1"没有跨任务/子代理/sidecar 的全局 admission"的**局部**回应——只保证外部进程不会无限增长，不解决全局资源准入。

#### D10.3 重启对账

| runtime | daemon 重启后 | 处理 |
|---|---|---|
| external | 进程 `detached` 启动，**继续存活** | 从 `state/subagent-runs/` restore，按 `run.json` 的 pid + fingerprint 探针；进程已退出则解析 `events.jsonl` 判终态，补发迟到唤醒 |
| external（有 intent 无 pid） | 无法证明启动过 | 判 `lost`，释放 lease，唤醒说明结局未知 |
| internal | 在进程内跑，**必然随 daemon 消失** | restore 时直接判 `lost`，唤醒 channel 说明该委派已中断及其 `artifactDir` |

内置 run 无法 reclaim 是构造决定的事实，不是缺陷。把它做成一次明确的 `lost` 唤醒，好过留一条永远 `running` 的孤儿记录。

进程指纹：`run.json` 记录 pid、argv 与一枚随机 cookie，避免 pid 复用后误杀无关进程。

**预算耗尽不丢弃已有产出**：外部 run 超 `maxWallTimeSec` 时杀进程组后仍解析 `events.jsonl`，回传已产生的助手文本并标 `failed` + 原因。这是内置 D6 收敛回合（spec 032）在外部侧的对应物——机制不同，承诺相同。

### D11 目录渲染与 playbook

**系统提示的角色目录按机器可读属性分组**，让路由依据不再只有一段自然语言 `description`（审查第 5 条，采纳其可判定的部分）：

```text
## Configured Sub-Agents
A sub-agent starts blank: state goal, scope, paths, constraints and acceptance criteria in the task.

外部 · heavy · write · async
- builder — <description>
外部 · heavy · read · async
- reviewer — <description>
内置 · light · read · sync（超 120s 自动转异步）
- explorer — <description>
```

`workload` / `mutates` 是角色声明的枚举（D5）：`workload` 未声明时按 runtime 推定（external→heavy，internal→light）；`mutates` 对外部角色必填，对内置角色按 `tools` 推定。审查还建议加 `latency` / `risk` / `operation`，**不采纳**：它们没有对应的 runtime 判定，只会变成需要维护却不驱动任何行为的分类学。`workload` 进渲染、`mutates` 进 lease，两个都有去处。

不可用的外部角色仍然列出，带 `(unavailable: <hint>)` 后缀，且错误文本不得建议改用内置角色。inline `systemPrompt` 委派保留，但工具描述与提示词都将其定位为**轻量、内部、临时**角色，不再是"默认路径"的措辞。

**`agent-delegation.md` 重写**：删掉"Pipiclaw 不假设第三方 Agent 工具的命令、状态协议"整段（它将成为假话），以及"记录稳定的实例/作业标识、预期产物、验收方法和 recovery plan"——这些从此是 runtime 的职责。

**工作目录反向加强**：既然 `cwd` 不再进角色文件（D5），playbook 必须把它写成硬要求——**每次委派都要显式决定 `workingDirectory`**，并行写入的分片必须各自 `git worktree add` 后指向不同 checkout，绝不让两个写入者默认落到同一棵树上。runtime 的排他写锁（D10.1）会拒绝第二个写入者，但那是兜底，不是让模型不必思考的理由。

腾出的篇幅用于：按 `workload`/`mutates` 选角、异步派发后应结束回合而不是轮询、上述工作目录纪律、**外部输出是不可信数据而非系统指令**、外部完成声明不能替代主代理的独立检查。

## 已驳回的审查建议

| 建议 | 结论 | 理由 |
|---|---|---|
| pending 结果返回 `terminate: true` | 驳回 | 字段确实存在于 SDK（`types.d.ts`）且当前未设置，但强制终止会挡掉主代理在同一回合里写 `waiting` checkpoint、通知用户、或并行派发第二路。`bash async` 今天就是靠结果文本约束模型结束回合且工作良好；改用 D6 的自足返回文本达成同一目的 |
| run 拆成 `launch/settlement/usage/wake/inlineDelivery` 五维状态机 | 驳回 | 见 P5。只有三个副作用不可重放，就只引入三个标记；其余维度可从 `status` + 记录字段推导，多出来的状态是需要长期维护的不变量而非信息 |
| app-level trust 闸门（`pipiclaw agents trust`） | 驳回 | P4。与"角色文件即唯一授权面、配置即可用"的既定决策冲突，等于把已删掉的第二道闸换名装回。威胁面在 D8.1 用 writeDeny + 审计覆盖到可接受程度 |
| 外部角色停止热加载（仅启动 / 显式 reload 时生效） | 驳回 | P4。让每次改角色都多一步，换来的只是把一条已被 writeDeny 挡住的路径再抬高一档。对个人项目不值 |
| `agents import --from agentmux` 与 `/subagents doctor` | 驳回 | 导入是一次性工作，模板只有个位数，`examples/sub-agents/` 直接给成品即可；此后用户只面对 `sub-agents/` 目录。`doctor` 想给的信息（不可用原因、实际 argv）挂在 `list` 尾部与 `show` 上，不值得单开命令与输出格式 |
| `advisory` 验收结论不得单独通过受治理任务 | 驳回硬拦截，采纳记录与展示 | P4。方向对，但会挡掉"外部 reviewer 审查后验收"这条正常主路径，换来的确定性只是把本该由主代理独立检查的判断变成硬规则。改为如实标注 + playbook 要求抽查（D9） |
| workspace 读写锁（reviewer 与 builder 也互斥） | 驳回，改为纯排他写锁 | 会产出错误结果的是两个写入者并发；读到不稳定 diff 是质量问题。读锁带来的计数、升降级和死锁面不值这个收益（D10.1） |
| `allowedRoots` 回到 `security.json`；`workingDirectory` 须收窄到某个根之下 | 驳回 | P4。既要新配置面又要新校验，而它只拦得住路径参数、拦不住进程行为——外部 agent 本来就没有 runtime 级隔离（D8），这道检查换不来真实安全。工作目录改为每次委派显式决定（D5），责任落在调用方而不是一道假边界上 |
| `exec` 降级为测试专用 / 显式低信任 | 驳回定位，采纳约束 | `exec` 是防止设计变成三个厂商协议封闭集合的逃生舱，是产品能力。但它无协议终态，因此 `terminalSeen` 恒 false、`usageKnown`/`costKnown` 恒 false，且禁止承担 `purpose=verify`（D4、D9） |
| 环境变量全量 allowlist | 部分采纳 | 各 CLI 依赖的变量不可穷举且随版本漂移，全量白名单会持续误伤。改为：继承 + 角色 `env` 追加 + 在文档中如实声明这项暴露（D8.2） |
| 采纳 agentmux 的 `--input-format stream-json` / `--replay-user-messages` / `--include-partial-messages` | 驳回 | 三者都是长驻双向会话的产物，在 D3 的一次性进程模型里无必要，partial 还会显著放大解析量。**但采纳同批发现的 `--session-id` 预指定**，它让 resume 不依赖首轮成功解析 |
| 主代理/job/sidecar 一并纳入 workspace lease | 驳回 | 会与主代理自己派发的委派死锁，且属于 runtime 全域并发改造。改为保证"委派之间"互斥，缺口用可见性与文档补，边界在 D10.1 明写 |

## 非目标

- **pi-rpc 与任何 tmux harness**。pipiclaw 本身构建在 `@earendil-works/pi-coding-agent` 上，内置子代理已经是 pi `Agent` + pipiclaw 工具集，再起一个 pi 子进程的边际收益只有进程隔离，不值第三套解析器。tmux 是给人旁观接管用的，pipiclaw 是 headless 的。
- **把外部 agent 做成 MCP / A2A / ACP 端点**。本 spec 要的是生命周期管理，这些协议不白送，且要为每个 CLI 写 server。
- **同一进程内的多轮排队与带内中断**（D3 主动放弃的能力）。
- **全局跨域资源准入**（审查报告 S1）。只加外部进程的两级上限。
- **外部副作用的幂等账本**（审查报告 S1-3）。本 spec 保证 run 自身不被重复派发、不被重复记账、不被重复唤醒；**不保证外部 agent 已经执行的副作用（commit、push、部署）幂等**。这是外部委派成为主路径后最值得下一个 spec 处理的问题。
- **主代理与委派之间的工作区互斥**（D10.1 明写边界）。
- **worktree 的自动创建与合并**。runtime 只保证互斥并在错误文本里推荐 worktree，不代管它。
- **内置 run 的 transcript 持久化**（因而 `follow_up` 不支持内置）。

## 兼容与迁移

| 面 | 影响 |
|---|---|
| 既有 `sub-agents/*.md` | 零改动。`runtime` 缺省 `internal`，字段语义与默认值全部不变 |
| `subagent` 调用 schema | 不变 |
| 内置同步行为 | **有变化**：`effort: deep` 不再阻塞 900s，超 120s 转异步 + 唤醒。`quick` 档实际不受影响 |
| `/stop` | **有变化**：不再连带杀死在跑的委派；改用 `subagent_manage op=cancel` 或 `/subagents cancel` |
| `workspace/sub-agents/` | **有变化**：进入 `writeDeny`，模型不能再改写角色目录（D8.1） |
| `session-events` 的子代理记账 | **有变化**：不再由它写 ledger 与归档，改由 `runs.ts` 统一结算（D7） |
| `job-manager.announce()` | **有变化**：唤醒改为先写 durable 记录再置 `notified`（D7）。对用户不可见，但它触碰的是 spec 031 加固过的投递链路，需回归覆盖 |
| `LoggedSubAgentRun` | 新增字段，只在终态归档；既有字段保留 |
| `workspaceSubjectHash` | **有变化**：纳入 untracked 文件内容，历史 attestation 的 hash 不再可比（attestation 已记录 `subjectDir`，按 run 重算即可） |
| `security.json` | **不变**。外部委派不引入任何配置段 |
| `ALLOWED_THINKING_LEVELS` | 新增 `max`，纯扩张 |
| agentmux | 不退休。保留 tmux / 人工 attach 场景；pipiclaw 不再依赖它 |

**`config.yaml` → 角色文件的迁移映射**（`examples/sub-agents/` 提供转换后的成品；用户的 system_prompt 是真正的资产，机械翻译，不重写）：

| agentmux | 角色文件 | 备注 |
|---|---|---|
| `templates.<name>` | 文件名 + `name` | — |
| `description` | `description` | 需补量级与代价措辞 |
| `command` | `command` | 分词成 argv，不再进 shell |
| `harness_type: claude-code-ndjson` | `harness: claude-code` | — |
| `harness_type: codex-cli-execjson` | `harness: codex-cli` | — |
| `harness_type: pi-rpc` / `claude-code`(tmux) | 不迁移 | discovery 产生 warning 并在 `/subagents list` 尾部列出，不静默丢失 |
| `model` | `model` | 原样 |
| `effort` | `thinkingLevel` | **换词**，见 D4 |
| `system_prompt` | 正文 | — |
| （无对应） | `mutates` | **必须新增**：agentmux 没有这个概念，迁移时按角色实际行为填 `read`/`write`（`planner`/`reviewer`/`scout` → `read`，`builder`/`documenter` → `write`） |
| `cwd` | 不迁移 | 工作目录改为每次委派由调用方传 `workingDirectory`（D5） |
| `defaults.shell` | `exec` 可用 `shell: true`；结构化 harness 改为包装脚本 | 结构化 harness 必须保留 runtime 的协议 argv 组装 |
| `defaults.env` | `env:` | — |
| `prompt` | 不迁移 | 首轮任务由调用方给 |
| `defaults.tmux` / `defaults.capture` / `defaults.status` / `max_instances` | 不迁移 | 属 tmux 路径或已由 runtime 承担 |

转换是**一次性工作**：模板只有个位数，`examples/sub-agents/` 直接提供转换后的成品，用户照抄即可，此后只面对 `sub-agents/` 目录，不会再回到 agentmux。因此不实现导入工具，也不实现独立的 `doctor` 命令——转换结果的自查信息（角色是否可用及原因、实际会启动的 argv）分别由 `/subagents list` 尾部与 `/subagents show` 承担。

## 实现顺序

按审查建议调整：先把状态机与契约做对，再接第一个真实 harness；`exec` 不作为首个生产路径。每阶段结束 `npm run check` 必须通过。

1. **run 状态机与契约**：`runs.ts`、三个幂等标记、launch intent 顺序、唤醒顺序修正（含 `job-manager` 同一处）、`runs.ts` 成为唯一结算权威、`session-events` 退出记账、ledger `runId` 幂等键与 `usageKnown`/`costKnown`、`store.ts` 字段扩展、`[SUBAGENT:...]` → `activateWaitingTask("external-signal")` 全链路。用 fake executor / fake harness 做崩溃注入。**此阶段结束时内置委派已完成异步化，外部尚未接入。**
2. **角色配置面、workspace lease 与授权面**：discovery 的 `runtime`/`harness`/`command`/`mutates`/`workload` 解析与字段合法性矩阵（含 external 的 `model` 不走 `models.json`、二进制缺失标 `unavailable`）、`workspace-lease.ts`（纯排他写锁，key 取 `workingDirectory` 的 realpath）、`workspace/sub-agents/` 写入拒绝、审计事件、`/subagents list|show|cancel`。此阶段后内置 run 也开始受 lease 约束。
3. **第一个结构化 harness：`codex-cli`**：`ExternalHarness` 接口、argv 组装与占位符、`ExternalOutcome` 全字段与状态判定表、外部 restore/reclaim、`follow_up`（resume）。选 codex 是因为它的短命进程模型与本设计天然一致，不需要为它发明任何新机制。
4. **`claude-code`**：stream-json 解析、`--session-id` 预指定与 `--resume`、cost/session 提取。
5. **`exec`**：通用兜底，受 D4/D9 的约束。
6. **收口**：`workspaceSubjectHash` 纳入 untracked 内容、`verificationStrength`、提示词目录分组、`agent-delegation.md` 与 `docs/sub-agents.md` 重写、`examples/sub-agents/` 外部角色成品。

## 测试

- **discovery**：`runtime: external` 解析；非法字段矩阵逐条驳回并产生 warning；external 的 `model` 不经模型解析；二进制缺失标 `unavailable` 而非丢弃，且错误不建议回落内置；`thinkingLevel` 夹取提示；角色文件写 `cwd` 时被驳回并产生 warning。
- **run 生命周期**（fake executor + fake harness）：宽限窗口内结算走内联返回且不唤醒；超窗降级返回 runId 且恰好唤醒一次；`cancel` 不唤醒；重复结算不二次记账、不二次唤醒。
- **崩溃注入**（每个都要有）：进程启动前崩、启动后持久化 pid 前崩、终态结算后崩、durable wake 入队后崩。断言：无孤儿进程记录、无重复记账、无重复唤醒、无丢失唤醒。
- **重启对账**：external 有 pid 记录 restore 后按探针与 `events.jsonl` 补发迟到唤醒；有 intent 无 pid 判 `lost` 并释放 lease；internal 判 `lost` 并唤醒；`wakeEnqueued` 已置位不重复唤醒。
- **harness 解析器**：用真实 CLI 采样的 `events.jsonl` fixture（成功、`turn.failed`、进程被杀截断、非法 JSON 行、**exit 0 但无终态**）驱动 `parseOutcome`；断言解析失败一律降级不抛，且无终态永不判 `completed`。
- **workspace lease**：两个 `mutates: write` run 竞争同一目录，后者被拒且错误点名持有者；`mutates: read` run 不取锁、不被阻塞；父子目录冲突被判定；lease 随 `settledAt` 与 `lost` 释放。
- **任务集成**：`waiting + waitingFor="external-signal"` → `[SUBAGENT:...]` 唤醒 → 激活 + attempt claim 的完整转移；driver 不重复调度已被委派认领的任务。
- **安全**：模型对 `workspace/sub-agents/` 的 `write`/`edit` 被拒；外部角色缺 `mutates` 时 discovery 驳回；每次派发写出 `type: "external-agent"` 审计事件且不受 `audit.logBlocked` 影响；per-channel 上限触发时错误带可执行下一步。
- **verify**：外部角色声明 `mutates: write` 或 harness 为 `exec` 时 `purpose=verify` 被拒；目标目录上有活跃写 lease 时 verify 被拒；untracked 文件内容变化能被 `workspaceSubjectHash` 检出；attestation 含 `verificationStrength` 且 `advisory` 在唤醒文本中可见。
- **成本**：`costKnown: false` 的 run 在 `/usage` 展示为未知而非 0。
- **e2e（opt-in，`vitest.config.e2e.ts`）**：每个 harness 一个真实冒烟，防 CLI schema 漂移；默认不在 `npm run test` 中运行。

## 与实现的偏差

2026-08-09 一轮审查（`docs/subagent-chain-review-2026-08-09.md`）核实并修复了本文档承诺、但实现当时尚未兑现的几处生命周期缺口（重启后不重新接管外部进程、结算副作用顺序、外部路径缺任务信封等）；这些已收敛，不再是偏差。以下三处是仍然存在、有意保留的偏差：

1. **`effort` 的外部语义与本文档不同**。本文档设想外部 `effort` 用 `600/1800/5400s`；修复前的实现把内置的 `120/300/900s` 元组直接套用到外部角色（`deep` 反而比外部默认墙钟更短）。现已改为：外部角色的 `effort` 只移动 `maxWallTimeSec`，取值为 `quick=600s`/`deep=5400s`，`standard` 或不传沿用角色自身配置（`docs/sub-agents.md` 已同步）。
2. **`fingerprint` 被 `pidStartedAt` 取代**。本文档与早期实现设想的随机 `fingerprint` 从未被消费、对 PID 复用零防护；现改为持久化 `ps` 的 `lstart` 输出，重启和周期性 sweep 都据此核实一个 pid 是否仍是原来那个进程，而不是已被复用的另一个。
3. **本文档设想的 24 小时辅助产物清理未实现**。`SubAgentRunManager` 的 GC 只清理终态 run 记录本身（`collectGarbageIfExpired`），不清理 `subagent-artifacts/` 下的 `events.jsonl`/`stderr.log`/`output.md` 等文件；这些产物目前无限期保留，需要人工清理磁盘空间。

## 风险

1. **CLI schema 漂移**。三个适配器都钉在目标 CLI 当前版本的实测行为上，升级会打破解析。缓解：`parseOutcome` 禁止抛异常、无终态永不判成功、每 harness 一个 opt-in e2e 冒烟、`/subagents show` 显示实际 argv 供人复核。这是吸收进来后 pipiclaw 必须长期承担的维护成本。
2. **自授权路径未被完全封死，且这是有意的取舍**（P4）。D8.1 的 writeDeny 封住 `write`/`edit`，封不住 `bash`——与 2026-08-06 审查报告记录的 memory 写入同属一个已知缺口。能真正封死它的手段（信任闸门、停止热加载）都会让日常配置多一步，对个人项目不划算，因此明确不做。兜底是把 `workspace/` 纳入版本控制 + 每次派发的 argv 审计，让变更与实际执行都可见、可回溯。
3. **外部副作用 × at-least-once**。见非目标。run 层的重复投递已被三个幂等标记挡住，但一个已经 push 的外部 builder 被重新派发仍会造成真实伤害。显式记为已知缺口，避免"外部委派已是主路径"给人以已经安全的错觉。
4. **主代理仍可与委派并发写同一棵树**。D10.1 明写了这个边界。文档与可见性是当前唯一的补法，独立 worktree 是唯一可靠的解。
5. **成本不可见**。外部 agent 烧的是另一份订阅额度，`codex-cli` 连 token 都只报部分，`exec` 什么都没有。缓解：`usageKnown` / `costKnown` 如实传播，展示面显示未知而非 0。
6. **异步化改变了钉钉侧的节奏**。重活从"等着出结果"变成"收到，回头叫你"。这是有意的，但要在文档里讲明白，否则会被当成回归。
7. **角色 description 写不好，路由照样错**。`workload` / `mutates` 让路由多了两个可判定维度，但选谁仍主要由 description 决定。缓解在文档与 `examples/` 的质量上，不在代码里。

# Task Ledger Phase 2：可见性与驱动力设计方案

> 历史设计：其中基于外部 heartbeat 的恢复路径和 wake/checkin 双写已由 [022 Native Task Driver](../022-native-task-driver/design.md) 取代；agentmux 专用传感器也已被 runtime playbook 分层取代。当前 Pipiclaw 不捆绑第三方 agent 工具脚本或状态协议，以 `src/playbooks/task-delegation.md` 和 `event-scheduling.md` 为准。

| 字段 | 值 |
|------|------|
| 分支 | `feat/task-ledger-phase2` |
| 状态 | IMPLEMENTED（2a + 2b；Phase 3 明确不做） |
| 日期 | 2026-07-08 |
| 前置 | [019（task ledger Phase 1）](../019-task-ledger/design.md)、015（tool registry）、009（memory recall 注入）、007（event preAction gate） |
| 关联实现（预期） | `src/agent/commands.ts`、`src/runtime/task-commands.ts`（新增）、`src/runtime/bootstrap.ts`、`src/runtime/dingtalk.ts`、`src/agent/channel-runner.ts`、`src/memory/task-digest.ts`（新增）、`src/settings.ts`；（2b）`src/tools/task-manage.ts`（新增）、`src/tools/registry.ts`、`src/tools/config.ts`、`src/tools/event-manage.ts` |

---

## 背景

Phase 1 把任务台账立了起来：`workspace/<channelId>/tasks/*.md` 承载意图/DoD/状态/手册，`event_manage` 让 agent 自我调度，心跳传感器兜底捞漏。但 Phase 1 刻意留了三块空白（见 019 §非目标）：

1. **台账对人不可见**。用户想知道"现在有哪些在途任务、卡在哪"，只能直接问 agent、触发一整个 LLM 回合。events 有 `/events list`，tasks 没有对等入口。
2. **台账对 agent 不是常驻上下文**。agent 每次唤醒都要靠 SOP 纪律去 `ls tasks/*.md`、`head` 读 frontmatter 才知道议程。这一步是"提示词让它做"，不是"运行时保证它看见"——一旦 agent 偷懒或上下文被别的事挤占，议程就被漏掉。心跳只保证"该醒时醒"，不保证"醒来就知道全局"。
3. **委派工作的回访仍是盲目轮询**。agent 委派给 agentmux 实例后，只能靠定时 one-shot 醒来 `agentmux capture` 看一眼——不管对方做完没做完都烧一个回合。缺一个"做完了才叫我"的完成驱动触发。

Phase 1 的赌注是"三字段 frontmatter + fail-open 传感器 + LLM 纪律"够用，并预告：LLM 维护结构化文件会漂移（本仓库 memory 子系统已验证过这个痛点），`task_manage` 工具"很可能在运营一段时间后就需要立项"。Phase 2 处理这三块空白，并对 `task_manage` 的必要性给出一个**证据门控**的答案，而不是反射性地造轮子。

## 目标

1. **可见性（读侧）**：`/tasks` 命令，让用户零 LLM 成本地查看台账——active 列表、单任务详情、archive 回顾。
2. **常驻议程（注入）**：每回合把一份**紧凑、确定性、有界**的任务摘要注入进 prompt，让 agent 无需依赖 `ls` 纪律就恒定知道在途工作。这是传感器的对侧：传感器决定"要不要醒"，摘要告诉"醒来后议程是什么"。
3. **完成驱动的委派回访**：给出 agentmux（及任何外部长任务）"做完才叫我"的触发范式，把盲目轮询换成传感器门控。
4. **`task_manage` 的立项判据**：分析其边际价值与代价，给出最小接口与"何时该建"的明确触发条件，把它放在 2b 且门控在运营证据上。

## 非目标

- **runtime 深度解析 task 正文 / task 成为一等数据模型**。台账仍是"文件约定 + 提示词 SOP"。`/tasks` 和摘要注入都只读 frontmatter + 首个标题，不解析 DoD/手册/日志的语义。
- **`/tasks` 变成台账编辑器**。用户侧命令保持只读（见 §1 的取舍）。写台账仍是 agent 的职责。
- **agentmux 状态的进程内原生 watcher / webhook 订阅**。Phase 2 用 preAction 传感器覆盖完成驱动；真正的事件订阅（agentmux 主动写 `events/`，或 pipiclaw 订阅 agentmux 生命周期）留作 Phase 3，仅在轮询延迟被证明不够时才立项（见 §4 升级路径）。
- **跨 channel 任务视图 / workspace 级台账**。延续 019 的 channel 隔离。

---

## 设计总览

Phase 2 分两个可独立交付的子阶段，按"零漂移风险的读侧先行、有写侧风险的自动化门控在证据上"排序：

| 子阶段 | 交付物 | 代码面 | 风险 |
|--------|--------|--------|------|
| **2a 可见性** | `/tasks` 命令 + prompt 任务摘要注入 + agentmux 完成驱动的**文档范式**（基于既有心跳，零新机制） | 只读路径 + 一个注入块 + 一份设置 | 低（不改台账写入语义） |
| **2b 自动化** | `task_manage` 工具（证据门控）+ event_manage 的**条件式 periodic 频率下限放宽**（可选，为分钟级 agentmux 回访） | 新工具 + 一处 event_manage 校验调整 | 中（新写侧工具、放宽一道自激励闸门） |

2a 无需 2b 即可上线并产生价值；2b 的两项都各自门控、可分别决策。

---

## 一、`/tasks` 命令（读侧可见性）

### 定位与取舍：为什么只读

events 的 `/events` 有 `delete`，但 tasks 命令**刻意不提供任何写操作**。理由：

- task 文件是 **agent 的工作记忆**，frontmatter 与正文（当前周期日志、DoD 勾选状态）强耦合。用户从命令行改 status 或删文件，会与 agent 下一回合的读写脱同步，且绕过了"done → archive + 清理 `task.*` 事件"这条闭环 SOP，制造孤儿事件。
- events 可删是因为 event 无状态、可丢弃（019 核心不变式）；task 恰恰相反——**真相在 task 文件里**，不该被一个无上下文的 CLI 动作随意改动。
- 用户想改任务，正确姿势是用自然语言告诉 agent（"这个任务不做了"），由 agent 走完整闭环。命令只负责"看"。

因此 `/tasks` 是纯读、零 LLM 成本、与 `/events list`/`/status`/`/usage` 同型（transport 层直接渲染文件、`sendPlain` 回投）。

### 接口

```text
/tasks                 # 列出 active 任务（tasks/ 根目录下所有 .md），按可推进优先排序
/tasks show <id>       # 显示单个任务文件全文（active 或 archive 均可）
/tasks archive         # 列出 archive/ 下已闭环任务（只列名 + 标题，不展开）
```

- `<id>` 复用与事件名一致的字符集校验 [`normalizeEventName`](../../src/runtime/event-commands.ts) 同型的 kebab-case + traversal 拦截（`.`/`..`/`/` 拒绝），防 `/tasks show ../../secrets`。
- 无参 `/tasks` == `/tasks list`。
- 命令是 **channel 作用域**：只读当前 `event.channelId` 的 `workspace/<channelId>/tasks/`，天然隔离，无需所有权校验（不像 events 是全局目录）。

### list 渲染

对 `tasks/*.md`（不含 `archive/` 子目录）逐个读 frontmatter 三字段 + 首个 `#` 标题，一行一任务，可推进的排在前：

```text
# Tasks (dm_015…): 2 active

- weekly-report — 周报编写与发布
  status: awaiting-user   wake: 2026-07-08T14:00 (2h)   recurrence: 每周一
- fix-voice-typer-ci — 修复 voice-typer CI
  status: in-progress     wake: —
```

排序键：**可推进优先**（status ≠ done 且 wake 已到/未设）在前，其余（wake 在未来）按 wake 升序在后。这与传感器 `isActionable` 的判据一致——用户一眼看到的顺序就是 agent 下一步会挑的顺序。frontmatter 解析失败的文件**照列**并标 `⚠ unreadable frontmatter`（不隐藏问题，与传感器 fail-open 精神一致）。

### 实现落点

镜像 events 命令的既有结构，改动量小且对称：

- `src/agent/commands.ts`：`BuiltInCommandName` 增加 `"tasks"`；`parseBuiltInCommand` 的 switch 增加 `case "tasks"`；`HELP_TEXT` 增补一段。
- `src/runtime/task-commands.ts`（**新增**，镜像 `event-commands.ts`）：`handleTasksCommand({ args, channelDir })` 解析子命令、读文件、返回 markdown 字符串。frontmatter 解析用一个与传感器语义一致的极简解析器（首个 `---` 块、逐行 `key: value`）。
- `src/runtime/dingtalk.ts`：handler 接口加 `handleTasksCommand`；busy 分支（`:1238` 一带）与"仅这些命令可用"的提示文案同步加入 `/tasks`。
- `src/runtime/bootstrap.ts`：实现 `handleTasksCommand`（`:675` 的 `handleEventsCommand` 同型，从 `options.paths` 拼 `workspace/<channelId>/tasks`）；非 busy 分支（`:789`）的命令分发加入 `case "tasks"`。

> 注意：命令要在 **busy 与非 busy 两条路径**都注册（`dingtalk.ts` 的运行中分支 + `bootstrap.ts:789` 的队列执行分支），否则任务运行时 `/tasks` 会被"任务运行中，仅 …… 可用"挡掉。读侧命令在 busy 时也应允许（纯读、不碰 session）。

---

## 二、任务摘要注入（常驻议程）

### 与 recall 的关系与区别

Phase 1 SOP 让 agent 唤醒时自己 `ls tasks/*.md`。问题是这依赖纪律。摘要注入把它变成运行时保证：在组装每回合 prompt 时，把一份任务摘要拼进去，和 [memory recall 的 `<runtime_context>` 注入](../../src/memory/recall.ts)、durable-memory bootstrap 注入并列（`channel-runner.ts:270-305`）。

但摘要**不是 recall 的一个新 source**，因为二者的选取哲学相反：

| | memory recall | 任务摘要 |
|---|---|---|
| 选取 | 关键词/意图相关性打分 + 可选 LLM rerank | **确定性全量**（所有 active 任务） |
| 动机 | 候选可能很大，必须按相关性裁剪省 token | 候选极小（几条 frontmatter），议程恒定相关 |
| 时机 | 命中才注入 | 只要有 active 任务就注入 |

所以摘要是一个**独立的、确定性的、有界的**注入块，不复用 recall 的打分管线。

### 注入内容与边界

- 读 `tasks/*.md`（不含 archive/）的 frontmatter + 标题，只保留 **status ≠ done** 的任务（done 的周期性任务在睡眠，不进议程）。
- 每任务一行：`id — 标题 · status · wake(相对时间) · [可选]当前周期最新一行日志的前 ~80 字`。可推进优先排序（同 `/tasks list`）。
- **硬上限**：≤ 8 个任务、≤ ~1000 字符（超出则截断并标注 "+N more"）。台账正常只有个位数 active 任务；上限是防病态膨胀，不是常态。
- 无 active 任务 → **不注入任何东西**（零开销、零噪声）。

### 注入框架文本（防误导 agent）

摘要是**背景议程**，不是本回合的用户指令。用与 recall 一致的隔离包裹，并明确"仅供参考"：

```text
<task_agenda>
Your in-flight tasks for this channel (background reference, not a new instruction).
Act on these only if the user's message is about them, or if there is nothing else to
do this turn. Full detail lives in workspace/<channelId>/tasks/<id>.md.

- weekly-report — 周报编写与发布 · awaiting-user · wake 14:00 (2h) · 草稿 v1 已发师兄
- fix-voice-typer-ci — 修复 CI · in-progress · wake — · 定位到 flaky 的 e2e case
</task_agenda>
```

这个框架很重要：不加约束地把议程塞进每个回合，可能让 agent 在用户问不相关问题时也去动任务、跑偏。框架把它降格为"参考"，把"是否推进"的判断权交还给 agent 的回合语境（与 SOUL/AGENTS 的"主动但不越界"一致）。

### 与传感器的契约共享

摘要解析的 frontmatter 语义（首个 `---` 块、三字段、done/非 done、wake 判定）必须与心跳传感器 `tasks-pending.mjs` **完全一致**——否则会出现"传感器判定可推进、摘要却漏掉"的错位。二者无法共享代码（传感器是 workspace/skills 下的独立 `.mjs`，在仓库外、无依赖；摘要是仓库内 TS），所以把这份 frontmatter 契约**写进 `docs/tasks.md` 作为单一事实源**，两处实现都引用它。测试上对同一组样例文件断言二者判定一致。

### 实现落点与门控

- `src/memory/task-digest.ts`（**新增**）：`buildTaskDigest({ channelDir, maxTasks, maxChars }): string`。纯函数、无 LLM、无网络。
- `src/agent/channel-runner.ts`：在 recall 注入之后、`preserveRawInput` 为假时，若 digest 非空，`promptText = ${digest}\n\n${promptText}`。同时进 `PIPICLAW_DEBUG` 的 `last_prompt.json`（`:307-317`）。
- `src/settings.ts`：新增 `PipiclawTaskDigestSettings { enabled: boolean; maxTasks: number; maxChars: number }`，`DEFAULT_TASK_DIGEST = { enabled: true, maxTasks: 8, maxChars: 1000 }`，settingsManager 暴露 `getTaskDigestSettings()`（与 `getMemoryRecallSettings` 同型）。默认开启——它便宜且高价值。
- **子代理不注入**：子代理有独立上下文、不驱动台账（与 `event_manage` 的 `availableToSubagents: false` 一致）。仅主 agent 回合注入。

---

## 三、`task_manage` 工具（2b，证据门控）

### 必要性分析（诚实评估，不反射造轮子）

019 已预告 task_manage"很可能需要立项"，理由是 memory 子系统的演化史证明"LLM 手动维护结构化文件会漂移"。但 Phase 1 才刚上线，**尚无本项目 task 台账的漂移证据**。KISS 要求：先看 2a 的 telemetry，再决定。

task_manage 相对"agent 裸用 write/edit + SOP"的**边际价值**只有三点，且都集中在 frontmatter 与闭环这两处"必须正确"的窄面：

1. **frontmatter 恒可解析**：工具校验 status ∈ 枚举、wake 是合法 ISO8601、只写这三个字段。→ 传感器与摘要不再因坏 frontmatter 而 fail-open 误唤醒 / 错位。
2. **闭环原子化**：`done` 一个动作里完成"置 done + 一次性任务移入 archive/ + 删除 `task.<channelId>.<id>.*` 残留事件"——正是 019 风险表点名的"agent 不遵守 SOP（忘清理）"最易出错的一步。
3. **状态转移可审计**：转移随工具调用留痕。

**代价**：多一个工具面；同一文件出现两个写者（frontmatter 走工具、正文 DoD/日志走 edit）。后者靠 run-queue 的 channel 级回合串行化免于竞态（同一回合内不会并发写），但概念上要求 agent 分清"改状态用 task_manage、改正文用 edit"。

**结论**：task_manage **值得建，但放 2b 且门控在证据上**。触发条件（满足任一即立即建）：
- 2a 上线后，摘要/传感器出现**因坏 frontmatter 导致的误唤醒/错位**（日志可查）；或
- `workspace/events/` 中出现 `task.*` **孤儿事件堆积**（闭环 SOP 被漏执行的信号）；或
- 运营中观察到 agent 反复写脏 status/wake。

在此之前，2a 的确定性读侧 + fail-open 已能安全运行。下面把接口定死，使触发时可立即实现、无需再设计。

### 接口（触发时按此实现）

镜像 `event_manage`（label + action + 参数、纯函数 `manageTask` + 薄封装）。**只管 frontmatter 与生命周期副作用，不碰正文**——正文仍由 write（创建）/ edit（DoD、日志）负责：

```ts
const taskManageSchema = Type.Object({
  label: Type.String(),
  action: Type.Union([Type.Literal("set"), Type.Literal("done"), Type.Literal("list")]),
  id: Type.Optional(Type.String()),        // set/done 必填；list 忽略
  status: Type.Optional(...),              // set：open/in-progress/awaiting-user/blocked
  wake: Type.Optional(Type.String()),      // set：ISO8601，校验可解析；空串=清除
  recurrence: Type.Optional(Type.String()),
});
```

- **set**：读目标文件 → 解析 → 替换 frontmatter 块（保留正文逐字节不动）→ 原子写。校验 status 枚举、wake 可解析。不允许把 status 设成 `done`（闭环走 `done` action，因为它带副作用）。
- **done**：置 `status: done` → 若是一次性任务（无对应 `task.<channelId>.<id>.schedule` periodic 事件）则移入 `archive/`；周期性任务留原地 → 删除 `task.<channelId>.<id>.*` 的残留 one-shot 事件（复用 `resolveEventPath` + unlink）。一步闭环。
- **list**：返回结构化的 active 任务列表（供 agent 用，与 `/tasks` 面向用户的渲染共享底层解析）。
- **create 不入工具**：新建任务的大头是正文（目标/DoD/手册），用 write 一次落更自然；frontmatter 初值简单（`status: open`）。硬把 create 塞进工具只会重复 write 的能力。
- 路径安全：与 event_manage 同——工具自带 kebab-case + traversal 校验，不依赖 path-guard（task_manage 也直接落盘）。
- 注册：`TOOL_REGISTRY`，`availableToSubagents: false`，`enabledBy: tools.tasks.enabled`（`config.ts` 三处同步，默认 true）。

> 说明：task_manage 与 event_manage 一样是**建议性**入口，不封 agent 的 write（agent 合法地用 write/edit 写正文，无法对 tasks/ 做 write-deny）。它的价值是"便捷 + frontmatter 保真 + 闭环原子化"，不是权限收口。

---

## 四、agentmux 完成驱动触发

### 问题

agent 用 agentmux 委派编码任务后，需要在对方**做完时**接手。目前只能定时 one-shot 醒来 `agentmux capture` 探一眼——对方还在忙也烧一个 LLM 回合。要的是"idle/exited 了才叫我"。

### 为什么必须是 periodic + preAction（而非 one-shot）

传感器只有退出码、不能"改期自己"。若用 one-shot + agentmux 传感器：到点若对方仍忙，preAction 退 1 → 回合被静默跳过 → 但 one-shot 已触发即消耗 → **没有下一次探测**，卡死。要自主轮询到 idle，只能用 **periodic + preAction 门控**：每隔几分钟传感器跑一次，忙则静默（零 token），idle 才唤醒 agent。这与 019 已认可的"正确姿势 = periodic + preAction 传感器门控"完全一致，只是传感器从"台账有活"换成"实例空闲"。

### 传感器与任务联动约定

```bash
# ~/.pi/pipiclaw/workspace/skills/agentmux-idle.mjs <instanceName>
# exit 0（唤醒）当且仅当实例存在且 status ∈ {idle, exited}
# exit 1（静默）当 status = busy（还在干）
# fail-open：list/inspect 失败或实例 lost → exit 0，让 agent 醒来处置
```

联动：agent 委派时——
1. 在 task 文件正文记下实例名（`agentmux 实例：编码助手-A`）。
2. 用 `event_manage` 建 periodic 事件 `task.<channelId>.<id>.agentmux`，文本"推进任务 <id>（agentmux 实例已就绪）"，preAction 为 `node …/agentmux-idle.mjs 编码助手-A`。
3. task 置 `blocked`（等外部条件），`wake` 设一个远期兜底点（心跳仍会在 wake 到期时兜底捞起，防传感器/实例双双失灵）。
4. agent 醒来（对方 idle）→ `agentmux capture` 取结果 → 验收 → 推进/闭环 → **删除该 agentmux periodic 事件**（连同 task 收尾 SOP 的事件清理一起做）。

### 两档实现，按延迟需求选

**基线（2a，零新机制）**：不建专用事件，靠既有心跳。task 停在 `blocked`/`in-progress`、`wake` 到期，心跳整点扫到 → agent `agentmux inspect` 探状态 → 忙则把 `wake` 推后再睡，闲则接手。**代价**：粒度 = 心跳间隔（约 1 小时），对分钟级编码任务偏慢，但零代码、零新事件。文档把它写成默认范式。

**响应式（2b，需一处 event_manage 调整）**：允许 agent 自建上面的分钟级 agentmux periodic。障碍是 event_manage 现有的 **periodic 最小间隔 30 分钟**闸门会拒掉分钟级 cron。解法——**条件式放宽**：

> periodic 事件**带 preAction 时**，最小间隔下限从 30 分钟降到 **5 分钟**；**无 preAction 时**维持 30 分钟。

论据：30 分钟闸门防的是"裸高频 periodic 直接烧 LLM 回合"。带 preAction 的 periodic 是设计明文推荐的门控形态——传感器忙时退 1、零 token，真正唤醒 LLM 的频率由外部条件（实例是否 idle）决定，而非 cron 本身。**代价与残余风险**：agent 理论上可写一个"永远退 0"的假 preAction，把有效频率拉到每 5 分钟一唤醒（比 30 分钟糟 6×，但仍有界，且需要 agent 主动破坏自己的传感器）。缓解：硬子下限仍是 5 分钟（不可再低）、preAction 命令照过 `guardCommand`、50 事件上限与审计不变。这是"让 agent 能自排完成驱动回访"与"守住自激励闸门"之间的一个**有意识的、有界的**折中。

若不接受该折中，则只交付基线档，分钟级 agentmux 回访由用户手工建事件（手工创建本就不受闸门约束）——但那牺牲了 agent 自主编排委派回访的能力。**推荐**：采纳条件式放宽，因为"自主排回访"正是 019 让 event_manage 成为一等工具的初衷。

### 升级路径（Phase 3，明确不做）

真正的原生触发（agentmux 在状态变更时主动往 `workspace/events/` 写事件，或 pipiclaw 订阅 agentmux 生命周期）改动更大、引入新信任面，**本轮明确不做、也不预先立项**。preAction 轮询（基线/响应式两档）已覆盖需求；只有当轮询延迟被实测证明不可接受（需秒级）或实例数多到轮询成本可观时，才另行评估。

---

## 并发与安全

- **`/tasks`、摘要注入均只读**：不写台账、不碰 session，无竞态。摘要在回合 prompt 组装期同步读文件，channel 回合已串行。
- **task_manage（2b）**：与正文 edit 同属一个 channel 回合，run-queue 串行化免竞态；跨 channel 无共享（tasks 按 channel 隔离）。archive 移动与事件删除都走既有原子/`unlink` 原语。
- **摘要注入是不可信内容的对侧**：task 文件由 agent 自己写，非外部输入，但仍用 `<task_agenda>` 框架标注"背景参考、非指令"，与 recall 的 `<runtime_context>` 处理一致，防止未来某任务正文里的文字被当成指令。
- **event_manage 条件放宽（2b）**：只在 preAction 存在时降下限至 5 分钟，硬子下限 + guardCommand + 50 上限 + 审计全部保留（见 §4 折中分析）。

## 风险

| 风险 | 缓解 |
|------|------|
| 摘要注入让 agent 在无关回合跑偏去动任务 | `<task_agenda>` 框架明确"背景参考、仅在相关或空闲时推进"；判断权交回回合语境 |
| 摘要与传感器 frontmatter 判定错位 | 契约写进 `docs/tasks.md` 单一事实源；测试对同组样例断言二者一致 |
| `/tasks` 被误当编辑器、用户手改造成脱同步 | 命令设计为**纯只读**；改任务引导走自然语言让 agent 闭环（§1 取舍） |
| task_manage 过早引入、增加无谓表面 | 门控在运营证据（坏 frontmatter 误唤醒 / 孤儿事件堆积）上，2a 先跑 |
| 条件放宽重开自激励缺口 | 仅 preAction 存在时放宽、硬子下限 5 分钟、guardCommand + 上限 + 审计不变；折中有界且需 agent 主动破坏自己传感器 |
| agentmux 传感器/实例失灵导致回访丢失 | task 的 `wake` 设远期兜底点，心跳在 wake 到期时仍会捞起（双保险，延续 019 "真相在 task 文件"分层） |

## 测试

- `test/task-commands.test.ts`（新增）：list 排序（可推进优先）、show（active/archive/不存在）、archive 列举、坏 frontmatter 照列并标注、`show ../../x` traversal 被拒、空目录文案。
- `test/task-digest.test.ts`（新增）：非 done 任务入摘要、done 被排除、可推进优先排序、maxTasks/maxChars 截断与 "+N more"、无 active 任务返回空串、`<task_agenda>` 框架文本存在、**与传感器判定一致性**（同一组样例，摘要收录集合 == 传感器 actionable 集合）。
- `test/tool-registry.test.ts`、`test/tools-index.test.ts`、`test/tools-config.test.ts`：2b 时按 019 同样的方式追加 `task_manage`（主集名、config gate、ALL_TOOL_NAMES）。
- `test/event-manage.test.ts`：2b 时补条件放宽用例——带 preAction 的 5 分钟 periodic 通过、无 preAction 的 5 分钟被拒、带 preAction 的 4 分钟仍被拒（硬子下限）。
- `test/task-manage.test.ts`（2b 新增）：set 只改 frontmatter 保正文逐字节不变、wake 非法被拒、set 到 done 被拒；done 对一次性任务 archive + 清事件、对周期性任务留原地 + 清事件；跨 channel 无涉（channel 隔离）。

`/tasks` 与摘要的 e2e 真实体验、agentmux 传感器由运营验证。

## 文档更新

- `docs/tasks.md`：新增"`/tasks` 命令"节；新增"任务摘要注入"节（含 `<task_agenda>` 样例与"仅供参考"语义）；**新增 frontmatter 契约小节作为单一事实源**（摘要与传感器共同引用）；agentmux 完成驱动范式（基线档 + 响应式档）与 `agentmux-idle.mjs` 全文。
- `docs/events-and-sub-agents.md`：`event_manage` 节补条件式频率下限（带 preAction 5 分钟 / 否则 30 分钟）与其用途（完成驱动回访）。
- `docs/configuration.md`：新增 `taskDigest`（settings.json）与（2b）`tools.tasks.enabled`（tools.json）门控。
- `~/.pi/pipiclaw/workspace/AGENTS.md`（运营）：SOP 补"委派 agentmux 时记实例名 + 建 agentmux 完成驱动事件 + 闭环时一并删除"。

## 成功标准

1. 用户 `/tasks` 零 LLM 成本看到 active 任务列表，顺序即 agent 下一步会挑的顺序；`/tasks show <id>` 看到全文；`/tasks archive` 回顾已闭环任务。
2. agent 每回合 prompt 里恒定带 `<task_agenda>`（有 active 任务时），即使不 `ls tasks/` 也能报出在途工作；无 active 任务时不注入、零开销。
3. 摘要收录的任务集合与心跳传感器判定"可推进"的集合在同组样例上完全一致。
4. agentmux 委派后，基线档下心跳能在 wake 到期时接手；（若采纳 2b）响应式档下 agent 能自建带 preAction 的分钟级 periodic，对方 busy 时零 token、idle 时被唤醒接手。
5.（2b 触发后）task_manage 的 `done` 一步完成置 done + archive + 清 `task.*` 事件，运营中 `task.*` 孤儿事件不再堆积。

## 分阶段

- **Phase 2a（已实现）**：`/tasks` 命令 + 任务摘要注入 + agentmux 完成驱动基线档文档。落点：只读命令路径（`agent/commands.ts` / `runtime/task-commands.ts` / `runtime/dingtalk.ts` / `runtime/bootstrap.ts`，TUI 侧 `tui/commands.ts` / `tui/turn-controller.ts` / `tui/app.ts`）、注入块（`memory/task-digest.ts` / `agent/channel-runner.ts`）、共享读层（`shared/task-ledger.ts`）、设置（`settings.ts`）。台账写入语义零改动。
- **Phase 2b（已实现，本次一并交付而非等证据门控）**：
  - `task_manage` 工具（`tools/task-manage.ts` + registry + config 三处门控），只管 frontmatter 与闭环。
  - event_manage **条件式 periodic 频率下限放宽**（带 preAction 降至 5 分钟，硬子下限 5 分钟）。
- **Phase 3：明确不做。** agentmux 状态原生 watcher / 事件订阅（秒级、免轮询）不在本轮范围，也不预先立项——preAction 轮询传感器（基线/响应式两档）已覆盖需求；只有当轮询延迟被实测证明不可接受时才另行评估。

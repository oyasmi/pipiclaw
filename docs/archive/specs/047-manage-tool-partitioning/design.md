# 收尾三个 `*_manage`：形状不同就拆，形状相同就合，op 枚举的散文是那笔税

| 字段 | 值 |
|------|------|
| 状态 | IMPLEMENTED（P1–P4b 全部完成）|
| 日期 | 2026-08-27 |
| 触发 | 046 落地后回看剩下三个按 `action`/`op` 路由的工具（`memory_manage` / `event_manage` / `subagent_manage`，合计 572 units = 工具集的 20%），逐个用 046 的判据复核，结论与 046 当时的预判有两处不一致 |
| 前置 | 046 tool-schema-partitioning（本 spec 是它的收尾）、021 toolset-enhancement、026 system-prompt-slimming、031 wake-layer-hardening（D7 effect ledger）、037 memory-probation、040/042 委派、044 native-file-io |
| 关联实现 | `src/tools/memory-manage.ts`、`src/tools/event-manage.ts`、`src/tools/subagent-manage.ts`、`src/tools/registry.ts`、`src/tools/index.ts`、`src/tools/tool-details.ts`、`src/tools/presentation.ts`、`src/agent/effect-ledger.ts`、`src/agent/session-events.ts`、`src/agent/turn-recovery.ts`、`src/runtime/event-commands.ts`、`src/subagents/runs.ts`、`src/playbooks/memory-and-learning.md`、`src/playbooks/event-scheduling.md`、`src/playbooks/agent-delegation.md` |

## 摘要

046 把 `task_manage` 和 `subagent` 按 payload 形状切开，并留下一句判断："`memory_manage` 是下一个自然候选，`subagent_manage` 不该拆，`event_manage` 已经是正确形态。" 实测之后，其中两句需要修正。

本 spec 对剩下三个工具逐个复核，只做四件事，按性价比排序：

| 阶段 | 内容 | units | 工具数 |
|---|---|---|---|
| **P1** | `event_manage` 增加 `action: "list"` | 141 → 153（+12） | 0 |
| **P2** | 删掉 `memory_manage` 的 `kind` 参数 | 237 → 200（−37） | 0 |
| **P3** | `subagent_manage` → `subagent_list` + `subagent_run` | 194 → ≈129（−65） | +1 |
| **P4** | `memory_manage` → `memory_save` / `memory_search` / `memory_forget` | 200 → ≈182（−18） | +2 |

三个工具合计 **572 → ≈464 units（−108）**，工具集 2,868 → ≈2,760，工具数 22 → 25。

**明确不做**：不拆 `event_manage`（实测 +86 units，且 create/update 形状相同）；不把 `subagent_manage` 拆成四个（cancel/show 形状相同）；不删 `follow_up`。理由见「不做什么」。

本 spec 补出的一条比 046 更短的规则：

> **形状不同就拆，形状相同就合。`op` 枚举的散文——它把每条分支各讲一遍——才是那笔税。**

046 的结论"切分不省 token，省 token 的是描述瘦身"只在它自己的两个工具上成立：那两个工具的描述已经被 P1 削到底，剩下的开销是重复的 `id` 和 `control` 块。这三个工具相反，描述从未瘦身过，`op` 的路由说明是主要成本，所以**在形状真正不同的地方，切分是省 token 的**。

## 当前事实与证据

### 测量口径

与 046 一致：`measureToolSchemas`（`src/agent/prompt/manifest.ts:49-60`）的口径，即 `name + description + JSON.stringify(parameters)` 的 prompt units。测量前 `rm -rf dist && npm run build`——`dist/` 会落后于 `src/`，046 就在这上面踩过一次。

### F1 基线：三个工具吃掉 20% 的 schema 预算

046 P1–P3 落地后（commit `e11fcce`），web 开启、`subagent_inline` 开启，工具集共 **22 个工具 / 2,868 units**（`TOOL_SCHEMA_TARGET_UNITS = 3_000`，尚有余量）。

| 工具 | units | 运行时必填检查 | payload 形状 |
|---|---|---|---|
| `memory_manage` | **237** | 3 | save / search / forget **完全不相交** |
| `subagent_manage` | **194** | 2 | list 形状独立；cancel / show **形状相同** |
| `event_manage` | **141** | 1 | create / update **形状相同** |

对照 046 拆完之后的任务族（`task_create` 187、`task_update` 264、`task_close` 102、`task_verify` 40、`task_list` 13）与委派面（`subagent` 158、`subagent_inline` 339）。

### F2 `event_manage` 的问题不是分区，是模型看不见自己的事件

拆分实测是明确亏本：

| 形态 | units | Δ |
|---|---|---|
| 今天 | 141 | — |
| 拆 3 个（create / update / delete） | **227** | **+86** |
| upsert 2 个（`event_set` / `event_delete`） | 154 | +13 |

`create` 与 `update` 的参数集**完全一样**（`name` + `definition`），只差一个"文件存不存在"的前置条件。这正是 046 F7(a) 说的"同一形状内的状态迁移应当合在一起"，按 046 自己的规则就不该拆。

真正的缺口在别处。**模型无法枚举自己创建的事件**，三处核实：

1. 工具本身只有 `create` / `update` / `delete`（`event-manage.ts:16`），没有任何读取路径。
2. 系统提示里没有 events 段——`MAIN_PROMPT_SECTIONS`（`src/agent/prompt/sections.ts:287-296`）是 identity / execution / invariants / tasks / playbooks / subagents / soul / agents / boundary，没有事件。
3. 唤醒载荷不带事件名：`src/runtime/channel-event.ts` 与 `src/agent/channel-runner.ts` 全文没有 `eventName` 引用。

而 `/events list` 是纯用户命令（`runtime/event-commands.ts:92`）。于是 `event-scheduling.md` 的「维护纪律」——"更新事件时整体替换 definition，不再需要就及时删除"——和 task-owned 事件的闭环清理，全靠模型按 `task.<channelId>.<taskId>.<use>` 约定把名字**凭记忆重建**出来。一个 periodic 传感器跑了两周之后再要求模型"退役它"，模型手里没有任何句柄。

今天模型能拿到的唯一存在性信号，是 `create` 撞到已存在时报的那句 `Event "X" already exists; use action "update" to replace it.`——**用一次失败的写去探测读**。这既是保留 create/update 分开的理由，也是补 `list` 的理由。

在真实字符串上实测：给现有单工具加一个 `list` 分支是 141 → **153（+12 units）**。

### F3 `memory_manage.kind` 的唯一消费方是一条人类命令的显示

`kind` 是六值枚举（`memory-manage.ts:35-47`），占 **37 units**（删掉后 237 → 200——比字段描述本身更贵，因为 union 的 JSON 结构也一起消失），并且**每次 save 都要模型做一次决策**。

把消费方全查了一遍：

| 可能的消费方 | 实际 |
|---|---|
| MEMORY.md 里的落位 | **否**。`applyChannelMemoryOps` 的 add 路径（`memory/files.ts:247-272`）统一 append，不按 kind 分章节 |
| 召回打分 | **否**。`recall.ts:543-550` 打分用的是 `candidate.sectionKind`，即**章节标题**（`candidates.ts:120`），不是 metadata 的 kind |
| 试用期 / 晋升 / consolidation | **否**。`promotion.ts` 只在类型里带 kind，没有分支读它 |
| `/memory` 列表显示 | **是**，唯一一处：`memory/commands.ts:136` 渲染 `[${record?.kind ?? "fact"}]` |

而 `metadata.ts:123` 在没有 hint 时本来就用 `inferKind(entry.sectionHeading)` 兜底。也就是说：模型每次 save 付一个决策 + 常驻 37 units，换来的是一个人类命令里的装饰性标签，而这个标签在模型不传时也有合理默认值。

后台 consolidation 走的是 `extraction.ts` 的 `memoryOps`（`extraction.ts:34-35`），那条路径自己带 kind，**不受本改动影响**——`/memory` 里绝大多数条目的 kind 仍然是真的。

### F4 `memory_manage` 的三处运行时检查里，有一处不是普通必填

三种 payload 完全不相交，是三个工具里最干净的：`save{content, kind?, supersedes?}` / `search{query}` / `forget{target}`。三处 `rejectMissingArgument`（`memory-manage.ts:147,213,251`）全部只为表达"这个 op 的这个字段必填"。

拆分实测**省 token**（与 046 的两个工具相反）：

| 形态 | units |
|---|---|
| 今天 | 237 |
| 拆 3 个 | 201（−36） |
| 拆 3 个 + 去掉 `kind`（P2 之后的实际形态） | **≈182** |

原因是 `op` 枚举把三条分支各讲一遍，加上每个字段 `"Required for save:"` / `"For search:"` 这类前缀——拆开后全部消失。

**但 `rejectMissingArgument` 不是普通的必填检查**，它对应一次真实事故（`evals/cases/regression.ts:143-167`，`M-write-03`，reported 2026-07-24）：流式 tool-call 参数被宽松解析，长非 ASCII 值上 JSON 尾部被截断，尾部 key 静默丢失，模型下一轮读回自己那次缺 `content` 的调用、照抄、死循环。它的报错专门写着"不要照原样重发上一次调用，它是在传输中丢的"，并且写一条 operator 侧的 warning log（`memory-manage.ts:127-130`）。

核实 pi 侧的时机：`agent-loop.js:404` 在 `execute` **之前**调用 `validateToolArguments`，后者用 TypeBox `Compile().Check` 校验（`pi-ai/dist/utils/validation.js`）。所以 `content` 一旦变成 schema 必填：

- 这次拒绝发生在 `execute` 之前，**那条定制提示和 warning log 都不会执行**；
- 替代它的是通用报错 `Validation failed for tool "memory_save": - content: ... Received arguments: {...}`。它够响（`isError: true`），死循环不会回来；
- 但它**没有经过 `withToolDetails`**（`tools/tool-details.ts:82`），所以结果里没有 `details.kind`，也没有 `recoverable: true`。

最后一条有用户可见的后果：`session-events.ts:199-215` 用 `isRecoverableRejection` 把"模型自己能改的拒绝"从进度卡里挡掉。校验失败拿不到那个标记，于是 `treatAsError` 为真，走 `logToolError` 并在进度卡里渲染一条红色错误——**今天安静的丢参重试，拆分后会变成用户眼前的一次报错**。

这不是拆分的理由，是拆分要一并修的东西（D4.2）。

### F5 `subagent_manage`：046 的"不拆"结论只对了一半

046「不做什么」写的是"list/cancel/show 共享 `runId` 且形状一致……拆成四个工具更贵且没有换来任何合法性"。实测两处不成立：

| 形态 | units | 工具数 |
|---|---|---|
| 今天 | 194 | 1 |
| 拆 4 个 | 158（−36） | 4 |
| **`subagent_list` + `subagent_run{op, runId, task?}`** | **≈129（−65）** | **2** |

- **不是更贵**：拆开省 36 units，因为 `op` 的路由说明在工具描述和枚举描述里各写了一遍四条分支。
- **`list` 并不共享 `runId`**：它是零参数，形状与另外三个不同。046 把 `task_list`（13 units，零参数）单独拆出来正是同一个理由，这里漏用了自己的判据。
- **但 `cancel` 和 `show` 的参数集完全相同**（只有 `runId`），拆开等于按动词切——和 F2 的 `event_create`/`event_update` 是同一个反模式。

所以正确的切法是两个而不是四个：`list` 出去，其余三个 op 留在一起。

### F6 `op=follow_up` 不计入 EFFECT_TOOLS——046 D2.4 那类静默故障的既有实例

```ts
// src/agent/effect-ledger.ts:27
const EFFECT_TOOLS = new Set(["write", "edit", "send_media", "subagent", "subagent_inline"]);
```

`subagent_manage` 不在里面。`op=list` / `show` / `cancel` 不该在，这没问题；但 **`op=follow_up` 会真的派发一个新的外部 run**（`subagent-manage.ts:351-384`），它和 `subagent` 一样是"对世界的可见改变"。

后果与 046 D2.4 描述的完全一致：一个靠 `follow_up` 连续推进的任务，三次 wake 之后会被治理器判为空转并停用（`task-driver.ts` 的 futile 计数）。**这是既有 bug，不是拆分引入的**，但拆分正好经过这里，一并修掉。

修法有现成的座位：`isEffectfulTool(toolName, details)`（`effect-ledger.ts:82`）**已经能读 `details`**——`bash` 就是靠它区分 `ls` 和后台启动的。

### F7 规则：`op` 枚举的散文是那笔税

把 F2/F4/F5 三组数字并排看，规律很干净：

| 工具 | 各 op 的 payload | 拆分 Δunits |
|---|---|---|
| `memory_manage` | 三个都不同 | **−36** |
| `subagent_manage` | list 独立，另外三个里两个相同 | 2 拆 **−65**；4 拆 −36 |
| `event_manage` | create/update 相同 | **+86** |

形状真正不同的地方，拆分省 token（省掉 `op` 描述里的分支枚举和字段描述里的 `"Required for X:"` 前缀）；形状相同的地方，拆分要重复付工具名、描述和共享字段。

046 的"切分要倒贴"是它那两个工具的局部事实，不是通则。通则是本 spec 标题那一句。

## 设计原则

**P1 补能力优先于改形状。** 一个模型无法读取自己写入的子系统，缺的是 op 不是分区。先把 `list` 补上，再谈要不要拆——事实上补完就不用拆了。

**P2 一个参数如果只服务人类的显示，它不该出现在模型的 schema 里。** 判据是 046 那条的推论：schema 里的字段必须影响这次调用的行为。`kind` 影响的是 `/memory` 的一行渲染。

**P3 形状不同就拆，形状相同就合。** 两个 op 的参数集完全相同时，拆开只是按动词切，重复付名字和描述，不换来任何 schema 层的合法性。

**P4 切分不得把一次拒绝从"安静可恢复"降级成"用户可见的错误"。** 拒绝的位置从 `execute` 前移到校验层是好事，但呈现层要跟上（D4.2）。

**P5 沿用 046 P4：切分只用独立工具，不用 root-level union。** 理由不变（`models.json` 允许任意 OpenAI 兼容端点，root-level `oneOf` 在 strict function calling 下不被接受）。

## D1 `event_manage` 增加 `action: "list"`（P1）

### D1.1 调用面

`action` 枚举加一个 `list`；`name` 与 `definition` 保持 optional（`list` 两个都不需要）。schema 层唯一的变化是枚举多一项和两句描述各加半句，实测 141 → **153 units**。

不拆成 `event_list` 独立工具：那要重复付一遍工具名和描述（实测独立形态 ≈35 units，比 +12 贵），而 `event_manage` 已经是本仓库最便宜的 action 工具，再拆一个零参数分支出去是 046 F6 说的"贵的不是 action 这个形状"的反向教训。

### D1.2 必须按 channel 过滤

`runtime/event-commands.ts:92` 的 `listEvents` 渲染 `workspace/events/` 下的**全部**文件，不分 channel——它服务的是人，人有权看全局。工具版**必须过滤 `event.channelId === options.channelId`**，与 `readOwnedEvent`（`event-manage.ts:125-128`）拒绝跨 channel 修改的边界保持一致：模型能看见的，恰好是它能改的。

### D1.3 输出形状

每个事件一行，不复用 `formatEventSummary` 的五行块（`MAX_EVENT_FILES = 50`，最坏情况 250 行进上下文）：

```
- <name> [one-shot] at 2099-01-02T10:00:00+08:00 — Review release candidate RC-17
- <name> [periodic] 0 9 * * 1-5 (preAction) — 执行工作日巡检
- <name> ⚠ 无法解析：<message>
```

`text` 用现有的 `clipText` 截断。无法解析的文件照样列出并标记——它们会被 scheduler 静默忽略（`event-scheduling.md` 已写明），模型看得见才可能清理。`details` 带 `{ action: "list", count, names }`。

`preAction` 只标存在与否，不展开命令：它是一段 bash，展开等于把 command guard 的输入抄进上下文。要看细节走 `/events show`。

### D1.4 playbook 与描述

`event-scheduling.md` 的「维护纪律」补一句：闭环或改期之前先 `list` 确认真实名字，不要凭约定拼。工具描述里加 `list` 的一句路由说明即可，格式细节仍归 playbook（046 F6 的形态不变）。

## D2 删掉 `memory_manage.kind`（P2）

按 F3。schema 去掉字段，`normalizeMemoryKind`（`memory-manage.ts:86-94`）与 `MemoryManageArgs.kind` 一并删除，save 写入的 metadata 固定为：

```ts
const metadata = { kind: "fact" as const, sourceType: "user" as const, probationUntil: null };
```

**不改 `MemoryEntryKind` 类型、不改 metadata 文件格式、不改 `extraction.ts`**：后台 consolidation 仍然按六类写入，`/memory` 的显示继续对那部分条目成立。变的只是"模型显式 save 的条目统一记为 `fact`"。

`memory-manage.ts:202` 的返回文案 `Saved to channel memory${kind ? ` (${kind})` : ""}.` 去掉括号部分。

这一项可独立发布，改动约 20 行，无行为风险。

## D3 `subagent_manage` → `subagent_list` + `subagent_run`（P3）

### D3.1 两个工具

**`subagent_list`**（零参数，≈32 units）——本频道委派 run 的快照。`LIST_CAP = 50` 与 running 豁免逻辑（`subagent-manage.ts:157-179`）原样搬过来。描述保留那句关键纪律："run 结束会自己唤醒本频道，不要在这里轮询。"

**`subagent_run`**（≈97 units）——对**一个** run 的操作：

```
op      required  show | cancel | follow_up
runId   required  run id
task    optional  follow_up 的新指令
```

`runId` 从 optional 变成 schema 必填，`subagent-manage.ts:181-183` 那处 `${op} requires runId.` 消失。剩下 `follow_up requires task.`（`:212`）保留——它是形状内分支，与 046 有意保留的 `task_close` 按 `outcome` 分支同型。

`resolveRef` 的 ambiguous / not_found 两条拒绝、9 道 follow_up 准入闸（项目边界、可续接 harness、非 running、有 sessionId、角色仍配置、角色可用、harness 未变、非 shell、verify 准入、fingerprint 未变）**逐条不变**——它们校验的是运行时状态，不是参数形状，schema 表达不了也不该表达。

### D3.2 `EFFECT_TOOLS` 必须跟着改（易漏，后果静默）

按 F6。`isEffectfulTool` 增加一个分支，与 `bash` 那条同型：

```ts
// src/agent/effect-ledger.ts
if (toolName === "subagent_run") {
    // op=follow_up 派发了一个新的外部 run —— 和 subagent 一样是对世界的可见改变。
    // show/cancel/list 不是。判据取自 details 而非参数：只有真的派发成功才会有 resumedFrom。
    return isRecord(details) && typeof details.resumedFrom === "string";
}
```

用 `details.resumedFrom` 而不是 `details.op === "follow_up"`：`follow_up` 的失败路径全部走 `RecoverableToolError` 或 `throw`，只有 `subagent-manage.ts:398-406` 的成功返回才带 `resumedFrom`。这样"拒绝也算 effect"不可能发生。

同时更新 `effect-ledger.ts:13` 那条注释里的自报告工具清单（P4 之后 `memory_manage` 也要改名）。

### D3.3 血缘中三处静默项

- **`src/agent/turn-recovery.ts:27-28`**：`toolName === "subagent" || toolName === "subagent_manage"` 的判断加上两个新名字，并把提示文案 `` 先用 `subagent_manage op=list` / `show` 查询 `` 改掉。漏改 = 中断回合恢复时教模型调一个不存在的工具。
- **`src/subagents/runs.ts:394, 671, 736`**：三处模型可见的字符串里写着 `subagent_manage`。漏改 = 同上。
- **`src/agent/effect-ledger.ts`**：见 D3.2。

## D4 `memory_manage` → `memory_save` / `memory_search` / `memory_forget`（P4）

### D4.1 三个工具

```
memory_save     content required, supersedes optional        （kind 已在 P2 删除）
memory_search   query   required
memory_forget   target  required
```

三处 `rejectMissingArgument` 全部消失，`MemoryManageArgs` 拆成三个类型，`execute` 里的 switch 与 default 分支（`memory-manage.ts:302-313`）删除。三个 `execute` 共用现有的 `save` / `search` / `forget` 闭包，实现体基本不动——它们今天已经是分离的函数。

`SAVE_CONFLICT_SCORE` 冲突检测回路（`memory-manage.ts:155-182`）、`containsSecret` 拦截、`queue.run` 串行、`appendMemoryReviewLog` 审计**逐条不变**。

`supersedes` 的 `"none"` 魔法值保留：它是冲突回路第二次调用的显式取舍，换成布尔字段要改 playbook 和 `docs/memory.md` 的口径，收益不抵改动面。

### D4.2 前置：校验失败必须降级为可恢复拒绝

按 F4 的最后一段。这是 **P4 的前置条件，不是可选优化**——不做它，拆分会把今天安静的丢参重试变成用户眼前的红色报错。

参数校验失败按定义就是模型自己能改的：它产出了不合 schema 的参数，重发一次正确的就好。所以它属于 `isRecoverableRejection` 那一类，只是今天拿不到标记，因为拒绝发生在 `withToolDetails` 之外。

两处改动：

1. `src/tools/tool-details.ts` 增加一个判据，识别 pi 的校验失败结果形状（`agent-loop.js:441-449` 的 `createErrorToolResult`，消息以 `Validation failed for tool "` 开头，且结果不带 `details.kind`）。这条耦合写进注释并**用一个真的走 SDK 校验的测试锁住**，不靠字符串匹配硬扛。
2. `src/agent/session-events.ts:199-201` 的判断改成：

```ts
const rejected = isRecoverableRejection(event.result) || isArgumentValidationFailure(event);
const treatAsError = (event.isError || Boolean(subAgentDetails?.failed)) && !rejected;
```

注意顺序：今天 `RecoverableToolError` 走的是"返回而非抛出"（`tool-details.ts:81-104`），`event.isError` 恒为 false，所以现有排序从未冲突；校验失败的 `isError` 为 true，必须让 `rejected` 优先。`subAgentDetails?.failed` 是真实的 run 失败，仍须可见——它带 `details`，不会被新判据命中。

这一改动**对所有工具生效**，不只 memory：任何工具的参数校验失败从此都走 `logToolRejected` 而不是 `logToolError`。这是本 spec 唯一一处影响面超出三个工具的改动，属于把 046 的分区推到底之后必然要补的一层。

### D4.3 丢参诊断的取舍要写清楚

即使做了 D4.2，`rejectMissingArgument` 那条定制文案和 operator warning log 仍然会消失——它们在 `execute` 里，而校验在 `execute` 之前。

**接受这个损失**，理由：

- 死循环（真正的事故）由"响不响"决定，不由文案决定。通用报错带 `Received arguments: {...}`，模型能直接看出哪个 key 没到。
- 把那段指引搬进 `content` 的 description 要付约 25 units 的常驻成本，去换一个罕见路径的措辞。046 的判据是"代码会不会因为这句话拒绝调用"——它不会。
- operator 侧证据没有完全丢：校验失败仍然经过 `session-events.ts` 的 `logToolRejected`，带工具名和完整结果串。

**这个取舍由 `M-write-03` 用数据验收**，不由本节的论证决定：P4 之后该 case 必须不低于 P1 取得的 baseline（见「阶段与验收」）。不过则回退 P4，保留单工具形态——P1–P3 已经拿走 90 units 里的绝大部分，P4 只值 18。

## D5 血缘：改名必须同步的位置

| 位置 | 改动 | 失败模式 |
|---|---|---|
| `tools/tool-details.ts` `ToolDetailsKind` | 加 4 个新名、删 2 个旧名 | 编译错误（响） |
| `tools/registry.ts` `TOOL_REGISTRY` / `TOOL_NAMES` | 同上 | `TOOL_NAMES` 缺项让 playbook `requires-tools` 加载时抛错（响，`playbooks/catalog.ts:62`） |
| `tools/presentation.ts` `DESCRIBERS` | 每个新工具一个 describer | `test/tool-presentation.test.ts` 断言每个 `TOOL_NAMES` 都有 describer（响） |
| `tools/index.ts` | 注册 `subagent_list` / `subagent_run` | — |
| **`agent/effect-ledger.ts:27,81`** | `subagent_run` 分支 + 注释里的自报告清单 | **静默**：靠 follow_up 推进的任务被治理器误停（D3.2） |
| **`agent/turn-recovery.ts:27-28`** | 工具名判断 + 中文提示文案 | **静默**：中断回合恢复时教模型调不存在的工具 |
| **`agent/session-events.ts:199-201`** | D4.2 的降级 | **静默**：安静的丢参重试变成用户可见报错 |
| **`subagents/runs.ts:394,671,736`** | 三处模型可见字符串 | **静默**：同 turn-recovery |
| `subagents/tool.ts` 多处注释 + `:1183` | 提到 `subagent_manage op=…` 的注释 | — |
| `playbooks/memory-and-learning.md:4` | `requires-tools: memory_manage, skill` → 三个新名（any-of） | 响（`catalog.ts:62` 校验） |
| `playbooks/event-scheduling.md` | 正文补 `list`（`requires-tools` 不变） | — |
| `playbooks/agent-delegation.md:58,61,65,66` | 四处工具名（该文件无 `requires-tools`） | **静默**：playbook 教模型调不存在的工具 |
| `test/tools-index.test.ts:232-248` | 精确的有序工具名列表 | 响 |
| `test/prompt-sections.test.ts` | 夹具已按 046 D6 从 `TOOL_NAMES` 派生，**无需改动** | — |
| `evals/cases/regression.ts` `M-write-03` / `E-schedule-01` | grader 里的工具名与字段过滤 | 响（eval 直接红） |
| `docs/tools.md`、`memory.md`、`sub-agents.md`、`events-and-tasks.md`、`architecture.md`、`configuration.md`、`configuration-reference.md`、`runtime-mechanisms.md`、`security.md` | 用户手册 | — |

**不留 `memory_manage` / `subagent_manage` 别名**（AGENTS.md：prefer moving code into the right module over adding compatibility aliases）。历史 session 的兼容性与 046 结论相同且已复核：`describeToolCall`（`presentation.ts:106-112`）对未知名 fallback 到名字本身，`toolResultDetails` 对未知 `kind` 返回 `null`，旧 `context.jsonl` 里的 tool_use/tool_result 对不会失效。

## D6 行为 eval

现有护栏三项，都直接压在本 spec 的改动面上，**必须在 P1 之前取得 baseline**：

| case | 现有断言 | 本 spec 的影响 |
|---|---|---|
| `M-write-03`（required 2/3） | `toolCallCount("single-shot-save", "memory_manage", 1, ["op", /save/])` + `noFailedToolResult` | P4 改名并去掉字段过滤；**它就是 D4.3 取舍的裁判** |
| `M-forget-01`（required 2/3） | 端到端行为，不断言工具名 | P4 后应当零改动通过 |
| `E-schedule-01` | `toolCallCount("one-event-create", "event_manage", 1, ["action", /^create$/])` | P1 后必须仍然选 `create` 而不是先 `list` 再 create |

核实过 `noFailedToolResult` 在 P4 之后仍然有效：`tool_execution_start` 在 `prepareToolCall` **之前**发出，校验失败走 `kind: "immediate"` 分支后同样发 `emitToolExecutionEnd`（`agent-loop.js:299-320`），trace 里照样有一条 `isError` 的记录。

新增两个，先登记 `report-only`：

| 新 case | 断言 | 防的是 |
|---|---|---|
| `E-list-01` | 要求"退役掉上周那个巡检提醒"（不给准确名字）时，必须先 `event_manage action=list` 再 delete，且 delete 的 name 命中真实文件 | D1 补的能力是否真的被用起来 |
| `A-route-02` | 想看委派进度时命中 `subagent_list`，不得用 `subagent_run` | D3 的两工具切分是否被正确路由 |

`E-schedule-01` 与 `E-list-01` 一起构成一对：前者防"补了 list 之后模型每次创建都先列一遍"，后者防"补了也不用"。

## 不做什么

- **不拆 `event_manage`。** 实测 +86 units，且 `create`/`update` 参数集完全相同——按 046 F7(a) 就是该合的情形。upsert 方案（`event_set` + `event_delete`，+13）同样驳回：它会丢掉防误覆盖的 `already exists` 拒绝，而在补 `list` 之前那句拒绝是模型唯一的存在性信号；补了 `list` 之后它也仍然是防误覆盖的最后一道。
- **不把 `subagent_manage` 拆成四个**（158 units，比两工具方案贵 29）。`cancel` 与 `show` 的参数集完全相同，拆开是按动词切。
- **不删 `follow_up`。** 它确实重：占 `subagent-manage.ts` 409 行里的约 200 行，派发前连过 9 道闸。但它的 schema 成本只有 `task` 一个字段（≈15 units），删掉是省代码不是省 prompt，而它买到的能力是真的（大型外部 run 免去重新交代上下文）。**要不要留由数据回答**：run 记录已经持久化 `resumedFrom`，跑几周之后按它的实际使用率再判，不在本 spec 内预设。
- **不删 `memory_manage` 的 `search` 或 `forget`。** `search` 是对已提炼文件的廉价确定性点查，与 `session_search`（冷存储原文）来源不重叠；`forget` 的 tombstone 语义（`tombstones.ts` + 不含原文的审计）是 `edit` 给不了的。
- **不改 `MemoryEntryKind` 类型、metadata 文件格式或 `extraction.ts`。** P2 只从模型的 schema 里拿掉一个入口。
- **不改事件 JSON 格式、任务文件格式或 run 记录的任何持久化结构。** 本 spec 与 046 一样只动调用面（D4.2 是呈现层）。
- **不改 `settings.json`，不新增数值阈值配置。** 四项改动都不引入开关。
- **不给这三个工具加 `tools.json` 门控。** 它们是核心能力，恒开（`docs/configuration-reference.md` 已有此口径），本 spec 不动。
- **不用 root-level union schema。** 046 P4 的理由不变。

## 阶段与验收

四个阶段独立可合并、可发布。P1/P2 无依赖可并行；P3 独立；**P4 依赖 D4.2，且 D4.2 应当先于 P4 单独合入**（它是全局呈现层改动，独立可验证）。

### P0 baseline

跑 `M-write-03` / `M-forget-01` / `E-schedule-01` 取得 `evals/baselines/latest.json` 读数；新增 `E-list-01` / `A-route-02` 并登记为 `report-only`（此时它们必然失败或不适用，只为建立对照）。

### P1 `event_manage` 加 `list`

改：`tools/event-manage.ts`（schema + `manageEvent` 的 list 分支 + `EventManageResult`）、`tools/presentation.ts` 的 describer、`playbooks/event-scheduling.md`。

验收：
- `event_manage` ≤ 160 units。
- `list` 只返回 `channelId === options.channelId` 的事件——**专门用例**：同目录下放一条别的 channel 的事件，不得出现在结果里。
- 无法解析的事件文件被列出并标记，不使整个 list 失败。
- `E-schedule-01` 不低于 P0 baseline（补了 list 不得让创建路径变啰嗦）。
- `E-list-01` 取得首个正向读数。

### P2 删 `memory_manage.kind`

改：`tools/memory-manage.ts`（schema、`MemoryManageArgs`、`normalizeMemoryKind`、返回文案）。

验收：
- `memory_manage` = 200 ± 5 units。
- 显式 save 的条目在 metadata 里记为 `fact`；`/memory` 仍能渲染（`commands.ts:136` 的 `?? "fact"` 兜底本来就在）。
- 后台 consolidation 写入的条目 kind 不变（`test/memory-extraction.test.ts` 零改动通过）。
- `M-write-03` / `M-forget-01` 不低于 P0 baseline。

### P3 `subagent_manage` 切分

改：`tools/subagent-manage.ts` 拆两个工厂；`tools/registry.ts`、`index.ts`、`tool-details.ts`、`presentation.ts`；**`agent/effect-ledger.ts`**、**`agent/turn-recovery.ts`**、**`subagents/runs.ts`**；`playbooks/agent-delegation.md`。

验收：
- 两个工具合计 129 ± 15 units。
- `runId` 缺失在 `subagent_run` 上无法构造（类型层），`${op} requires runId.` 已从代码中消失。
- **`op=follow_up` 成功派发后计入 effect ledger；`list`/`show`/`cancel` 与 follow_up 的失败路径都不计**——四条专门断言（F6/D3.2）。
- `resolveRef` 的 ambiguous / not_found、9 道 follow_up 准入闸、workspace lease 的获取与失败释放逐条不变（`test/tool-subagent-manage.test.ts` 按新调用面重组后全绿）。
- `rg 'subagent_manage' src/` 只剩注释里的历史引用。
- `A-route-02` 取得首个正向读数；`A-delegate-01` / `S-verify-01` 不低于 baseline。

### P4a 校验失败降级（D4.2，独立提交）

改：`tools/tool-details.ts`、`agent/session-events.ts`。

验收：
- 用真实 SDK 驱动一次参数校验失败，断言：结果被判为 `rejected`、走 `logToolRejected`、**不进入进度卡**。
- `subAgentDetails.failed` 的 run 失败仍然可见（回归断言）。
- 安全 guard 拒绝（`RecoverableToolError` 之外的路径）仍然可见。

### P4b `memory_manage` 切分

改：`tools/memory-manage.ts` 拆三个工厂；D5 表里的全部下游；`playbooks/memory-and-learning.md`。

验收：
- 三个工具合计 182 ± 15 units；工具集总量 ≤ 2,800。
- 三处 `rejectMissingArgument` 已删除，`content`/`query`/`target` 在各自 schema 里必填。
- 冲突检测回路（`SAVE_CONFLICT_SCORE` → 列出冲突 → 带 `supersedes` 重发）行为不变；`containsSecret` 拦截不变；`forget` 的多匹配拒绝与 tombstone 审计不变。
- **`M-write-03` 不低于 P0 baseline**——不过则回退 P4b（见 D4.3）。
- `M-forget-01` 不低于 baseline。

## 测试计划

改造成本集中在四个文件，都是机械替换：

- `test/memory-manage.test.ts`（196 行，27 处按 `op` 调用）→ 直接调用三个工具。
- `test/tool-subagent-manage.test.ts`（895 行，16 处按 `op` 调用）→ 按两个工具重组。
- `test/event-manage.test.ts`（323 行）→ 只**新增** list 用例，现有 39 处调用不动。
- `test/tools-index.test.ts:232-248` 的有序工具名列表。

新增：

- `test/event-manage.test.ts`：list 的 channel 过滤、无法解析文件的降级渲染、空目录。
- `test/effect-ledger.test.ts`：`subagent_run` 的四象限（follow_up 成功 / follow_up 失败 / cancel / show）。
- `test/tool-error-contract.test.ts`：D4.2 的校验失败降级（走真实 SDK 校验，不 mock）。
- `test/turn-recovery.test.ts`：新工具名的恢复提示。

`test/tool-presentation.test.ts` 与 `test/tool-registry.test.ts` 断言的是"每个注册名都有对应项"，切分后自动覆盖新工具。`test/prompt-sections.test.ts` 的夹具在 046 D6 已改为从 `TOOL_NAMES` 派生，本 spec 零改动——这是那次加固的第一次兑现。

## 风险与回滚

| 风险 | 评估 | 处置 |
|---|---|---|
| 漏改 `effect-ledger.ts`，靠 follow_up 推进的任务被误停 | **高**——静默，且要连续三次 wake 后才显形 | D3.2 单列；P3 验收有四条专门断言。注意这是**既有 bug**，不修的话现状本来就是坏的 |
| 漏做 D4.2，丢参重试变成用户可见报错 | **高**——用户直接看到，且原因不在报错文字里 | P4a 独立成一次提交，先于 P4b 合入 |
| 删掉 `rejectMissingArgument` 的定制指引导致丢参路径恶化 | 中——罕见但真实发生过 | D4.3 明确取舍；`M-write-03` 是裁判，不过则回退 P4b |
| 补了 `list` 之后模型每次创建事件都先列一遍 | 中——多一次工具往返 | `E-schedule-01` 就是这条的护栏；不过则把 `list` 的描述收紧为"名字不确定时才用" |
| `turn-recovery.ts` / `runs.ts` 的文案遗留旧工具名 | 低但尴尬——教模型调不存在的工具 | D5 列出全部位置；`rg 'subagent_manage|memory_manage' src/` 收口 |
| 工具数从 22 增至 25，模型选择成本上升 | 中——本 spec 的主要未量化风险，与 046 同源 | `A-route-02` + `E-list-01` 测；若路由准确率下降，先合并 `subagent_list` 回 `subagent_run`（P3 可单独回滚） |
| `list` 输出把 50 个事件灌进上下文 | 低 | 一行一条 + `clipText`；`MAX_EVENT_FILES = 50` 是硬上限，最坏约 50 行 |

回滚粒度即阶段粒度：五次独立提交（P1 / P2 / P3 / P4a / P4b），`git revert` 单个即可回到上一个自洽状态。四项都不触碰任何持久化结构——事件 JSON、memory metadata、run 记录在回滚后仍可用。

## 对文档的影响

- `docs/tools.md`：工具表改名并加 `subagent_list` / `subagent_run` / 三个 memory 工具；「子代理可用」那段列全新工具名。
- `docs/memory.md`：`memory_manage save` / `search` 的口径改名；说明显式 save 不再带 kind。
- `docs/events-and-tasks.md`：`event_manage` 的 op 列表补 `list`。
- `docs/sub-agents.md`：「控制面」一节从"四个 op"改写为两个工具。
- `docs/configuration-reference.md` / `docs/configuration.md`：恒开工具清单改名（不新增配置项）。
- `docs/architecture.md`：工具表改名；`memory_manage save` 的冲突检测那段改名；补一句"形状不同就拆，形状相同就合"。
- `docs/runtime-mechanisms.md` / `docs/security.md`：提到 `subagent_manage` / `memory_manage` 的行改名。
- `docs/runtime-playbooks.md`：目录表随 `requires-tools` 改名同步（`test/playbooks.test.ts` 会对账）。
- `docs/specs/README.md`：主题分组表加 `047` 一行。
- spec 021/031/040/042/046 中关于这三个工具旧形态的描述**保留为历史，不改写**（按 specs README 的维护规则）。046「不做什么」里关于 `memory_manage` / `subagent_manage` / `event_manage` 的三句预判同样保留原样——本 spec 的 F2/F5 已记录它们哪两句需要修正。

## 实现说明（2026-08-27）

四个阶段全部落地，与本文档的偏差：

- **单位实测**（`measureToolSchemas`，`rm -rf dist && npm run build` 后）：`event_manage` 141 → **127**（P1 顺手把从未瘦身过的描述收紧，净减而非 spec 预估的 +12）；`memory_save`/`memory_search`/`memory_forget` 合计 **≈163**；`subagent_list` + `subagent_run` 合计 **≈121**。三项都在或优于验收带。
- **D4.2 降级**：`isArgumentValidationFailure(result, isError)` 落在 `src/tools/tool-details.ts`，判据是「`isError` 且结果不带 `details.kind` 且文本以 `Validation failed for tool "` 开头」；`session-events.ts` 的 `rejected` 纳入它，`treatAsError` 加 `&& !rejected`。`test/tool-validation-downgrade.test.ts` 用真实 `validateToolArguments` 驱动一次校验失败锁住这条字符串耦合。
- **`subagent_manage` → 两个工厂**：`createSubAgentListTool` + `createSubAgentRunTool`，`runId` 在 `subagent_run` 的 schema 里必填，`${op} requires runId.` 已从代码移除。`test/tool-subagent-manage.test.ts` 保留一个按 `op` 分发的本地 helper，既有行为用例不动。
- **`EFFECT_TOOLS` / `isEffectfulTool`**：`subagent_run` 分支按 `details.resumedFrom` 判定（只有成功派发才带），`test/effect-ledger.test.ts` 有四象限断言。
- **血缘**：`src/` 内 `subagent_manage` / `memory_manage` 引用已全部改名（含 `turn-recovery.ts`、`runs.ts`、`subagents/tool.ts`、`workspace-lease.ts`、`runtime/subagent-commands.ts`、`prompt/sections.ts`、`memory/recall.ts`、`security/path-guard.ts`）；`docs/specs/*` 保留为历史。
- **eval**：`M-write-03` 改名到 `memory_save` 并去掉 `["op", /save/]` 过滤；`E-schedule-01` 不变（`event_manage` 仍有 `create`）。`evals/harness/worker.ts` 的 `TOOL_FIELDS` 加了五个新工具名。`E-list-01` / `A-route-02` 未新增（留待后续 eval 批次）。

# Task Ledger（任务台账）设计方案

| 字段 | 值 |
|------|------|
| 分支 | `feat/task-ledger` |
| 状态 | Phase 1 IMPLEMENTED（rev.1，已吸收 `review.md` 评审意见） |
| 日期 | 2026-07-08 |
| 关联实现 | `src/tools/event-manage.ts`（新增）, `src/tools/registry.ts`, `src/tools/config.ts`, `src/runtime/event-commands.ts`（导出复用）, `docs/tasks.md`（新增） |
| 前置 | 007（event preAction gate）、015（tool registry） |

---

## 背景

Pipiclaw 的 events 机制（immediate / one-shot / periodic + preAction gate）解决了"什么时候唤醒 agent"，但每次唤醒都是**无状态**的：agent 醒来只知道事件文本里写死的那句话，不知道有哪些在途工作、进展到哪、验收标准是什么。这导致：

1. 被委派出去的工作（如 agentmux 实例）会死在两次触发之间——没人回访。
2. 等待用户反馈的工作没有被记录的"等待"状态，也没有回访计划。
3. 周期性任务每一轮都从零开始，不积累手艺（格式偏好、返工教训、预检步骤）。
4. 进程宕机或回合出错后，工作凭空消失——one-shot 事件过期即删，没有恢复入口。

缺的是一个**议程闭环**：醒来 → 查看在途工作 → 推进最需要推进的一项 → 记下状态和下次检查点 → 睡去。

## 目标

1. 定义 **tasks 台账**：一个语义上高于 events 的持久任务层。task 持有"做什么、做到什么程度算完、进展如何"；event 只提供"什么时候看一眼"。
2. 把"创建 / 修改 / 删除事件"做成一等工具 `event_manage`，让 agent 能自我调度（委派后安排回访、阻塞时安排催办、完结时清理检查点）。
3. 给出统一的任务生命周期，**一次性任务和周期性任务用同一套状态机**，不引入模板/实例两层结构。
4. 提供一个廉价的**心跳**兜底机制（periodic 事件 + preAction 传感器脚本），恢复丢失的检查点，零 token 空转。

## 非目标（本 spec 不做，记为后续）

- **task 专用工具 / runtime 解析 task 文件**。台账是 LLM 用现有 read/edit/write 工具操作的**文件约定**，runtime 不解析它。注意预期：本仓库 memory 子系统的演化史（从文件操作走向 `memory_save` 工具 + lifecycle/consolidation 机制）表明"LLM 维护结构化文件会漂移"是本项目已验证过的痛点——`task_manage` 工具**很可能在运营一段时间后就需要立项**，Phase 1 先赌"三字段 frontmatter + fail-open 传感器"能把漂移的破坏面压到可接受。
- **`/tasks` slash command**、prompt 注入任务摘要。可见性先靠直接问 agent；phase 2 再做。
- **workspace 级共享任务**。任务只在 channel 级（与 MEMORY.md 的分层一致，也天然避免跨 channel 并发写）。
- **one-shot 事件的宕机补偿**（启动时补触发过期 one-shot）。改动事件语义、易产生启动风暴；由心跳兜底覆盖，不改。
- **agentmux 状态原生 watcher / 外部 webhook 触发**。先用 preAction 轮询传感器覆盖，另行立项。

---

## 设计总览

三层，职责严格分离：

| 层 | 载体 | 持有什么 | 谁维护 |
|----|------|----------|--------|
| **tasks** | `workspace/<channelId>/tasks/*.md` | 意图、DoD、状态、手册、周期日志 | LLM（read/edit/write 工具） |
| **events** | `workspace/events/*.json` | 唤醒时间点，文本退化为指针（"推进任务 X"） | LLM 经 `event_manage` 工具；用户手工亦可 |
| **传感器** | preAction 脚本 | 确定性条件判断（有没有活要干） | 脚本，零 token |

核心不变式：**event 无状态、可丢弃；真相永远在 task 文件里。** 事件文件误删、过期、丢失，最坏后果只是"晚一点被心跳捞起来"，不丢工作。

---

## 一、任务模型

### 目录布局

```text
workspace/<channelId>/tasks/
├── weekly-report.md        # 周期性任务（常驻一个文件）
├── fix-voice-typer-ci.md   # 一次性任务（完成后移入 archive/）
└── archive/
    └── fix-login-bug.md    # 已完结的一次性任务 / 已退役的周期性任务
```

- 一个任务 = 一个 kebab-case 命名的 `.md` 文件，文件名即任务 id。
- `archive/` 存放已闭环的任务，是周报素材和复盘依据；不参与任何扫描。

### 文件格式

YAML frontmatter（机器可读的最小集，**只有三个字段**）+ Markdown 正文（LLM 的领地）：

```markdown
---
status: in-progress
wake: 2026-07-07T14:00:00+08:00
recurrence: 每周一
---

# 周报编写与发布

## 目标
每周一完成上周周报的编写，经师兄确认后发布到 <渠道>。

## DoD
- [ ] 内容覆盖上周全部工作（素材：git log、上周 archive/ 的任务、MEMORY.md）
- [ ] 数据准确（先核对 X 数据源）
- [ ] 师兄确认后发布，并验证发布成功

## 手册
1. 收集素材，起草
2. 发草稿给师兄，安排当天 14:00 回访检查点
3. 确认后发布、验证、复盘

## 当前周期（2026-W28）
- 07-07 09:32 草稿 v1 已发师兄，等待反馈

## 历史
### 2026-W27 — done
1 轮返工：数据错误 1 处，原因是没核对 X 数据源 → 已把预检写入手册第 1 步。
```

frontmatter 字段：

| 字段 | 必填 | 取值 | 说明 |
|------|------|------|------|
| `status` | 是 | `open` / `in-progress` / `awaiting-user` / `blocked` / `done` | 唯一的机器判定依据是 done / 非 done；细分状态给人和 LLM 看 |
| `wake` | 否 | 带时区的 ISO 8601 | 最早值得再看一眼的时间。缺省 = 随时可推进 |
| `recurrence` | 否 | 自由文本（如 `每周一`） | 仅作标注，供人和 LLM 阅读；**节奏的真相在对应的 periodic 事件里**，不在这里 |

刻意不设 priority / due / owner / cycle-id 等字段：优先级和截止时间写在正文里由 LLM 判断，避免 frontmatter 膨胀成第二个状态机。

### 生命周期：一次性与周期性统一

状态机只有一个：

```text
open → in-progress ⇄ awaiting-user / blocked → done
```

差别只在 **done 之后文件去哪**：

| | done 之后 | 不变式 |
|---|---|---|
| 一次性任务 | agent 把文件移入 `archive/`（收尾 SOP 的最后一步） | `tasks/` 根目录下**不存在** done 的一次性任务 |
| 周期性任务 | 文件**留在原地**，done = 睡眠 | done 的周期性任务 = 等下一次 periodic 事件唤醒 |

于是"文件存在 = 未完成"这个直觉被推广为一条统一不变式：

> **`tasks/` 根目录下任何 status ≠ done 的文件，都代表有活要干。**

周期性任务的新一轮**只由它的 periodic 事件开启**（心跳不开启新周期，只推进已开启的工作——避免两个入口竞争）：

1. periodic 事件触发（文本："推进任务 weekly-report"）。
2. agent 打开任务文件。若 `status: done`：把"当前周期"一节折叠进"历史"（历史只保留最近 ~5 轮，更早的删除或压缩成一行），开一节新的"当前周期"，status 置 `in-progress`，开始干活。
3. 若上一轮还没 done（过期未完成）：先处置旧周期（补完或明确放弃并记录原因），再开新周期。这是 LLM 级判断，不需要机制。

**退役**周期性任务 = 文件移入 `archive/` + 用 `event_manage` 删除它的 periodic 事件。

### 一个周期性任务 = 一个 task 文件 + 一个 periodic 事件

职责分离：task 文件积累手艺（DoD、手册、返工教训），periodic 事件只管节奏。修改节奏改事件，修改做法改文件，互不牵连。task 与 event 不是一对一：一个任务生命周期里还会临时消耗多个 one-shot 检查点事件（见下）。

### 任务归属的事件命名约定

**注意：tasks 目录按 channel 隔离，但 `workspace/events/` 是全局单目录**（`events.ts` 的 `eventsDir = join(workspaceDir, "events")`）。因此任务派生的事件名必须编入 channelId，否则两个 channel 的同名任务会静默互相覆盖对方的事件：

```text
task.<channelId>.<任务id>.<用途>.json
# 例：task.dm_123.weekly-report.schedule.json（periodic 节奏）
#     task.dm_123.weekly-report.checkin.json（one-shot 回访）
```

事件 JSON schema 零改动——归属关系编码在文件名里，`/events list` 天然可读，任务收尾时 `task.<channelId>.<id>.*.json` 一把清理，不留孤儿。名字唯一性由 channelId 前缀保证；所有权校验由工具在 update/delete 时执行（见下）。

---

## 二、`event_manage` 工具

### 为什么必须是一等工具

台账运转起来后，事件写入是高频、agent 驱动的操作（一个任务周期：建回访 → 改期 0~2 次 → 完结删除）。目前 agent 只能用 write 工具裸写 JSON，三个问题：格式错误会被 watcher **静默删除**（agent 以为安排好了回访，实际丢了）；preAction 里的危险命令要等触发时才被 guard 拦下；没有结构化审计。工具在**写入时**就完成 parse 校验 + guard 检查，失败大声报错。

### 接口

仿照 `skill_manage` 的形态（label + action + 参数），单工具多 action：

```ts
const eventManageSchema = Type.Object({
  label: Type.String(),                 // 给用户看的一句话说明
  action: "create" | "update" | "delete",
  name: Type.String(),                  // 事件名，同 /events 命令的字符集 [a-zA-Z0-9._-]，自动归一化 .json
  definition: Type.Optional(Type.String()), // create/update 必填：完整事件 JSON 字符串
});
```

- **create**：目标文件已存在则报错。
- **update**：整体替换（事件文件很小，不做 patch）；目标不存在则报错。运行中的 watcher 检测到变更后自动重装载——复用现有机制，无需额外通知。
- **delete**：删除文件；对 periodic 事件即停用（现有语义）。
- 读取/列举不进工具：`workspace/events/` 在 workspace 内，现有 read 工具可直接读。

### 路径安全（工具自带，不依赖 path-guard）

`event_manage` 与 `skill_manage` 同型，直接 `writeFileAtomically` 落盘，**不经过文件工具的 path-guard**——所以 `name` 的路径校验必须由工具自己完成。`src/runtime/event-commands.ts` 已有现成实现：`normalizeEventName`（字符集 `[A-Za-z0-9._-]`、拒绝 `.`/`..`、归一化 `.json` 后缀）和 `resolveEventPath`（resolve 后校验落在 events 目录内的 traversal 拦截）。将这两个函数导出（或移至共享模块）供工具复用，并加 `name = "../../x"` 被拒的测试。

### 写入时校验（工具的核心价值）

1. `definition` 必须能通过 `parseScheduledEventContent`（`src/runtime/events.ts` **已导出**的纯函数，`event-commands.ts` 已在复用；工具直接 import，零改动，保证工具写出的文件必然可被 watcher 装载）。
2. `preAction.command` 若存在，写入时即过 `guardCommand`，被拦截则整个 create/update 失败。触发时的既有检查保留。注意：两道检查都以 `commandGuard.enabled` 为前提（现有行为，`events.ts` 的 `runPreAction` 与 `guardCommand` 内部均如此）——**全局关闭 commandGuard 时双保险均不生效**，这是既有语义，不在本 spec 内改变，但需在文档中注明。
3. **channel 所有权**：`definition.channelId` 缺省填充为当前 channel；显式给出但不等于当前 channel 则报错。update/delete 前先读目标文件，其 `channelId` ≠ 当前 channel 则拒绝——一个 channel 的 agent 不能操纵或打扰其他 channel（跨 channel 调度若有真实需求，Phase 2 再放开）。
4. **immediate 全面禁止（create 与 update 双侧）**：agent 当下能做的事就该在当前回合做完；immediate 自触发是回合自激励循环（token 燃烧）的入口。仅禁 create 不够——watcher 的 `handleFileChange` 对已知文件会重新装载，而 `handleImmediate` 只检查 `mtime < startTime`，update 会刷新 mtime 使 immediate **立即重新执行**。因此：`definition.type` 为 `immediate` 时 create/update 一律拒绝；update 的目标现有文件是 immediate 类型时也拒绝（delete 不受限）。用户手工创建 immediate 不受影响。
5. **one-shot 的 `at` 必须晚于 now + 2 分钟**：同样是防自激励（"1 秒后叫醒我自己"≈ immediate）。
6. **periodic 的 cron 频率下限**：用 `croner`（已有依赖）计算前 3 次触发时刻，相邻最小间隔 < 30 分钟则拒绝。没有这条，"50 个事件上限"只限数量不限频率——一个 `* * * * *` 的 periodic 就是最猛的 token 燃烧形态。agent 需要更密的探测时，正确姿势是 periodic + preAction 传感器门控（如心跳），而不是裸高频 cron；此规则写入 promptHint。用户手工创建不受限。
7. 理智上限：`workspace/events/` 内 `.json` 文件数（与 watcher 的过滤口径一致，不计 `.error.txt` 等标记文件）≥ 50 时拒绝 create，报错提示先清理。

### 写入方式

经 `writeFileAtomically` 原子写入。半成品不会被误装载——已核实：`createAtomicTempPath` 的临时文件以 `.tmp` 结尾，而 watcher（`events.ts` 的 watch 回调与启动扫描）只处理 `.json` 文件。测试中加一条后缀断言防回归即可。

### 注册与门控

- 进入 `TOOL_REGISTRY`（spec 015）：`availableToSubagents: false`——调度是主 agent 的编排职责，子代理不该安排唤醒。
- config 门控：字段名为 **`tools.events.enabled`**，默认 `true`（与 `memory.sessionSearch.enabled`、`skills.manage.enabled`、`rtk.enabled` 的主流约定一致；`web.enable` 是历史特例，不效仿）。这不是一行配置，`src/tools/config.ts` 是手写强类型 merge loader，需同步改三处：`PipiclawToolsConfig` 接口、`DEFAULT_TOOLS_CONFIG` 默认值、`mergeToolsConfig` 读取分支；registry 侧为 `enabledBy: (ctx) => ctx.toolsConfig?.tools.events.enabled !== false`。
- promptHint 一并给出，说明：task 事件命名约定（含 channelId 前缀）；"one-shot 用于回访检查点、periodic 用于任务节奏，periodic 最密 30 分钟"；以及 **wake 字段与 checkin 事件的对称性**——推后回访时两处要一起动（改 one-shot 的 `at` + 改任务的 `wake`），闭环时两处一起清。
- 审计：事件文件的装载/触发/删除已写入 `state/events/history.jsonl`（现有机制），工具调用本身随会话日志留痕，不另建审计流。

---

## 三、心跳（heartbeat）

心跳是**兜底**，不是主驱动。主驱动是任务自带的事件（periodic 节奏 + one-shot 回访）；心跳只负责捞起漏网的工作：agent 忘了安排回访、one-shot 在进程宕机期间过期被删、回合中途出错任务卡在 in-progress。

实现 = 一个用户创建的 periodic 事件 + preAction 传感器，**零代码改动**：

```json
{
  "type": "periodic",
  "channelId": "dm_<staffId>",
  "text": "心跳：扫描 tasks/ 台账，推进最需要推进的一项；若无事可做回 [SILENT]。",
  "schedule": "0 9-19 * * 1-5",
  "timezone": "Asia/Shanghai",
  "preAction": {
    "type": "bash",
    "command": "node \"${PIPICLAW_HOME:-$HOME/.pi/pipiclaw}/workspace/skills/tasks-pending.mjs\" dm_<staffId>"
  }
}
```

（路径不硬编码 `~/.pi/pipiclaw`——`src/paths.ts` 的 `APP_HOME_DIR` 支持 `PIPICLAW_HOME` 覆盖，配方用 shell 变量展开兼容两种情况。）

传感器脚本 `tasks-pending.mjs`（随文档提供全文，放 `workspace/skills/`，与既有 `check-last-workday.js` 同一惯例）：

> 遍历 `workspace/<channelId>/tasks/*.md`（不含 `archive/`），读 frontmatter 的 `status` 和 `wake` 两行。
> **exit 0（唤醒）当且仅当存在一个任务：`status` ≠ `done`，且（无 `wake` 或 `wake` ≤ now）。**
> frontmatter 解析失败的文件视为"需要关注"（fail-open，唤醒 agent 去修，而不是静默漏掉）。

这就是 `wake` 字段存在的意义：awaiting-user / blocked 的任务把 `wake` 设到下一个回访点，心跳每小时扫过时因 `wake` 未到而**不消耗任何 token**；回访点若已由 one-shot 正常触发并处理，agent 会顺手把 `wake` 推后或任务闭环，心跳依旧安静。频率上每小时一次足够——它只是安全网，正常路径的实时性由 one-shot 保证。

---

## 四、Agent 工作 SOP（写入 workspace AGENTS.md，本 spec 提供模板）

runtime 不解析 task 文件，所以约定必须靠提示词落地。`docs/tasks.md` 提供以下 SOP 的完整模板文本，供用户合入 workspace `AGENTS.md`：

**唤醒时**（事件指名任务则直达；心跳则扫描）：
1. `ls tasks/*.md`，用 `head` 读各文件 frontmatter，挑出可推进的任务（status ≠ done 且 wake 已到），按正文里的优先级判断先推进哪个。
2. 推进：按手册执行 / 检查 agentmux 委派进展 / 处理用户反馈。

**回合结束前（雷打不动的三件事）**：
1. 更新任务文件：status、wake、当前周期日志追加一行（做了什么、卡在哪、下一步）。
2. 若任务仍在途且有明确的下次检查时间：用 `event_manage` 创建/改期 one-shot 回访事件（`task.<channelId>.<id>.checkin.json`），并把任务的 `wake` 同步到同一时间点——两者是对称的一对，一起动、一起清。
3. 任务 done：一次性任务移入 `archive/`；周期性任务折叠周期日志；两种情况都删除 `task.<channelId>.<id>.*` 的残留 one-shot 事件。

**创建任务时**：从用户指令提炼目标 / DoD / 手册写入新文件；周期性任务同时用 `event_manage` 创建 `task.<channelId>.<id>.schedule.json`。

---

## 五、并发与安全

- **channel 内无竞争**：task 文件只在 agent 回合内读写，run queue 已保证 channel 级回合串行。
- **channel 间隔离**：tasks 目录在 channel 目录下，天然隔离。events 目录是**全局的**，隔离靠两道机制补齐：事件名编入 channelId 前缀（防同名碰撞），工具校验 channel 所有权（防跨 channel 操纵/打扰，见"写入时校验"第 3 条）。
- **路径**：task 文件经现有文件工具读写，path-guard 覆盖；`event_manage` 直接落盘**不经 path-guard**，路径安全由工具内复用 `resolveEventPath` 的归一化 + traversal 校验保证（见"路径安全"节）。
- **自激励循环**：四道闸——禁 immediate（create/update 双侧）、one-shot 最短 2 分钟提前量、periodic 最小间隔 30 分钟、50 个事件上限。
- **preAction 注入**：写入时 + 触发时双重 `guardCommand`（均以 `commandGuard.enabled` 为前提，全局关闭时两道都不生效——既有语义，文档注明）。

## 风险

| 风险 | 缓解 |
|------|------|
| LLM 写坏 frontmatter，传感器误判 | 字段只有 3 个、格式极简；传感器 fail-open（解析失败=唤醒）；SOP 模板给出可复制的样例 |
| 孤儿事件（任务删了、事件还在） | `task.<channelId>.<id>.*` 命名约定 + 收尾 SOP 清理 + `/events list` 可见 + 心跳唤醒的 agent 可顺手发现 |
| archive/ 无限增长 | 纯文本、增长慢；可用一个周期性"台账整理"任务自我治理（机制的 dogfood） |
| agent 不遵守 SOP（忘更新、忘清理） | 心跳兜底保证不丢工作；SOP 违背只降低效率不破坏正确性——这是"真相在 task 文件、event 可丢弃"分层的直接收益 |
| agent 创建高频 periodic 燃烧 token | 写入时 cron 频率下限（30 分钟）硬校验 + promptHint 引导用 preAction 传感器替代高频轮询 |

## 测试

`test/event-manage.test.ts`（新增）：
- create：合法 periodic/one-shot 落盘且 watcher 可装载；非法 JSON / 缺字段 / 坏 cron 报错不落盘；immediate 被拒；`at` 提前量不足被拒；periodic 间隔 < 30 分钟被拒（如 `* * * * *`）；preAction 被 guard 拦截时整体失败；重名报错；名字归一化（`foo` ≡ `foo.json`）；**`name = "../../x"` 等 traversal 被拒**；`channelId` 缺省填充；显式跨 channel 的 `channelId` 被拒；`.json` 计数 ≥50 时拒绝。
- update：整体替换后重新校验；目标不存在报错；**目标文件是 immediate 或 `definition.type` 为 immediate 被拒**；目标文件 `channelId` 非当前 channel 被拒。
- delete：删除存在/不存在的目标；目标 `channelId` 非当前 channel 被拒。
- 原子写：临时文件不会被 watcher 误装载（后缀断言）。
- registry 契约测试的泛化断言（名字唯一、hint 非空、不进子代理集）自动覆盖新工具；**`tool-registry.test.ts` 中硬编码主集工具名的期望数组需追加 `event_manage`**（"builds the full leaf set" 一条会因新工具而失败，属预期内更新）。

传感器脚本与 task 文件约定不进单测（docs 层交付物），由 e2e 或实际运营验证。

## 文档更新

- 新增 `docs/tasks.md`：任务模型、生命周期、frontmatter 参考、SOP 模板全文、心跳配方、`tasks-pending.mjs` 全文。
- `docs/events-and-sub-agents.md`：增加 `event_manage` 工具一节，标注 `/events` 命令仍是用户侧管理入口。
- `docs/configuration.md`：`tools.events.enabled` 门控。

## 成功标准

1. agent 能在一个回合内完成：委派任务 → 更新台账 → 用 `event_manage` 安排回访 → 结束；回访事件如期触发且指向正确任务。
2. 周报场景全流程走通：periodic 开启周期 → 草稿 → awaiting-user + one-shot 回访 → 确认 → 发布 → done 折叠周期日志 → 清理检查点事件；下一周期 agent 能读到上一轮沉淀的手册改进。
3. 杀掉进程使一个 one-shot 回访过期丢失（重启时 watcher 会把过期 one-shot 当"in the past"删除），**在任务 `wake` 已到或未设的前提下**，重启后心跳在下一个整点将该任务捞起并继续推进。（若 agent 刻意把 `wake` 设到远期，心跳静默到 wake 到期——那是 agent 的明确意图，不算丢失。）
4. 心跳在无在途任务（或 wake 均未到）时，不产生任何 LLM 调用（`history.jsonl` 可验证 preAction blocked）。

## 分阶段

- **Phase 1（本 spec）**：`event_manage` 工具 + 测试 + 三份文档（含 SOP 模板与传感器脚本全文）。代码改动集中在 `src/tools/`（新工具 + registry + config 三处门控）与 `src/runtime/event-commands.ts`（导出 `normalizeEventName`/`resolveEventPath` 供复用）；`events.ts` **零改动**——`parseScheduledEventContent` 已导出可直接用。
- **Phase 2（另立 spec）**：`/tasks` slash command、prompt 注入任务摘要、必要时的 `task_manage` 工具、agentmux 状态原生触发器。

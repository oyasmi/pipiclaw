# 工具集增强：借鉴 oh-my-pi 设计内核的分批演进方案

| 字段 | 值 |
|------|------|
| 分支 | `feat/toolset-enhancement`（按 wave 分 PR） |
| 状态 | IMPLEMENTED（全部三个 wave；下列 §实现说明 记录了与本设计的有意偏差） |
| 日期 | 2026-07-09 |
| 前置 | [015（tool registry）](../015-tool-registry/design.md)、[006（web tools）](../006-web-tools/design.md)、[013（memory write semantics）](../013-memory-write-semantics/design.md)、[019](../019-task-ledger/design.md)/[020（task ledger）](../020-task-visibility-and-drivers/design.md) |
| 参考对象 | `~/projects/oh-my-pi`（基于 pi 的重度打磨编码代理，30+ 工具，每工具有独立设计文档 `docs/tools/*.md`） |
| 关联实现（预期） | 见各任务的"落点"小节；汇总在 §设计总览 |

---

## 背景

oh-my-pi 与 pipiclaw 同源（均基于 pi/pi-coding-agent），但走了相反的工具集路线：oh-my-pi 是 30+ 工具的重装编码代理，pipiclaw 是 14 个工具的精简长程助手。对 oh-my-pi 工具集的系统研读（`docs/tools/` 下 33 份工具文档 + 源码结构）表明，它真正的价值不在工具清单，而在贯穿所有工具的**四条设计内核**：

1. **Token 经济学是每个工具的一等公民。** read 对大文件做结构化摘要并在尾注给出可直接执行的续读指令（`[…NNln elided; re-read needed ranges, e.g. path:5-16,40-80]`）；grep 输出按目录树分组、每文件 20 条匹配、多文件轮转选取防热文件霸屏、512 字符行截断、20 文件/页 + `Use skip=N` 翻页；bash 大输出落 artifact 并回给引用。**所有截断都附带一条可照做的续读指令。**
2. **错误即导航（errors steer the model）。** 每条错误都告诉模型下一步：`:0` 报 "lines are 1-indexed. Use :1"；越界读取不抛错而是返回 "Use :&lt;last line&gt;"；edit 连续 3 次字节级 no-op 升级为硬错误并明说"问题在别处，先重读文件，不要加宽 payload"。这是防模型死循环、省重试轮次的核心手段。
3. **一个入口吃掉一整类需求。** read 的一个 `path` 字符串统一了文件、目录树、压缩包内文件、SQLite、PDF/DOCX、网页 URL 与一套内部 URL 协议，行选择器语法跨所有目标通用——工具数量不涨，能力面扩一个数量级。
4. **长任务不阻塞回合。** bash 有显式 `async` 与 auto-background（前台超 60s 自动转后台并归还控制权），配套 `job` 工具 poll/cancel/list，poll 等待用自适应阶梯（5s→10s→30s→1m→5m），完成结果由运行时自动投递回对话。

另有一条组织原则：**动词化的记忆五件套**（recall 查 / retain 存 / reflect 综合 / memory_edit 改删作废 / learn 沉淀教训），以及 `invalidate`（软作废、留痕）与 `forget`（硬删）的语义区分。

### 定位差异——借鉴的过滤器

| | oh-my-pi | pipiclaw |
|---|---|---|
| 形态 | 交互式 TUI 编码代理 | 钉钉驱动的常驻个人长程助手 |
| 主负载 | 代码库操作（编辑为王） | 记忆、任务、日程、信息获取 |
| 并发模型 | 用户盯着终端，可随时 Esc | 频道 run-queue 串行，用户异步收消息 |
| 工具数 | 30+，靠 BM25 发现机制承载 | 14，全部常驻 prompt |

由此得出三条过滤规则，决定了本 spec 的取舍：

- ① 服务于**重度代码编辑**的机制（hashline 补丁语言、tree-sitter 块操作、LSP）对 pipiclaw 是负资产；
- ② 服务于**长任务不阻塞**的机制对 pipiclaw 比对 oh-my-pi **更重要**——TUI 用户能看见卡住并中断，钉钉用户只会看到已读不回，且一个卡住的 bash 会锁死整个频道的 run queue；
- ③ 服务于**记忆质量**的机制是 pipiclaw 的主场，值得深抄语义（而非实现）。

## 目标

1. 把四条设计内核落进 pipiclaw 既有工具，而不是扩张工具清单：做完全部任务，工具数从 14 → **约 15**（+grep +job −2 个 skill 工具 +memory_manage 吸收 memory_save）。
2. 消除两个结构性短板：无结构化搜索工具（T2）、bash 全阻塞（T3）。
3. 补全记忆动词（显式检索 + 忘记/作废），且不破坏 memory 子系统的串行化不变量（T4）。
4. 全部任务按 wave 分批交付，每个 wave 可独立上线、独立回滚。

## 非目标（明确不抄的清单）

| oh-my-pi 机制 | 不抄的理由 |
|---|---|
| **hashline 编辑语言**（快照 tag、`SWAP/DEL/INS` 补丁语法、tree-sitter 块操作、stale-anchor 恢复引擎） | 为高频重度代码编辑设计的重机器（仅 hashline 包即数千行）。pipiclaw 的编辑频率与文件规模用 exact-match `edit` 足够，失配成本远大于收益。只借它的两个轻量点：no-op 循环防护（T1）与结果回显 diff（T1）。 |
| **BM25 工具发现**（`search_tool_bm25`、essential/discoverable 分层） | oh-my-pi 的 auto 模式在 >40 工具才启用。pipiclaw 做完本 spec 约 15 个，全量常驻更简单可靠。此条反向成为 pipiclaw 的**上限警戒线**：工具数逼近 20 时先做合并（如 T7），而不是上发现机制。 |
| **checkpoint / rewind**（探索性上下文折叠为报告） | pipiclaw 已有更适配的机制——memory consolidation + `HISTORY.md` 本质是异步版 rewind。 |
| **PTY / 交互式终端、client-terminal bridge** | 无终端可交互，语义不存在。 |
| **todo 工具** | pipiclaw 的 task ledger（019/020）是跨会话、带 wake 事件的持久任务体系，比会话内 todo 更先进。仅借其一条不变量自查：失败的 op 整体丢弃、不落半应用状态（`task_manage`/`event_manage` 已遵守，实现新工具时延续）。 |
| **archive/SQLite 读取选择器**（`a.zip:src/x.ts`、`db.sqlite:table?where=`） | 代码考古场景，pipiclaw 需求出现前不做。 |
| **reflect 独立工具** | pipiclaw 的自动 recall + sidecar 已覆盖；oh-my-pi 的本地路径 reflect 也只是 recall + 格式化。 |
| **内部 URL 协议层**（`memory://`、`skill://`、`artifact://`……） | 优雅但属于平台级投入；pipiclaw 的内部资源（memory 文件、skills、tasks）都是真实文件路径，`read` 直达即可，无需间接层。 |

另记一个 pipiclaw 反向领先、必须在新工具中延续的点：每个工具的 **`label` 参数**（面向用户的意图说明，渲染进钉钉进度卡片）是 oh-my-pi 没有的。T2/T3 新工具必须带 `label`。

---

## 设计总览：任务分解

八个任务，按依赖与风险排成三个 wave。每个任务独立可验收；同 wave 内可并行。

| 任务 | 名称 | Wave | 风险 | 依赖 | 主要落点 |
|------|------|:----:|:----:|------|----------|
| **T1** | 错误导航化 + edit diff 回显 | 1 | 低 | — | `tools/read.ts`、`tools/edit.ts`、`tools/bash.ts`、`tools/session-search.ts`、`AGENTS.md`（规约） |
| **T2** | `grep` 工具 | 1 | 低 | — | `tools/grep.ts`（新增）、`tools/registry.ts`、`tools/config.ts` |
| **T3** | 后台作业 + `job` 工具 | 2 | 中 | T1 文案规约 | `agent/job-manager.ts`（新增）、`tools/bash.ts`、`tools/job.ts`（新增）、`agent/channel-runner.ts`、`runtime/bootstrap.ts` |
| **T4** | `memory_manage` 演进 | 2 | 中 | — | `tools/memory-manage.ts`（替代 `memory-save.ts`）、`memory/` 若干 |
| **T5** | read 增强：目录 + 文档 | 2 | 低 | — | `tools/read.ts` |
| **T6** | web_fetch 缓存 + 分页 | 3 | 低 | — | `tools/web-fetch.ts`、`tools/web-cache.ts`（新增） |
| **T7** | skill 三工具合一 | 3 | 低 | — | `tools/skill-manage.ts`、删 `skill-list.ts`/`skill-view.ts` |
| **T8** | bash 拦截器（轻量版） | 3 | 低 | **T2** | `tools/bash.ts`、`tools/config.ts` |

> 注册面三处同步的固定动作（015 确立）：凡增删工具，`tools/registry.ts`（TOOL_REGISTRY + prompt hint）、`tools/config.ts`（gate 默认值）、测试三件套（`tool-registry.test.ts` / `tools-index.test.ts` / `tools-config.test.ts`）必须同步。下文各任务不再重复。

---

## T1：错误导航化 + edit diff 回显（Wave 1）

### T1a 错误导航化规约

定一条工程规约写入仓库 `AGENTS.md`：

> **任何工具的错误或截断输出，必须包含一条模型可直接照做的下一步指令。**

然后过一遍现有工具补齐缺口：

| 位置 | 现状 | 改为 |
|------|------|------|
| `read` offset 越界（`read.ts:140`） | `Offset N is beyond end of file (M lines total)` | 追加 `Use offset=M to read the last line, or omit offset to read from the start.`（M=最后有效行） |
| `edit` no-op（`edit.ts:199-203`） | 单次报错，无循环防护 | 见 T1b |
| `bash` 命中 command-guard | `Command blocked [category] / Reason / Matched` | 追加一句：`If this operation is genuinely needed, explain the intent to the user so they can adjust security.json.` |
| `session_search` 空结果 | 返回空结果 JSON | 文本追加：可放宽 `roleFilter`、换更宽泛的 query，或提示"提炼后的记忆在 MEMORY.md/HISTORY.md，可直接 read" |
| `web_fetch`/`web_search` 失败 | （实现期核对） | 失败时给出替代路径（换 query / 直接 fetch 已知 URL） |

### T1b edit no-op 循环防护

借 oh-my-pi 的 noop-loop-guard 语义：`edit` 对同一文件、同一 `(oldText,newText)` 的**连续** no-op 计数（进程内 per-channel Map，容量小、无需持久化），第 3 次升级为硬错误，文案传达三个信息——STOP、问题在别处（先重读文件核对锚点）、不要通过加宽 oldText 来"修"：

```text
STOP. This exact edit to <path> has been a no-op 3 times in a row.
The bug is somewhere else — re-read the file to verify the anchor text
before editing again. Do NOT widen oldText or add lines to force a match.
```

计数在任何一次成功 edit 或不同 payload 时清零。

### T1c edit 结果回显紧凑 diff

现状：`edit.ts` 把 diff 放进 `details`（UI 用），模型只见 "Successfully replaced text..."，常触发一次额外 `read` 验证。改为把既有 `generateDiffString` 的输出**截断到 ~40 行后拼进 content 文本**（超出加 `[diff truncated, N more lines]`）。`details` 保持不变。

### 验收

- 上述每处错误文案有对应单测断言（含下一步指令的关键词）。
- no-op 三连升级硬错误、成功后清零，有单测。
- edit 成功结果 content 中含 diff 片段；超长 diff 被截断。

---

## T2：`grep` 工具（Wave 1）

### 动机

pipiclaw 没有搜索工具，模型只能 `bash: grep -rn ...`：原始输出无行截断、无分组、无分页，一次大搜索即打爆 50KB 进 spill 流程；参数拼写出错率高；输出格式不稳定。这是全清单里 token ROI 最高的一项，并直接强化 sub-agent 的研究能力。

### 设计：执行薄、塑形厚

**执行层**复用现有 `Executor`（host 或 docker sandbox 内跑命令），不引入 native 依赖：启动时探测一次 `rg`（`command -v rg`），有则 `rg --json` / `rg -n -C`，无则退化 `grep -rn -C`（探测结果缓存于工具闭包）。**价值在 JS 侧输出塑形**，规格抄 oh-my-pi：

| 维度 | 规格 |
|------|------|
| 上下文行 | before=1 / after=3（固定，不暴露参数） |
| 行截断 | 每行 512 字符 + `…` |
| 单文件匹配上限 | 多文件范围 20 条/文件；单文件目标 200 条 |
| 文件分页 | 20 文件/页；尾注 `Use skip=N for the next page` |
| 轮转选取 | 多文件时按文件轮转（round-robin）填页，防单个热文件霸屏 |
| 输出分组 | 按文件分组，头行 `== path ==`，匹配行 `*LINE:text`、上下文行 ` LINE:text` |
| 总量兜底 | 最终文本过一遍 `truncateHead`（复用 `truncate.ts`） |
| 空结果 | `No matches found in <scope>.` + 放宽建议（去掉 glob / 换 pattern） |

### 接口

```ts
const grepSchema = Type.Object({
  label: Type.String(),                       // pipiclaw 惯例，渲染进进度卡片
  pattern: Type.String(),                     // 正则；空白-only 拒绝
  path: Type.Optional(Type.String()),         // 文件或目录；默认 workspace 根
  glob: Type.Optional(Type.String()),         // 文件名过滤，如 "*.ts"；仅目录范围有效
  caseSensitive: Type.Optional(Type.Boolean()), // 默认 true
  skip: Type.Optional(Type.Integer({ minimum: 0 })), // 文件页偏移
});
```

不单独立 `glob` 工具：15 个工具的规模下一个 `glob` 参数就够（oh-my-pi 拆开是因为有发现机制兜着）。

### 安全与注册

- `path` 走 `path-guard`（read 操作），拒绝时用 T1 规约文案。
- `pattern` 经 `shellEscape` 后传给 rg/grep（数据，不是命令拼接面）；`glob` 白名单字符校验（字母数字 `*?.[]{}-_/`）。
- 注册：`TOOL_REGISTRY`，**`availableToSubagents: true`**（研究型子代理最需要），gate `tools.grep.enabled`（默认 true）。
- prompt hint：`Search file contents with a regex; grouped, paginated, token-bounded output — prefer this over bash grep`。

### 验收

- 单测覆盖：分组格式、每文件截断、轮转、翻页 skip、512 字符行截断、rg 缺失时 grep 退化路径、path-guard 拒绝、空结果建议文案。
- 子代理工具集中含 grep（`tools-index.test.ts`）。

---

## T3：后台作业 + `job` 工具（Wave 2）

### 动机

`executor.exec` 全程阻塞。跑 `npm install`、爬虫、长数据处理时整个频道 run queue 被锁——`/steer`、`/followup` 全部排队，用户看到的是已读不回。这对常驻长程助手是结构性短板（过滤规则 ②：此机制对 pipiclaw 比对 oh-my-pi 更重要）。

### 总体设计

三件套：**JobManager**（每频道，挂在 ChannelRunner）、bash 的 **`async` 参数 + auto-background**、**`job` 工具**。完成投递复用 events 的唤醒路径。

#### JobManager（`src/agent/job-manager.ts`，新增）

关键取舍：**作业进程必须活在 executor 的世界里**（host 或 docker），不能是 pipiclaw 进程内的 child handle——否则 docker sandbox 下无法成立。因此作业的生命周期完全通过 executor 命令管理：

- **启动**：`nohup <command> > <spillFile> 2>&1 & echo $!` 经 `executor.exec` 一次性返回 PID。spill 文件复用 `bash.ts` 的 `getSpillFilePath()` 机制（`/tmp/pipiclaw-bash-<id>.log`，host 与 docker 均可写、模型可 read）。
- **状态探测**：`kill -0 <pid>` 判活；退出码经 wrapper 落地（启动命令实际为 `sh -c '<command>; echo $? > <spillFile>.exit'` 的 nohup 形态），`.exit` 文件存在即完成。
- **取消**：`kill <pid>`（TERM），2s 后仍活则 `kill -9`。
- **注册表**：进程内 Map（jobId → { pid, label, command, spillFile, startedAt, status }），随 ChannelRunner 生命周期；**不持久化**——进程重启后孤儿作业自然由 spill 文件留痕，`job list` 对失联作业标 `lost (process restarted)`。持久化留作后续演进，本轮明确不做。
- **上限**：每频道并发运行作业 ≤ 5（超出时 `async` 请求报错并建议先 `job list`）；作业硬超时沿用 bash `timeout` 语义（默认 300s，作业启动时以 `timeout <n> sh -c ...` 包裹，防失控进程）。

#### bash 工具改动

1. 新增 `async: Type.Optional(Type.Boolean())`：为 true 时经 JobManager 启动，立即返回：
   ```text
   Background job <id> started: <label>
   Output streams to <spillFile>. Poll with job {op:"poll"}; it is delivered
   automatically when finished.
   ```
2. **auto-background**：前台命令跑到阈值（`tools.jobs.autoBackgroundSeconds`，默认 45，0=关闭）仍未退出且未被 abort，自动转后台——但受 executor 限制，**前台命令无法中途"转"后台**（exec 是一次性调用）。因此实现为反向策略：当 `tools.jobs.enabled` 且命令未显式 `async` 时，**一律先以后台形态启动**，前台等待循环轮询 `.exit` 文件，阈值内完成则读 spill 全文按现行截断管线返回（对模型完全等价于今天的前台执行）；超阈值则返回 background-start 结果。这正是 oh-my-pi auto-background 的语义，且天然规避"转移"难题。
   - 例外：带 `stdin` 的内部调用（spill 写入等）不走此路径。
3. abort 信号（`/stop`）在前台等待期收到时：默认杀作业（保持现行语义）；模型显式 `async: true` 的作业不受 `/stop` 影响（它已归还回合）。

#### `job` 工具（`src/tools/job.ts`，新增）

op 风格，与 `task_manage`/`event_manage` 同构：

```ts
const jobSchema = Type.Object({
  label: Type.String(),
  op: Type.Union([Type.Literal("list"), Type.Literal("poll"), Type.Literal("cancel")]),
  ids: Type.Optional(Type.Array(Type.String())),   // poll/cancel；poll 省略 = 全部运行中
});
```

借 oh-my-pi 的边界语义：

- `poll` 等到**第一个**目标作业完成即返回快照，其余列 `Still Running`（模型需再次 poll）；等待窗口用自适应阶梯 5s→10s→30s→60s（连续 poll 爬一档，60s 无 poll 重置），封顶不超过回合合理时长。
- `cancel` 非运行中作业返回 `already_completed` 而非报错；未知 id 返回 `not_found` 而非报错。
- `list` 纯快照不等待。
- 完成作业的结果文本 = spill 尾部按 `truncateTail` 截断 + `Full output: <spillFile>` 提示 + exit code。

#### 完成投递（复用 events 唤醒路径）

JobManager 内部低频巡检（运行中作业每 10s 一次 `.exit` 探测，无作业时不巡检）。作业完成且**未被 poll 取走**（acknowledged 标记，语义同 oh-my-pi 的 delivery suppression）时，向频道注入一次系统侧回合：走 events watcher 对 run-queue 的同一注入入口（`bootstrap.ts` 中 events 唤醒 ChannelRunner 的路径，实现期确认具体挂点），prompt 形如 `[system] Background job <id> (<label>) finished with exit code <n>. Tail: ...`。模型已 poll 到结果的作业不再投递（防双份）。

### 与 task ledger 的关系

长任务型 task 可在正文记录 job id，但**不建立结构性耦合**——job 是分钟级、进程内、易失的；task 是天级、文件化、持久的。二者的桥梁是模型的 SOP，不是代码。

### 门控与注册

- gate `tools.jobs.enabled`（默认 **false** 先灰度，运营验证后翻 true）：关闭时 bash 无 `async` 参数行为（传入报错并说明）、`job` 工具不注册、auto-background 不生效——完全回到现行为。
- `job` 工具 `availableToSubagents: false`（子代理回合短，后台作业归主 agent 编排）；bash 的 `async` 参数在子代理集同样不暴露。

### 验收

- 单测（用 fake executor）：启动/探测/取消/上限/lost 语义；auto-background 阈值内等价前台、超阈值转 background-start；poll 首完成即返、阶梯递增；cancel 幂等语义；suppression（poll 过的不再投递）。
- e2e：`sleep 90` 触发 auto-background → job poll → 完成投递，全链路。

---

## T4：`memory_manage` 演进（Wave 2）

### 动机

写侧只有 `memory_save`（进 candidate store），读侧只有每回合自动 recall + `session_search`（冷转录）。缺两个动词：

1. **显式检索**：模型执行任务中途想查"用户对 X 的偏好"没有主动入口——session_search 查的是原始转录（贵、噪声大），不是提炼后的 `MEMORY.md`/`HISTORY.md`。
2. **忘记/作废**：用户说"忘掉这个"时模型只能用 `edit` 直改 `MEMORY.md`——**绕过了 channel-maintenance-queue 的串行化**，与 maintenance jobs 存在竞态（CLAUDE.md 明令保护的不变量）。

### 设计：一个 op 工具，净增工具数 0

把 `memory_save` 演进为 `memory_manage`，与 task/event/skill 形成统一的 "manage 工具族" 心智：

```ts
const memoryManageSchema = Type.Object({
  label: Type.String(),
  op: Type.Union([
    Type.Literal("save"),        // 现 memory_save 语义原样迁移（candidate store）
    Type.Literal("search"),      // 检索 MEMORY.md + HISTORY.md + candidates
    Type.Literal("invalidate"),  // 软作废：标记条目过时，留痕供 consolidation 参考
    Type.Literal("forget"),      // 硬删：立即从 MEMORY.md 移除
  ]),
  content: Type.Optional(Type.String()),   // save 必填
  query: Type.Optional(Type.String()),     // search 必填
  target: Type.Optional(Type.String()),    // invalidate/forget：条目定位文本（精确子串）
  reason: Type.Optional(Type.String()),    // invalidate/forget：动因，写入审计行
});
```

关键语义（借 oh-my-pi 的 update/invalidate/forget 三分法，落到文件形态）：

- **search**：确定性检索（关键词/子串打分，不走 LLM），返回条目原文 + 来源文件 + 定位（供后续 invalidate/forget 的 `target` 用）。上限 8 条。空结果给放宽建议（T1 规约）。**不与自动 recall 争职责**——recall 是"本回合话题"的被动注入，search 是任务中途的主动点查。
- **invalidate**：不删除，在目标条目上追加标记（如行尾 `⟪invalidated 2026-07-09: <reason>⟫`），下次 consolidation 时由 sidecar 决定归档进 `HISTORY.md` 还是清除。用于"事实过时但历史可能有用"。
- **forget**：从 `MEMORY.md` 移除条目，审计行写入维护日志。用于用户明确要求删除（隐私类）。`target` 不唯一命中时报错并列出候选（不猜）。
- **所有写操作经 `channel-maintenance-queue` 的共享单例串行队列执行**（与 lifecycle/maintenance-jobs 同队列），杜绝竞态。这是本任务的核心工程约束。

### 配套：prompt SOP 更新

系统提示中"用户要求忘记时"的指引从"编辑 MEMORY.md"改为"用 memory_manage forget/invalidate"；明确 edit/write **不应**直接触碰 `MEMORY.md`/`HISTORY.md`（软约束，靠 SOP；是否上 path-guard 硬拦截留待运营观察，避免误伤 memory 维护调试场景）。

### 迁移

- `memory-save.ts` 删除，`memory_save` 名字不保留别名（模型按 prompt hint 用新名，无历史会话兼容负担——工具名不进持久化状态）。
- gate 沿用 `tools.memory.save.enabled` 更名为 `tools.memory.manage.enabled`（config.ts 默认 true；旧键在 loadToolsConfig 做一次向后兼容读取）。

### 验收

- 单测：四个 op 的行为；invalidate 标记格式与 consolidation 的兼容（consolidation 测试样例加入含标记的条目）；forget 多命中报错列候选；所有写路径断言经过共享队列（注入 spy 队列）；search 上限与空结果文案。
- `memory-lifecycle.test.ts` 回归：维护管线对 invalidated 条目的处理。

---

## T5：read 增强：目录 + 文档（Wave 2）

按 pipiclaw 实际负载（个人助手收文档 >> 代码考古）挑两样，均在 `read.ts` 内分支，不改接口：

### T5a 目录读取

现状 `read` 一个目录会失败（`cat` 报错）。新增分支：path 为目录时（`test -d` 探测）返回目录树，规格抄 oh-my-pi：深度 2、每目录 12 项、按 mtime 新旧排序、附大小与相对时间，超限标 `[+N more]`。空目录返回 `(empty directory)`。实现用一条 executor 命令（`find -maxdepth 2` + `stat`）取数、JS 侧塑形。

### T5b 文档转换

扩展名命中 `.pdf`（首批只做 PDF，`.docx` 等看运营需求）时，经 sandbox 内 `pdftotext -layout` 转文本后走现行 offset/limit/truncateHead 管线。要点：

- 转换失败**不抛错**，返回 `[Cannot read .pdf file: <reason>. The file may be scanned/image-based.]`（T1 规约：附下一步——建议用户转发文字版或截图）。
- `pdftotext` 缺失时提示安装路径（host）/ 镜像升级（docker）；Dockerfile 加装 `poppler-utils`。
- 转换结果不缓存（文件级 read 本就低频；缓存留给 T6 的 URL 场景）。

### 验收

- 目录：树形格式、排序、每目录上限、空目录、深度截断，单测（fake executor 喂 find/stat 输出）。
- PDF：有 pdftotext 时转换 + offset/limit 生效；无 pdftotext / 转换失败的降级文案。

---

## T6：web_fetch 缓存 + 分页（Wave 3）

### 动机

oh-my-pi 的 URL 读取链路里对长程助手最实用的一条：**渲染结果缓存 + 本地分页**——长文被截断后续读不重新发请求。pipiclaw 的 `web-fetch.ts` 目前是一次性抓取，读长文被截断即死路（重抓昂贵且不确定）。

### 设计

- `web_fetch` 增加 `offset`/`limit` 可选参数（语义同 read）。
- 抓取结果（抽取后的可读文本）落频道目录缓存：`<channelDir>/web-cache/<sha256(url)>.txt` + 同名 `.meta.json`（url、抓取时间、content-type）。TTL 15 分钟（同 URL + 未过期 + 带 offset 的调用直接翻缓存，不发请求）；容量上限 20 个文件，LRU 淘汰。
- 截断尾注从"被截断了"改为可照做的续读指令（T1 规约）：`[Showing lines 1-400 of 2100. Re-call web_fetch with the same url and offset=401 — served from cache, no refetch.]`
- 低成本取内容技巧（各一次尝试、失败静默降级，不做 oh-my-pi 的完整管线）：HTML 且正文抽取质量差时，依次试 `<url>.md`、`Accept: text/markdown` 内容协商。

### 验收

- 单测（mock fetch）：命中缓存不发请求、TTL 过期重抓、LRU 淘汰、offset 翻页、尾注文案、降级链。

---

## T7：skill 三工具合一（Wave 3）

`skill_list` / `skill_view` / `skill_manage` 三个工具、三条 prompt hint，做的是一个领域的事（oh-my-pi 仅一个 `manage_skill`）。合并为一个 op 风格 `skill_manage`：

```ts
op: "list" | "view" | "create" | "patch" | "write_file"   // 现三工具的 action 全集：list/view 来自被合并的两工具，后三者为 skill_manage 现有 action
```

- `skill-list.ts`/`skill-view.ts` 的实现函数并入 `skill-manage.ts`（逻辑原样迁移，非重写）。
- gate 沿用 `tools.skills.manage.enabled`。
- prompt 净省两行 hint；模型选择面更干净。
- 纯精简性收益、无新能力，放 Wave 3 收尾。

### 验收

- 现有 skill 三工具的测试全部迁移到 op 形态并通过；registry 三处同步；`ALL_TOOL_NAMES` 更新。

---

## T8：bash 拦截器（轻量版，Wave 3，依赖 T2）

### 动机与边界

oh-my-pi 用规则拦截"有更好工具"的 shell 模式，报错导向 read/grep/edit。pipiclaw 已有 rtk 优化器（管"输出更省"），拦截器管"路径更对"，二者互补。**前置条件是 T2 落地**——否则拦了 `grep -rn` 模型无路可走。

### 设计

- 挂点：`bash.ts` 中 **command-guard 之后、rtk 之前**（guard 必须看到真实命令；拦截发生在语义等价改写之前）。
- 默认规则只取最明确的三类（宁缺毋滥，误拦的代价是模型多一轮困惑）：

| 模式 | 导向 | 报错文案要点 |
|------|------|--------------|
| `^cat <file>$`（整文件、无管道） | `read` | read 有截断保护与续读指令 |
| `grep/rg -r`（递归内容搜索） | `grep` 工具 | 分组、分页、token 有界 |
| `sed -i` / `perl -i` | `edit` | edit 有唯一性校验与 diff 回显 |

- 报错即导航（T1 规约）：`Blocked: use the read tool instead — it truncates safely and tells you how to continue. Command: <cmd>`。
- 规则表落 `tools.json`（`tools.bashInterceptor.rules`，可增删禁用），gate `tools.bashInterceptor.enabled` 默认 **false** 先灰度（观察 rtk 与拦截器叠加后的模型行为，再翻默认）。
- 带管道/重定向的复合命令**不拦**（`cat x | jq` 是合法用法）——规则用锚定正则保证只命中裸形态。

### 验收

- 单测：三类命中、复合命令不命中、规则禁用生效、guard→拦截器→rtk 的顺序断言。

---

## 并发与安全（跨任务汇总）

- **T2 grep / T5 read 目录与文档**：只读，走 path-guard；pattern/glob 经转义与白名单，不构成命令注入面。
- **T3 jobs**：作业进程活在 executor 世界（host/docker 一致）；启动命令整体经 command-guard（guard 看到的是用户意图的原命令，nohup 包裹在 guard 之后）；每频道 ≤5 并发 + 硬超时包裹，防失控进程；spill 路径沿用现有机制。完成投递走 events 同一注入入口，不新增消息通路。JobManager 状态进程内、不持久化——重启后 `lost` 语义诚实呈现，不假装恢复。
- **T4 memory_manage**：所有写操作经 channel-maintenance-queue 共享单例串行队列（本 spec 最重要的工程约束）；forget 有审计行；target 多命中不猜、报错列候选。
- **T6 web-cache**：缓存落频道目录（channel 隔离天然成立）；LRU + TTL 防膨胀；缓存文件名为 URL 哈希，无路径注入面。
- **T8 拦截器**：在 guard 之后运行，不影响安全判定；只影响"用哪个工具"，不放行任何 guard 会拦的东西。

## 风险

| 风险 | 缓解 |
|------|------|
| T3 auto-background 改变了所有 bash 的执行形态（先后台再等待），引入兼容性回归 | gate 默认 false 灰度；对模型语义等价（阈值内完成时输出与现行前台一致）有专门等价性测试；带 stdin 的内部调用不走此路径 |
| T3 完成投递与用户消息回合交错，造成上下文混乱 | 投递走 run-queue 串行（天然不与用户回合并发）；已被 poll 取走的作业抑制投递 |
| T4 invalidate 标记格式与 consolidation/sidecar 的解析冲突 | 标记格式写进 `docs/`（memory 契约处）作为单一事实源；consolidation 测试样例前置加入含标记条目 |
| T8 误拦合法命令、模型陷入困惑 | 默认规则仅三类裸形态 + 锚定正则；gate 默认 false；报错文案给明确替代路径 |
| 工具数回升侵蚀精简性 | 本 spec 净增 ≈1（+grep +job −2 skill，memory_save 原地演进）；§非目标 确立"逼近 20 先合并"的警戒线 |
| T2 rg/grep 输出格式跨平台差异（macOS grep vs GNU grep vs rg） | 塑形层只依赖 `path:line:text` 与 `-C` 的分隔约定；CI 中 host（darwin）与 docker（alpine/GNU）双跑 grep 工具测试 |

## 测试

各任务的验收小节已列明细，汇总新增/修改的测试面：

- 新增：`test/grep-tool.test.ts`、`test/job-manager.test.ts`、`test/job-tool.test.ts`、`test/memory-manage.test.ts`、`test/web-cache.test.ts`、`test/bash-interceptor.test.ts`。
- 修改：`test/edit-tool*.test.ts`（no-op guard、diff 回显）、`test/read-tool*.test.ts`（目录、PDF、越界文案）、`test/bash-tool*.test.ts`（async、auto-background、guard 文案）、skill 三件迁移、memory-lifecycle 回归、registry/index/config 三件套。
- e2e：T3 全链路（auto-background → poll → 完成投递）一条。

## 文档更新

- `docs/`（工具参考处）：grep、job、memory_manage、skill_manage（op 形态）、bash `async`/拦截器、web_fetch 分页——各一节。
- `docs/configuration.md`：`tools.grep.enabled`、`tools.jobs.*`、`tools.memory.manage.enabled`（含旧键兼容说明）、`tools.bashInterceptor.*`、web-cache 参数。
- 仓库 `AGENTS.md`：T1 错误导航化规约一条。
- `~/.pi/pipiclaw/workspace/AGENTS.md`（运营）：SOP 更新——忘记/作废走 memory_manage；长命令用 async + job；搜索优先 grep 工具。
- 记忆契约文档：invalidate 标记格式（单一事实源）。

## 成功标准

1. **T1**：任意工具的错误/截断输出均含可照做的下一步指令；edit no-op 三连被硬拦；edit 结果自带 diff，运营中"edit 后跟一次验证性 read"的模式显著减少。
2. **T2**：模型在搜索场景默认选 grep 工具；同等搜索任务的工具输出 token 相比裸 `bash grep -rn` 显著下降（spill 触发率近零）。
3. **T3**：长命令不再锁频道——运营中出现"作业后台跑、用户继续对话、完成后自动收到结果"的完整链路；`/steer` 在作业运行期可达。
4. **T4**：用户"忘掉 X"由 memory_manage 闭环，`MEMORY.md` 不再被 edit 直改；维护日志可审计每次 forget/invalidate。
5. **T5/T6**：用户丢 PDF/长网页链接可直接读、可续读，不触发重抓。
6. **T7/T8**：prompt 工具区更短；bash 中 `cat 整文件`/递归 grep 的出现率趋零。

## 实现说明（与本设计的有意偏差）

实现时按 KISS / 无技术债原则做了几处有意识的收窄，记录如下，避免本文档误导后来者：

- **T3 未做 auto-background 反转**：不把所有前台 bash 改写成"先后台再等待"。Executor 的 `exec` 是一次性调用，无法把一个已在前台运行的命令中途转后台；为此重写核心前台路径（stdout 捕获、流式、abort/timeout、既有 spill 逻辑）的等价性风险远大于收益。改为显式 `async: true`。长命令的常见场景由模型显式选择 async 覆盖。
- **T3 未做独立的完成自动投递**：JobManager 不主动"唤醒频道"。pipiclaw 已有频道自唤醒机制（`event_manage` 的 one-shot/periodic 事件经 `bot.enqueueEvent` 注入 run-queue）。把 bot 回调穿过 4 层（bot→bootstrap→runner-factory→ChannelRunner→tool）纯属重复造轮子。范式：启动 async 作业 + 用 `event_manage` 排一个 check-in 事件去 `job poll`。`job poll` 亦支持短时阻塞等待首个完成。
- **T4 未做 soft-invalidate**：只做 `save`/`search`/`forget`。软作废（保留条目但标记过时）只有在 recall/consolidation 理解该标记时才有用，否则过时事实仍被 recall——这是会引入的耦合。`forget`（经共享串行队列的硬删）已覆盖用户"忘掉 X"的诉求，零耦合。
- **T4 gate 键名保持 `tools.memory.save.enabled`**：工具已更名 `memory_manage`，但沿用既有 gate 键，避免一次"重命名 + 向后兼容 shim"（shim 本身即债）或静默重置用户配置。
- **T5 目录树不含大小/mtime**：`find -printf` / `stat` 的格式在 BSD/GNU/busybox 间不一致；只用 `find -maxdepth 2` + `sed` 标注目录（可移植），呈现结构而非元数据。PDF 首批只支持 `.pdf`（`pdftotext`），缺二进制时优雅降级并给出下一步。仓库内无 Dockerfile，故 poppler-utils 由用户镜像提供，错误信息已引导。
- **T5 未做 archive/SQLite read 选择器**：见 §非目标，需求出现前不做。
- **T6 未做低成本备选抽取链**（`URL.md` / content negotiation / `llms.txt`）：缓存 + 分页是核心价值；备选抽取是可后续叠加的细化。
- **grep 保留上下文行**：设计草稿曾担心跨平台上下文解析歧义，实现用"锚定当前匹配文件路径"消歧，安全保留了 before=1/after=3。执行层用 `grep`（非 `rg` 探测），JS 侧承担全部塑形。
- **bash 拦截器规则硬编码**（未做 `tools.bashInterceptor.rules` 可配）：只保留三条最明确的裸形态规则，gate 用 `enabled` 单开关；可配规则表是可后续叠加的细化，当前会增加配置校验面而收益有限。

各 gate 的默认值：`grep` 默认开；`jobs`、`bashInterceptor` 默认关（灰度），运营验证后再翻默认。

## 分阶段交付

- **Wave 1（纯增量、无架构改动，可即刻开工）**：T1 + T2。两个独立 PR：T1 是文案与小状态；T2 是新工具标准三处同步。
- **Wave 2（有架构面，逐个上）**：T3（gate 默认 false 灰度）→ T4（memory 子系统正式变更，注意串行队列不变量）→ T5（独立小 PR，可与前两者并行）。
- **Wave 3（收尾与打磨）**：T6 → T7 → T8（T8 待 T2 运营稳定后再翻默认）。
- 每个 wave 结束跑 `npm run check` 全量门 + 运营观察一段（channel telemetry / 维护日志），再进下一 wave。T3、T8 的 gate 默认值翻转各自独立决策。

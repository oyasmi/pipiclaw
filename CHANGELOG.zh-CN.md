# 更新日志

说明：请与 `CHANGELOG.md` 保持同步更新。

## [Unreleased]

## [0.8.4] - 2026-07-12

### 变更

- 将频道轮次生命周期统一收敛到 `ChannelRunner`：钉钉派发、TUI、任务调度与状态渲染均从同一份显式轮次状态派生忙碌与停止状态，并共用 runtime 频道队列。
- 非活跃频道的记忆维护现在使用轻量、磁盘驱动的上下文，不再创建并长期保留完整 agent runner。任务工具、任务摘要和 task driver 统一受 `tools.tasks.enabled` 总开关控制。
- 更新配置与运维指南，并新增按实际实现编写的架构指南，说明运行时拓扑、消息生命周期、并发边界、记忆分层和运维不变量。

## [0.8.2] - 2026-07-11

### 变更

- 未知斜杠命令（如笔误 `/modle`）现在在派发层直接拒绝并提示 `/help`，钉钉与 TUI 同步生效，不再作为普通消息发给模型。斜杠命令的帮助文本、TUI 补全与忙碌提示改为单一元数据源生成。
- README 按用户可感知的能力重写，替代按迭代累积的功能公告；浓缩 AI Agent 安装说明，删去与 `docs/` 重复的章节。`docs/scaling-and-concurrency.md` 精简为持久有效的并发模型；`docs/configuration.md` 与 `docs/deployment-and-operations.md` 同步修缮（可观测性入口、备份清单补 `security.json`、task driver 排障）。

### 新增

- Runtime 知识改为仿 pi 的渐进式组织：九份带触发 metadata 的只读 playbook 随包发布到 `dist/playbooks/`，系统提示只保留所有权/安全不变量、task 恢复纪律和自动生成的小型索引。目录覆盖 runtime 导航、记忆与学习、事件调度，以及任务规划/推进/周期/委派/验收/修复；runtime 事实不再复制到 workspace `AGENTS.md` 或 skill，用户/团队层保持独立。第三方 agent 工具明确解耦：删除内置 agentmux 传感器，工具命令和完成态检测归用户可执行文件与 workspace skill。closeout playbook 同时补齐 independent verification + external approval 的 hash-safe 顺序。

## [0.8.0] - 2026-07-10

### 新增

- Task Loop v2 完成轻量自主工作闭环：每个 driver 回合都会带上紧凑的 Task Capsule（标题、状态、最近 checkpoint、下一动作和剩余 attempt 预算），完整 Markdown task 仍是人可读的唯一事实源。
- 操作者控制面：`/tasks run <id>` 会恢复任务，并在 DingTalk runtime 可用时立即进行持久入队；`/tasks stats [id]` 不消耗 LLM 回合即可报告 attempt、token、成本、墙钟时间、最近结果与验收状态。
- 对 task-driver 正在执行的任务发送 `/stop` 时，runtime 会先持久 `pause` 任务，再中断当前模型回合，避免用户暂停后发生意外自动续跑。
- 新增 Task Loop v2 设计规格（`docs/specs/024-task-loop-v2`），明确 at-least-once、有界 token 开销、状态机、恢复路径和有意保留的非目标。

### 变更

- v2 最终流程变为显式且可检查的：wake/event/user run → durable dispatch → 有界 driver attempt → 原子 checkpoint → continue、wait、verify、pause 或 escalate。它保持 file-native、单进程，而不是演变成工作流引擎。

## [0.7.10] - 2026-07-10

### 新增

- 受治理任务 control（P1）：priority/deadline/next-action、累计 attempt/token/cost/wall-time 预算、副作用策略、父子依赖、隔离意图和验收状态都经过校验。原生 driver 不调用 LLM 即可检查硬限制与终止性依赖，回写真实用量，并在超限时升级而不是继续循环。
- 独立验收：任务骨架新增 Verification；`subagent purpose=verify` 以只读 checker 运行并持久化绑定 task body 的证明，供 `task_manage verify` 导入。缺少/过期/失败的验收、未完成依赖/子任务或未授权外部动作都会阻止 `done`。
- `/tasks approve <id>` 提供显式外部动作授权；runtime 直接记录授权人/时间，`task_manage` 无法自授予。
- 长任务分解与隔离（P2）：parent/child 与 `dependsOn` 会门禁执行/收尾，并拒绝缺失、自指和成环关系；`subagent isolation=worktree` 可创建或复用 task-owned host git worktree，并返回 path/branch。
- 内建 task driver：DingTalk daemon 原生按 `status`/`wake` 确定性扫描并唤醒 actionable task，长程工作不再要求手工安装 heartbeat event、`tasks-pending.mjs` 或配套 `.checkin`。派发会跳过运行中的 channel、跨 channel 轮转、限制单 tick 数量；台账有进展时短冷却续跑，无变化时长退避，避免 token 热循环。
- `task_manage progress`：在一次原子文件替换中追加 Current Cycle checkpoint 并更新 status/wake/recurrence。工具注册时，系统提示会自动注入完整任务生命周期 SOP。
- 新增 `settings.taskDriver`，可控制 driver 开关、续跑冷却、停滞重试与单 tick 派发上限；默认值保守且所有数值都有安全范围。
- task driver 的冷却判断现已基于语义任务状态而非文件 mtime：usage/cost 核算不会再把无进展的受治理任务误判为应短间隔续跑。
- 新增 `/tasks pause <id>` 与 `/tasks resume <id>`，让用户可持久暂停和恢复自主唤醒。
- 新增 `task_manage start-cycle`：已完成的周期任务可原子开启具名新周期；上一周期的可见进展进入 History，并清空本周期 usage、approval、verification 与 worktree 状态。
- 持久 synthetic dispatch：scheduled event 与 task-driver wake 会先写入 `state/dispatch/`，再进入内存 channel queue。lease 保护正在处理的工作；重启后会重放 pending 或过期 dispatch，提供有意识的 at-least-once 投递语义。
- 已过期 one-shot event 现在会在恢复时执行一次，不再静默删除；periodic event 保持既有 cadence 与 queue-full 语义。
- 质量闭环入口：`task_manage candidate` 会把所有验收项已勾选的工作转入 `verifying`；native driver 下一回合会给出只做 checker 的明确指令，而非继续实现。
- 独立 verifier attestation 除 task body 外，在 host Git checkout 中还绑定 HEAD、status、暂存与未暂存 diff 的 SHA-256 artifact subject。导入 PASS 或完成任务时若产物已变化，会拒绝旧验收。

### 变更

- `/tasks`、task agenda 与 `/tasks doctor` 现在展示治理状态；`task_manage` 新增 `verify` / `cancel`，progress 会使旧验收失效。
- task `wake` 成为普通恢复的单一条件。task-owned one-shot `.checkin` 进入兼容退役：升级期间 driver 会短暂让 live checkin 负责交接，`/tasks doctor` 会建议删除；周期任务仍只用 `.schedule` 开启新周期。
- 任务摘要现在读取 Current Cycle 的最后一条记录，不再被骨架创建时的第一条默认文本长期遮住，注入议程会反映真正的最新进展。

## [0.7.7] - 2026-07-09

任务台账加固：收紧 task/event 生命周期，让长程自主工作拥有更清晰、可审计的控制面，同时不再引入新的用户概念。

### 新增

- `task_manage create`：创建标准化任务台账，包含 frontmatter 以及 `Goal`、`DoD`、`Manual`、`Current Cycle`、`History` 等固定章节，为长任务提供唯一的规范起点。
- `/tasks doctor`：在钉钉与 TUI 中新增只读诊断命令，用于检查任务/事件一致性，包括 frontmatter 损坏、已归档任务仍有 live event、孤儿 task event、周期任务缺 schedule、check-in 不匹配、缺少标准台账章节等问题。每个问题都带可执行的下一步建议。
- 抽出共享的 task event 命名与 task ledger 章节辅助函数，使运行时命令和工具由同一份实现强制执行相同约定。

### 变更

- `task_manage done` 现在要求提供完成 `summary` 与 `evidence`，会向任务台账追加 `Completion Evidence` 章节，再标记 done 并归档。可选的 `residualRisk` 会随证据一起记录。
- 周期任务清理现在只保留规范的 `task.<channel>.<taskId>.schedule.json` 周期 schedule；任务完成时会删除生命周期 check-in 与委派工作轮询事件，避免残留唤醒。
- `/tasks` 帮助、自动补全、文档和任务诊断现在在钉钉与 TUI 中更一致地呈现任务台账模型。

## [0.7.6] - 2026-07-09

工具集增强（spec 021）：落地四条设计内核——token 经济、错误即导航、一个入口吃一类需求、长任务不阻塞回合——但不扩张工具清单，保持 pipiclaw 精简长程助手的定位。

### 新增

- `grep` 工具（T2）：正则文件内容搜索，执行层薄、JS 侧塑形厚——按文件分组、before=1/after=3 上下文、每行 512 字符截断、单文件匹配上限（多文件 20 / 单文件 200）、20 文件/页 + `Use skip=N` 翻页、空结果放宽建议。`pattern`/`path` 经 `shellEscape`、`glob` 经正则转义，`path` 走 path-guard。子代理可用以支撑研究。由 `tools.grep.enabled` 门控（默认开）。
- 后台 bash 作业 + `job` 工具（T3）：`bash async:true` 经 `nohup` 在 executor 世界里启动命令并立即返回作业 id，长命令（`npm install`、爬虫）不再占用频道 run queue。`job` 工具（op `list`/`poll`/`cancel`）用于查看与控制，`poll` 短时阻塞等待首个作业完成。作业完全活在 shell（host 或 docker）里，状态进程内、不持久化（重启后旧作业标 `lost`），每频道并发上限 5，硬超时由 JS 侧强制。仅主 agent 可用（子代理不可后台）。由 `tools.jobs.enabled` 门控（默认开）。
- `read` 目录与 PDF 支持（T5）：读目录返回深度 2 的目录树（每目录 12 项、`[+N more]`、`(empty directory)`）；读 `.pdf` 经 `pdftotext -layout` 走现行 offset/limit/截断管线，缺二进制或扫描件/图片时优雅降级并附下一步指引。
- `web_fetch` 缓存 + 分页（T6）：抓取后的可读文本按频道缓存（`sha256(mode\nurl)` 键、15 分钟 TTL、LRU 上限 20 个文件），`offset`/`limit` 直接翻缓存不重抓；截断尾注改为可照做的「带 offset=Y 重新调用（走缓存、不重抓）」指令。每页重新附上不可信内容横幅。
- `AGENTS.md` 错误导航化规约（T1）：任何工具的错误或截断输出必须包含一条可照做的下一步指令。已应用于 `read` 越界/空 offset、`bash` command-guard 拦截、`session_search` 空结果。
- `edit` no-op 循环防护与 diff 回显（T1）：对同一文件同一 payload 连续 3 次字节级 no-op 升级为硬错误，提示重读锚点而非加宽 `oldText`；成功 edit 现在在结果中回显紧凑（≤40 行）diff，模型极少再需一次验证性重读。

### 变更

- `memory_save` 演进为 `memory_manage`（T4），含 `save`/`search`/`forget` 三个 op，净增工具数 0。`search` 是对提炼后 `MEMORY.md`/`HISTORY.md` 的廉价确定性点查（复用 recall 打分、关闭模型 rerank）；`forget` 删除唯一命中条目、拒绝歧义目标。所有写操作经共享的 channel-maintenance 队列串行，消除了直接 `edit` `MEMORY.md` 与后台 consolidation 的竞态。gate 键沿用 `tools.memory.save.enabled`，避免重置用户已有配置。
- `skill_list` 与 `skill_view` 合并进 `skill_manage`（T7）：一个 op 风格工具（`list`/`view`/`create`/`patch`/`write_file`）取代三个，省两行 prompt hint。gate 沿用 `tools.skills.manage.enabled`。
- `bash` 拦截器（T8）：`tools.bashInterceptor.enabled`（默认开）时，把几类最明确的裸 shell 形态（`cat <file>`、递归 `grep`/`rg`、`sed -i`/`perl -i`）导向对应专用工具。运行在 command-guard 之后（guard 始终看到真实命令）、rtk 之前；带管道/复合的命令原样放行。依赖 T2。
- 系统提示现在明确指示模型不要用 edit/write 直改频道 `MEMORY.md`/`HISTORY.md`——这些文件由运行时管理，须走 `memory_manage`。

### 修复

- 后台作业：运行态作业上报的 `durationMs` 是绝对 epoch 时间戳而非已运行时长，导致 `job` 工具对在跑作业渲染出天文数字时长。
- 后台作业：完成或超时的作业此前只在模型恰好调用 `list`/`poll`/`cancel` 时才被回收，因此一个从不轮询的作业会永久占用并发槽位，最终可能锁死该频道的全部 `async`。现在由一个低频内部 sweeper reconcile 运行中作业（不唤醒频道）并释放其槽位。
- `bash` 拦截器：递归 `grep` 规则未做结尾锚定，导致合法的管道递归 grep（`grep -rn foo . | wc -l`）被误拦。现已排除管道/重定向字符并锚定行尾，与 `cat`/`rg` 规则对齐。
- `grep`：`details.matchCount` 统计的是页内文件的全部匹配数而非实际展示数，在文件匹配被截断时过报。
- `memory_manage` `forget` 现在向频道维护日志（`memory-review.jsonl`）写一条审计行（`reason: "user-forget"`，含被删条目），使 forget 可审计，而不再只能从 `.memory-backups/` 恢复。

## [0.7.5] - 2026-07-08

### 新增

- 任务台账支持（spec 019/020）：在 `docs/tasks.md` 中记录按 channel 隔离的 `workspace/<channelId>/tasks/*.md` 约定、心跳模式、任务/事件命名方案和操作流程。
- 新增 `event_manage` 工具，让主 agent 可以创建、更新和删除定时事件文件，并在写入前完成格式校验、channel 所有权检查、immediate/自唤醒防护、cron 频率限制、preAction 命令守卫和原子写入。
- 在钉钉与 TUI 中新增只读 `/tasks` 命令，支持查看 active 任务列表、archive 列表和单任务详情，并保持按 channel 隔离。
- 新增确定性的任务议程注入，由 `settings.taskDigest` 控制，把 active 任务的 frontmatter 与标题作为有界背景上下文注入主 agent 回合，无需依赖 LLM 主动扫描任务目录。
- 新增 `task_manage` 工具，用于结构化更新任务 frontmatter、列出任务，以及在任务完成时执行归档和相关 checkpoint 事件清理。

### 变更

- `event_manage` 现在仅在 periodic 事件带 `preAction` 门控时允许更短调度间隔：无门控 periodic 仍保持 30 分钟下限，带门控 periodic 可降到 5 分钟，用于用户提供的完成态传感器。
- 补充任务可见性、委派工作回访，以及任务文件、事件 checkpoint、周期性心跳传感器之间关系的文档。

## [0.7.4] - 2026-07-07

### 新增

- rtk 命令优化器（`tools.rtk`）：为 `bash` 新增可选的 [rtk（Rust Token Killer）](https://github.com/rtk-ai/rtk) 集成，在执行前把已知的只读命令改写成 token 精简的 `rtk` 等价形式（例如 `git status` → `rtk git status`），从而压缩返回给模型的输出。仅通过 `tools.json` 中的单个开关 `tools.rtk.enabled` 启用（默认关闭）；改写规则全部由 rtk 的 `rtk rewrite` 契约提供，pipiclaw 不内联任何规则，也不暴露任何实现细节参数。改写发生在命令守卫**之后**，因此 `command-guard` 始终针对操作者的原始命令做校验；主 agent 与子 agent 的 bash 都生效；可用性探测走命令的**实际执行环境**（host 的 PATH，或 Docker 沙箱内部）并按 executor 缓存结果；且为尽力而为——任何失败（rtk 未安装、超时、无等价命令）都会静默回退到原始命令，因此启用 rtk 永远不会让 bash 命令失败。判定以 `rtk rewrite` 的 stdout 为准而非退出码，因为 rtk 0.43.0 在成功改写时退出码为 3，尽管其 `--help` 声称为 0。

## [0.7.3] - 2026-07-05

### 变更

- 在移除 Windows 支持（0.7.1）以及新增 `/status` / `/usage` 命令之后同步文档：删除 README 中过时的 Windows/WSL host 模式章节和已失效的 `PIPICLAW_SHELL` 环境变量，将 Node 最低版本更正为 `>=22.19.0`（与 `package.json` engines 对齐），在 README 与扩展性文档的忙碌命令表中补上 `/status` 和 `/usage`，并刷新 `CLAUDE.md`（移除已删除的 `attach` 工具与过时的包名说明）和 `configuration.md`（SDK 包名、`security.json`、`PIPICLAW_LOG_LEVEL` / `PIPICLAW_LOG_FILE`）。

### 移除

- 移除 knip 无法发现的死代码（其 `ignoreExportsUsedInFile` 设置会把文件内自引用的导出当作“已使用”）：`createPipiclawBaseTools` 辅助函数（已被工具注册表取代）及其公共 barrel 导出、`ChannelStore.getLastTimestamp`、从未被发射的 `auto_compaction_*` 会话事件分支（联合类型收窄到仍在使用的 `compaction_start` / `compaction_end`），以及会把旧结构静默强转成全 add op 的 `memoryEntries` 巩固回退分支。

### 修复

- 记忆候选文件读取不再吞掉非 ENOENT 错误：权限或 IO 失败现在会正常抛出，而不再被当作“文件不存在”，与其他记忆读取路径保持一致。

### 开发

- 去重内部辅助函数：新增共享的 `readOptionalTextFile` / `isNodeError`（`src/shared/fs-utils.ts`）支撑各记忆文件读取路径，`eventNameFromFilename` 与 `parseUpdateHeadingTimestamp` 改为单一实现，`ChannelStore` 改用共享的 `SerialQueue` 替代手写的写入链。

## [0.7.2] - 2026-07-05

### 新增

- 终端 TUI（spec 018）：新增 `pipiclaw tui` 子命令，可直接在终端与 agent 对话，复用与钉钉运行时**同一套**配置、记忆和每 channel 会话，且**无需配置任何钉钉凭据**。TUI 通过 `prepareAppServices` 与守护进程路径共享 app 服务（settings、tools、security、沙箱校验），但跳过钉钉门控，因此无需填写 `channel.json` 也能运行，且从不构造 `DingTalkBot`。
  - 在 TTY 下渲染全屏 pi-tui 前端（滚动记录、状态行、流式进度、斜杠命令补全）；非 TTY 输入（管道/重定向）与 `--print` 会自动回退到纯文本前端。
  - 参数：`--channel <id>` 挂接到任意历史对话（例如 `dm_<staffId>` 可共享某个钉钉会话的记忆；默认 `tui_local`）；`--print`/`-p` 执行一次性非交互回合（prompt 取自命令行参数或 stdin）后退出；`--quiet`/`-q` 只打印最终答案；`--plain` 强制纯文本前端；`--sandbox=host`（默认）或 `--sandbox=docker:<name>` 选择工具隔离方式。
  - 续接是隐式且按 channel 进行的：用相同 `--channel` 重新运行即从 `context.jsonl` 还原上一轮对话——没有 `/resume` 命令，更长期的事实通过记忆层跨会话带回。
  - 斜杠命令：`/help`、`/new`、`/compact`、`/session`、`/status`、`/model`、`/usage`、`/events`、`/steer`、`/followup`、`/stop` 和 `/exit`；启动欢迎横幅；`Ctrl-C` / `Ctrl-D` / `/exit` 可可靠退出（退出前会先落盘记忆）。
  - 输出形态由 `settings.json` 中可选的 `tui` 块（`responseMode`）控制，与钉钉的 `channel.json.responseMode` 相互独立。

### 变更

- 重构 `bootstrap.ts`，将与传输无关的 app 初始化（`prepareAppServices`）与钉钉专属的运行时装配分离，使终端 TUI 和钉钉守护进程共享同一套配置、沙箱与日志初始化，而无需重复实现。

## [0.7.1] - 2026-07-05

### 新增

- 单一备用模型回退（spec 017）：当主模型的一次任务以错误结束时（不含 `/stop` 与上下文溢出场景），运行时会切换到配置的 `fallbackModel` 并把该回合重跑一次；经过 5 分钟冷却后自动切回主模型重试。通过 `fallbackModel` 设置项配置（不设置即禁用），在 `/status` 的 `Fallback` 行展示，并以结构化 `model_fallback` 日志事件记录。

### 移除

- 移除 Windows 支持及其平台相关的复杂度：删除 `isWindowsPlatform()` 以及命令/路径守卫的 fail-open 分支（此前 Windows 会完全绕过安全守卫）、Git Bash shell 探测、`PIPICLAW_SHELL`、`taskkill` 进程终止、沙箱的 `windowsHide` 选项，将 `toShellPath`/`shellEscapePath` 合并为 `shellEscape`，去掉凭证文件权限加固中的 win32 空操作，并清理相关的 Windows 专属测试与文档章节。

## [0.7.0] - 2026-07-04

### 新增

- `edit` 工具新增 `replaceAll` 选项，可替换目标文本的全部匹配，而不再要求匹配唯一。

### 变更

- `bash` 现在把非零退出码作为正常结果内联返回（附带退出码），而不再抛出错误，因此 `grep`、`diff`、`test` 等命令的退出码被当作数据而非工具故障。
- 收紧工具输入 schema：为 `skill_manage.action`、`subagent.contextMode`/`memory`、`memory_save.kind`、`session_search.roleFilter` 增加 enum 约束，为 `read`、`web_search`、`session_search`、`bash` 的数值参数增加整数边界，使非法值在生成阶段就被拒绝，而不是执行时才失败。
- `skill_view` 现在返回原始文件内容并按共享截断上限封顶，而不再是无上限、被 JSON 转义的文本；`skill_list` 和 `session_search` 改为输出紧凑 JSON。
- 围绕声明式工具注册表（`src/tools/registry.ts`）重构工具层：主工具集、子代理工具集和系统提示词的工具说明现在都从同一来源派生，而不再是三份手工维护的清单。

### 移除

- 移除未使用的 `attach` 工具；它从未被注册，且在 DingTalk 模式下不受支持。

### 修复

- 系统提示词不再与实际工具集漂移。在默认配置下（web 工具关闭），此前提示词会宣传未注册的 `web_search`/`web_fetch`，同时漏掉已注册的 `memory_save`。现在 `## Tools` 段落及每条工具相关指引都从本次会话实际注册的工具生成。
- `bash` 截断输出的落盘文件现在经 executor 写入沙箱内部，因此提示中的“full output”路径在 Docker 沙箱下对 `read`/`bash` 可达（此前是模型无法打开的宿主机临时路径）；同时移除了未 await 的写入流。
- `bash` 现在在未指定超时时应用 300 秒默认超时，因此永不返回的命令不会再把频道的 run queue 堵到用户 `/stop`。

### 开发

- 新增 spec `015-tool-registry`，记录注册表设计及推迟的后续项（工具中间件/遥测管道、`tools.json` schema 化、MCP 客户端、`read` 行号 / Read-before-Edit）。
- 新增契约测试：跨层校验注册工具集与提示词工具清单保持一致，以及工具注册表测试（名字唯一、hint 覆盖、主集/子集派生、config 门控）。

## [0.6.10] - 2026-07-03

### 新增

- 新增 `/events` 钉钉传输层命令，用于第一版定时事件管理：
  - `/events list` 列出事件文件名、类型、目标 `channelId`、`schedule` / `at` 和文本预览；非法 JSON 文件也会显示为 invalid，而不是被隐藏。
  - `/events show <name>` 展示指定事件文件的完整格式化 JSON。
  - `/events delete <name>` 删除对应的 `workspace/events/<name>.json` 文件。
  - `/events history [name]` 从 `state/events/history.jsonl` 展示最近的事件调度历史，并可按事件名过滤。
- 新增结构化事件调度历史 `${PIPICLAW_HOME:-~/.pi/pipiclaw}/state/events/history.jsonl`，以本地时间 JSONL 记录事件加载、调度、触发、preAction 结果、入队结果、删除、非法文件和取消调度等信息。
- 新增 Claude Code 使用说明文档（`CLAUDE.md`），覆盖开发命令、运行时分层、并发规则、记忆子系统边界、工具/安全结构和文档入口。

### 变更

- 事件文件解析现在由 `EventsWatcher` 和新的 `/events` 命令处理器共用，保证命令展示与运行时调度校验规则一致。
- `/events` 完全由运行时层处理，并且在频道忙碌时仍可执行，与 `/stop`、`/steer`、`/followup` 一样可用。
- `/new` 现在会把旧会话的 durable memory consolidation 放到后台执行，从而更快返回；关机和测试仍可等待这段后台工作完成。
- 更新 README、AGENTS 和事件文档，使其反映当前包作用域、运行时模块边界、app 级配置文件、`session_search`、workspace skill 管理和新的事件管理命令。
- 精简测试套件：删除重复且较慢的 `/new` runtime 测试，并把 session id 断言移动到更轻量的 command-extension 测试中。

### 修复

- 修复 `extractToolResultText(undefined)`，确保进度格式化始终返回字符串，而不会泄漏 `JSON.stringify` 对 `undefined` 的返回值。

### 开发

- 将 `knip` 死代码检查接入标准 `npm run check` 流程，并在 `tsconfig.json` 中启用 TypeScript 未使用符号检查。
- 清理新死代码检查和未使用符号检查发现的无用导出与既有 lint 问题。
- 新增聚焦的 `progress-formatter` 和 `event-commands` 测试，并补充 `/events` 命令在 DingTalk/runtime 层的路由覆盖。

## [0.6.9] - 2026-06-24

### 安全

- 修复了三处命令守卫旁路，避免危险命令绕过拦截规则：
  - `allowPatterns` 现在按命令原子（atom）做词边界锚定匹配，而不再对整条命令做子串包含判断，因此被允许的片段不能再放行链式危险命令（例如 `git status; rm -rf /`）。
  - 守卫现在会递归检查通过 `-c` 传入的 shell 脚本体（`sh`/`bash`/`zsh`/`dash`/`ash`/`ksh`，含 `-lc` 等组合标志），因此 `bash -c "rm -rf /"` 这类内容会被检查到。
  - 守卫现在会展开包装类命令（`xargs`、`env`、`time`、`nice`、`timeout`、`nohup`、`find -exec`/`-execdir` 等）并对内层命令进行守卫，因此 `xargs rm -rf /` 或 `find . -exec shred {} ;` 会被拦截。递归带有深度上限。

### 变更

- 将 pi 依赖组从 `0.75.5` 升级到 `0.80.2`，包括 `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core` 和 `@earendil-works/pi-coding-agent`。
- 适配 pi `0.80.x` 的 API 拆分：内置模型读取改为使用 `@earendil-works/pi-ai/providers/all`，并为新版资源加载器补充所需的项目信任方法。
- 项目许可证从 Apache License 2.0 改为 GNU Affero General Public License v3.0。

### 修复

- `/stop` 现在除了中止进行中的任务外，还会丢弃该频道中已排队但尚未开始的消息，因此突发的连续消息不会在用户要求停止后继续运行。
- 投递层现在只在最终回复确认送达后才归档，因此当发送失败时，会话日志不再错误地声称机器人已回复。
- 当事件队列已满时，一次性/即时事件不再被静默丢弃：源文件会被保留，并写入 `.error.txt` 标记记录此次丢失。周期事件不受影响（会在下一个 tick 再次触发）。
- 钉钉 AI 卡片创建现在按频道做单飞（singleflight），消除了卡片预热与首次进度更新可能各自创建一张卡片的竞态。
- 修复忙碌路由竞态：频道的运行中状态现在在分发时同步设置，因此同一 tick 内到达的第二条消息会被正确路由为 steer/follow-up，而不是开启一次新的运行。
- 关机时的记忆巩固现在也会持久化那些只产生了 durable 活动、但没有最终 assistant 回合的纯工具会话（此前会被跳过）。

## [0.6.8] - 2026-05-26

### 新增

- `/session` 命令现在会在自动路由 provider（如 OpenRouter、Cloudflare AI Gateway）实际命中的模型与配置模型不同时，显示真实使用的模型；运行时也会在每次任务结束时将实际模型写入日志。
- edit 工具结果新增标准 unified `patch` 字段，与现有自定义 `diff` 字段并存，可直接供 diff 渲染消费方使用。

### 变更

- 将 pi 依赖包名从 `@mariozechner/pi-*` 迁移到 `@earendil-works/pi-*`，版本从 `0.70.2` 升级到 `0.75.5`（上游在 `0.74.0` 重命名了包作用域）。Pipiclaw 使用到的所有公共 API 符号在此版本范围内保持不变。
- Node.js 最低版本要求从 `>=22.0.0` 提升到 `>=22.19.0`，对齐 pi `0.75.0` 引入的硬性下限。

## [0.6.7] - 2026-05-26

### 新增

- 在 `channel.json` 中新增 `responseMode`，支持三种模式：`full_progress_then_plain_final`（默认）、`rolling_progress_then_plain_final` 和 `final_card_only`。该模式会派生出两个正交特征（进度展示风格与最终投递目标），运行时不再直接判断枚举字符串。
- 在 `channel.json` 中新增 `cardAutoLayout`（默认 `true`），作为用户可读的钉钉 AI 卡片宽屏开关。

### 变更

- 在 `final_card_only` 模式下，运行时会隐藏中间过程输出（`tool`/`thinking`/compaction/retry/error 进度），改为单阶段只在 AI 卡片流式呈现最终答案。

### 移除

- 移除 `progressDisplay` 渠道配置项以及旧值 `responseMode: "progress_then_plain_final"` 别名；两者现在都会在启动时被拒绝。

### 修复

- 修复钉钉宽屏卡片参数传递：AI 卡片创建请求改为使用 `cardData.cardParamMap.sys_full_json_obj` 并传入 `{"config":{"autoLayout":...}}`，与钉钉文档要求一致。
- 修复 `final_card_only` 模式下中间 assistant 文本被当作卡片进度推送的问题；现在过程输出被完全抑制（投递层也加了兜底），只有最终答案会写入卡片。
- 修复钉钉在一次短暂断连后重连永久卡死的问题。重连退避 sleep 与重连调度器共用同一个 timer 字段，导致退避等待期间到达的 WebSocket `close` 事件会清掉退避 timer，使 `isReconnecting` 永久停在 `true`，从而阻塞之后所有重连尝试。现在退避 sleep 使用独立 timer，`scheduleReconnect` 不再抢占进行中的重连尝试，且 `>90s` 连接超时看门狗会主动发起重连，而不再只是打日志。

## [0.6.6] - 2026-04-27

### 变更

- 将 pi-mono 依赖组升级到 `0.70.2`，包括 `@mariozechner/pi-ai`、`@mariozechner/pi-agent-core` 和 `@mariozechner/pi-coding-agent`。
- 将自定义工具 schema 从 `@sinclair/typebox` 迁移到 `typebox` 1.x，以兼容新版 pi 的工具参数校验路径。
- 将频道会话替换逻辑迁移到新的 `AgentSessionRuntime` 流程，用于 `/new`、fork 和 session switch 操作。

### 修复

- 修复任务忙碌窗口中的 follow-up 消息竞态：当当前任务已经结束时，迟到的 follow-up 不再丢失或错误排队，而是重新作为普通任务处理。
- 将 `/new` 命令的后续确认消息移动到替换后的 session context 中，避免 pi 在 session replacement 后使旧 extension context 失效导致确认消息丢失。
- 将记忆边界记录从已移除的 `session_switch` extension 事件迁移到当前的 `session_start` 事件模型。

## [0.6.5] - 2026-04-20

### 新增

- 在 `channel.json` 中新增 `busyMessageDefault`，允许钉钉机器人配置任务运行中收到普通消息时默认走 `steer` 或 `followUp`；配置同时接受小写别名 `followup`，并会在启动阶段拒绝无效的显式配置值。
- 在 `channel.json` 中新增 `progressDisplay`；`rolling` 模式会在任务运行中只保留最近进展，并在最终回复发送后将进度卡片收起为一行完成摘要。

## [0.6.4] - 2026-04-19

### 新增

- **记忆成长与召回引擎**：对 Pipiclaw 长期记忆和程序化记忆（Procedural Memory）的全面升级
  - **会话搜索**：新增 `session_search` 工具，允许 Agent 直接在当前频道的冷存储日志（`context.jsonl` 和 `log.jsonl`）中搜索历史细节
  - **回合后审查**：新增专注的发掘流水线（post-turn review），评估对话中是否有值得沉淀的长期事实或工作流，将“智能抽取”与“基础会话维护”解耦
  - **程序化记忆 (Skills)**：Agent 现在可以使用新增的 `skill_manage`、`skill_list` 和 `skill_view` 工具，主动创建、修补和管理 workspace skills
  - **记忆审计日志**：记忆提升、建议和丢弃的决策现在会透明地记录在 `memory-review.jsonl` 中，并支持 1MB 自动文件轮转
- **记忆维护调度器**：新增内置后台 scheduler，将记忆维护从用户等待的 turn 路径中批量移出
  - 在 `${PIPICLAW_HOME}/state/memory/` 下新增每个 channel 的隐藏调度状态，用于记录 dirty 标记、上次运行时间、阈值计数和失败 backoff
  - 新增 session refresh、durable consolidation、growth review、structural cleanup/folding 四类后台维护任务
  - 四类任务在调用 LLM 前都先经过本地 no-LLM gate；无新内容、channel 活跃、未达阈值或处于 backoff 时会直接跳过，不消耗模型 token
  - 记忆维护保持为内部机制，不通过 `workspace/events/` 暴露，也不会注入 synthetic DingTalk turn

### 变更

- 收紧了记忆文件边界：`MEMORY.md` 现在只存放长期有效的事实与决策，防止瞬时任务状态污染长期记忆
- 普通 turn 结束后现在只记录 memory activity 和计数；session refresh、durable consolidation、回合后 growth review、cleanup 和 history folding 都迁移到后台维护任务
- `HISTORY.md` 继续聚焦 compaction、`/new`、shutdown 等边界摘要；后台 durable consolidation 只写入 durable channel memory
- 记忆召回 rerank 默认改为 `"auto"`，本地排序置信度高时不调用模型，只在候选接近且问题明显依赖历史/偏好/决策时使用模型 rerank
- `session_search` 的模型摘要默认保持关闭，并且在空 query、无结果或短 preview 时即使开启也会跳过 LLM 摘要
- 为回合内的多次会话日志搜索添加了 30 秒 TTL 的语料缓存，显著加速同回合检索
- `memoryGrowth.minSkillAutoWriteConfidence` 现在会尊重更严格的用户配置，同时对 workspace skill 自动写入保留 `0.9` 的安全下限
- 清理了调度器接管后不再使用的旧 memory lifecycle wiring，并从公共 API 中移除了废弃的 `runBackgroundMaintenance` wrapper
- `skill_list` 现在改用异步文件系统 API，与其他 workspace skill 工具保持一致

### 修复

- 加固了技能执行的安全性：扩展规则以拦截各类 prompt 注入变体、`wget` 管道执行、`dd`、`mkfs` 以及 `.env` 等凭证文件扫描
- 增强了记忆抽取的 JSON 解析鲁棒性，现在可以优雅处理 LLM 返回的 markdown 代码块包裹
- 修复了原子写入时的竞争条件，避免因时间戳漂移导致失败回滚时残留临时文件
- 限制频道会话语料库最大加载量为 5000 条，防止超大耗时频道触发宿主机内存风险
- 删除了已经失效的旧 idle timer lifecycle 测试，并围绕新的 scheduled-maintenance 模型更新了记忆测试
- 修复 scheduler 的 channel 选择逻辑，避免活跃 channel 消耗唯一的 per-tick 维护名额而跳过其他可维护 channel
- 修复 `session_search` 构建语料时重复处理 `context.jsonl` 的问题
- 修复 review log rotation，使触发轮转的新 entry 保留在 active log 中
- 统一 memory 与 skill 的原子写入实现，在失败时清理临时文件，并统一 memory 侧串行队列实现
- 更新 session-memory E2E 测试，使其通过内置 memory scheduler 验证 scheduled `SESSION.md` refresh 路径

## [0.6.3] - 2026-04-14

### 新增

- CLI 现在支持 `--version`，可直接输出当前 Pipiclaw 版本号并退出
- 运行时文档补充了更清晰的扩展性、并发性，以及 DingTalk Stream 重连行为说明，便于长期部署运维

### 变更

- 精简了构建和运行时依赖，移除了冗余包，并将 `chalk` / `shx` 替换为 Node.js 内置能力，减少安装体积和 lockfile 噪音

### 修复

- DingTalk Stream 重连现在由 Pipiclaw 作为唯一重连控制方，禁用了 SDK 自动重连，避免出现彼此竞争的重连循环
- Stream socket 在重连和关闭时现在会进行确定性清理；对无法正常关闭的陈旧 socket 会进行强制终止
- 异常网络下挂起的 DingTalk Stream 连接尝试现在会超时退出，而不会无限期卡死整个重连循环

## [0.6.2] - 2026-04-11

### 新增

- 新增了 Pipiclaw 与 Hermes 的对比参考文档，以及从 Hermes 运行时中提炼出的经验总结
- 新增了归档后的代码审查修复规范文档，记录 2026-04-11 代码审查中的问题、决策和修复结果

### 修复

- 事件 `preAction` 命令现在会通过配置好的 sandbox executor 执行，而不再直接在宿主机上运行，因此定时事件会与普通工具执行遵循相同的 host / Docker 隔离规则
- `MEMORY.md` 和 `HISTORY.md` 的更新现在会通过专门的 durable-memory 队列串行执行，原子写入也会使用唯一临时文件，以避免 consolidation 和后台维护并发时的写入竞争
- `read` 工具现在可以正确报告空文件、带尾部换行文件和不带尾部换行文件的总行数及行窗口边界
- 用于兼容 SDK 的 compaction 配置 getter 现在会正确尊重用户配置的 reserve / keep-recent token 值，而不再退回到硬编码默认值

## [0.6.1] - 2026-04-10

### 新增

- 事件文件现在支持 `preAction` 命令门控，可在真正排队到 LLM 会话之前先进行确定性判断，从而跳过不需要触发的定时任务
- 现在会在超大输入消息以及排队中的 steer / follow-up 消息进入前，预先执行上下文压缩判断，避免 projected context usage 过高

### 变更

- 记忆召回候选加载现在采用感知文件变化的缓存，并收紧历史片段选取范围，提升长生命周期通道上的 recall 性能
- DingTalk AI Card 流式输出现在会追加增量内容，而不是每次都重放整段文本，并改进了预热和最终收尾行为
- compaction 进度和失败信息现在会提供更清晰的运行时反馈；当 compaction 影响到一次运行失败时，也会附带更明确的恢复细节

### 修复

- `/new` 及相关会话命令在 channel runner 内的绑定现在能够保持正确工作
- 后台记忆维护现在获得了更长的超时时间，减少 compaction 密集场景下的误报失败

## [0.6.0] - 2026-04-07

### 新增

- 在启动阶段新增了对 `settings.json`、`tools.json` 和 `security.json` 非法配置值的诊断输出，包括对错误工具配置和安全配置字段的细粒度告警

### 变更

- 记忆 session 和 consolidation 的 sidecar 更新现在会对瞬时失败进行重试，而不是在第一次超时或 worker 中止时立即失败
- 围绕 DingTalk 投递、定时事件、settings、安全配置与 web 工具配置的运行时恢复和配置重载逻辑都得到了加固
- 非法的定时事件文件现在会保留 `.error.txt` 标记文件，写出解析或调度错误细节，而不是无提示消失
- DingTalk AI Card 投递现在会在交互式运行中更早预热卡片，并在 stop、abort 和最终响应路径上更可靠地清理卡片状态

### 修复

- Windows 上的命令守卫和路径守卫现在可以正确应用平台特定处理，包括在 runtime 和测试 harness 中正确接入 security config

## [0.5.9] - 2026-04-06

### 变更

- 版本号提升到 `0.5.9`，用于发布最新的 web 工具与运行时修复

## [0.5.8] - 2026-04-06

### 新增

- 内建 `web_search` 和 `web_fetch` 工具，支持基于 provider 的搜索、HTML/JSON/text/image 抓取与 SSRF 安全校验
- 新增 `tools.json` 配置入口，用于内建工具设置，包括 `tools.web` provider、代理和抓取行为控制
- 在 `security.json` 中新增网络守卫配置，支持 Web 请求的 host/CIDR 白名单与重定向限制
- 在 prompt、主工具注册表和子代理中接入新的 web 工具
- 新增 web 工具 rollout 的专门设计和实现规范文档

### 变更

- Windows shell 执行现在会尊重 POSIX shell 路径，而不再强制使用 `cmd`，同时隐藏工具执行时可能闪烁的控制台窗口
- DingTalk 运行时和 web 工具现在默认遵循标准代理环境变量；旧的 `DINGTALK_FORCE_PROXY` 行为已移除
- 默认 bootstrap 生成的 `tools.json` 模板现在默认关闭 web 工具，并包含 Brave 与代理配置示例，便于首次接入

### 修复

- `web_fetch` 现在会抑制 `jsdom` 样式表解析产生的噪声告警，因此畸形内联 CSS 不会污染运行日志，同时内容提取仍能正常完成

## [0.5.7] - 2026-04-05

### 变更

- `/model` 现在除了支持精确匹配 `provider/modelId` 和精确匹配裸 `modelId` 外，还支持对完整 `provider/modelId` 做唯一子串匹配
- README 和相关文档已更新，补充说明新的 `/model` 匹配行为和 `/model turbo` 等示例

## [0.5.6] - 2026-04-05

### 修复

- 修复 macOS 下 path guard 的 realpath 处理，使 workspace、home 和 temp 路径在文件系统解析为 `/private/...` 时仍能正确判断
- 修复临时目录识别逻辑，使 macOS 运行时 temp 路径在文件安全层中得到一致处理

## [0.5.5] - 2026-04-05

### 新增

- 新增 runtime 级端到端测试 harness，可驱动真实运行时并使用模拟的 DingTalk transport
- 新增 `bash`、`read`、`write`、`edit` 等文件工具的安全守卫与审计日志钩子

### 变更

- 提升了运行时关闭阶段的 flush 和写入管道稳健性
- 统一规范了群聊 channel 目录命名，使持久化路径更安全、更可预测

### 修复

- 修复阻塞 `npm run check` 的 import 排序问题

## [0.5.4] - 2026-04-03

### 变更

- 按既有领域边界重新组织了 `src/`，将 agent、memory、model 和 settings 代码分别移动到对应模块
- 移除了根目录级别的 `src/agent.ts` 兼容 shim，并将引用更新为直接指向 `src/agent/`
- 升级 GitHub Actions 工作流到更新版本的 `actions/checkout` 与 `actions/setup-node`，并将 release 发布切换为 `gh release create`

## [0.5.3] - 2026-04-03

### 新增

- 面向用户的配置指南，覆盖 DingTalk、模型/provider、settings 与 workspace 文件
- 独立的定时事件与预定义子代理指南
- 面向长期运行的部署与运维指南，覆盖部署、日志、升级与备份
- README 中新增面向 AI Agent 的快速开始路径，提供可直接复制使用的安装与配置提示词

### 变更

- README 重新组织为两条主要入口：`For AI Agent` 和 `For Human`
- README 和配置文档现在建议正式使用时配置 AI Card，同时保留首次排障用的回退说明
- npm 发布内容现在排除了 `docs/`、`docs/specs/`、`test/` 和 `CHANGELOG.md`
- 发布构建不再产出 `.js.map` 与 `.d.ts.map` 文件，显著缩小包体积

### 修复

- 修复 `src/agent/channel-runner.ts` 中的 Biome import 排序问题

## [0.5.2] - 2026-04-02

### 新增

- 新增 agents 使用指南与更完整的 memory 设计文档
- 优化首轮记忆 bootstrap，使首次上下文加载更合理

### 变更

- memory pipeline 改为非阻塞执行，使 consolidation 和 refresh 工作不再阻塞主会话路径
- 对运行时基础模块进行了更清晰的领域拆分，包括 bootstrap 抽取和源码结构重组
- 提升了 memory 生命周期与 recall 质量，包括更好的首轮 bootstrap 行为和更稳健的运行时维护
- 改进了子代理配置解析，使其能更可靠地处理 YAML 数组和数字 frontmatter 值

### 修复

- 修复 runtime、memory 和子代理模块中的 lint 阻塞项与格式不一致问题

## [0.5.1] - 2026-04-01

说明：此仓库中不存在 `v0.5.0` git tag；通向 `0.5.0` 发布的改动在这里统一归入 `0.5.1`。

### 新增

- 通道级 memory 模型，运行时会管理 `SESSION.md`、`MEMORY.md` 和 `HISTORY.md`
- 相关记忆召回流水线，可在活跃对话中注入少量有价值的历史上下文
- 上下文感知的子代理记忆注入，让子代理可以获得受控的 session 和 memory 上下文
- 扩展了对 delivery、DingTalk 和 memory 流程的独立测试覆盖

### 变更

- 对 memory 和 recall 行为进行了整合，使其成为完整的运行时流水线，而非零散的 prompt 注入
- 为 `0.5.x` 发布线扩充了独立仓库级别的测试覆盖基线

## [0.4.0] - 2026-03-31

### 新增

- 初始独立版 Pipiclaw npm 包与 CLI 仓库
- 面向用户的 README 改进，以及独立包发布所需的 release 工作流骨架

### 变更

- 为独立发布更新了 package 元数据、Node.js 支持声明和 CI matrix

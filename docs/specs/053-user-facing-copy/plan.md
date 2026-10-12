# 053 实施计划

设计见 [design.md](./design.md)。分四个阶段。每个阶段结束时 `npm run check` 与 `npm run test:e2e` 必须全绿，且每个阶段都能独立发布。阶段顺序按"先修缺陷和泄露、再拆受众、再统一、最后 CLI 与日志"排列：越靠前，风险越低、用户收益越直接。

## 阶段总览

| 阶段 | 交付 | 对应决策 | 可独立发布 |
|---|---|---|---|
| P1 缺陷与泄露 | 投递失败通知不再转发提示词；任务回执状态与用语修正；忙碌提示派生；群聊日志上下文修复；进度流英文改中文；文档引用改 URL | D2（部分）、D7（部分）、D8（部分）、D5.4、D12.1 | 是 |
| P2 拆分受众 | 任务记录与工作项的用户侧渲染；守卫拦截结构化；轮次失败分类；委派通知带 runId；清除工具名外泄 | D2、D3、D5、D6 | 是 |
| P3 统一与限长 | 术语表全量落地；统一句式与标点；`/context` 中文化；所有报告接入 `capReply`；`/help` 重组；TUI 文案同源 | D4、D7、D8、D9、D10 | 是 |
| P4 CLI 与日志 | 首次运行引导与退出码；`tui --help` 语义；关键日志迁移到 `logEvent`；日志措辞与级别 | D11、D12 | 是 |

每个阶段都遵守 design.md 第 3 节 D13：只加结构性测试，不断言具体文案；遇到现存的文案断言，删除或改为结构性断言，不跟着改字符串。

---

## P1 缺陷与泄露

### 改动

| 文件 | 改动 |
|---|---|
| `src/runtime/bootstrap.ts`（`onExhausted`，约 968 行） | 不再发送 `record.event.text` 与 `record.event.user`。用 `parseDriverTaskId` 识别任务唤醒，渲染为"任务 `x` 的后台唤醒"；委派完成唤醒按其 dispatch 来源识别；其余为"一次后台唤醒"。记录路径用 `APP_HOME_DIR` 渲染为绝对路径。按 D6 补下一步 |
| `src/tasks/`（新增导出，位置随 `frontmatter.ts` 或 `ledger.ts`） | `taskStateLabel(state)`：`open` → 进行中、`parked` → 等待中、`done` → 已结束 |
| `src/runtime/task-commands.ts`、`src/runtime/task-spawn.ts` | 删除各自的 `STATE_LABEL`，改用 `taskStateLabel` |
| `src/runtime/task-driver.ts`（`taskStopReceipt`） | `当前阶段：${state}` 改为 `状态：${taskStateLabel(state)}`；"让 Agent cancel 该任务"改为"直接告诉我取消该任务"；按 D6 加 🛑 标记；预算类原因附带 `+steps` / `+usd` 的续跑示例 |
| `src/commands/catalog.ts` | 新增 `formatBusyHint()`，由 `availableWhileBusy` 派生"运行中可用"和"需空闲"两份列表；`/tasks` 及 `pause` 的描述去掉"阶段" |
| `src/runtime/dingtalk.ts`（约 1658 行）、`src/tui/turn-controller.ts`（约 147 行） | 改用 `formatBusyHint()` |
| `src/runtime/task-commands.ts`（`pauseTask` 回复） | 去掉"当前阶段"，改为"等待条件已保留" |
| `src/agent/session-events.ts` | `Compacting context...` → `正在压缩上下文…`；`Retrying (n/m)...` → `模型请求失败，正在重试（n/m）…`；`Compaction failed` 的回退文本改中文 |
| `src/log.ts`（`legacyContext`） | 正则改为 `/^\[([^\]\s]+)\]\s*/` |
| `src/paths.ts` 附近 | 新增文档 base URL 常量与 `docsUrl(relativePath)` |
| `src/models/auth-cli.ts`（约 236、269 行）、`src/runtime/task-commands.ts`（约 299 行） | 文档引用改用 `docsUrl(...)` |

### 新测试

| 测试 | 断言 | 抓什么回归 |
|---|---|---|
| `test/log-file-sink.test.ts`（或新建 `test/log-context.test.ts`） | `[group_cid+a/b==] msg` 解析出 `channelId` 为 `group_cid+a/b==`，message 为 `msg` | 群聊频道日志丢失 `channel` 字段 |
| `test/commands-subcommands.test.ts`（现有文件内新增用例） | `formatBusyHint()` 中出现的命令集合等于目录按 `availableWhileBusy` 派生的集合 | 忙碌提示又被手抄 |
| 投递失败通知的单测 | 输入一个 `[TASK_DRIVER:x] Resume task …` 记录，断言输出不含 `TASK_DRIVER`、`Resume task`，且包含任务 id | 提示词重新泄露 |

### 完成标准

- 钉钉里不再可能看到 `TASK_DRIVER`、`Resume task` 或原始英文状态值 `open` / `parked`；
- 群聊频道的 JSONL 日志带 `channelId`；
- `rg '阶段' src` 只剩 `memory/chinese-words.ts` 的分词词表。

---

## P2 拆分受众

### 改动

| 文件 | 改动 |
|---|---|
| `src/tasks/log.ts` | 新增 `renderTaskLogLineForUser`：中文动作词（开始委派 / 委派结束 / 第 n 步 / 等待超时 / 完成 / 取消），不出现 `step`、`continue`、`VERDICT`、`exit` 等参数值；时间只保留到分钟 |
| `src/tasks/board.ts` | 新增 `renderTaskBoardForUser`：平铺，无缩进续行；一个工作项关联多个委派时合并成一行（`run_a1 完成、run_a2 进行中`）；不渲染"已看过"区分，不提 `task_log` |
| `src/runtime/task-commands.ts` | `/tasks show`、`/tasks log` 改用上述两个函数；小节标题按术语表改为"工作项""最近记录""任务说明" |
| `src/security/`（新增类型，或扩展 `block-message.ts`） | `GuardBlockedError extends Error`，携带 `{ guard, category, target }`；`message` 保持现在的英文多行文本不变 |
| `src/security/path-guard-check.ts`、`src/tools/bash.ts`、网络守卫抛错处 | 改抛 `GuardBlockedError` |
| `src/tools/tool-details.ts`（`withToolDetails` 或等价的错误包装处） | 捕获 `GuardBlockedError` 时，在结果 `details` 写入 `blocked` 字段 |
| `src/agent/session-events.ts` | 工具错误上屏：带 `blocked` 的渲染为 D5.2 的中文一行；其余普通错误只取第一行、截取 120 字 |
| `src/agent/`（新增 `turn-error.ts`，纯函数） | `classifyTurnError(message): "auth" \| "rate_limit" \| "context_overflow" \| "network" \| "other"` 与对应的用户文案 |
| `src/agent/channel-runner.ts`（约 665 行） | 错误气泡按 D5.1 形态渲染；`可以让我 read 该文件`（约 415、1111、1122 行）按 D3 替换 |
| `src/runtime/subagent-commands.ts`（`renderRunNotice`） | 带 runId；失败时附 `/subagents show <runId>`；按 D6 统一标记符号 |
| `src/runtime/subagent-commands.ts`（`showRun`） | 删除"可用于 subagent_run op=follow_up"，改为 D3 的说法 |
| `src/runtime/skill-commands.ts` | 按 D3 替换 `read 工具`、`write/edit`、`<available_skills>` 三处 |
| `src/runtime/task-commands.ts`（空状态） | "让 Agent 用 task_create 建立"按 D3 替换 |
| `src/events/event-commands.ts` | `/events list` 展示无效事件时，按 `EventValidationError` 的种类映射为中文短句；未识别的种类不贴原文，提示 `/events show <name>`。需要时给 `EventValidationError` 增加一个 `kind` 字段，消息文本不变 |

### 新测试

| 测试 | 断言 | 抓什么回归 |
|---|---|---|
| `test/turn-error.test.ts` | 表驱动：一组真实 provider 错误文本（401、429、`context_length_exceeded`、`ETIMEDOUT`、未知）→ 类别 | 分类分支回归 |
| 任务用户侧渲染（加到 `test/task-brief.test.ts` / `test/task-log.test.ts`） | 多委派工作项输出单行；输出中没有以空白开头的行，也不含 `task_log`、`VERDICT` | 双渲染器被合并回去 |
| 守卫拦截 | 路径越界的工具调用：结果 `details.blocked.guard === "path"`；给模型的 `content` 与改动前一致 | 结构化信息丢失，或模型侧消息被意外改动 |
| e2e（deterministic） | 一次被守卫拦截的写入：断言投递到频道的进度项来自 `blocked` 渲染（检查投递记录中不含 `Resolved path`），模型请求体里的工具结果仍含原英文消息 | 用户侧与模型侧再次混用同一文本 |

e2e 用例按 AGENTS.md 要求写明它抓的回归，并在合入前做一次变异检查（把 `session-events.ts` 的 `blocked` 分支删掉，确认用例变红）。

### 完成标准

- 用户可见文案里，D3 禁用清单中的词零命中（P3 的结构性测试会把这一点固化）；
- 轮次失败都带下一步；委派失败通知都带 runId。

---

## P3 统一与限长

### 改动

| 文件 | 改动 |
|---|---|
| 全部用户文案出处（design.md 1.1 表） | 按 D4 术语表替换：等待票、兜底、契约、派发 / 结算、团队看板、游标、墓碑化、准入、可选根、试用期、"步"（卡片）、"日志"（journal） |
| 同上 | 统一句式：`未找到 X`、`未知子命令`、`缺少 X`；中文叙述用全角标点 |
| `src/shared/`（新增或并入 `format.ts`） | 中文时长格式化函数，替换 `task-commands.ts` 的 `relative()`、`status-render.ts` 的 `formatUptime()`、`delivery.ts` 的 `formatElapsed()`、委派相关的 `formatDuration` / `formatRunDuration` 中面向用户的调用 |
| `src/runtime/delivery.ts` | 页脚与滚动头改为"工具调用"；收尾语按结局取（D7） |
| `src/agent/session-events.ts` | `已沉淀：…` 改为 D7 的说法 |
| `src/agent/prompt/manifest.ts`（`renderContextReport`） | 中文化；去掉 `# Context Report`；默认视图只保留汇总；`detail` 经过 `capReply`。`toolSchemaBudgetWarning` 同时被重建日志使用，拆成日志用英文版和报告用中文版两个函数 |
| `src/agent/command-extension.ts` | `/session` 字段标签中文化；`/compact` 只回 token 数与摘要首行；`/new` 确认语改用共享函数 |
| `src/runtime/bootstrap.ts`（约 472 行） | `/new` 确认语改用同一共享函数 |
| `src/memory/commands.ts` | `/memory show` 用"中文标签（键名）"形式；`/memory status` 删除游标，"试用期"改"观察期" |
| `src/runtime/project-commands.ts` | Enforcement → 隔离级别；unbounded → 不限制（沿用全局文件权限）；可选根 → 允许的根目录 |
| `src/runtime/subagent-commands.ts` | `showRun` 字段标签中文化；`purpose`、`parserVersion` 作为"（键名）"保留；括号统一全角 |
| `src/runtime/task-commands.ts`、`src/runtime/subagent-commands.ts`、`src/agent/command-extension.ts` | `/tasks show`、`/tasks log`、`/subagents show`、`/compact` 接入 `capReply`，按 D9 调整条数与下一步提示 |
| `src/commands/catalog.ts` | `/help` 改按"随时可用 / 空闲时可用"分组（由 `availableWhileBusy` 派生），首段解释"回合"；`busyMessageDefault` / `responseMode` 说明移到 `/help steer` 详情；示例改为中文句子；各命令描述按术语表修订 |
| `src/agent/channel-runner.ts`（约 968 行） | `**Prompt templates**` → `**提示模板**` |
| `src/tui/turn-controller.ts`、`src/tui/commands.ts`、`src/tui/pitui-frontend.ts` | 排队确认、缺参数、失败、退出提示复用钉钉侧函数或改中文；状态栏统一"空闲 / 运行中"；`/exit` 描述中文化；开屏提示中文化 |

### 新测试

| 测试 | 断言 | 抓什么回归 |
|---|---|---|
| `test/user-copy-shape.test.ts`（新） | 对每个报告 handler（`/tasks` 各子命令、`/subagents` 各子命令、`/memory`、`/events`、`/skills`、`/project`、`/status`、`/usage`、`/context`、`/help`）与推送渲染函数（`taskStopReceipt`、`renderRunNotice`、投递失败通知、错误气泡）：输出中没有以两个以上空格开头的行，没有 `#` 开头的行，不含 `<[a-z_]+>` 标签、`op=`、`TASK_DRIVER`，不含 D3 禁用清单中的工具名作为独立词 | 违反第 3、4 条约定或 D3 |
| 同上，大数据量样例 | 50 个任务、200 条 run、超长任务说明、超长 stderr：每个报告长度 ≤ 1,500 字加截断提示；发生截断时含 `/` 开头的下一步命令 | 新报告或新字段绕过 `capReply` |
| 时长格式化（若函数有分支） | 边界：59 秒、60 秒、59 分、24 小时 | 单位进位错误 |

工具名独立词匹配要避开合法出现的情况（例如 `/skills show` 里的 skill 名恰好叫 `read`）：只检查运行时自己写的模板文本，不检查回显的用户数据。实现上对 handler 喂不含这类名字的 fixture 即可。

### 完成标准

- design.md 第 1 节列出的 F3、F4、F6、F7 条目全部消除；
- `user-copy-shape.test.ts` 覆盖所有报告 handler 与推送渲染函数。

---

## P4 CLI 与日志

### 改动

| 文件 | 改动 |
|---|---|
| `src/runtime/app-home.ts`（`printBootstrapSummary` 或新增 `printFirstRunGuide`） | 生成 `channel.json` 模板后输出 D11 的 Next steps |
| `src/runtime/bootstrap.ts`（约 1238 行） | 刚生成模板时退出码改为 0；配置校验失败仍为 1 |
| `src/tui/cli.ts`（`printTuiHelp`） | `--plain` 与 `--quiet` 按 D11 重写说明 |
| `src/main.ts`、`src/runtime/app-home.ts`、`src/tui/cli.ts`、`src/models/auth-cli.ts` | 收尾统一为 `Run \`pipiclaw … --help\` for usage.` |
| `src/runtime/dingtalk.ts`、`src/runtime/task-driver.ts`、`src/runtime/durable-dispatch.ts`、`src/subagents/runs.ts`、`src/runtime/bootstrap.ts`（关机流程） | warn 级别与关键路径的 `logInfo` / `logWarning` 迁到 `logEvent`，事件名按 `<domain>.<object>.<verb>`；原因放 `details`；message 去掉 `DingTalk:` 前缀 |
| `src/runtime/task-driver.ts` | `Task driver enqueued` 降到 debug（`taskdriver.step.enqueued`） |
| `src/runtime/bootstrap.ts` | `Waiting for N active task(s)` → `Waiting for N active turn(s)` |
| `src/log.ts` | `logUsageSummary` 去掉被丢弃的 Markdown 拼接，返回类型改为 `void`；更新唯一调用点 |

### 新测试

| 测试 | 断言 | 抓什么回归 |
|---|---|---|
| `test/bootstrap.test.ts`（现有文件内） | 首次生成模板：退出码 0；已有模板但字段为占位符：退出码 1 | 首次运行被当成错误，或校验失败被吞 |

日志措辞与事件名不写测试：它们是给人 grep 的，钉死事件名只会制造变更检测器。

### 完成标准

- `rg -c 'logInfo\(|logWarning\(' src` 的数量较开工前明显下降，所有 warn 级别都有具体事件名；
- 首次运行的输出足以让新部署者不看文档也知道下一步。

---

## 文档同步（各阶段随改随写）

| 阶段 | 文档 |
|---|---|
| P1 | `docs/specs/README.md` 登记 053 |
| P2 | `docs/security.md`：拦截在聊天里的呈现方式 |
| P3 | `AGENTS.md`：「Command Reply Conventions」改为「User-Facing Copy Conventions」，补 D1、D2、D3、D6，并链接 design.md 的术语表；`docs/interaction-and-commands.md`：`/help` 新分组、忙碌规则、"界面用语对照"；`docs/events-and-tasks.md`：`/tasks show` / `/tasks log` 的新形态；`docs/memory.md`、`docs/configuration-reference.md`：观察期、工作日记 |
| P4 | `docs/deployment-and-operations.md`：首次运行步骤、日志事件名变化；release notes 说明 `system.*` 事件名的变化与首次运行退出码 |

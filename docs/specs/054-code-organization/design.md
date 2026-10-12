# 代码组织重构：单向分层、模块归位与机器检查的边界

| 字段 | 值 |
|------|------|
| 状态 | 已实施（[实施计划](./plan.md)；偏差见末尾「实施记录」） |
| 日期 | 2026-10-12 |
| 触发 | 用户要求评估项目架构与代码组织，并产出一份整体重构方案，交给后续的实施 Agent 完成 |
| 前置 | 035 公共 API 面（`src/index.ts` 导出名稳定）、044 `FileStore`/`Executor` 端口、046 工具参数形状、048 e2e 分层 |
| 关联实现 | `src/**`（只搬迁、改接口、拆文件，不改行为）、`scripts/check-architecture.mjs`（新）、`scripts/move-modules.mjs`（新）、`scripts/architecture-baseline.json`（新）、`package.json`、`AGENTS.md`、`CLAUDE.md`、`docs/architecture.md` |
| 明确不含 | 任何用户可见行为、文案、`settings.json` 键、持久化格式或日志事件名的变化；改写测试逻辑（测试只改 import 路径和被拆出的协作者引用）；把后台 job 与委派 run 合并成通用框架；拆 `subagents/discovery.ts`；改变 `SubAgentRunManager` 对结算、用量、租约和完成唤醒的所有权；引入新的第三方依赖 |

## 摘要

现状（2026-10-12，`src/` 共 214 个 `.ts` 文件、46.8k 行）：

- **划分基本正确。**领域目录清晰；`shared/`、`commands/` 不 import 任何项目内模块；`tasks/` 只依赖 `shared/` 和根目录；`security/` 只依赖 `shared/`。`channel/` 定义了与传输无关的投递和事件契约，DingTalk 和 TUI 实现的是同一套接口。
- **实际依赖与文档不一致。**有 14 对顶层目录互相 import。`runtime/` 依赖 13 个目录，同时承担装配根、DingTalk 传输、任务调度、各领域的斜杠命令和 CLI 外壳五种职责。
- **大文件。**8 个文件超过 1000 行：`agent/channel-runner.ts` 1871、`runtime/dingtalk.ts` 1820、`subagents/tool.ts` 1692、`subagents/runs.ts` 1654、`runtime/bootstrap.ts` 1383、`agent/job-manager.ts` 1328、`subagents/discovery.ts` 1040、`events/events.ts` 1009。其中 `dispatchInternalRun` 一个函数就有 535 行，`bootstrap.ts` 内嵌了约 630 行的轮次调度逻辑。
- **规则只写在文档里。**分层约束没有工具检查，所以会漂移：`docs/architecture.md` 已经引用了一个不存在的 `tasks/verification.ts`。此外有 4 处文件级类型循环。

方案：先把目标分层写成 `npm run check` 里的可执行检查，并把现有违规登记为"只能减少"的基线（D1、D2）；再按"只搬家 → 改接口 → 拆大文件 → 写文档"的顺序把代码挪到位（D3–D13）。每一步都不改行为。

把本文的搬迁表套到当前依赖图上做过模拟：所有文件搬完后，剩下的违规恰好是 D9 列出的 9 条，没有一条需要新增例外。

| 决策 | 内容 |
|---|---|
| D1 | 目标分层：模块表和允许依赖表，构成一个有向无环图 |
| D2 | `scripts/check-architecture.mjs`：依赖规则、文件级循环、文件行数预算、悬空的相对路径、文档里的路径引用；基线只能缩小 |
| D3 | `runtime/` 只保留装配根，以及把多个子系统接起来的守护进程服务 |
| D4 | DingTalk 传输独立为 `src/dingtalk/`，并按职责拆分 |
| D5 | `src/app/`：进程外壳（应用主目录脚手架、CLI 参数、共享服务、代理、`auth` 子命令） |
| D6 | 命令平面：`commands/catalog.ts`（叶子）+ 各领域的 `commands.ts` + `commands/router.ts` |
| D7 | 每个应用级 JSON 配置文件只有一个加载者；`src/config/` 放跨领域的两个 |
| D8 | 新目录与归位：`jobs/`、`skills/`、`tools/contract/`，以及若干单文件搬迁 |
| D9 | 9 条反向依赖的修法：接口下沉或依赖注入 |
| D10 | `tools/` 的边界：工具只是适配层，领域逻辑留在领域目录 |
| D11 | 大文件拆分：目标结构、行数目标和不变量 |
| D12 | 命名约定 |
| D13 | 文档：`AGENTS.md` 的模块表是唯一来源；每个文件开头写一句职责注释 |
| D14 | 重构期间必须保持的不变量 |
| D15 | 三项已确认的取舍：`task-driver` 留在 `runtime/`、`executor.ts`/`file-store.ts` 留在根目录、不拆 `subagents/discovery.ts` |

---

## 1. 问题清单

| # | 问题 | 证据 |
|---|---|---|
| 1 | `runtime/` 成了"放不下就丢这里"的目录 | `task-commands`、`subagent-commands`、`skill-commands`、`project-commands` 四个文件不 import `runtime/` 里的任何东西，只是被放在这里；AGENTS.md 规定"命令处理放在拥有其状态的那一层"，只有 `memory/commands.ts` 照做了 |
| 2 | DingTalk 传输没有隔离 | `settings.ts` 从 `runtime/dingtalk.ts` 取 `ResponseMode`；`events/events.ts` 依赖整个 `DingTalkBot` 类型，实际只调用 `enqueueEvent`；`tui/app.ts` 从 DingTalk 文件取 `progressStyleOf`；`app-home.ts` 依赖 DingTalk 的配置归一化 |
| 3 | 装配根里混进了业务逻辑 | `bootstrap.ts` 中 `createDingTalkHandler` 约 630 行（stop、`/new`、唤醒合并、`durable-dispatch` 去重、任务步骤绑定），`handleEvent` 单个方法约 210 行 |
| 4 | 过大的类和函数 | `ChannelRunner` 有 44 个私有字段，`run()` 226 行，`finishTurn()` 170 行；`dispatchInternalRun` 535 行 |
| 5 | 模块放错位置导致互相依赖 | `tools → agent/job-manager`（5 处）；`subagents → tools/registry`，同时 `tools → subagents/tool`；`web → tools/config`（5 处），同时 `tools → web`；`settings → memory/maintenance-tuning`；`memory/task-digest → tasks`；`agent/prompt → runtime/workspace-templates`；`app-services.ts` 的注释明说它放在根目录"是为了避开循环依赖" |
| 6 | 同一种东西有多种命名 | 命令处理器有三种命名（`memory/commands.ts`、`events/event-commands.ts`、`runtime/task-commands.ts`）；`ledger` 指两种东西（任务说明读取器、用量账本）；`log` 指三种东西；`tools/task-manage.ts` 与同名目录并存；`agent/` 下 21 个文件平铺 |
| 7 | 规则不可执行 | 没有依赖检查；4 处文件级类型循环（`runs ↔ external/settlement`、`events ↔ event-validation`、`channel-runner ↔ runner-factory`、`tui/renderer ↔ *-frontend`）；文档已出现不存在的文件名 |

## 2. 目标

- **G1 一个目录一种职责。**每个目录都能用一句话说清放什么、不放什么。
- **G2 依赖单向。**目录之间构成有向无环图，由脚本在 `npm run check` 中强制。
- **G3 Agent 能预测文件位置。**拿到一个需求，查模块表和命名约定就能推出代码该放在哪个文件；文档里出现的路径由脚本保证真实存在。
- **G4 文件能整体读入。**单文件不超过 800 行（少数登记在基线里的例外，且有上限），单个函数或方法的目标是不超过 150 行。
- **G5 零行为变化。**每个阶段 `npm run check` 和 `npm run test:e2e` 全绿；`src/index.ts` 导出的名字不变。

## 3. 决策

### D1 目标分层

模块就是 `src/` 下的一段路径。没有在下表中特别登记的文件，取 `src/` 之后的第一级目录名作为模块名；根目录下的文件必须显式登记。

| 层 | 模块 | 路径 | 职责 | 可以 import |
|---|---|---|---|---|
| 0 | `shared` | `src/shared/` | 不含任何领域知识的通用小工具 | — |
| 0 | `commands` | `src/commands/catalog.ts`、`reply-limits.ts` | 斜杠命令目录、回复长度预算 | — |
| 1 | `foundation` | `src/log.ts`、`paths.ts`、`executor.ts`、`file-store.ts`、`proxy-from-env.d.ts` | 进程级基础设施（日志、路径）和宿主 I/O 端口（命令执行、文件读写） | shared |
| 2 | `security` | `src/security/` | 命令、路径、网络三道护栏，以及审计日志 | 第 0–1 层 |
| 2 | `usage` | `src/usage/` | 用量账本、用量渲染、`UsageTotals` | 第 0–1 层 |
| 2 | `tasks` | `src/tasks/` | 长程任务：任务说明、等待条件、循环日志、预算、`/tasks` | 第 0–1 层 |
| 2 | `playbooks` | `src/playbooks/` | 随包发布的只读运行时手册 | 第 0–1 层 |
| 3 | `channel` | `src/channel/` | 与传输无关的频道域：投递和事件契约、身份、持久状态、`/project` | 第 0–1 层、security |
| 3 | `tools-contract` | `src/tools/contract/` | 工具结果 `details` 契约、工具调用的展示文本、工具名单 | 第 0–1 层、security |
| 4 | `config` | `src/config/` | `settings.json`、`tools.json` 的加载和校验 | 第 0–1 层、channel（仅类型） |
| 5 | `models` | `src/models/` | 模型引用、模型运行时、API key、备用模型回退判断 | 第 0–1 层、config |
| 5 | `web` | `src/web/` | 搜索和抓取的客户端、正文提取 | 第 0–1 层、security、config |
| 5 | `skills` | `src/skills/` | 工作区 skills 的加载、校验、读取，以及 `/skills` | 第 0–1 层、security |
| 6 | `memory` | `src/memory/` | 频道记忆、工作日记、反思 pass、会话检索，以及 `/memory` | 第 0–1 层、channel、config、models、usage |
| 6 | `events` | `src/events/` | 定时和传感器事件：定义、校验、文件监视器，以及 `/events` | 第 0–1 层、channel、security、tasks |
| 7 | `jobs` | `src/jobs/` | 后台 shell job 的生命周期 | 第 0–1 层、channel、tasks |
| 7 | `subagents` | `src/subagents/` | 角色发现、委派派发、内部和外部执行、run 生命周期、租约，以及 `/subagents` | 第 0–1 层、security、usage、tasks、channel、config、models、memory、tools-contract |
| 8 | `tools` | `src/tools/`（`contract/` 除外） | 交给模型的工具：参数 schema、校验，调用领域代码，组装 `content`/`details` | 第 0–7 层的全部模块 |
| 9 | `agent` | `src/agent/` | 单频道编排：SDK 会话、一轮对话、提示词、内置会话命令 | 第 0–8 层 |
| 10 | `commands-router` | `src/commands/router.ts` | 无状态报告命令的唯一分发点，由两个传输共用 | 第 0–9 层 |
| 10 | `app` | `src/app/` | 进程外壳：应用主目录脚手架、CLI 参数与版本号、共享服务、LLM 代理、`pipiclaw auth` | 第 0–9 层 |
| 11 | `dingtalk` | `src/dingtalk/` | 钉钉 Stream 传输：连接、AI 卡片、媒体、入站路由、`ChannelContext` 实现 | 第 0–10 层 |
| 11 | `tui` | `src/tui/` | 终端前端：第二个 `ChannelContext` 实现 | 第 0–10 层 |
| 12 | `runtime` | `src/runtime/` | 守护进程：装配根和跨子系统服务（见 D3） | 除 `tui` 外的全部模块 |
| — | `entry` | `src/main.ts`、`src/index.ts` | 可执行入口和公共库出口 | 不限 |

规则：

1. **只能依赖"可以 import"一列点名的模块，而且都在更低的层。**同一层内的模块互不 import，例如 `memory ↔ events`、`jobs ↔ subagents`、`commands-router ↔ app`、`dingtalk ↔ tui`。上层也不是自动可以依赖所有下层：例如 `events` 不能 import `models`，`jobs` 不能 import `memory`。
2. **`import type` 也算依赖。**类型依赖同样是概念上的耦合。唯一例外是 `config → channel`：只允许 `import type`，并在检查脚本中单独登记。
3. **跨模块不要重导出。**不允许为了绕过规则而建转手文件。
4. **新增顶层目录必须同时更新检查脚本的模块表和 `AGENTS.md` 的模块表。**否则检查会以"未登记"失败。

```
 12  runtime ─────────────────────────────────────────────── 装配根 + 跨子系统服务
 11  dingtalk                     tui                         两个传输
 10  commands/router              app                         命令分发 · 进程外壳
  9  agent                                                    单频道编排
  8  tools                                                    模型工具（适配层）
  7  jobs                         subagents                   后台工作
  6  memory                       events                      有状态的领域
  5  models        web            skills
  4  config
  3  channel                      tools/contract
  2  security      usage          tasks          playbooks
  1  foundation  (log · paths · executor · file-store)
  0  shared                       commands/catalog
```

### D2 机器检查：`scripts/check-architecture.mjs`

新增一个 Node 脚本，作为 `npm run arch` 加入 `npm run check`（放在 `typecheck` 之后、`deadcode` 之前）。规则表（`MODULES`、`ALLOWED`）写在脚本顶部，是 D1 的可执行版本：两者不一致时以脚本为准，并在同一个提交里修正文档。

| 规则 | 检查什么 | 范围 |
|---|---|---|
| R1 依赖方向 | 跨模块的每条 import（含 `import type`、`export … from`、动态 `import()`）都在 `ALLOWED` 中；脚本启动时先验证 `ALLOWED` 本身无环 | `src/` |
| R2 文件级循环 | 不存在文件级的强连通分量（含只有类型的循环） | `src/` |
| R3 行数预算 | 单文件不超过 800 行；基线里的例外不得超过登记的上限 | `src/` |
| R4 悬空的相对路径 | 每个相对路径都能解析到一个存在的文件，包括 `vi.mock("…")`、`vi.importActual("…")` 和动态 `import("…")` 的字符串（`tsc` 不检查这些字符串） | `src/`、`test/`、`evals/`、`scripts/*.mjs` |
| R5 文档引用 | `AGENTS.md`、`CLAUDE.md`、`docs/architecture.md` 中反引号括起的 `*.ts` 引用必须存在：含 `/` 的按相对仓库根或 `src/` 的路径解析；不含 `/` 的必须在 `src/` 或 `test/` 下能找到同名文件 | 三份文档 |

**基线**（`scripts/architecture-baseline.json`）：

- 只在 P0 用 `--init` 生成一次，记录当时全部的 R1 违规边（`from → to` 文件对）、R2 循环和 R3 超限文件（及当时的行数，作为上限）。
- 违规在基线里：通过，并汇总打印剩余数量。违规不在基线里：失败。
- 基线里有、但已经不存在的条目：**失败**，提示用 `--prune` 删除。这样基线只能缩小，修好的东西不会悄悄退化。
- `--prune` 只删除已不存在的条目，永远不新增。P0 之后禁止再用 `--init`。
- `scripts/move-modules.mjs` 搬迁文件时会同步改写基线里的路径。被搬走的文件若在新位置仍违规，算老问题；若产生新的违规模块对，则在同一阶段修掉。

**输出**：每条失败带一个下一步，例如"把 X 移到 Y，或者在 Z 定义接口并由上层注入；模块表见 AGENTS.md"。

不引入 dependency-cruiser 之类的新依赖。项目的 import 一律是带 `.js` 后缀的相对路径，没有路径别名；用已有的 devDependency `typescript` 解析语法树来收集 import，两三百行的脚本就够用，而且规则表就在仓库里，Agent 能直接读到。之所以不用正则，是因为 `test/evals/comparability.test.ts` 会把 `import … from "./helper.js"` 当作字符串写进临时文件，正则会把它误报为悬空路径。

### D3 `runtime/` 只保留装配根和跨子系统服务

**判断规则**：领域目录保持纯粹。只有把两个以上子系统和派发/唤醒机制接到一起的代码，才放在 `runtime/`。

| 留在 `runtime/` | 理由 |
|---|---|
| `bootstrap.ts` | 装配根：只构造和连接，目标 ≤ 500 行 |
| `turn-handler.ts`（新，从 `bootstrap.ts` 抽出） | 守护进程的每频道轮次处理：stop、`/new`、忙碌消息、运行时命令、`handleEvent` |
| `shutdown.ts`（新，从 `bootstrap.ts` 抽出） | 有序关闭和超时等待 |
| `durable-dispatch.ts`、`wake-coalescing.ts` | 派发的持久化和唤醒合并 |
| `task-driver.ts`、`task-spawn.ts`、`task-wake.ts` | 连接 tasks 与 channel、events、jobs、subagents；`tasks/` 本身保持叶子地位（D15） |
| `task-migration.ts` | 启动时的一次性迁移；`scripts/rehearse-task-migration.mjs` 依赖它在 `dist/` 中的路径 |

| 离开 `runtime/` | 去向 |
|---|---|
| `dingtalk.ts`、`channel-queue.ts`、`delivery.ts`、`inbound-media.ts` | `src/dingtalk/`（D4） |
| `app-home.ts`、`proxy.ts` | `src/app/`（D5） |
| `workspace-templates.ts` | `src/agent/prompt/`：SOUL/AGENTS 默认模板属于提示词资源 |
| `report-commands.ts` | `src/commands/router.ts`（D6） |
| `task-commands.ts`、`subagent-commands.ts`、`project-commands.ts`、`skill-commands.ts` | 各自领域的 `commands.ts`（D6） |

### D4 DingTalk 传输：`src/dingtalk/`

| 文件 | 内容 | 来源 |
|---|---|---|
| `bot.ts` | `DingTalkBot` 外观：`start`/`stop`、`enqueueEvent`、`routeInboundEvent`、每频道队列、空闲缓存清理；实现 `MediaSender` 和 `ChannelEventSink` | `runtime/dingtalk.ts` |
| `handler.ts` | 运行时要实现的契约：`DingTalkHandler`、`StopOutcome`、`BusyMessageResult`、`BusyMessageMode` | 同上 |
| `config.ts` | `DingTalkConfig`、`loadConfig`、`listChannelConfigIssues`、`busyMessageDefault` 的归一化 | `runtime/dingtalk.ts`、`runtime/app-home.ts` |
| `connection.ts` | Stream 客户端生命周期：连接超时、keepalive、带退避的重连、socket 清理 | `runtime/dingtalk.ts` |
| `access-token.ts` | access token 缓存和刷新 | 同上 |
| `cards.ts` | AI 卡片：创建、流式写入、替换和追加、卡片代际 | 同上 |
| `media.ts` | 媒体上传、发送、入站文件下载 | 同上 |
| `inbound.ts` | 解析 `onStreamMessage`、按消息 id 去重、会话元数据 | 同上 |
| `channel-queue.ts`、`delivery.ts`、`inbound-media.ts` | 原样搬入 | `runtime/` |

- `ResponseMode`、`progressStyleOf`、`finalDeliveryOf`、`normalizeResponseMode`、`isResponseModeConfig` 移到 `channel/channel-context.ts`，与 `ProgressStyle`、`FinalDelivery` 放在一起：它们是传输无关的投递词汇，TUI 也在用。
- `DingTalkBot` 的类名、构造参数和公有方法签名不变（`src/index.ts` 导出了它）。拆出来的部分是 `bot.ts` 持有的内部协作者，不另行导出给其他模块。
- 每个文件不超过 500 行。

### D5 进程外壳：`src/app/`

| 文件 | 内容 | 来源 |
|---|---|---|
| `home.ts` | 应用主目录脚手架、首次运行引导、`parseArgs`、`readCliVersion`、`BootstrapPaths`/`BootstrapIO`/`BootstrapExitError` | `runtime/app-home.ts`（去掉 `loadConfig`） |
| `services.ts` | `prepareAppServices`：DingTalk 守护进程、TUI 和 `auth` 子命令共用 | `src/app-services.ts` |
| `proxy.ts` | 安装 LLM 代理 | `runtime/proxy.ts` |
| `auth-command.ts` | `pipiclaw auth status\|login\|logout` | `models/auth-cli.ts` |

`home.ts` 用 `new URL("../../package.json", import.meta.url)` 读取版本号。搬迁前后都处在 `src/` 下第二层（`dist/` 中同理），路径不变；实施时要核对这一点。

### D6 命令平面

一条斜杠命令由三处组成，各在固定位置：

1. **目录**：`commands/catalog.ts` 登记名称、说明、忙碌时是否可用。它是叶子，不 import 任何东西。
2. **处理器**：拥有该状态的领域目录下的 `commands.ts`，导出 `handle<Name>Command`。
3. **分发**：无状态的报告命令经 `commands/router.ts`（原 `runtime/report-commands.ts`）分发，DingTalk 和 TUI 共用；会话内命令留在 `agent/session/command-extension.ts`。

| 命令 | 处理器 |
|---|---|
| `/tasks` | `tasks/commands.ts` |
| `/subagents` | `subagents/commands.ts` |
| `/events` | `events/commands.ts` |
| `/memory` | `memory/commands.ts`（不变） |
| `/skills` | `skills/commands.ts` |
| `/project` | `channel/commands.ts` |
| `/status`、`/usage`、`/context` | `agent/status-render.ts`、`usage/render.ts`、`ChannelRunner.renderContextReport`（不变） |

`commands/router.ts` 不 import `app/`：它需要的路径字段自己声明为一个结构类型，不再借用 `BootstrapPaths`。

### D7 应用级配置文件的归属

| 文件 | 唯一加载者 |
|---|---|
| `settings.json` | `config/settings.ts`（原 `src/settings.ts`） |
| `tools.json` | `config/tools.ts`（原 `tools/config.ts`） |
| `security.json` | `security/config.ts`（不变） |
| `channel.json` | `dingtalk/config.ts` |
| `models.json`、`auth.json` | `models/`（通过 SDK，不变） |

`config/settings.ts` 只依赖 `shared/`、`foundation`，以及 `channel` 中的 `ResponseMode` 类型：

- 删除对 `memory/maintenance-tuning.ts` 的依赖。`getMemoryMaintenanceSettings()` 只返回 `{ enabled }`；需要节奏常量的地方（`memory/` 内部，以及 `ChannelRunner` 记录活动的那一处）直接调用 `getMemoryMaintenanceTuning()`，或者由 `memory/` 提供一个合并两者的函数。行为不变。
- `ResponseMode` 改为用 `import type` 从 `channel/channel-context.ts` 引入。`ENUM_SETTINGS` 里 `tui.responseMode` 保留字面量列表，配合 `satisfies readonly ResponseMode[]` 保证与类型一致；那段注释的理由改为"config 对 channel 只允许类型依赖"。

### D8 新目录与归位

| 来源 | 去向 | 理由 |
|---|---|---|
| `agent/job-manager.ts` | `jobs/manager.ts` | 后台 job 与委派 run 同层，不属于 agent；消除 `tools → agent` |
| `agent/workspace-resources.ts` | `skills/loader.ts` | skills 是独立领域 |
| `tools/skill-security.ts` | `skills/validation.ts` | 同上 |
| `tools/skill.ts` 中的 `listWorkspaceSkills`、`loadWorkspaceSkillFile` | `skills/workspace.ts` | 领域逻辑；`tools/skill.ts` 只剩适配层 |
| `agent/model-fallback.ts` | `models/fallback.ts` | agent 和 subagents 都要用；消除 `subagents → agent` |
| `memory/task-digest.ts` | `agent/turn/task-digest.ts`（P1 先放到 `agent/`，P5 建好 `turn/` 后再移入） | 它在拼装一轮对话的上下文；消除 `memory → tasks` |
| `shared/types.ts` | `usage/totals.ts` | 文件内容只有 `UsageTotals` 和累加函数 |
| `tools/tool-details.ts`、`tools/presentation.ts`、`tools/subagent-tool-names.ts` | `tools/contract/details.ts`、`presentation.ts`、`names.ts` | 下层模块也要读的工具契约，只依赖 shared 和 security |
| `tools/task-manage.ts` | `tools/task-manage/factory.ts` | 文件与同名目录不再并存 |

根目录最终只剩：`main.ts`、`index.ts`、`log.ts`、`paths.ts`、`executor.ts`、`file-store.ts`、`proxy-from-env.d.ts`。`paths.ts` 不能移动：它用 `import.meta.url` 相对定位 `playbooks/`（`./playbooks` 和 `../src/playbooks`）。`executor.ts` 和 `file-store.ts` 是 spec 044 定义的宿主 I/O 端口，有 13 个以上的使用方，搬走只会制造改动，不会让代码更清楚，所以留在原地，归入 `foundation`（D15）。

### D9 九条反向依赖的修法

按 D1–D8 完成搬迁后，模拟结果剩下 9 条违规。修法如下，签名改动都限于内部接口：

| 违规 | 修法 |
|---|---|
| `events → dingtalk`（`DingTalkBot`） | 在 `channel/channel-event.ts` 定义 `ChannelEventSink { enqueueEvent(event: ChannelEvent): boolean }`。`EventsWatcher` 和 `durable-dispatch`（原为 `Pick<DingTalkBot, "enqueueEvent">`）都改用它；`DingTalkBot` 实现它 |
| `config → dingtalk`（`ResponseMode`） | D4：`ResponseMode` 一族移到 `channel/channel-context.ts` |
| `tui → dingtalk`（`progressStyleOf`/`finalDeliveryOf`） | 同上 |
| `app → dingtalk`（`loadConfig` 及其归一化） | D4/D5：`loadConfig` 移到 `dingtalk/config.ts`，由 `runtime/bootstrap.ts` 调用 |
| `config → memory`（节奏常量） | D7 |
| `playbooks → tools`（`TOOL_NAMES`） | `loadRuntimePlaybookCatalog(knownToolNames, directory?)` 改为由调用方传入工具名集合，`agent/` 传 `TOOL_NAMES`。未知工具名仍然抛错，行为不变 |
| `subagents → tools`（`buildToolSet`） | 派发选项增加 `buildWorkerTools(ctx): AgentTool[]`，由 `tools/index.ts` 在组装选项时注入。`subagents/` 只认识这个函数签名；对 verify 过滤 `write`/`edit`、拒绝写入记忆这类子代理策略仍留在 `subagents/` |
| `skills → tools`（`skills/commands` 用到 `tools/skill`） | D8：把这两个函数移到 `skills/workspace.ts`。截断等纯展示处理留在 `tools/skill.ts` |
| `commands-router → app`（`BootstrapPaths` 类型） | D6：路由器自己声明 `ReportCommandPaths` 结构类型 |

文件级循环一并消除，做法是把共享类型挪到一个不依赖实现的文件里：

| 循环 | 修法 |
|---|---|
| `subagents/runs.ts ↔ external/{settlement,progress-tail}.ts` | run 的类型和常量移到 `subagents/run-record.ts`（见 D11） |
| `events/events.ts ↔ event-validation.ts` | 事件类型移到 `events/types.ts` |
| `agent/channel-runner.ts ↔ runner-factory.ts` | `RunnerDeps`、`RunnerFactoryPaths` 移到 `agent/types.ts` |
| `tui/renderer.ts ↔ {pitui,plain}-frontend.ts` | `Frontend`、`FrontendCallbacks` 移到 `tui/frontend.ts` |

### D10 `tools/` 的边界

- **`tools/<name>.ts` 是适配层**：工具的参数 schema、参数校验（以及按 AGENTS.md 抛出 `RecoverableToolError`）、调用领域函数、组装给模型看的 `content` 和给运行时看的 `details`。持久化、状态机、调度、策略都不放在这里。
- **领域目录不 import `tools/`**，只能 import `tools/contract/`。
- **委派工具和其他领域工具同样处理。**`subagent`、`subagent_inline` 的 schema 和工具工厂（`createSubAgentTool`、`createSubAgentInlineTool`、`SubAgentToolFields`/`SubAgentToolDetails`、`createDetails`）移到 `tools/subagent.ts`；派发和执行留在 `subagents/`（D11）。原先 `memory`、`task`、`event`、`job` 工具在 `tools/` 而唯独委派工具不在的不一致，到此消除。
- 注册表 `tools/registry.ts` 和 `buildToolSet` 继续是工具清单的唯一来源，`details.kind` 的打标规则不变。

### D11 大文件拆分

通用约束：

- 先做纯搬移（把函数或方法原样移到新文件、改成参数传递），再做内部整理，两者分开提交。
- 公有类名、公有方法签名、`src/index.ts` 的导出、持久化格式、日志事件名一律不变。
- 测试如果直接访问被拆走的私有字段（例如 `(bot as unknown as { accessToken })`），只把访问目标改到新的协作者上，断言不变。

**`agent/channel-runner.ts`（1871 行，目标 ≤ 600 行）**：`ChannelRunner` 保留为外观，继续实现 `AgentRunner`，并独占轮次状态（`TurnStateMachine`）。

```
agent/
  channel-runner.ts        外观：公有 API、轮次状态、对下列协作者的委托
  runner-factory.ts
  types.ts                 + RunnerDeps、RunnerFactoryPaths
  builtin-commands.ts      handleBuiltinCommand、renderContextReport、帮助、sendCommandReply
  status-render.ts
  session/
    session-host.ts        AgentSession 的生命周期：初始化、重载、绑定任务会话或聊天会话、退役、释放；
                           资源加载器、SDK 服务、扩展绑定、事件订阅
    model-selection.ts     当前模型、备用模型切换与恢复、thinking level 兼容
    session-adapter.ts  session-events.ts  session-resource-gate.ts  command-extension.ts
    event-guards.ts        原 type-guards.ts（SDK 事件的类型守卫）
  turn/
    turn-input.ts          用户消息格式化、超长输入落盘、原样转发规则、图片
    turn-context.ts        任务议程、首轮记忆注入、频道上下文拼装
    turn-finish.ts         原 finishTurn
    task-digest.ts         原 memory/task-digest.ts
    turn-state.ts  turn-prompt.ts  turn-error.ts  turn-recovery.ts  run-queue.ts
    context-budget.ts  progress-formatter.ts
  prompt/                  不变，另加 workspace-templates.ts
```

`run()` 只负责编排各个步骤，目标 ≤ 120 行。`ChannelRunner` 没有单元测试，主要靠 `test/e2e/deterministic/` 覆盖，所以这一步的每次提交都要跑 `npm run test:e2e`。

**`subagents/tool.ts`（1692 行，拆完后删除）**：

```
tools/subagent.ts                 schema、两个工具工厂、details（D10）
subagents/dispatch.ts             dispatchSubAgentRun、run 上下文准备（工作目录、项目边界、产物目录）、派发选项类型
subagents/task-envelope.ts        buildSubAgentTask、buildFollowUpTask、核验协议、assertVerifyAdmissible、上下文块（读取记忆）
subagents/grace.ts                graceDeadlineFor、watchAbort：同步等待窗口，内部和外部 run 共用
subagents/internal/run.ts         dispatchInternalRun：只编排，目标 ≤ 150 行
subagents/internal/worker.ts      DirectoryExecutor、worker 的创建、工具集（通过注入的 buildWorkerTools）、拒绝写入记忆
subagents/internal/provider-retry.ts  瞬时错误重试与备用模型切换（原 recoverFromProviderErrors）
subagents/internal/outcome.ts     输出收尾、verify 结论、用量 → SettleInput
subagents/external/dispatch.ts    dispatchExternalRun（与 external/run.ts 放在一起）
```

`internal/` 与已有的 `external/` 对称，Agent 看目录就知道两种执行方式各在哪里。

**`runtime/bootstrap.ts`（1383 行，目标 ≤ 500 行）**：抽出 `runtime/turn-handler.ts`（原 `createDingTalkHandler` 及其依赖接口，改名为 `createTurnHandler`）和 `runtime/shutdown.ts`。`handleEvent` 按步骤拆成命名函数：派发准入（`markStarted`、吸收可合并的唤醒）→ 内置命令 → 未知斜杠命令 → 唤醒核验并确定任务步骤 → 执行 → 收尾（结束任务步骤、完成派发）。目标是 `handleEvent` ≤ 120 行、`turn-handler.ts` ≤ 700 行。`createRuntimeContext` 的测试注入点保持不变。

**`runtime/dingtalk.ts`（1820 行）**：见 D4。

**`subagents/runs.ts`（1654 行，目标 ≤ 1100 行）与 `jobs/manager.ts`（1328 行，目标 ≤ 900 行）**：只抽出纯数据和纯函数：

- `subagents/run-record.ts`：类型、常量、run id 的生成与解析、`parseRunRecord`、待结算记录的辅助函数。
- `jobs/launch.ts`：启动脚本的生成、启动输出的解析。
- `jobs/record.ts`：job 记录的类型和解析。

`SubAgentRunManager` 和 `ChannelJobManager` 仍是各自状态的唯一所有者，幂等标记原样保留；恢复和对账逻辑不移出类。两个文件留在 R3 基线里，以拆分后的行数作为上限。

**`events/events.ts`（1009 行）**：拆成 `events/types.ts`、`events/parse.ts`（`parseScheduledEventContent`、`describeEventPayload` 等）、`events/watcher.ts`（`EventsWatcher`、`createEventsWatcher`），以及可选的 `events/pre-action.ts`。

**不拆**：`subagents/discovery.ts`（1040 行，结构内聚，保留在基线里，见 D15）、`security/command-guard.ts`（708 行）。

### D12 命名约定

1. 文件名用 kebab-case，**不重复目录名**：`events/commands.ts`，而不是 `events/event-commands.ts`。
2. `<domain>/commands.ts` 是该领域给用户用的斜杠命令处理器；`tools/<name>.ts` 是给模型用的工具适配层。两者都调用领域函数，彼此不 import。
3. 不新建 `utils.ts`、`helpers.ts`、`misc.ts` 这类按"杂项"命名的文件，按内容命名。现有的 `models/utils.ts` 在 P5 拆成 `models/reference.ts`（模型引用的格式化和匹配）和 `models/runtime.ts`（`createModelRuntime`、默认模型）。
4. 一个领域的类型如果被它自己的实现文件 import 回去，就放进 `types.ts`，避免循环。
5. 任务相关文件按术语命名：`tasks/contract.ts`（原 `ledger.ts`，任务说明 `tasks/<id>.md` 的解析与渲染）、`tasks/loop-log.ts`（原 `log.ts`，循环日志）、`tasks/bound-work.ts`（原 `work-log.ts`，job 和 run 写入 dispatch/settle 记录的唯一入口）。`usage/ledger.ts` 保持原名，`ledger` 从此只指用量账本。
6. 跨模块使用的东西不重导出，也不建兼容别名：搬了文件就改所有 import。

### D13 文档与注释

- `AGENTS.md` 的「Core Structure」改写成 D1 的模块表（职责 / 可以 import / 典型文件），作为唯一来源。`CLAUDE.md` 的 Architecture 只讲跨文件的流程和并发模型，模块划分改为引用 `AGENTS.md`。`docs/architecture.md` §2「源码地图」同步更新，修掉 `tasks/verification.ts` 这条失效引用。三份文档都受 R5 检查。
- 模块表要写明 D15 的三项取舍：`tasks` 一行注明"调度和唤醒的衔接代码在 `runtime/task-*.ts`"；`foundation` 一行列出根目录的文件；`subagents` 一行注明 `discovery.ts` 是登记过的超长例外。
- `AGENTS.md` 的 Engineering Rules 增加三条：一条指向 `npm run arch`；"新代码放哪里"的判断顺序（先看模块表，再看 D12 的命名约定）；D10 的工具边界。
- 每个文件开头用 1–3 行注释说明它负责什么。新建、搬迁或拆分的文件必须有；其余缺少的文件在 P6 统一补上，例如 `channel-runner.ts`、`bootstrap.ts`、`durable-dispatch.ts`、`command-guard.ts`、`path-guard.ts`、`network.ts`、`config/tools.ts`、`web/client.ts`、`usage/ledger.ts`、`channel/store.ts`。不加检查，由评审把关。

### D14 不变量（实施期间必须保持）

- `src/index.ts` 导出的名称不变（spec 035）；`main.ts` 保持为薄入口；`bin` 仍指向 `dist/main.js`。
- `SubAgentRunManager` 独占结算、用量、租约和完成唤醒；`resolveTicket` 是产生 `Ticket` 的唯一入口；`redeemTicket` 是恢复的唯一路径。
- `memory/channel-maintenance-queue.ts` 仍是共享单例；每频道的串行队列语义不变。
- `ChannelContext` 和 `ChannelEvent` 契约不变；轮次状态只由 runner 的 `TurnStateMachine` 持有。
- 工具注册表、`details.kind` 打标规则、`RecoverableToolError` 的语义不变。
- `paths.ts` 不移动；`app/home.ts` 读取 `package.json` 的相对层级不变；`dist/runtime/task-migration.js` 的路径不变。
- 日志事件名（`<domain>.<object>.<verb>`）不变，哪怕代码换了目录。

### D15 已确认的取舍

以下三项由用户于 2026-10-12 确认。实施 Agent 不要再搬动这些文件，也不要把它们当作遗漏去"补做"。

| 取舍 | 决定 | 理由 | 代价 |
|---|---|---|---|
| `task-driver.ts`（以及 `task-spawn.ts`、`task-wake.ts`、`task-migration.ts`）的位置 | **留在 `runtime/`**，不搬进 `tasks/` | `task-driver` 要构造 `ChannelEvent`、读频道索引和 `settings`；搬进 `tasks/` 就得让 `tasks` 依赖 `channel` 和 `config`。留在 `runtime/`，`tasks/` 就能保持"只依赖第 0–1 层"的叶子地位，这一点比"调度代码放在任务目录"更重要。这也符合 D3 的判断规则：把多个子系统和派发、唤醒机制接在一起的代码放 `runtime/` | 找任务调度代码要去 `runtime/task-*.ts`，而不是 `tasks/`。D13 要求在 `AGENTS.md` 的模块表中，在 `tasks` 一行注明这一点 |
| `executor.ts`、`file-store.ts` 的位置 | **留在 `src/` 根目录**，归入 `foundation` 模块，不新建 `host/` 目录 | 它们是 spec 044 定义的宿主 I/O 端口，`src/` 内有 13 个以上的使用方，还有大量测试引用。搬迁只有改动，没有可读性收益；根目录文件已经由 D1 的模块表显式登记，不会退化成"杂物堆" | 根目录有 7 个文件，不全是入口。检查脚本的 `MODULES` 表必须逐个登记根目录文件，新的根目录文件会因"未登记"失败 |
| `subagents/discovery.ts`（1040 行） | **不拆**，在 R3 基线里以 1040 行为上限 | 这个文件负责角色文件的解析和校验，结构内聚，没有反向依赖，也不在本次要修的问题清单里。拆分留到"后续"（第 6 节）单独评估 | 它是 3 个超过 800 行的登记例外之一；以后不能再增长，新增角色字段时要先把解析拆出去 |

## 4. 目标目录树

只列出有变化的部分。未列出的目录和文件保持不变。

```
src/
  main.ts  index.ts  log.ts  paths.ts  executor.ts  file-store.ts  proxy-from-env.d.ts
  app/          home.ts  services.ts  proxy.ts  auth-command.ts
  config/       settings.ts  tools.ts
  dingtalk/     bot.ts  handler.ts  config.ts  connection.ts  access-token.ts  cards.ts  media.ts
                inbound.ts  channel-queue.ts  delivery.ts  inbound-media.ts
  runtime/      bootstrap.ts  turn-handler.ts  shutdown.ts  durable-dispatch.ts  wake-coalescing.ts
                task-driver.ts  task-spawn.ts  task-wake.ts  task-migration.ts
  commands/     catalog.ts  reply-limits.ts  router.ts
  agent/        （见 D11）
  jobs/         manager.ts  launch.ts  record.ts
  skills/       loader.ts  validation.ts  workspace.ts  commands.ts
  subagents/    commands.ts  dispatch.ts  task-envelope.ts  grace.ts  run-record.ts  runs.ts
                discovery.ts  detached-discovery.ts  format.ts  verification-outcome.ts
                workspace-lease.ts  workspace-summary.ts
                internal/  run.ts  worker.ts  provider-retry.ts  outcome.ts
                external/  dispatch.ts  （其余不变）
  tasks/        contract.ts  loop-log.ts  bound-work.ts  commands.ts  （其余不变）
  events/       types.ts  parse.ts  watcher.ts  validation.ts  commands.ts  [pre-action.ts]
  channel/      + commands.ts；channel-context.ts 增加 ResponseMode 一族；channel-event.ts 增加 ChannelEventSink
  models/       api-keys.ts  fallback.ts  login-ui.ts  provider-login.ts  reference.ts  runtime.ts
  usage/        ledger.ts  render.ts  totals.ts
  memory/       去掉 task-digest.ts
  tools/        contract/  details.ts  presentation.ts  names.ts
                subagent.ts  skill.ts（只剩适配层）  task-manage/factory.ts  （去掉 config.ts、skill-security.ts）
  tui/          + frontend.ts
  shared/       去掉 types.ts
```

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 搬迁后 `vi.mock("../src/…")` 指向不存在的路径，mock 静默失效，测试换成了真实模块却仍然通过 | `move-modules.mjs` 会改写 `vi.mock` 的字符串；R4 检查每个 `vi.mock` 路径都能解析（`tsc` 不检查它） |
| `evals/` 引用 `src/` 的路径，但不在 `tsconfig.json` 的范围内 | 每个搬迁阶段都跑 `npm run eval:typecheck`；R4 也覆盖 `evals/` |
| 依赖 `import.meta.url` 的相对路径 | `paths.ts` 不动；`app/home.ts` 的层级不变；每个阶段都跑 `npm run build`，并实际运行一次 `node dist/main.js --version` |
| 大量 import 改写和 Biome 排序带来噪声 | 搬迁提交只含 `git mv`、import 改写和 `biome check --write`，不夹带逻辑改动；可以把这些提交登记进 `.git-blame-ignore-revs` |
| 拆分 `ChannelRunner`、`turn-handler`、`dingtalk` 时引入时序回归 | 先纯搬移再整理；每次提交都跑 `test:e2e`；不改任何 `await` 的先后顺序和锁的范围 |
| 测试访问的私有字段被拆走 | 只改访问目标，不改断言（D11） |
| 基线被当成"豁免清单"越积越多 | P0 之后禁止 `--init`；过期条目会让检查失败；新增违规必须当场修掉 |

## 6. 后续（不在本 spec 范围）

- 后台 job 与委派 run 有相似的记录、持久化、唤醒认领和垃圾回收（`shared/wake-claim.ts` 已经抽出了一部分），可以评估是否合并为一个后台工作框架。
- `subagents/discovery.ts` 的角色文件解析可以独立成 `subagents/roles/`。
- 把 `tui/app.ts` 和 `runtime/bootstrap.ts` 共同的装配（job、run、runner）抽成共享函数。

## 实施记录

实施于 2026-10-12 至 2026-10-13，分支 `refactor/054-code-organization`。最终闸门全部通过：`npm run check`（lint、typecheck、arch、deadcode、980 个单元/集成测试）、`npm run test:e2e`（44 个确定性用例）、`npm run eval:typecheck`、`npm run build && node dist/main.js --version`。`src/` 现为 256 个 `.ts` 文件、48.4k 行；基线为 R1 0 条、R2 0 个循环、R3 3 个登记文件（`subagents/runs.ts` 1173、`jobs/manager.ts` 1095、`subagents/discovery.ts` 1040）。P0 用 `--init` 生成的基线与预期完全一致（R1 9、R2 4、R3 8）。

以下是与 plan 不一致的地方，以及理由。

**P0**
- 解析 import 的代码抽成了 `scripts/lib/imports.mjs`，`check-architecture.mjs` 和 `move-modules.mjs` 共用。
- R5 对含 `/` 的引用除了按仓库根、`src/` 解析，还接受"某个真实文件路径的后缀"（如 `prompt/types.ts`）：`docs/architecture.md` 大量使用相对于小节目录的写法。
- `--prune` 除了删掉已消失的条目，也会把 R3 上限调低到当前行数。

**P2**
- 第 4 步：`getMemoryMaintenanceSettings()` 只返回 `{ enabled }`；`memory/maintenance-tuning.ts` 新增 `resolveMemoryMaintenanceSettings`，由 `reflect-job.ts` 和 `scheduler.ts` 在内部合并节奏常量，调用方显式给出的值仍然优先，所以调度测试原样通过。`test/context.test.ts` 里对 `getMemoryMaintenanceSettings()` 的两处断言必须改成只含 `enabled`（它们断言的正是被删掉的合并结果）。
- 第 5 步：`app/home.ts` 的 `CHANNEL_CONFIG_TEMPLATE` 失去了 `satisfies DingTalkConfig`（`app` 不能 import `dingtalk`）。
- 第 7 步：`loadWorkspaceSkillFile` 返回完整文件，截断由 `tools/skill.ts` 自己做（`skills` 不能 import `tools/truncate.ts`）。`/skills show` 因此不再先经过这道截断，而它的回复本来就被 `capReply` 限在 1500 字符内，只有"第一行就超过 50 KB"的畸形文件会有差别。
- 第 8 步：为了不让 `ChannelRunner` 多一行 import（它的 R3 上限不能增长），`agent/prompt/resources.ts` 新增 `loadPlaybooks(toolNames)`，由它传入 `TOOL_NAMES`。
- 第 9 步：`WorkerToolRequest`/`BuildWorkerTools` 最终放在 `subagents/types.ts`；测试里由 `testManagers()` 助手注入 `buildWorkerTools`。这一步的提交当时让 `subagents/tool.ts` 超出 R3 上限一行，下一个提交修正（中间有一个提交 `npm run arch` 是红的）。
- 第 10 步：`tui/frontend.ts` 同时承载 `TranscriptRenderer`（`Frontend` 继承它）。

**P3a**
- `handler.ts` 里的 `DingTalkHandler` 引用 `DingTalkBot` 会和 `bot.ts` 形成类型循环，所以改用结构化的 `DingTalkBotPort`（运行时处理器和 `delivery.ts` 用到的那部分公有方法），`DingTalkBot` 实现它。`src/index.ts` 的导出名不变。
- 额外文件：`api.ts`（共用的 axios 实例、两个域名、`sendRobotMessage`）、`conversation-meta.ts`（会话元数据的内存缓存与落盘）。
- `delivery.ts` 按计划"原样搬入"，仍是 526 行，超过 D4 的 500 行目标；其余 `dingtalk/` 文件都在 500 行以内。
- 测试里访问私有字段的地方改到了协作者上：`bot.tokens`、`bot.conversations`、`bot.inbound`、`bot.connection`；断言不变。

**P3b**
- 额外文件：`stop-watchdog.ts`（`forceEndStuckTurnAfterStop`）、`turn-run.ts`（`handleEvent` 的步骤函数：`admitTurn`、`runBuiltinCommand`、`verifyInternalWake`、`executeTurn`、`finishTurn`）、`inbound-images.ts`。这样 `turn-handler.ts` 为 432 行、`bootstrap.ts` 500 行、`handleEvent` 约 30 行。`structuredWakeFinalized` 仍取自合并前的入站事件。

**P4**
- plan/D10 把 `SubAgentToolFields`/`createDetails` 放进 `tools/subagent.ts`，但派发代码（在 `subagents/`）要产出它们，而 `subagents/` 不能 import `tools/`，二者矛盾。落地为：`SubAgentToolFields` 在 `subagents/types.ts`，`createDetails` 在 `subagents/result.ts`；`tools/subagent.ts` 导出打了 `kind` 的 `SubAgentToolDetails`，`agent/` 从它 import。
- `SubAgentToolOptions` 放在 `subagents/types.ts` 而不是 `dispatch.ts`：它的 `buildTools?` 字段引用 `buildSubagentTools`，放进 `dispatch.ts` 会产生类型循环（D12 第 4 条）。
- 额外文件：`result.ts`、`types.ts`、`internal/state.ts`（`InternalRunState` 和进度发射器）。`dispatchInternalRun` 为 146 行。

**P5**
- `ChannelRunner` 还额外拆出了 `turn/turn-pipeline.ts`（输入准备、回合上下文、图片、预防性压缩、fallback 接缝、steer 入队）和 `agent/builtin-commands.ts`；`run()` 为 99 行，`channel-runner.ts` 为 593 行，`agent/` 根目录 6 个文件。构造顺序（解析项目范围 → 恢复会话 → models → memoryLifecycle → host → 异步初始化）不变。
- `subagents/runs.ts` 没有达到 ≤ 1100 行：D11 规定恢复和对账逻辑留在类内，纯数据部分抽完（`run-record.ts` 的 id/待结算/解析助手、`completion-wake.ts`、`run-registry.ts`，`resolveSyncGraceMs` 挪到 `grace.ts`）后是 1173 行。`jobs/manager.ts`（`launch.ts`、`record.ts`）同理，1095 行，目标 900 未达到。两者都在基线里以这两个数字为上限。
- `events/pre-action.ts` 是可选项，没有拆。

**其他**
- `evals/baselines/*/cases.json` 记录的是历史文件路径的哈希，是历史数据，没有改动。
- 纯搬迁提交已登记到 `.git-blame-ignore-revs`。

**自检（P6 完成标准里的三个问题）**
1. 新增一个 `/foo` 报告命令：`commands/catalog.ts`（目录项）、拥有该状态的领域目录下的 `commands.ts`（处理器）、`commands/router.ts`（分发）。
2. 给记忆加一个工具：领域逻辑在 `memory/`（例如 `store.ts`、`search.ts`），模型侧适配层在 `tools/memory-manage.ts`，并在 `tools/registry.ts` 登记。
3. 钉钉卡片流式更新的 bug：`dingtalk/cards.ts`（卡片创建、流式写入、代际）；一轮内的投递顺序在 `dingtalk/delivery.ts`。

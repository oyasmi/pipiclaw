# 054 实施计划

设计见 [design.md](./design.md)。共七个阶段，每个阶段都能独立合并：

- 越靠前的阶段越机械、风险越低；
- P0 先把检查装上，之后每一步都由检查兜底；
- 每个阶段结束时，下面的「阶段闸门」必须全部通过。

## 阶段总览

| 阶段 | 交付 | 对应决策 | 风险 |
|---|---|---|---|
| P0 护栏 | `check-architecture.mjs`、`move-modules.mjs`、基线、`npm run arch` 接入 `check`；修掉失效的文档引用 | D1、D2 | 极低：不动 `src/` |
| P1 搬迁 | 31 个文件换位置或改名，只改 import | D3–D8、D12 | 低：纯机械操作 |
| P2 改接口 | 消除 9 条反向依赖和 4 处文件级循环；拆出 `skills/workspace.ts` | D7、D9 | 低到中 |
| P3 拆传输与装配根 | 拆分 `dingtalk/`；从 `bootstrap.ts` 抽出 `turn-handler.ts`、`shutdown.ts` | D4、D11 | 中 |
| P4 拆委派 | `subagents/tool.ts` 拆成 `tools/subagent.ts`、`subagents/{dispatch,task-envelope,grace}.ts`、`internal/*`、`external/dispatch.ts` | D10、D11 | 中 |
| P5 拆 agent 及其余 | `ChannelRunner` 拆分、`agent/` 分出子目录；`runs`、`jobs`、`events` 抽出纯数据部分；`models/utils.ts` 拆分 | D11、D12 | 中到高 |
| P6 文档 | `AGENTS.md` 模块表、`CLAUDE.md`、`docs/architecture.md`、文件头注释 | D13 | 极低 |

P3、P4 互不依赖，可以对调。P5 必须在 P2 之后做（依赖 `ChannelEventSink` 和 `buildWorkerTools` 注入）。

---

## 通用规则（每个阶段都适用）

**阶段闸门**（全部通过才算完成）：

```bash
npm run check                 # lint + typecheck + arch + deadcode + test
npm run test:e2e
npm run eval:typecheck        # evals/ 引用了 src/，但不在 tsconfig.json 的范围内
npm run build && node dist/main.js --version
```

**提交纪律**：

- **搬迁提交**只包含 `git mv`、import 改写和 `npx biome check --write .` 的结果，不夹带任何逻辑改动。提交信息用 `refactor: move …`。
- **逻辑提交**（改接口、拆函数）与搬迁提交分开，提交信息用 `refactor: …`，正文写明"无行为变化"以及对应的决策编号。
- 遵守 CLAUDE.md：不加 `Co-Authored-By` 之类的署名尾注。
- 纯搬迁提交的哈希可以追加到 `.git-blame-ignore-revs`（P0 创建该文件），这样 blame 能跳过它们。

**不能改的东西**：`src/index.ts` 的导出名称（只允许改 `from` 路径）、日志事件名、持久化格式、用户可见文案、测试断言。测试只允许改 import 路径，以及把对私有字段的访问改到被拆出的协作者上。

**已确认的取舍**：design.md D15 中的三项（`task-driver` 留在 `runtime/`、`executor.ts`/`file-store.ts` 留在根目录、不拆 `subagents/discovery.ts`）是定案，不属于偏差，不要搬动或拆分。

**偏差处理**：实施中发现本计划与代码事实不符时（例如某个函数还有计划之外的调用方），按 design.md 的原则就地决定，并写进 design.md 末尾的「实施记录」，写明阶段、偏差和理由。不要为了照搬计划而引入新的反向依赖或兼容别名。

**测试路径陷阱**：测试里的 `vi.mock("../src/…")` 比 `src/` 内部的 import 多一层 `../`，而且 `tsc` 不检查这个字符串。搬迁后务必依赖 R4 的检查，不要只看 `typecheck`。

---

## P0 护栏

### 改动

| 文件 | 改动 |
|---|---|
| `scripts/check-architecture.mjs`（新） | 实现 design.md D2 的 R1–R5；规则表 `MODULES`、`ALLOWED` 写在文件顶部；支持 `--init`、`--prune` |
| `scripts/architecture-baseline.json`（新） | 用 `--init` 生成 |
| `scripts/move-modules.mjs`（新） | 搬迁工具，规格见下 |
| `package.json` | 新增 `"arch": "node scripts/check-architecture.mjs"`；`check` 改为 `lint && typecheck && arch && deadcode && test` |
| `docs/architecture.md` | §2 tasks 行删掉不存在的 `verification.ts`（R5 会报出来） |
| `.git-blame-ignore-revs`（新） | 先建一个空文件，加一行注释说明用途 |

### `check-architecture.mjs` 实现要点

- **解析 import 用 `typescript` 包**（已是 devDependency）：用 `ts.createSourceFile` 遍历语法树，收集以下节点中的相对路径字符串：
  - `ImportDeclaration`、`ExportDeclaration`；
  - 调用 `import(…)`；
  - 调用 `vi.mock(…)`、`vi.importActual(…)`、`vi.doMock(…)`。

  **不要用正则**：`test/evals/comparability.test.ts` 会把 `'import { value } from "./helper.js"'` 当作字符串写进临时文件，正则会把它误报为悬空路径。
- 路径解析：`.js` 映射到 `.ts`，依次尝试 `.ts`、`.d.ts`、`.mts`，以及原样的 `.mjs`/`.js`（用于 `scripts/`）。
- **`MODULES` 表**：一个有序数组，元素为 `[路径前缀或完整文件路径, 模块名]`，第一个匹配的生效；未匹配的取 `src/` 之后的第一级目录名；根目录文件未登记时报错。
  - **P0 的表里包含"遗留条目"**：尚未搬迁的文件直接登记为它的目标模块，例如：
    - `src/settings.ts → config`、`src/app-services.ts → app`、`src/agent/job-manager.ts → jobs`；
    - `src/runtime/dingtalk.ts` 以及要搬去 `dingtalk/` 的其他三个文件 → `dingtalk`；
    - `src/runtime/report-commands.ts → commands-router`；
    - `src/tools/config.ts → config`；
    - `src/tools/{tool-details,presentation,subagent-tool-names}.ts → tools-contract`；
    - 其余按 design.md 第 4 节的目标位置登记。

  这样 P1 的每次搬迁都不改变文件所属的模块，基线也就不会因为搬家而变化。P1 搬完一个文件，就删掉它的遗留条目。
- **`ALLOWED` 表**：照抄 design.md D1。启动时用拓扑排序验证它无环。`config → channel` 只允许 `import type`：这是唯一需要区分 type-only 的规则，实现为一张单独的 `TYPE_ONLY_ALLOWED` 表。
- **R3** 按物理行数计算。
- **R5** 扫描三份文档中所有反引号括起、以 `.ts` 结尾的 token。
- **输出格式**：`[R1] src/a.ts → src/b.ts (events → dingtalk) 不允许。下一步：…`；最后一行汇总"基线剩余 N 条"。

### `move-modules.mjs` 规格

```
node scripts/move-modules.mjs moves.json      # {"src/runtime/dingtalk.ts": "src/dingtalk/bot.ts", ...}
```

1. 校验：每个来源都存在，每个目标都不存在，没有两个来源映射到同一个目标。
2. 对每对路径执行 `mkdir -p` 和 `git mv`。
3. 遍历 `src/`、`test/`、`evals/` 下的 `*.ts` 以及 `scripts/*.mjs`。按「旧位置」解析每个相对路径（同样用 `typescript` 的语法树，范围和上面一致）；若目标被搬迁，或者引用方自己被搬迁了，就按新位置重新计算相对路径。保留原来的扩展名风格（`src/` 用 `.js`，`scripts/measure-playbooks.mjs` 用 `.ts`）。只替换字符串字面量的内容，不重排代码。
4. 用同一张映射改写 `scripts/architecture-baseline.json` 里的文件路径，并删掉 `check-architecture.mjs` 里已经搬完的遗留 `MODULES` 条目（或者打印提示，由人手删）。
5. 被搬迁的文件里如果含有 `import.meta.url`，打印警告：这类相对 URL 不会被自动改写，要人工核对。
6. 不碰 `*.md`：文档由 R5 报出，人工修改。

做完后执行 `npx biome check --write .`。

### 预期基线

把 design.md 的搬迁表套到 2026-10-12 的依赖图上做过模拟，`--init` 的结果应当是（实施时若有出入，以实际为准，并写进实施记录）：

- **R1：9 条**，正好是 design.md D9 表中的 9 条：
  - `events/events.ts → runtime/dingtalk.ts`
  - `playbooks/catalog.ts → tools/registry.ts`
  - `runtime/app-home.ts → runtime/dingtalk.ts`
  - `runtime/report-commands.ts → runtime/app-home.ts`
  - `runtime/skill-commands.ts → tools/skill.ts`
  - `settings.ts → memory/maintenance-tuning.ts`
  - `settings.ts → runtime/dingtalk.ts`
  - `subagents/tool.ts → tools/registry.ts`
  - `tui/app.ts → runtime/dingtalk.ts`
- **R2：4 个循环**，见 design.md D9 第二张表。
- **R3：8 个文件**，各自以当前行数为上限：`channel-runner` 1871、`dingtalk` 1820、`subagents/tool` 1692、`runs` 1654、`bootstrap` 1383、`job-manager` 1328、`discovery` 1040、`events` 1009。
- **R4、R5：0 条**。`verification.ts` 那条在本阶段直接修掉，不进基线。

### 完成标准

- `npm run arch` 通过，打印出上述基线数量。
- 故意加一行 `import "../runtime/dingtalk.js"` 到 `src/memory/store.ts`，`arch` 失败并给出下一步提示；撤销后通过。把这个"变异检查"的结果写进提交正文。

---

## P1 搬迁

用 `move-modules.mjs` 分三批执行，每批一个搬迁提交，每批都要过阶段闸门。路径一律相对 `src/`。

**P1a 传输、外壳、命令路由**

| 来源 | 目标 |
|---|---|
| `runtime/dingtalk.ts` | `dingtalk/bot.ts` |
| `runtime/channel-queue.ts` | `dingtalk/channel-queue.ts` |
| `runtime/delivery.ts` | `dingtalk/delivery.ts` |
| `runtime/inbound-media.ts` | `dingtalk/inbound-media.ts` |
| `runtime/app-home.ts` | `app/home.ts` |
| `app-services.ts` | `app/services.ts` |
| `runtime/proxy.ts` | `app/proxy.ts` |
| `models/auth-cli.ts` | `app/auth-command.ts` |
| `runtime/workspace-templates.ts` | `agent/prompt/workspace-templates.ts` |
| `runtime/report-commands.ts` | `commands/router.ts` |

**P1b 命令处理器归位**

| 来源 | 目标 |
|---|---|
| `runtime/task-commands.ts` | `tasks/commands.ts` |
| `runtime/subagent-commands.ts` | `subagents/commands.ts` |
| `runtime/project-commands.ts` | `channel/commands.ts` |
| `runtime/skill-commands.ts` | `skills/commands.ts` |
| `events/event-commands.ts` | `events/commands.ts` |
| `events/event-validation.ts` | `events/validation.ts` |

**P1c 领域归位与改名**

| 来源 | 目标 |
|---|---|
| `agent/job-manager.ts` | `jobs/manager.ts` |
| `agent/workspace-resources.ts` | `skills/loader.ts` |
| `tools/skill-security.ts` | `skills/validation.ts` |
| `agent/model-fallback.ts` | `models/fallback.ts` |
| `memory/task-digest.ts` | `agent/task-digest.ts`（P5 再移进 `agent/turn/`） |
| `shared/types.ts` | `usage/totals.ts` |
| `tools/tool-details.ts` | `tools/contract/details.ts` |
| `tools/presentation.ts` | `tools/contract/presentation.ts` |
| `tools/subagent-tool-names.ts` | `tools/contract/names.ts` |
| `tools/config.ts` | `config/tools.ts` |
| `settings.ts` | `config/settings.ts` |
| `tasks/ledger.ts` | `tasks/contract.ts` |
| `tasks/log.ts` | `tasks/loop-log.ts` |
| `tasks/work-log.ts` | `tasks/bound-work.ts` |
| `tools/task-manage.ts` | `tools/task-manage/factory.ts` |

### 注意

- `app/home.ts` 读取 `../../package.json` 的层级与原来相同，但要用 `node dist/main.js --version` 实际确认一次。
- `scripts/rehearse-task-migration.mjs` 引用的 `dist/runtime/task-migration.js` 不受影响（`task-migration.ts` 不搬）。
- 只改文件名、不改导出的符号名。例如 `tasks/contract.ts` 里的 `TaskLedgerEntry` 暂不改名；符号改名不在本 spec 范围内。
- `CLAUDE.md`、`docs/architecture.md` 中被 R5 报出的路径，在同一个提交里改掉。

### 完成标准

- `src/runtime/` 只剩 `bootstrap.ts`、`durable-dispatch.ts`、`wake-coalescing.ts`、`task-driver.ts`、`task-spawn.ts`、`task-wake.ts`、`task-migration.ts`。
- `src/` 根目录只剩 `main.ts`、`index.ts`、`log.ts`、`paths.ts`、`executor.ts`、`file-store.ts`、`proxy-from-env.d.ts`。
- `MODULES` 表里不再有遗留条目；基线数量与 P0 相同（只是路径变了）。

---

## P2 改接口

按 design.md D9 第一张表逐条修改，每条一个逻辑提交；修完一条就 `--prune` 一次基线。

| 步骤 | 改动 | 测试 |
|---|---|---|
| 1 | `channel/channel-event.ts` 增加 `ChannelEventSink`；`events/events.ts`、`runtime/durable-dispatch.ts` 改用它 | 现有测试足够；只有类型标注写成 `DingTalkBot` 的地方需要改为 `ChannelEventSink` |
| 2 | `ResponseMode`、`RESPONSE_MODE_VALUES`、`progressStyleOf`、`finalDeliveryOf`、`normalizeResponseMode`、`isResponseModeConfig` 移到 `channel/channel-context.ts`；`dingtalk/bot.ts` 改为从这里 import；`src/index.ts` 中 `type ResponseMode` 的来源随之改变（名称不变） | — |
| 3 | `config/settings.ts` 用 `import type { ResponseMode }` 从 `channel/channel-context.ts` 引入类型；`ENUM_SETTINGS` 里 `tui.responseMode` 保留字面量列表，配合 `satisfies readonly ResponseMode[]`；重写那段说明"为什么抄一份列表"的注释，理由改为"config 对 channel 只允许类型依赖" | — |
| 4 | `config/settings.ts` 不再合并节奏常量：`getMemoryMaintenanceSettings()` 只返回 `{ enabled }`；`memory/` 内部和 `ChannelRunner` 记录活动的那一处改为调用 `getMemoryMaintenanceTuning()` | 现有 memory 调度测试必须原样通过 |
| 5 | `loadConfig`、`listChannelConfigIssues` 和 `busyMessageDefault` 的归一化移到 `dingtalk/config.ts`；`DingTalkConfig` 一并移过去；`app/home.ts` 只保留模板文本 | `bootstrap` 相关测试改 import 路径 |
| 6 | `commands/router.ts` 自己声明 `ReportCommandPaths` | — |
| 7 | `listWorkspaceSkills`、`loadWorkspaceSkillFile` 及其类型移到 `skills/workspace.ts`；`tools/skill.ts` 只保留 schema 和截断 | — |
| 8 | `loadRuntimePlaybookCatalog(knownToolNames, directory?)`；调用方 `agent/` 传入 `TOOL_NAMES` | playbook 目录测试改为显式传入名单 |
| 9 | 派发选项增加 `buildWorkerTools`，由 `tools/index.ts` 注入 `buildToolSet` 的包装；`subagents/tool.ts` 不再 import `tools/registry.ts` | e2e `subagent-toolset.test.ts` 是这一步的护栏 |
| 10 | 消除 4 处文件级循环：`subagents/run-record.ts`（只放类型和常量，完整的抽取在 P5）、`events/types.ts`、`agent/types.ts` 接收 `RunnerDeps`/`RunnerFactoryPaths`、`tui/frontend.ts` | — |

第 3 步的取舍：`config → channel` 只允许 `import type`，所以 settings 不能 import `RESPONSE_MODE_VALUES` 这个值。保留字面量列表并加 `satisfies readonly ResponseMode[]`，类型系统就能保证两份列表一致。

### 完成标准

- 基线中 R1、R2 都为 0 条；R3 仍是 8 个文件。
- 除 `runtime/` 和 `src/index.ts` 外，没有任何文件 import `dingtalk/`（R1 已经保证，这里再人工确认一次 `tui/`、`events/`、`config/`、`app/`）。

---

## P3 拆传输与装配根

### P3a `dingtalk/bot.ts` → design.md D4 的文件布局

1. 先移走纯声明：`handler.ts`（契约类型）、`config.ts` 中剩下的常量。
2. 再依次抽出 `access-token.ts`、`connection.ts`、`cards.ts`、`media.ts`、`inbound.ts`。每个都是 `DingTalkBot` 持有的内部类或一组函数：共享的状态（定时器、Map）随职责一起搬走，跨职责需要的回调通过构造参数传入。
3. `DingTalkBot` 的公有方法保持原签名，改为转发到协作者。
4. 测试中访问私有字段的地方（`accessToken`、`tokenExpiry`、`convMeta`、`queues`、`isReconnecting`、`client`、`doReconnect`、`getQueue`），访问路径改到新的协作者上，断言不变。

完成标准：`dingtalk/` 下每个文件 ≤ 500 行；R3 基线删掉 `dingtalk` 这一项。

### P3b `runtime/bootstrap.ts`

1. 纯搬移：把 `createDingTalkHandler`、`DingTalkHandlerDeps`，以及只被它使用的辅助函数（`forceEndStuckTurnAfterStop`、`isIdleRuntimeCommandName` 等）原样移到 `runtime/turn-handler.ts`，改名为 `createTurnHandler`。被测试 import 的符号保持导出。
2. 纯搬移：`shutdownWithReason` 及其等待辅助函数移到 `runtime/shutdown.ts`，需要的状态通过参数对象传入。
3. 整理：把 `handleEvent` 拆成命名的步骤函数（design.md D11），每个步骤的 `await` 顺序、`try/finally` 范围和 `endTurn` 的调用点保持原样。

完成标准：`bootstrap.ts` ≤ 500 行；`turn-handler.ts` ≤ 700 行；`handleEvent` ≤ 120 行；R3 基线删掉 `bootstrap` 这一项；`bootstrap-structured-wake`、`runtime-stop`、`runtime-context` 测试和全部 e2e 通过。

---

## P4 拆委派：`subagents/tool.ts`

按 design.md D11 的布局，顺序如下：

1. `subagents/grace.ts`、`subagents/task-envelope.ts`：纯函数，原样搬。
2. `subagents/external/dispatch.ts`：`dispatchExternalRun` 原样搬。
3. `subagents/internal/run.ts`：`dispatchInternalRun` 先原样搬入。
4. 在 `internal/run.ts` 内部拆分。原函数的局部状态（`usage`、`assistantTurns`、`toolCalls`、`failureReason`、`budgetExceeded`、`externallyCancelled`、`detached`、`activeModel`、`fallbackNote`）收拢成一个 `InternalRunState` 对象，交给：
   - `internal/worker.ts`：创建 worker 和工具集；
   - `internal/provider-retry.ts`：原 `recoverFromProviderErrors`；
   - `internal/outcome.ts`：原 `runToCompletion` 里的结果组装部分。
   租约释放、取消句柄的安装时机（"在任何 setup I/O 之前"）、等待窗口与 detach 逻辑都留在 `run.ts`，顺序不变。
5. `subagents/dispatch.ts`：`dispatchSubAgentRun`、run 上下文准备、派发选项类型。
6. `tools/subagent.ts`：两个工具的 schema、工厂和 details；`tools/index.ts`、`tools/subagent-manage.ts`、`agent/session-events.ts`、`agent/type-guards.ts` 改为从这里 import。
7. 删除 `subagents/tool.ts`。

完成标准：
- `subagents/tool.ts` 不存在；
- `internal/run.ts` 中的 `dispatchInternalRun` ≤ 150 行，`subagents/` 下没有文件超过 800 行（`runs.ts` 与 `discovery.ts` 除外，见 P5）；
- e2e 的 `subagent-chain`、`subagent-toolset`、`external-run`、`concurrency` 全部通过。

---

## P5 拆 agent 及其余

### P5a `ChannelRunner`（风险最高；每次提交都跑 `test:e2e`）

1. 建 `agent/session/`、`agent/turn/` 两个子目录，用 `move-modules.mjs` 把现有文件搬进去，`type-guards.ts` 改名为 `session/event-guards.ts`（design.md D11 的目录树）。
2. 抽出 `agent/builtin-commands.ts`：内置命令和报告的渲染（只依赖 runner 的只读快照和几个回调）。
3. 抽出 `agent/turn/turn-input.ts`、`turn-context.ts`：都是纯函数或接近纯函数，需要的字段作为参数传入。
4. 抽出 `agent/session/model-selection.ts`：`activeModel`、`primaryFailedAt`、fallback 的解析与恢复、thinking level 的兼容处理。
5. 抽出 `agent/session/session-host.ts`：`session`、`sessionRuntime`、`modelRuntime`、`modelRegistry`、资源加载器、扩展绑定、事件订阅、绑定任务会话或聊天会话、`retire`、`dispose`。`ChannelRunner` 通过它访问当前会话。
6. 抽出 `agent/turn/turn-finish.ts`（原 `finishTurn`），再把 `run()` 改写为按步骤编排。

不变量：`TurnStateMachine` 只由 `ChannelRunner` 持有；`sessionReady` 与 `sessionInitialized` 的语义不变（spec 048 F2）；构造函数里"恢复中断的轮次要在任何东西碰会话之前完成"的顺序不变。

完成标准：`channel-runner.ts` ≤ 600 行；`run()` ≤ 120 行；R3 基线删掉 `channel-runner` 这一项。

### P5b 纯数据抽取

- `subagents/run-record.ts`：补齐类型、常量、`mintRunId` 的纯函数部分、`parseRunRecord`、`createPendingSettlement`/`applyPendingSettlement`。`runs.ts` ≤ 1100 行。
- `jobs/launch.ts`（`buildLaunchScript`、`parseLaunchOutput`）、`jobs/record.ts`（类型、`parseJobRecord`、`toSnapshot`）。`jobs/manager.ts` ≤ 900 行。
- `events/parse.ts`、`events/watcher.ts`（以及可选的 `events/pre-action.ts`），删除 `events/events.ts`。
- R3 基线把 `runs`、`jobs/manager` 的上限更新为新行数（这是唯一允许改基线上限的情况：只能调低），删掉 `events` 这一项。

### P5c 命名收尾

- `models/utils.ts` → `models/reference.ts`（`formatModelReference`、`find*ModelReferenceMatch`、`formatModelList`、`hasKnownModelPricing`）和 `models/runtime.ts`（`createModelRuntime`、`wrapModelRegistry`、`defaultModel`、`resolveInitialModel`）。

### 完成标准

- R3 基线只剩 `subagents/runs.ts`（≤ 1100）、`jobs/manager.ts`（≤ 900）、`subagents/discovery.ts`（1040）。
- `agent/` 根目录不超过 8 个文件。

---

## P6 文档

| 文件 | 改动 |
|---|---|
| `AGENTS.md` | 「Core Structure」改写为 design.md D1 的模块表（职责 / 可以 import / 典型文件），并按 D13 写明 D15 的三项取舍；Engineering Rules 增加三条：一条指向 `npm run arch`，一条讲"新代码放哪里"的判断顺序（先看模块表，再看 D12 的命名约定），一条讲 D10 的工具边界；Practical Notes 中「DingTalk transport commands are handled in the runtime layer」改为指向命令平面（D6） |
| `CLAUDE.md` | Architecture 中的路径更新为新位置；"Transport → agent → delivery flow"一节改用 `dingtalk/`、`runtime/turn-handler.ts`、`commands/router.ts`；模块划分改为引用 AGENTS.md，不再重复一遍；Commands 一节加上 `npm run arch` |
| `docs/architecture.md` | §2「源码地图」按新的目录重写；§3、§4、§12 中出现的路径同步更新 |
| `docs/specs/README.md` | 054 的状态改为"已实施" |
| `design.md` | 状态改为"已实施"，补充「实施记录」 |
| 文件头注释 | design.md D13 列出的那些文件补上 1–3 行职责说明 |
| `CHANGELOG.md`、`CHANGELOG.zh-CN.md` | Unreleased 段落加一条内部重构说明：无行为变化；深层 import 路径已变化，只有 `src/index.ts` 是兼容承诺 |

### 完成标准

- 基线中 R1、R2、R4、R5 都为 0 条，R3 只有 3 个登记文件。
- 一个只读过 `AGENTS.md` 的 Agent，能对下面三个问题给出唯一答案：
  - "新增一个 `/foo` 报告命令"要改哪三个文件？
  - "给记忆加一个工具"的领域逻辑和适配层分别放在哪？
  - "钉钉卡片流式更新的 bug"去哪个文件找？

  （在实施记录里写下答案作为自检。）

# 058 实施计划

> 历史实施计划：术语与目标布局由 [060 Desk](../060-desk/design.md) 接续。原迁移脚本及专用测试已删除；下文相关命令保留为当时实施记录，不再作为操作指引。当前迁移见[一次性说明](../../desk-migration.md)。

设计见 [design.md](./design.md)，决策编号 D1–D23、不变量 INV-1–INV-8 都以它为准。本计划只规定实施顺序、每步改什么，以及什么情况下才算做完。

## 阶段总览

| 阶段 | 交付 | 对应决策 | 风险 |
|---|---|---|---|
| P0 基线与 `src/dot/` | 记录基线数据；新模块 `dot/`（类型、路径、注册表、命令的解析与渲染）、`shared/file-lock.ts`（跨进程锁）及其单测；更新 arch 表。**不接入运行时** | D3、D4、D6（跨进程锁）、D11 | 低 |
| P1 删除 project | 删掉 project 的全部代码、配置、命令、文档、测试；cwd 暂时等于频道目录 | D9 | 低到中 |
| P2 存储模型切换 | `DotRuntime`；runner、记忆、任务、事件、委派、job、传输、用量全部改用 dot 寻址；删除 channelId 的路径转义；启动检查；e2e 夹具迁移与新增用例 | D1、D2、D6–D8、D10–D17、D19、D21 | **高**：核心 |
| P3 `/dot` 命令与动态绑定 | `/dot`、`/dot new`、`/dot bind`；换绑流程、休眠与恢复；CHANNELS.md 的 dot 列 | D5、D6、D8、D17 | 中 |
| P4 TUI | `--dot`、`--create`；能打开任何 dot；会话区锁；TUI 中的 `/dot` | D18 | 低到中 |
| P5 迁移脚本 | `scripts/migrate-to-dots.mjs` 及其测试；在用户数据的副本上演练 | D20 | **高**：数据 |
| P6 文档、playbook 与评测 | 顶层手册、`AGENTS.md`、`CLAUDE.md`、playbooks、053 术语表、changelog、评测探针 | D23 | 低 |
| P7 上线（用户在场） | 在真实的 `~/.pipiclaw` 上迁移、校验、启动，并在钉钉里冒烟 | D20 | 需用户批准 |

依赖关系：

- P0 → P1 → P2 → P3，必须按顺序做。
- P4 依赖 P2，可以与 P3 并行。
- P5 依赖 P2 的目标布局，但脚本本身不 import `src/`，所以 P5 可以从 P2 中途开始写，P3 结束后定稿。
- P6 跟随各阶段同步更新，最后统一收尾。
- **P7 必须由用户明确批准后才能执行。**

---

## 通用规则（每个阶段都适用）

**分支**：在 `feat/dots` 分支上开发，不要直接在 master 上提交。

**阶段闸门**，全部通过才算这个阶段完成：

```bash
npm run check                 # lint + typecheck + arch + deadcode + test
npm run test:e2e              # 会先 build
npm run eval:typecheck
npm run build && node dist/main.js --version
```

**提交纪律**：

- 遵循 conventional commits（`feat:`、`refactor:`、`test:`、`docs:`、`chore:`）。
- 每个提交只做一件可以描述清楚的事。纯改名或搬迁的提交与逻辑提交分开。
- 遵守 CLAUDE.md：**不加 `Co-Authored-By` 之类的署名尾注**。

**测试纪律**：遵守 AGENTS.md 的"Unit-test admission and size control"和 e2e 硬规则。

- 默认不净增用例数。每个新增用例都要说清楚它防的故障模式、为什么现有用例覆盖不到，以及用例数的变化。
- 新增的确定性 e2e 用例必须做 mutation check：故意弄坏被保护的代码，确认用例变红，并把这个过程写进用例注释。
- 删除的测试只能是被删除机制的测试，不能为了压低数量去删别的。
- 每个阶段结束时，在 design.md 末尾「实施记录」里写下用例数的变化：单测和 e2e 各自 before → after，并说明原因。

**偏差处理**：

- 发现计划与代码事实不符时，按 design.md 的原则就地决定，并写进「实施记录」：阶段、偏差、理由。
- 不要为了照搬计划而新增反向依赖、兼容别名或转手文件。
- **遇到设计层面的决定**（会改变用户可见行为或某个不变量的），停下来问用户，不要自行拍板。

**不能改的东西**：

- `src/index.ts` 的导出名称；
- 日志事件名（新增可以；改名要在实施记录中说明）；
- `SubAgentRunManager` 对结算、用量、租约和完成唤醒的独占所有权，以及它的幂等标记；
- 051/052 的等待条件机制。

**测试路径陷阱**：测试里的 `vi.mock("../src/…")` 比 `src/` 内部的 import 多一层 `../`，`tsc` 不会检查这个字符串，要靠 `npm run arch` 的悬空路径检查发现。删除或改名文件之前，先 `rg` 一遍 `test/`。

---

## P0 基线与 `src/dot/`

### 步骤

1. **记录基线**：单测用例数、e2e 用例数、`src/` 文件数和行数，写进「实施记录」。
2. **新建 `src/dot/`**：

   | 文件 | 内容 |
   |---|---|
   | `types.ts` | `DotRecord`、`DotConversationRecord`、`DotBinding`、`BindingsFile`、`DotConversation`、`DotSummary`、`DotAvailability`（`available` / `missing` / `invalid`） |
   | `paths.ts` | `DOTS_DIRNAME = "dots"`、`getDotsDir(workspaceDir)`、`getDotDir(workspaceDir, dot)`、`getConversationDir(dotDir, conversation)`、`getBindingsPath(workspaceDir)`、`isDotName`、`normalizeDotName`（先 trim 再转小写）。正则见 D3 |
   | `registry.ts` | 见下 |
   | `../shared/file-lock.ts`（不在 `dot/` 下） | 见 D6。提供两种形式：短锁 `withFileLock(path, fn, { timeoutMs })`，以及长锁 `acquireFileLock(path)`，后者返回 `{ release() }`，被持有时返回 `{ heldBy }`。用 `open(path, "wx")` 独占创建锁文件，写入 `{ pid, hostname, acquiredAt }`；陈旧判定只针对同主机，用 `process.kill(pid, 0)` 加 `ESRCH` 判断；等待时按退避间隔重试；`release` 只删除自己持有的锁。只依赖 `node:fs`、`node:os`，符合 `shared` 不 import 项目内模块的规则 |
   | `commands.ts` | `/dot` 参数解析（`list` / `new <dot>` / `bind <dot>`，不带参数等于 `list`）、`DotCommandPort` 接口、按 053 文案规则把回复渲染成文本 |

   `registry.ts` 提供的函数：

   - `listDots(workspaceDir)`：列出 `dots/` 下的目录，对每个读取并校验 `dot.json`，返回带可用性的 `DotSummary`；
   - `createDot(workspaceDir, name, now)`：`mkdir` 不带 `recursive`，目录已存在就报错；然后写 `dot.json`；
   - `readDotRecord`；
   - `allocateConversation(dotDir, channelId, kind, now)`：`kind` 是 `"dm" | "group" | "tui"`，由调用方传入；幂等；按 kind 顺序编号；原子写；
   - `loadBindings(workspaceDir)`：文件缺失返回空表；文件损坏抛出带路径的英文错误；
   - `writeBindings`：原子写。

   内部写入走 `shared/serial-queue.ts`，按文件路径串行。

   **dot 不解析频道 id 的格式**：`kind` 由调用方传入，调用方在 runtime 或 tui 层，用 `channel/channel-id.ts` 算出来。这样 dot（layer 2）不需要 import channel（layer 3），频道 id 的格式规则也只在 channel 模块一处。
3. **新建 `src/channel/channel-id.ts`**：
   - `isChannelId`：`dm_`、`group_` 前缀，或者等于 `tui`；不含 `\0`；
   - `channelKind`：返回 `dm` / `group` / `tui`；
   - `conversationTypeOf`：群返回 `"2"`，其他返回 `"1"`。现在 `completion-wake.ts`、`jobs/manager.ts`、`task-driver.ts` 里各有一份 `startsWith("group_") ? …` 的副本，这一步先建好函数，P2 再替换掉这些副本。
4. **arch 表**：`scripts/check-architecture.mjs` 加上 `dot: L01`；`channel`、`memory`、`events`、`jobs`、`subagents` 的允许列表加上 `dot`；`BELOW_TOOLS` 加上 `dot`。`AGENTS.md` 的模块表同步加一行 `dot`。
5. **单测**（新增，均有明确的故障模式）：
   - `test/dot-registry.test.ts`：
     - 名字合法性的边界，一个表驱动用例；
     - `createDot` 遇到重名；
     - `allocateConversation` 重复调用返回同一个目录，并且 dm、group、tui 各自编号；
     - `loadBindings` 在文件缺失和文件损坏两种情况下的行为；
     - `dot.json` 的 `name` 与目录名不一致时判为 `invalid`。
   - `test/file-lock.test.ts`，**用一个真实子进程持锁**：
     - 本进程的 `withFileLock` 等到子进程释放后才进入；
     - 超时后抛错；
     - 子进程被杀以后，陈旧锁被回收；
     - `release` 不删别人的锁。

     这几项防的是跨进程互斥失效。用子进程是因为 AGENTS.md 要求跨进程的结论必须由独立进程来证明。
   - `registry.allocateConversation` 和 `createDot` 的"读、改、写"必须包在 `withFileLock(.locks/dot-json.lock)` 里，`dot-registry` 测试中补一个断言：锁被持有时，分配会等待。
   - `/dot` 的参数解析放进现有的 `test/commands-subcommands.test.ts` 机制：catalog 里的 `subcommands[].example` 会自动喂给解析器。不要另写渲染文案的测试。

### 闸门

通用闸门。`knip` 会把未接入的导出报告为未使用：P0 的导出可以先在 `knip` 配置里**临时**登记为 entry，**P2 结束前必须移除**，并记入实施记录。也可以把 P0 与 P2 的第一步合并到同一个 PR 里。推荐后者。

---

## P1 删除 project

### 步骤

1. **删除文件**：
   - `src/channel/project-scope-store.ts`
   - `src/security/project-scope.ts`
   - `test/project-commands.test.ts`
   - `test/runtime-project-scope-store.test.ts`
   - `test/security-project-scope.test.ts`
2. **`src/security/types.ts`**：
   - `SecurityConfig` 删掉 `projectAccess`；`SECURITY_CONFIG_TOP_LEVEL_KEYS` 同步删掉；
   - `SecurityRuntimeContext` 改为 `{ agentWorkspaceDir; cwd?: string; homeDir? }`。

   `src/security/config.ts`：加载时遇到 `projectAccess` 键，报一条退役键 warn。`RETIRED_SETTINGS_KEYS` 的模式可以参考，但 security 有自己的加载器，在那里实现，并在 `docs/configuration-reference.md` 中登记。
3. **`src/security/path-guard.ts`**：
   - 删掉 `boundary === "project"` 的全部分支，以及 `isWithinProjectRoot`、`isAgentWorkspaceSkillsAccess`、`isChannelDirAccess`；
   - 相对路径的基准从 `ctx.projectRoot ?? process.cwd()` 改为 `ctx.cwd ?? process.cwd()`；
   - 报错原因里不再提 project root；
   - `test/security-path-guard.test.ts` 删掉 `boundary="project"` 那组 describe，其余改用 `cwd`。
4. **`src/tools/index.ts`**：
   - 去掉 `projectScope` 参数，改为 `cwd: string`（P1 时传频道目录，P2 起传 dot 目录）；
   - `projectRoot` 和 `boundary` 的传递全部删掉；
   - 委派的 `workingDirectory` 默认值改为 `cwd`，删除 `projectBoundary`。
5. **`src/subagents/`**：`dispatch.ts`、`types.ts` 删掉 `projectBoundary`。`dispatch.ts` 里对 `workingDirectory` 的规范化（realpath）**保留**，因为租约的 key 依赖它；只删掉"必须在 project root 内"的那条判断。`tools/subagent-manage.ts` 删掉 `assertWithinProjectBoundary` 那一段及 `projectBoundary` 选项。
6. **`src/agent/`**：
   - `channel-runner.ts` 删掉 `projectScope` 字段，以及构造函数里解析 scope 的那一段；
   - `session-host.ts` 的 `cwd: this.projectScope.projectRoot` 三处，全部改为构造参数传入的 `cwd`。
7. **`src/runtime/turn-handler.ts`**：
   - `/new` 里对 project 的解析删掉，`createFreshActiveSession(dir, cwd)` 的 `cwd` 传频道目录（P2 起传 dot 目录）；
   - 删掉 `onScopeChanged`。
8. **命令**：
   - `src/channel/commands.ts` 删掉 `handleProjectCommand`。文件里如果没剩下东西就删除整个文件，并从 `AGENTS.md` 模块表的典型文件列表中去掉 `commands.ts`；
   - `commands/catalog.ts` 删掉 `project`，`BuiltInCommandName` 同步删掉；
   - `commands/router.ts` 删掉 `case "project"`、`runningJobLines` 和 `onScopeChanged`。只有 `/project` 用到的上下文字段一并删除，`runningJobLines` 只被 `/project` 使用；
   - `src/tui/commands.ts` 同步修改。
9. **e2e 测试**：
   - `test/e2e/deterministic/guards.test.ts`：第一个 A19 用例保留"越界写入被拒绝并写入审计"这一半，删掉 `/project set` 那一半；第二个 A19 用例（"/project set 在忙碌时被拒绝"）**留到 P3 改写**成"`/dot bind` 在忙碌时被拒绝"，P1 先删掉，记一笔 e2e 用例数 -1，P3 再 +1；
   - `memory.test.ts` 的 M2 去掉 `projectAccess: true`，断言保持不变；
   - `test/support/runtime-harness.ts` 去掉 `projectAccess`、`projectRootB`。
10. **文档与 playbook 的 project 部分**：`runtime-orientation.md` 删掉 ProjectRoot 和 `/project` 的说法，暂时写"cwd 是频道目录"，P2/P6 改为 dot 目录；`agent-delegation.md` 的默认 `workingDirectory` 同理；`docs/security.md`、`docs/interaction-and-commands.md`、`docs/configuration-reference.md` 删掉 project 相关章节。
11. 用 `rg -n -i "project(Root|Scope|Access|Boundary)|/project|project-scope|boundary: \"project\"" src test docs/*.md AGENTS.md CLAUDE.md` 确认没有残留。保留设计记录（specs）中的历史描述。

### 闸门

- 通用闸门。
- 外加上面第 11 步的检索结果为空（specs 和 archive 除外）。

---

## P2 存储模型切换（核心）

这一阶段改动的是布局本身，中间状态无法交付，所以**作为一个整体合并**。但内部按下面的顺序分成多个提交，每个提交至少通过 `npm run typecheck && npm run arch` 和本步涉及模块的单测；e2e 在 2.10 之后统一跑通。

### 2.1 `DotRuntime` 与启动

**新增 `src/runtime/dot-runtime.ts`**，提供：

- `load()`：读绑定表；
- `resolve(channelId)`：返回 `{ kind: "bound"; conversation: DotConversation }`、`{ kind: "unavailable"; dot; reason }` 或 `{ kind: "unbound" }`；
- `isBoundTo(channelId, dot)`；
- `activeDots()`；
- `activate(dot)`、`deactivate(dot)`：每个 dot 一个串行队列，见 D6；
- `sendFromDot(dot, channelId, text)`；
- `create(name)`、`bind(channelId, name)`：P3 实现，P2 先留接口；
- `shutdown()`：停掉所有 watcher。

激活时调用的协作方（恢复扫描、watcher 工厂）都以构造参数注入，便于单测。

**`bootstrap.ts`**：

- 在 `jobs.restore()` 和 `runs.restore()` 之前构建 `DotRuntime`；
- job 和 run 的恢复**与绑定无关**：启动时遍历 `state/jobs/` 和 `state/subagent-runs/` 下的每个 dot 目录，逐个执行 `jobs.restore(dot)`、`runs.restore(dot)`。dot 名就是目录名，不需要反查（D6）；
- 启动时依次激活每个已绑定的 dot；
- `scanWorkspaceForInterruptedTurns` 改为在 `activate` 里对该 dot 中已绑定的会话区执行，见 2.2；
- 删除 `migrateTasksToV5` 的调用。

**启动检查（D21）**：新增 `runtime/legacy-layout.ts`，提供 `assertNoLegacyLayout(paths)`。在 `createRuntimeContext` 最前面调用，**TUI 启动时也调用**。

**删除**：`src/runtime/task-migration.ts`、`test/task-migration.test.ts`、`test/task-migration-faults.test.ts`、`scripts/rehearse-task-migration.mjs`，以及它们在文档里的引用。单测预计减少 30 例。

**单测 `test/dot-runtime.test.ts`**，用注入的假协作方：

- 激活时启动 watcher 并加入扫描集合，休眠时停掉 watcher 并移出集合；激活和休眠交错时，以最后一次操作为准（P3 补齐）；
- `sendFromDot` 在绑定不符时不发送。

预计新增 2–3 例，故障模式分别是：休眠与激活竞争导致 watcher 泄漏或丢失、跨 dot 投递。

### 2.2 runner、会话与会话区

- **`agent/types.ts` 的 `RunnerFactoryPaths`** 加上 `workspaceDir`。`createRunner(conversation: DotConversation, paths)` 和 `ChannelRunner` 的构造函数改为接收 `DotConversation`，字段改为 `dot`、`dotDir`、`conversationDir`、`channelId`。`workspaceDir` 从 paths 来，**删掉 `dirname(channelDir)`**。
- **`SessionManager.open(join(conversationDir, file), conversationDir, dotDir)`**：第一个参数是会话文件路径，第二个是 sessionDir，第三个是 cwd。`SessionHost` 的 `cwd` 改为 `dotDir`；`taskSessionPath` 改用 `dotDir`。
- **`channel/active-session-store.ts`**：所有参数改名为 `conversationDir`，逻辑不变。
- **`skills/loader.ts`**：`loadPipiclawSkills(workspaceDir)`，所有调用方同步修改。
- **`agent/maintenance-context.ts`**：`loadDetachedMaintenanceContext({ conversation, workspaceDir, … })`，从会话区加载会话。
- **`agent/turn/turn-recovery.ts`**：
  - `scanWorkspaceForInterruptedTurns` 改为 `scanConversationsForInterruptedTurns(conversations: DotConversation[])`，由 `activate` 调用；
  - 删除 `CHANNEL_DIR_PREFIXES`；
  - `test/turn-recovery.test.ts` 改用新的签名，用例数不变。
- **`agent/turn/*`**：其中的 `channelDir` 按语义拆成 `dotDir`（记忆、任务、tasks digest）和 `conversationDir`（会话相关）。
- **`renderChannelTurnContext`** 改名为 `renderDotTurnContext(conversation, channelName)`，内容见 D16：只写当前 dot 和当前频道，**不列出其他绑定频道**。频道名称由运行时通过回调提供：`agent` 可以 import `channel`，名称来自 channel index 的内存视图。
- **`bootstrap.ts` 的 `getRunner(channelId)`**：先 `dotRuntime.resolve(channelId)`；结果不是 `bound` 就**不建 runner**，由调用方处理，见 2.7。runner 缓存的 key 仍然是 `channelId`。

### 2.3 记忆

- **队列**：`memory/channel-maintenance-queue.ts` 改名为 `memory/dot-memory-queue.ts`，`ChannelMemoryQueue` 改名为 `DotMemoryQueue`。**所有 `queue.run(...)` 的 key 改为 dot 名**，包括 `lifecycle.ts`、`reflect-job.ts`、`tools/memory-manage.ts`、`memory/commands.ts`。改完用 `rg -n "\.run\(options\.channelId|\.run\(input\.channelId|\.run\(this\.options\.channelId" src` 确认为空。
  - `DotMemoryQueue.run(dot, job)` 的实现：先过进程内串行队列，再在其中 `withFileLock(<dotDir>/.locks/memory.lock, job)`。因此 `run` 的参数要能拿到 `dotDir`，比如改为 `run(conversationOrDot, job)`，签名由实施者定。
  - 补一个单测：另一个进程持有 `memory.lock` 时，`run` 会等待。可以复用 `file-lock` 测试里的子进程夹具。故障模式是记忆队列漏接跨进程锁，daemon 和 TUI 并发写坏同一个 dot 的记忆。
- **维护状态**：`memory/maintenance-state.ts` 的路径改为 `state/memory/<dot>/<conversation>.json`，删掉 `getChannelDirName`。`createMemoryActivityRecorder` 的事件里带上 `dot` 和 `conversation`。
- **调度器**：
  - `memory/scheduler.ts`：`MemoryMaintenanceRuntimeContext` 改为 `{ conversation: DotConversation; workspaceDir; messages; sessionEntries; model; resolveApiKey; settings }`；
  - 候选来自注入的 `getConversations(): DotConversation[]`，由运行时提供：所有激活 dot 中当前绑定的会话区；
  - 删除 `listStateChannels`、`discoverMemoryMaintenanceChannels`；
  - `isChannelActive` 仍然按频道判断。
- **reflect job**：`memory/reflect-job.ts` 和 `reflect.ts` 改为接收 `conversation`。写记忆用 `dotDir`，用量上下文带上 `dot` 和 `channelId`。
- **会话检索**：`memory/session-corpus.ts` 改为遍历 `dotDir/conversations/*/` 下的会话 jsonl 和 `log.jsonl*`，文档带上 `conversation` 标签；`session-search.ts` 的缓存 key 改用 `dotDir`；`tools/session-search.ts` 的结果标注来源会话区，名称由运行时提供。
- **其余**：`memory/store.ts`、`journal.ts`、`review-log.ts`、`commands.ts` 的参数统一改名为 `dotDir`。
- **测试**：`test/memory-maintenance-scheduler.test.ts`、`test/memory-reflect-job.test.ts` 等改用新签名。删掉针对 escaped-id 去重的用例（被删除的机制），记一笔用例数减少。

### 2.4 任务

- **frontmatter**：
  - `tasks/frontmatter.ts`：`TaskFrontmatter.channel?: string`；解析时读 `channel:`，trim 之后为空就当作 undefined；
  - `FIELD_ORDER` 改为 `["state", "paused", "channel", "origin", "ticket", "usage", "budget"]`；
  - 归档分支也输出 `channel`；
  - **扩展**现有的 frontmatter 往返测试，不新增文件。
- **全部 `channelDir` 参数改名为 `dotDir`**，范围是 `tasks/` 下所有文件（`store.ts`、`create.ts`、`contract.ts`、`board.ts`、`brief.ts`、`loop-log.ts`、`bound-work.ts`、`mutation-lock.ts`、`steer.ts`、`commands.ts`、`session-path.ts`）。`session-path.ts` 的注释写明 dot 目录。
- **任务修改跨进程串行**（`tasks/mutation-lock.ts`）：`withTaskMutation` 在进程内的可重入队列之内，再加一层 `withFileLock(<dotDir>/.locks/task-<id>.lock)`。可重入时（AsyncLocalStorage 里已经持有这个 key）两层都跳过。
  - 核对 `store.ts` 里的 `redeemTicket`、`expireTicket`、`pauseTask`、`resumeTask`，`bound-work.ts`，`steer.ts`，以及工具和命令的修改路径，确认全部经过 `withTaskMutation`。漏掉的补上，并写进实施记录；
  - 文件头那句"one process per workspace"改为说明跨进程锁；
  - 补一个单测：另一个进程持有该任务的锁时，修改会等待。
- **创建任务**：`tasks/create.ts` 的 `createTaskDocument` 新增**必填**参数 `channel: string`。
  - `tools/task-manage/create.ts` 传当前回合的 `channelId`；
  - `runtime/task-spawn.ts` 传请求里的 `channelId`，也就是事件的投递频道。
- **task driver**（`runtime/task-driver.ts`）：
  - 删除 `discoverTaskChannels`；
  - 遍历注入的 `getActiveDots(): { dot; dotDir }[]`；
  - `channel` 缺失或未绑定在本 dot 上（注入 `isBoundTo`）的任务，**从本次扫描中完全排除**，`maintain`、预算检查、空转检测、派发都不做，并且在进入挂起状态时记一次 info 日志（`taskdriver.task.suspended`）；
  - 派发前检查的忙碌状态，是投递频道的忙碌状态；
  - `createTaskDriverEvent(dot, channelId, entry, now)` 和 `taskStopReceipt` 带上 `dot`，dispatch id 改为 `task:<dot>:<id>:…`；
  - 删掉 `channelType()` 的副本，改用 `conversationTypeOf`；
  - `lastDispatchedTaskId` 改为以 dot 为 key，`attemptKey` 改为 `(dot, taskId)`；
  - `test/task-driver.test.ts` **扩展**一个用例：投递频道未绑定时，整个任务被冻结，包括到期的 `time` 等待条件也不兑现；重新绑定后照常推进。故障模式是挂起的任务被继续推进或继续发回执。
- **准入后的任务步骤**（`runtime/turn-run.ts`）：
  - `prepareTaskStep` 和 `finishTaskStep` 用 runner 的 `dotDir`；
  - `prepareTaskStep` 断言 `event.dot === runner.dot`，不相等就退回聊天路径，并记 warn；
  - `/tasks` 的 `dispatchTask` 闭包（`turn-handler.ts`）用 `dotDir`，dispatch id 带上 dot。
- **`/tasks` 渲染**（`tasks/commands.ts`）：
  - 接收 `currentChannelId` 和 `describeChannel(id) => { name; boundHere: boolean }`；
  - 投递频道不是本频道时，显示投递频道名称；
  - `boundHere === false` 时标注"已暂停：投递频道未绑定到本 dot"；
  - `/tasks doctor` 报告缺少 `channel` 的任务；
  - 只断言结构，不断言具体文案。
- **委派的任务说明**（`subagents/task-envelope.ts`）：改为 "Dot directory"，任务路径改用 `dotDir`。

### 2.5 事件

- **watcher**：`events/watcher.ts` 的 `EventsWatcher` 已经是每个目录一个实例。`createEventsWatcher` 改为接收 `{ dot, dotDir, … }`，事件目录为 `dotDir/events`。
- **触发时检查**：
  - 触发时调用注入的 `isBoundTo(event.channelId)`；不满足时写一条 `skipped` 的 history，reason 为 `channel_not_bound`，不派发、不生成实例；
  - `eventDispatchId` 改为 `event:<dot>:<name>:…`；
  - 合成事件带上 `dot`；
  - history 记录新增 `dot`。
- **`events/types.ts`**：
  - `SpawnTaskRequest` 增加 `dot`，`EventHistoryRecord` 增加 `dot?`；
  - `OneShotEvent` 和 `PeriodicEvent` 的 `channelId` 保持必填，注释改为"投递频道"。
- **`events/validation.ts`**：去掉"cross-channel channelIds"相关的校验（如果有），绑定检查只在触发时做。
- **`tools/event-manage.ts`**：目录改为 `dotDir/events`；`channelId` 绑定为当前频道（行为不变）；列表只看本 dot。
- **`events/commands.ts`**：
  - `/events` 改为接收 `dotDir` 和本 dot 的 history 过滤条件；
  - list 和 show 中，对 `channelId` 未绑定在本 dot 上的事件标注已暂停，判断依据由运行时注入；
  - 现有的 history 读取改为按 `dot` 过滤。迁移前的历史记录没有 `dot` 字段，按 `channelId` 属于本 dot 的会话区登记来兜底。
- **`runtime/task-spawn.ts`**：`getChannelDir` 改为 `getDotDir(dot)`；跳过回执改走 `dotRuntime.sendFromDot`。
- **`bootstrap.ts`**：不再创建单一的 watcher，由 `DotRuntime.activate` 创建、`deactivate` 停止，并通过注入的工厂来做，便于 e2e 的 `createEventsWatcher` 选项继续生效。
- **测试**：events 的 watcher 单测**扩展**一个用例：投递频道未绑定时写 `skipped` 且不派发。故障模式是挂起的 dot 仍在向别的 dot 的频道派发。

### 2.6 委派与后台 job

- **run 注册表**：
  - `subagents/run-registry.ts` 的 `get(dot)`、`restore(dot)`。启动时不再全局扫描，由 `activate` 调用；
  - 删除 `listRecordChannelIds`；
  - 按 dot 恢复时，用 `join(stateDir, dot)`；
  - GC 定时器仍然遍历所有已创建的 manager。
- **`subagents/runs.ts`**：
  - `SubAgentRunManager` 的构造参数从 `channelId` 改为 `{ dot, dotDir }`；
  - `recordDir()` 改为 `join(stateDir, dot)`，删掉 `getChannelDir`；
  - 注册 run 时，记录里的 `channelId` 来自调用方（发起委派的回合所在的频道），artifact 目录在 `dotDir` 下。
- **完成唤醒**（`subagents/completion-wake.ts`）：
  - 事件带上 `dot`，dispatch id 改为 `subagent:<dot>:<runId>:done`，删掉 `startsWith("group_")` 的副本；
  - 生产前调用注入的 `isBoundTo(record.channelId, dot)`。不满足时**不派发，但把 `wakeEnqueued`（或同名的幂等标记）置位**，并记 info 日志 `subagent.wake.suppressed`；
  - 任务绑定 run 的 `settle` 记录和 `work` 等待条件的兑现**不受影响**：先确认它们在唤醒之前已经完成，或者与唤醒无关，并写进实施记录。
- **job**（`jobs/manager.ts`）：
  - `ChannelJobManager` 改名为 `DotJobManager`，构造参数为 `{ dot, dotDir }`；
  - 每条 job 记录带 `channelId`（发起方），记录格式加这个字段；旧记录由迁移脚本补上；
  - 状态目录为 `join(jobsStateDir, dot)`，这也修掉了 D10 提到的 bug；
  - spill 目录为 `dotDir/logs`；
  - 唤醒的处理与 run 相同；
  - `createJobRuntime` 的 `get(dot)`、`restore(dot)`、`runningLines(dot)`。
- **`bootstrap.ts` 中 run 的 `notify`** 改走 `dotRuntime.sendFromDot`。`RunNotifier` 的签名带上 `dot`。
- **`tools/index.ts`**：委派的默认 `workingDirectory` 为 `dotDir`。

### 2.7 频道、传输与准入

- **`ChannelEvent`**（`channel/channel-event.ts`）：新增 `dot?: string`，并写好注释：所有进程内生产者必须填写；钉钉入站解析永远不会写它。
- **`runtime/durable-dispatch.ts`**：
  - `dispatch()` 遇到没有 `dot` 的事件，返回 `false` 并记 warn `dispatch.event.missing_dot`；
  - `parseRecord` 不强制要求 `dot`，这样旧记录可读，由准入检查兜底；
  - `cancelChannel`、`absorbPending` 等按频道的逻辑保持不变；
  - 单测**扩展**一个用例覆盖拒绝。
- **准入**（`runtime/turn-run.ts` 的 `runEventTurn`）：
  - 在 `getRunner` **之前**解析绑定。
  - 合成事件（带 `dispatchId`）满足以下任一条件时，`markCompleted` 并记 `dispatch.wake.dot_mismatch`，**不调用模型**：没有 `dot`；频道未绑定；频道绑定的 dot 不等于 `event.dot`。
  - 人发的消息：
    - 频道未绑定时，只有 `/dot` 和 `/help` 能执行（`/dot` 在 P3 实现，P2 先只放行 `/help`），其余回复"未绑定"提示（D4）；
    - 频道不可用时，回复不可用的原因；
    - 两种情况都不归档、不建 runner。
- **`runtime/turn-handler.ts`**：
  - `isRunning`、`handleStop`、`handleBusyMessage`、`handleNewSession`、`reserveEvent` 中所有调用 `getRunner` 的地方，都先处理未绑定的情况：
    - `reserveEvent` 遇到未绑定频道时什么都不做（不 `beginTurn`），这样 `endTurn` 也不会被调用；
    - `handleNewSession` 回复提示；
    - `handleStop` 已经用 `channelRunners.get`，没有 runner 时自然什么都不做。
  - `pauseStoredTask` 用 runner 的 `dotDir`。
  - `persistInboundImage` 改为解析绑定后存到 `dotDir/inbox`，未绑定时返回 `null`。
- **`runtime/inbound-images.ts`**：参数改为 `dotDir`；`relativeImagePaths` 相对于 `dotDir`。
- **`dingtalk/conversation-meta.ts`**：
  - 改为单文件 `state/dingtalk/conversations.json`，加载一次后缓存在内存；
  - `set` 只在内容变化时同步原子写；
  - 删掉 `getChannelDir`；
  - `DingTalkConfig.stateDir` 的语义改为 app 的 state 目录。核对 `bootstrap.ts` 里 `dingtalkConfig.stateDir = paths.workspaceDir` 这一行及其他使用者，统一改为 `join(appHomeDir, "state")`。
- **`channel/store.ts`（ChannelStore）**：
  - 构造参数改为 `{ resolveArchiveDirs(channelId): { conversationDir: string; dotDir: string } | undefined }`；
  - `log.jsonl` 写入 `conversationDir`，`subagent-runs.jsonl` 写入 `dotDir`；
  - 解析不到时跳过，并记一次 debug 日志。
- **`channel/channel-index.ts`**：
  - 删除 `discoverWorkspaceChannelIds`、`readChannelIndexIds`、`DiscoverOptions`；
  - 渲染时增加「dot」列，由注入的 `getBoundDot(channelId)` 提供；
  - 解析时兼容旧的四列格式（迁移后第一次写盘会补上新列）；
  - 暴露一个只读的内存名称视图 `nameOf(channelId)`，供 `/dot list`、turn capsule、`/tasks` 使用；
  - `test/channel-index.test.ts` 里删掉 discovery 的用例，**扩展**解析用例以覆盖四列转五列。
- **删除 `channel/channel-paths.ts` 和 `test/channel-paths.test.ts`**。
- **`agent/maintenance-context.ts`** 等地方剩下的 `getChannelDir` 引用全部清掉。

### 2.8 用量

- `usage/ledger.ts`：`UsageLedgerEntry.dot?: string`。所有 `record()` 调用方补上 `dot`：turn、subagent、sidecar 都能从上下文拿到。查询时可以按 `dot` 过滤。
- `usage/render.ts` 和 `/usage`：统计范围改为本 dot（D19）。`byChannel` 保留，用来在 dot 内部按频道拆分显示，具体是否显示由实施者按 053 的长度预算决定。

### 2.9 router 与命令上下文

`commands/router.ts` 的 `ReportCommandContext` 改为携带：

- `conversation: DotConversation`；
- `describeChannel`；
- `isBoundHere`；
- `dotRuntime` 端口（P3 用）。

`getChannelDir` 删掉，各个 `case` 改用 `conversation.dotDir`。频道未绑定时，router 只会收到 `/dot` 和 `/help`（2.7 已经拦截），所以其余 case 可以假定 `conversation` 存在。类型上用联合类型表达这一点，不要用 `!` 断言。

### 2.10 e2e 夹具与用例

- **`test/support/runtime-harness.ts`**：
  - 删掉本地复制的 `getChannelDirName`；
  - 夹具默认创建 dot `e2e`，写 `dots/bindings.json`，把 `dm_e2e_user` 绑定到它；
  - 对外暴露 `dotDir`、`conversationDir`、`channelId`、`dot`；
  - 提供 `bindChannel(channelId, dot)`（直接写绑定表，P3 起改为走命令）和 `createDot(name)`；
  - 支持第二个频道：`sendUserMessage(text, { channelId })`，以及 `createDeterministicHarness({ extraChannels })`。
- **现有 e2e 用例**：所有用到 `harness.channelDir` 的地方，按语义改为 `dotDir` 或 `conversationDir`。只改路径，不改断言。
- **新增确定性 e2e 用例**，每条都要做 mutation check 并写进注释：

  | 用例 | 防的故障 | 断言（只看副作用） | mutation |
  |---|---|---|---|
  | DOT-1：同一个 dot 下的两个频道共享记忆，会话彼此隔离 | 会话区串了，或者记忆没有共享 | 频道 A 调用 `memory_save` 后，频道 B 首回合发给 provider 的请求包含该事实；B 的请求消息里不含 A 的任何用户文本 | 两个频道共用一个会话区目录，用例变红；把首回合注入改用会话区目录，用例变红 |
  | DOT-2：同一个 dot 下的记忆写入以 dot 为键串行 | 记忆队列仍以频道为键，两个频道并发写坏记忆 | 用 `hold` 卡住 A 会话区的 reflect（sidecar 请求 `arrived`），这时 B 执行 `memory_save`；断言 B 的工具结果在 `release` 之后才到达 provider，并且最后两条事实都在 `MEMORY.md` 里 | 把 `memory-manage.ts` 的 key 改回 `channelId`，用例变红 |
  | DOT-3：投递频道换绑后，后台工作挂起，在途唤醒被拒 | 换绑后旧 dot 的结果投到了新 dot 的会话里，或者挂起的任务继续推进 | 预先放一条带 `dot: X` 的 dispatch 记录，然后把频道绑到 Y；断言该频道的模型请求数为 0，记录被标记为 completed；X 中以该频道为投递频道的 open 任务不派发；绑回 X 后任务步骤被派发 | 删掉准入检查，用例变红；删掉 task driver 的绑定检查，用例变红 |
  | DOT-4：未绑定频道不调用模型，也不创建任何文件 | 退化成自动创建 dot 或频道目录 | 未绑定频道发一条消息：模型请求数为 0；`dots/` 下没有新增目录；`bindings.json` 不变；收到一条回复 | 未绑定时退回到自动创建，用例变红 |

  e2e 用例数变化：+4（DOT-1 至 DOT-4）。P1 的 -1 由 P3 的 +1 抵消（A19 改写）。DOT-1 可以与 `memory.test.ts` 的 M2 合并，把 M2 的"跨 project 边界"换成"跨频道"，这样净增为 +3，**推荐这样做**。
- **`restart.test.ts`**：扩展现有的独立进程重启用例，让它带上绑定表，验证重启后 dot 被重新激活、job 和 run 按 dot 恢复。不新增用例。

### P2 闸门

- 通用闸门全绿。
- **INV-3 检索**，以下命令都应当返回空（specs 和 archive 除外）：

  ```bash
  rg -n "getChannelDir|getChannelDirName|ensureChannelDir|dedupeChannelIdsByDirectory|discoverWorkspaceChannelIds|channel-paths" src test
  rg -n "join\([^)]*channelId" src
  rg -n "\.run\((options|input|this\.options)\.channelId" src
  ```

- `rg -n "channelDir" src` 剩下的结果逐个确认：要么是会话区之类的地址层概念，要么已经改名，并把确认结论写进实施记录。目标是 `src/` 中不再出现 `channelDir` 这个名字。
- 实施记录写清：单测和 e2e 的用例数变化；D16 中 SDK 基于 cwd 的发现路径的核对结论。

---

## P3 `/dot` 命令与动态绑定

### 步骤

1. **命令注册**：
   - `commands/catalog.ts` 增加 `dot`：`argumentHint: "[list|new <dot>|bind <dot>]"`，`availableWhileBusy: true`，有 `subcommands` 和 examples；
   - `BuiltInCommandName` 加上 `"dot"`；
   - `commands/router.ts` 增加 `case "dot"`，交给 `dot/commands.ts` 的 `handleDotCommand(args, port, ctx)`。
2. **`DotRuntime.create(name)`**：规范化名字，校验，然后调用 `registry.createDot`。创建出来的 dot 不激活，没有绑定的 dot 本来就处于休眠状态。
3. **`DotRuntime.bind(channelId, name)`**：严格按 D5 的 7 步实现。
   - 第 5 步的 runner 处理要复用 `/new` 已有的那套缓存移除与释放逻辑（`channelRunners.delete` 之后 `await dispose()`），不要另写一套；
   - 返回的 `BindOutcome` 包含 `{ kind: "bound" | "same" | "busy" | "unknown" | "invalid"; previousDot?; previousDotDormant?; suspendedTasks?; suspendedEvents? }`；
   - 挂起任务和事件的计数来自读取旧 dot 的任务和事件文件，只做只读统计。
4. **休眠与恢复**：
   - `deactivate(dot)` 只停 watcher、移出扫描集合，不等待也不释放正在运行的 run 和 job（D6）；
   - `activate` 和 `deactivate` 在同一个 dot 的串行队列里执行，所以交错调用时以最后一次为准。
5. **未绑定频道的命令**：2.7 里先放行的 `/help` 之外，加上 `/dot`。
6. **CHANNELS.md**：绑定变化时调用 `channelIndex.markStructural(channelId)` 或同等机制，立即重写，让「dot」列反映新的绑定。
7. **e2e**：
   - guards.test.ts 的第二个 A19 改写为"`/dot bind` 在忙碌时被拒绝"：通过直接执行运行时命令的路径发出 `/dot bind`，断言 `bindings.json` 不变，并且后续回合仍在原来的 dot。mutation：去掉忙碌检查，用例变红。这一例抵消 P1 的 -1。
   - DOT-3 改为通过 `/dot bind` 命令换绑（原来是夹具直接写绑定表），并补上断言：绑定后频道的下一回合在新 dot 的会话区里。
8. **单测**：`test/dot-runtime.test.ts` 补齐：
   - bind 的各种结果分支（`same`、`busy`、`unknown`）；
   - 绑定写入失败时，runner 不被释放；
   - 绑定已提交后 dispose 失败，不回滚绑定。

   这里**不要**为每条回复文案写测试，文案形状由 `test/user-copy-shape.test.ts` 结构化覆盖，把 `/dot` 的回复样本加入它的样本集即可。

### 闸门

通用闸门。

---

## P4 TUI

### 步骤

1. **`tui/app.ts`**：
   - `--channel` 改为 `--dot <name>`，必须提供；增加 `--create`；
   - 启动顺序：`assertNoLegacyLayout` → 读取 dot（不存在且没有 `--create` 就报错并列出已有 dot）→ 为频道 `tui` 分配会话区（走 `dot-json.lock`）→ 用 `acquireFileLock` 获取会话区锁 `conversations/tui-N/.lock`（被另一个 TUI 持有时报错退出，错误里给出 pid）→ 构造 runner → 退出时释放会话区锁，包括 SIGINT 的退出路径；
   - **不检查 dot 是否已绑定，也不检查 daemon 是否在运行**（D18）；
   - jobs 和 runs 用 `get(dot)`，仍然不落盘（现状不变）；
   - TUI 不启动 task driver、事件 watcher 和记忆调度器（现状不变）。实施时核对一遍，并写进实施记录。
2. **`tui/commands.ts`**：
   - `/dot list` 和 `/dot new` 通过 `DotCommandPort` 的 TUI 实现执行，`/dot bind` 返回不支持；
   - TUI 的端口实现直接用 `dot/registry.ts`；
   - 名称来源：TUI 没有运行中的频道索引，所以由 `channel-index` 提供一个只读加载函数，读一次 CHANNELS.md。
3. **e2e**：`tui-command.test.ts` 改用 `--dot`。跨进程互斥由 `file-lock` 单测（真实子进程）覆盖，不新增 e2e。
4. **文档**：`docs/deployment-and-operations.md` 的 TUI 一节。

### 闸门

通用闸门；并手工跑一次 `pipiclaw tui --dot <x> --create`，在其中执行 `/dot` 和一次普通对话。

---

## P5 迁移脚本

### 步骤

1. **编写 `scripts/migrate-to-dots.mjs`**，严格按 D20 实现。
   - **零依赖，不 import `src/` 或 `dist/`**。旧的转义规则（`/` 替换为 `__`）在脚本里自己实现，用于识别旧目录名，并在代码注释里写明"仅用于识别旧布局"。
   - 结构上拆成纯函数：盘点（inventory）、规划（plan）、执行（apply）、校验（verify），便于测试和 `--dry-run`。`--dry-run` 输出的就是 plan 的完整内容。
   - 输出给部署者看，用英文；报告用 JSON。
2. **测试 `test/migrate-to-dots.test.ts`**：在临时目录里构造一个旧布局的 home 夹具，用 `node` 子进程运行脚本。

   | 用例 | 防的故障 |
   |---|---|
   | 完整迁移：DM 加含 `/` 的群（真实 id 只能从 `.channel-meta.json` 还原）加 TUI 目录；断言 dot 目录、会话区、`bindings.json`、`dot.json`、事件归位、任务带上 `channel`、各状态目录归位、dispatch 记录补上 `dot`、用量补上 `dot`、绝对路径改写，以及边界规则（`dm_162403` 不误伤 `dm_1624031`），最后 `--verify` 通过 | 迁移后数据丢失或错位，或者路径改写误伤 |
   | 有遗漏的旧目录时拒绝，并且一个字节都不写 | 半迁移的状态 |
   | 真实 id 有歧义或无法还原时拒绝 | 绑定到一个伪造的频道 id |
   | 缺少 `task-migration-v5.done` 时拒绝 | 在 v3 任务上执行迁移 |
   | `--dry-run` 不写任何文件，并且打印的计划包含每一项移动 | 演练时意外写盘 |
   | `--verify` 能发现残留的旧路径和未归位的事件 | 校验形同虚设 |

   单测用例数 +6，这些都是数据完整性方面的用例，AGENTS.md 明确要求保留这类测试。
3. **在用户数据的副本上演练**，源数据只读：

   ```bash
   cp -a ~/.pipiclaw /tmp/<scratch>/pipiclaw-copy
   node scripts/migrate-to-dots.mjs --home /tmp/<scratch>/pipiclaw-copy --dry-run   # 先看计划
   ```

   映射关系（哪个目录叫什么名字）**由用户决定**：把 `--dry-run` 的盘点结果给用户看，请用户给出 `--map` 和 `--drop`。拿到之后在副本上正式执行，然后运行 `--verify`，并执行 `PIPICLAW_HOME=<副本> node dist/main.js tui --dot <x>` 核对记忆、任务和事件。**不要在副本上启动 daemon**，它会连上钉钉。把演练报告写进实施记录。
4. **文档**：`docs/deployment-and-operations.md` 增加迁移一节，内容包括前置条件、命令、备份位置、失败时如何恢复、`--verify`。

### 闸门

- 通用闸门。
- 演练报告完成，包括真实副本上的 `--verify` 结果，并已交给用户确认。

---

## P6 文档、playbook 与评测

### 步骤

1. **顶层手册**：按 D23 的清单逐个更新，只写当前行为。spec 中的历史描述不改。
2. **`AGENTS.md`**：
   - Project 描述中的 "per-channel workspaces" 改为 dot；
   - Runtime Model 一节改写为三层：workspace 级、dot 级、会话区级文件；
   - 模块表在 P0 已加 dot，这里核对一遍；
   - Engineering Rules 中提到 channel 的地方核对一遍，比如"Keep `SubAgentRunManager` …"。
3. **`CLAUDE.md`**：
   - Architecture 中的 transport → agent → delivery 流程补上"先解析绑定"一步；
   - Concurrency 一节写明：记忆队列以 dot 为键；记忆、任务和 `dot.json` 的跨进程短锁；TUI 的会话区锁；daemon 和 TUI 可以同时使用同一个 dot；
   - Long-horizon tasks 一节写明 `channel` frontmatter 和挂起；
   - Memory 一节改为 dot 记忆；
   - Delegation 一节写明 manager 按 dot、默认工作目录；
   - Config & state 一节写明 `dots/` 和 `state/dingtalk/`；
   - 删除 `/project` 和 project scope 的全部提法；
   - `ChannelJobManager` 改为 `DotJobManager`。
4. **playbooks**：`runtime-orientation.md`、`agent-delegation.md`、`memory-and-learning.md`、`event-scheduling.md`、`task-lead.md`，改动点见 D23。改完运行 `npm run playbooks:measure`，确认没有超出预算。
5. **评测**：
   - 运行 `npm run eval -- plan --changed-since <P0 之前的提交>`；
   - 有凭据时跑受影响的 dev 用例，把 run id、失败项和归因写进实施记录；
   - 没有凭据或无法执行时如实记录，**不得当作通过**；
   - 如果改动了 `evals/`，还要运行 `npm run test:evals`。
6. **其他**：
   - `docs/specs/053-user-facing-copy/design.md` 的 D4 术语表追加"dot""绑定""投递频道"；
   - `docs/specs/README.md` 把 058 的状态改为"已实施"；
   - `CHANGELOG`（如果仓库有）记录：新增 dot；删除 `/project`；cwd 变化；需要运行迁移脚本。

### 闸门

- 通用闸门。
- `npm run arch` 的文档路径检查通过：文档里出现的路径都真实存在。

---

## P7 上线（必须由用户批准并在场）

1. 用户停掉 daemon。
2. 运行 `node scripts/migrate-to-dots.mjs --home ~/.pipiclaw --map … --drop …`，映射关系使用 P5 中用户确认过的那一份。
3. 运行 `--verify`。
4. 安装新版本（`scripts/install.sh`），然后启动 daemon。
5. 在钉钉里冒烟：
   - 私聊里 `/dot` 能列出 dot；
   - 能读到已有的记忆；
   - `/tasks`、`/events` 能看到已迁移的任务和事件；
   - `/dot new test-dot` 之后，在一个测试群里 `/dot bind test-dot`，确认新群回复正常，原私聊不受影响；
   - 在测试群里 `/dot bind <私聊的 dot>`，确认两边记忆共享、会话彼此隔离。
6. 出现问题时，停掉 daemon，从 `~/.pipiclaw/backups/pre-dots-<时间戳>/` 恢复 `workspace/` 和 `state/`，再装回旧版本。

---

## 验收清单（全部阶段完成后）

| 项 | 依据 |
|---|---|
| G1 同一个 dot 下两个频道记忆共享、会话隔离 | DOT-1 |
| G2 任何入站消息和后台服务都不会创建 dot 或频道目录 | DOT-4；INV-2 |
| G3 任务、事件、run、job 都显式记录投递频道；准入检查拒绝跨 dot 的投递 | DOT-3；`dispatch.event.missing_dot` 单测 |
| G4 INV-3 检索为空；`channel-paths.ts` 已删除 | P2 闸门 |
| G5 project 检索为空；`security.json` 里的 `projectAccess` 只产生 warn | P1 闸门 |
| G6 迁移脚本的测试全部通过；真实副本上的演练报告与 `--verify` 通过；上线步骤执行完毕 | P5、P7 |
| INV-6 daemon 和 TUI 可以同时使用同一个 dot（包括已绑定的）；共享写入的文件经跨进程锁串行；第二个 TUI 打开同一个 dot 时被会话区锁拒绝 | `file-lock` 单测（子进程）；记忆队列和任务修改的持锁用例；P4 手工验证：daemon 运行时，用 TUI 打开一个已绑定的 dot 并写一条记忆 |
| INV-8 记忆写入以 dot 为键串行 | DOT-2 |
| 用例数变化在实施记录中有逐阶段的说明 | 实施记录 |
| 评测探针的执行情况如实记录 | 实施记录 |

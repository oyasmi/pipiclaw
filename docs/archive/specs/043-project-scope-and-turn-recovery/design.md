# 项目作用域与回合恢复：把“在哪个会话、在哪里工作、崩溃后怎么收口”变成运行时事实

| 字段 | 值 |
|------|------|
| 状态 | PROPOSED |
| 日期 | 2026-08-12 |
| 触发 | 对 `~/projects/nanobot` 的设计复盘（显式 workspace/project 双根目录、中断回合的诚实收口），以及对 Pipiclaw 现有 session 绑定与 `process.cwd()` 使用的核查 |
| 前置 | 025 system-prompt-architecture、031 wake-layer-hardening、040 async-delegation-and-external-agents、042 delegation-consistency-hardening |
| 关联实现 | `src/agent/channel-runner.ts`、`src/agent/runner-factory.ts`、`src/agent/prompt/`、`src/security/`（`types.ts`、`path-guard.ts`、`config.ts`）、`src/tools/`、`src/subagents/`、`src/runtime/`、`src/tui/`、`src/shared/atomic-file.ts` |

## 摘要

本 spec 修三个**当前已经存在、可复现**的运行时缺陷，按依赖顺序分成三个可独立合并的阶段：

| 阶段 | 缺陷 | 现状 |
|---|---|---|
| **S0 会话身份** | `/new` 之后重启 daemon，那段会话被永久孤儿化 | `ChannelRunner` 固定打开 `context.jsonl`，但 SDK 的 `newSession()` 会把活动文件换成另一个名字 |
| **A 项目作用域** | Agent 在哪里工作，取决于 daemon 从哪个目录启动 | 文件工具、shell、prompt 多处直接取 `process.cwd()`；pathGuard 默认放行整个 `$HOME` |
| **B 回合恢复** | 进程停在 tool call 与 tool result 之间，频道永久卡死 | 恢复后的会话带着无 `tool_result` 的 `tool_use` 打给 provider，每次都 400，直到用户手动 `/new` |

三者共享一个前提：**一个频道在任一时刻，必须能说清自己在哪个 session 文件上、以哪个目录为工作面**。S0 建立这个前提，A 和 B 分别在它上面展开，可以分别评审、分别上线。

最终不变量：

> 一个频道的活动 session 由一份持久化指针唯一决定；一次回合内所有项目 I/O 使用同一个不可变 `ProjectScope`；重启后 runtime 只把会话结构修成合法且诚实的形态，绝不重放结局未知的副作用。

## 当前事实与证据

### F1 活动 session 指针不存在（S0 的依据）

`ChannelRunner` 构造时固定打开频道目录下的 `context.jsonl`：

```ts
// src/agent/channel-runner.ts:224
const contextFile = join(channelDir, "context.jsonl");
this.sessionManager = SessionManager.open(contextFile, channelDir);
```

而 SDK 的 `SessionManager.newSession()` 在 persist 模式下会把 `sessionFile` 重写为 `<sessionDir>/<timestamp>_<sessionId>.jsonl`。频道的 `sessionDir` 就是 channelDir，因此 `/new`、fork、switch 之后活动文件不再是 `context.jsonl`；下一次进程启动，runner 又回到 `context.jsonl`，新会话在磁盘上留着但再也不会被打开。

这不是"以后要做的抽象"，是现在就在丢数据。A 需要它（换项目要重建 runner，不能顺手回退到旧会话），B 更需要它（恢复必须打开崩溃时那个 session，不能猜）。

### F2 `workspaceDir` 与 `cwd` 混用（A 的依据）

`ChannelRunner` 把频道目录的父目录记为 `workspaceDir`（`channel-runner.ts:217`），这是 Pipiclaw 自己的持久化目录；与此同时，工作面根目录到处直接取进程 cwd：

```
src/tools/index.ts:50          securityContext.cwd = process.cwd()
src/tools/grep.ts:174-175      workspaceDir/cwd = process.cwd()
src/tools/bash.ts:147-148      同上
src/tools/edit.ts:142-143      同上
src/tools/write-content.ts:35-36  同上
src/agent/channel-runner.ts:1095/1252/1289/1348/1407  AgentSession cwd、prompt 变量
```

于是"workspace"这个词在代码里至少指三样东西：Pipiclaw 持久化目录（SOUL/AGENTS/MEMORY/skills/events/频道目录）、daemon 启动目录、某次子智能体显式选择的 `workingDirectory`。三者权限、生命周期、内容信任级别都不同。

还有一个独立事实：pathGuard 的默认放行范围是

```ts
// src/security/path-guard.ts:270
return isWithinWorkspace(path, ctx.workspaceDir) || isWithinTemp(path) || isWithinHome(path, homeDir);
```

即今天 generic file tool 对**整个家目录**可读写。所以引入项目边界不只是整理命名，是第一次真正收窄文件面。

### F3 悬空 tool call 没有任何人修（B 的依据）

SDK 的 `buildSessionContext()`（`session-manager.js:232`）只做 compaction 与分支遍历，不检查 `toolCall` 是否有对应 `toolResult`；整个 SDK 里没有 dangling/synthetic 补洞逻辑。因此一旦进程停在 assistant tool call 与 tool result 之间，后续每一次回合都会把不合法的消息序列发给 provider，频道彻底卡死。

同时，这个窗口比想象中窄：`SessionManager._persist()` 是同步 `appendFileSync`（`session-manager.js:730/751`），进程崩溃（SIGKILL、OOM、未捕获异常、部署重启）**不会**丢已写入的字节，只有主机掉电或内核 panic 才会。这一点直接决定了 B 的设计规模，见 D9.1。

### F4 首回合的延迟落盘（S0 顺带解决）

`SessionManager._persist()` 在会话尚无 assistant 消息且文件尚不存在时，把 entry 只留在内存：

```js
// session-manager.js:719-731
const hasAssistant = this.fileEntries.some(e => e.type === "message" && e.message.role === "assistant");
if (!hasAssistant) {
    if (this.flushed) appendFileSync(this.sessionFile, ...);  // 文件已存在 → 立即落盘
    else this.flushed = false;                                 // 文件不存在 → 只在内存
    return;
}
```

关键点：**`flushed` 为真时，即使还没有 assistant，user entry 也是立即 append 的**。而 `_setSessionFile()` 在文件存在且能解析出 header 时直接置 `flushed = true`。因此只要 Pipiclaw 在打开 session 之前先 materialize 一个只含 header 的 JSONL，这个延迟窗口就消失了——不需要修改 `@earendil-works/pi-coding-agent`，也不需要触碰它的私有字段。

## 设计原则

### P1 两个根目录必须始终可区分

- **AgentWorkspace**：Pipiclaw 自己拥有的持久化与能力目录（SOUL、AGENTS、MEMORY、skills、sub-agents、events、频道目录）。
- **ProjectRoot**：当前频道选中的代码/文件工作目录。

不再用一个含混的 `workspaceDir` 同时表示两者，也不保留长期兼容别名。调用点迁移到 `agentWorkspaceDir` 与 `projectRoot`。

### P2 ProjectScope 在 runner generation 上冻结

scope 不能在回合中途变化，不能由模型在某个 tool call 里提升，不能被 busy-time 消息覆盖。一次回合里的 prompt、文件工具、shell、job、subagent 默认目录和审计记录使用同一份 snapshot。

### P3 边界只有一个轴：ProjectRoot

不引入 `restricted` / `full` 两套访问模式。"能访问多大范围"由 operator 在 `security.json` 配置的可选根 + 频道选中的 `projectRoot` 共同表达：想要一个覆盖家目录的 Agent，就把 `~` 配成可选根并选它；这与今天的行为等价，但**是显式声明的，而不是 daemon 启动目录的副作用**。两个正交的模式轴只会制造"selected 与 effective 不一致"的展示债。

### P4 Pipiclaw 只声称自己能强制的事

Pipiclaw 能硬约束自己实现的路径工具；仅设置 shell cwd 阻止不了 `cd ..`、绝对路径、子进程和外部 CLI。展示面必须区分：

- `application`：Pipiclaw 路径工具被约束，shell 只是 cwd + 既有 command guard，**不是系统强制隔离**；
- `system`：宿主沙箱确实把进程限制在项目范围内（只接受 bootstrap 显式注入的能力，不靠"bwrap 二进制存在"猜测）。

### P5 session branch 是恢复的唯一事实源

恢复只读 `<channelDir>` 下由 active-session 指针确定的那个 JSONL，从活动分支推导发生了什么。不引入第二份 transcript、不引入声明式 WAL（论证见 D9.1）。

### P6 未知副作用绝不自动重放

进程在 tool 执行与 result 落盘之间退出时，runtime 无法判断工具是否生效。恢复动作固定为：补一条 `isError: true` 的 tool result，明确"可能已生效，先检查状态再决定是否重试"。对 send、write、bash、job、subagent 一律不自动执行第二次。

### P7 模糊状态 fail closed，兼容迁移显式完成

"老频道还没有 `project.json`"有唯一兼容答案，可以静默迁移；"持久化的项目目录消失、跑出可选根、活动 session 指针与文件矛盾"没有唯一答案，必须阻止新回合并给出修复指令，不能静默换到一个看起来能用的默认值。

## 非目标

- 工具调用的串行/并行策略；那是独立的不变量。
- DingTalk 最终消息 exactly-once。投递成功后、状态落盘前崩溃仍可能"已送达但 runtime 不知道"；本 spec 选择不自动重发。
- 通用容器、VM 或 bwrap 生命周期管理；这里只如实接入宿主已经提供的 sandbox 状态。
- 每个请求任意覆盖 project root。采用频道级 scope，避免 prompt、session、tasks 和后台 run 同时漂移。
- 项目级 memory 分区。频道 SESSION/MEMORY/HISTORY 仍属于 AgentWorkspace。
- 抵抗掉电导致的字节丢失。见 D9.1 的取舍论证。
- 修复人为编辑、截断或任意损坏的 JSONL。恢复只处理"分支结构缺 tool result"这一类可判定残片。

---

# S0 · 会话身份

## D1 ActiveSessionRef

### D1.1 文件与 schema

```text
<channelDir>/active-session.json
```

```ts
interface ActiveSessionRefV1 {
	version: 1;
	file: string;        // 只允许 channelDir 下的单层 .jsonl basename
	sessionId: string;
	updatedAt: string;
}
```

它只保存指针，不保存消息、leaf 或项目。缺失时迁移为 `context.jsonl`（并立即 materialize 出该文件）。`file` 字段必须拒绝绝对路径、路径分隔符和 `..`——这是一个会被用来打开并**追加写**的路径，且频道目录内容部分来自模型可写的世界。

由 `src/runtime/active-session-store.ts` 独占读写，使用 `writeFileAtomically()`（它已经做了 file fsync + rename + 目录 fsync，见 `src/shared/atomic-file.ts:9-38`）。

### D1.2 durable header 先行

打开 session 前，store 必须保证目标文件已经存在且含合法 session header。顺序固定为：

```text
materialize 目标 JSONL（header 已落盘）
→ 原子更新 active-session.json（唯一 commit point）
→ SessionManager.open(join(channelDir, ref.file), channelDir)
```

这一步有两个收益：

1. `_setSessionFile()` 走"文件存在"分支，`flushed` 立即为真，此后**每条 user entry 都同步落盘**（F4）。B 阶段因此不需要任何上游改动就能保证"触发 provider 请求的 user 正文可以从新进程读回"。
2. 事务永远不会留下一个指向尚不存在文件的 ref。

### D1.3 session topology 事务

`/new`、fork、switch、tree navigation 是拓扑操作，不是普通 prompt。它们必须走同一条事务，且只在频道 idle 时执行：

```text
确认 idle（TurnPhase 为 idle，无进行中回合）
→ 创建/打开目标 session，写入并落盘 header
→ 原子更新 active-session.json（commit point）
→ rebind/replace AgentSession
```

接入点是现成的：`ChannelRunner` 已经把 session 重建收敛到 `AgentSessionRuntime` 的工厂回调（`channel-runner.ts:1100-1110`，回调参数带 `sessionManager` 与 `sessionStartEvent`），在那里读 `sessionManager.getSessionFile()` 并提交 ref 即可；SDK 侧还有 `session_before_switch` / `session_before_fork` 扩展事件可用于 idle 校验。

目标 session 必须位于当前 channelDir；跨频道或任意宿主路径的 session switch 不在授权范围内。事务任一步失败，ref 仍指旧 session，按旧 ref 重建 runner。

### D1.4 S0 的第二件事：机械改名

同阶段完成一次**零行为变更**的重命名，为 A 阶段扫清 diff 噪音：

```ts
// src/security/types.ts
export interface SecurityRuntimeContext {
	agentWorkspaceDir: string;   // was: workspaceDir
	projectRoot: string;         // was: cwd?（此刻仍然填 process.cwd()）
	homeDir?: string;
}
```

改名 commit 里 `projectRoot` 依旧由调用方填 `process.cwd()`，行为逐字节不变；A 阶段再把值换成真正的 scope。把改名和语义改动分成两个 commit，是这次改造能被 review 的前提——`SecurityRuntimeContext` 的调用点横跨 `src/tools/*`、`src/security/*`、`src/subagents/`、`src/tui/`。

---

# A · 项目作用域

## D2 类型与所有权

### D2.1 ProjectScope

```ts
export interface ProjectSandboxStatus {
	/** application：仅 Pipiclaw 自己的路径工具被强制；system：宿主沙箱强制。 */
	level: "application" | "system";
	provider: string;   // "pipiclaw-path-guard" | "bubblewrap" | ...
	summary: string;    // 展示用的一句话，见 D6.3
}

/** 一次 runner generation 使用的不可变值。 */
export interface ProjectScope {
	/** 已存在目录的 realpath。 */
	projectRoot: string;
	/**
	 * project：generic 路径工具被收紧到 projectRoot；
	 * unbounded：尚未配置 projectAccess 的兼容状态，沿用既有 pathGuard 默认放行范围。
	 */
	boundary: "project" | "unbounded";
	sandbox: ProjectSandboxStatus;
}
```

`ProjectScope` 是**有效结果**，不携带"请求值可能是什么"的歧义。请求与持久化用不同类型：

```ts
export interface PersistedProjectSelectionV1 {
	version: 1;
	projectRoot: string;   // 持久化时已 canonicalize
	updatedAt: string;
	updatedBy: "migration" | "dingtalk-command" | "tui-command";
}

export interface ProjectAccessPolicy {
	defaultRoot: string;
	allowedRoots: readonly string[];
}
```

注意这里**没有** `accessMode`、`allowFullAccess`、`policyFingerprint`。理由见 P3 与"被驳回的替代方案"。

### D2.2 所有权矩阵

| 事实 | 唯一所有者 | 不得拥有它的模块 |
|---|---|---|
| app 默认项目与可选根 | `src/security/project-scope.ts` 解析出的 policy | prompt、tool factory |
| 频道选中的项目 | `src/runtime/project-scope-store.ts` | ChannelRunner 内存字段 |
| 一次 generation 的 effective scope | runner 构造参数，ChannelRunner 只读 | 单个 tool 参数 |
| 活动 session 指针 | `src/runtime/active-session-store.ts` | runner 内存 |
| project `AGENTS.md` 注入 | `src/agent/prompt/project-resources.ts` | pi 的自动 resource discovery |
| generic 路径许可 | `src/security/path-guard.ts` | read/edit/write 各自再发明规则 |
| 中断回合的修复 | `src/agent/turn-recovery.ts` | runtime 直接改 JSONL |

## D3 配置、持久化与迁移

### D3.1 app policy 放在 `security.json`

可选项目根是安全策略，不是模型偏好，进入 app-level `security.json`（既有加载器在 `src/security/config.ts`）：

```json
{
  "projectAccess": {
    "defaultRoot": "~/projects/pipiclaw",
    "allowedRoots": ["~/projects"]
  }
}
```

规则：

1. 两个字段都支持 `~`；解析后必须是绝对路径、现存目录，并 canonicalize 为 realpath。
2. `defaultRoot` 自动加入可选根；选中的 project root 必须等于某个可选根，或位于其下。
3. 配置本身出错（目录不存在、不是绝对路径）产生 startup diagnostic，并**禁用 scope 变更**；不得因为一条坏 allowlist 就退化成"任意目录可选"。

**为什么需要 allowlist**：`/project set` 来自聊天频道，而钉钉群成员未必等同于宿主账号所有者。可选根表达的是"宿主主人允许这台机器上的 Agent 在哪些树里工作"，与"群里谁在说话"无关。如果你的部署里频道成员恒等于宿主主人，把 `allowedRoots` 配成 `["~"]` 即可，语义保持一致而不是多一个开关。

### D3.2 兼容与新安装

| 情况 | effective scope |
|---|---|
| 升级用户：完全没有 `projectAccess` 段 | `projectRoot = startup cwd`，`boundary = "unbounded"`，行为与今天逐字节一致 |
| 新 app home 的 bootstrap 模板 | 写出 `projectAccess`，`defaultRoot` 取首次启动 cwd，`allowedRoots = [defaultRoot]` |
| 有 `projectAccess` 段但省略字段 | `defaultRoot = startup cwd`，`allowedRoots = [defaultRoot]`，`boundary = "project"` |

"配置段不存在"与"字段省略"故意不同：前者是有期限的兼容路径，后者是用户已经选择新机制之后的安全默认。

兼容路径下 `/project set` 不可用——runtime 没有安全依据判断一个任意绝对路径是否可选。用户要选别的目录，先在 `security.json` 写出 `projectAccess`。这条限制同时也是把"unbounded"变成一个有出口的临时状态的手段：`/project` 的输出会明确写出下一步。

### D3.3 每频道一个 `project.json`

```text
<channelDir>/project.json     // 只含 PersistedProjectSelectionV1，writeFileAtomically
```

不新建通用 `channel-meta.json`：项目选择有独立的校验、命令和迁移生命周期，为它造一个杂物箱只会让后续事实互相覆盖。

缺文件时按 D3.2 解析默认值，并在**第一次成功准入后立即 materialize**。这一步把过去隐含的 startup cwd 固定下来：daemon 下次从另一个目录启动，不会悄悄改变老频道的工作面。

持久化目录后来消失时：

- `/project` 仍能读取并显示 stale selection；
- 普通回合、task/event wake 一律拒绝；
- 错误明确要求"恢复该目录，或在频道空闲时 `/project set <path>` / `/project reset`"；
- **不自动回退到 default root**——那会把原本针对 A 项目的任务发到 B 项目去执行。

### D3.4 canonical path 规则

设置项目时要求目录已存在，存 realpath，不存可被重新指向的 symlink 字符串。每次 runner generation 创建时再次 realpath，并要求结果仍等于持久化值。这样 `..` 与 symlink 不能绕过可选根；symlink 后来被改指不会静默迁移频道；目录重命名会进入 stale 状态，由人显式重新绑定。

## D4 scope 是频道身份，不是单次调用参数

### D4.1 解析优先级

```text
channel project.json
  └─ 缺失时：app ProjectAccessPolicy default
```

普通消息 metadata、event payload、task frontmatter、模型 tool call 都不能覆盖 project root。后台 task/event 使用目标频道同一份 selection，因此不会出现"真人回合在 A、task wake 在 B"的隐式分叉。

### D4.2 runner generation 不可变

`ChannelRunner` 构造时接收已解析好的 `ProjectScope`，其 Agent、AgentSession、ResourceLoader、tool closure 和 Executor 只引用这一份值。切换提交序列：

```text
校验 idle 且无进行中的 running job / subagent run
→ fence runner slot，阻止新回合准入
→ dispose 旧 runner 并从 owner slot 移除
→ 原子写 project.json（唯一 commit point）
→ 下一次访问按新 scope 创建 runner generation（active-session ref 不变）
```

commit 前失败：解除 fence，按旧 selection 重建。commit 后：`project.json` 就是唯一 scope 事实，按新 selection、**同一个 active session** 重建 runner。既不会出现"文件已切换、旧 runner 仍在接单"的窗口，也不会因为换项目而悄悄回到旧 `context.jsonl`。

不在存活 runner 上逐字段热改 cwd：AgentSession、ResourceLoader 和工具 closure 都捕获了 cwd，局部 reload 很容易留下半套旧 scope。daemon 的 runner map 与 TUI 的 runner slot 是生命周期所有者；`createRunner()` 保持无缓存（`runner-factory.ts` 的现有约定）。

### D4.3 后台工作用快照，不用全局阻塞

切换项目时，**只**阻塞两类真正在跑的东西：正在进行的回合、running 的 job / subagent run。对 task 不做阻塞。

理由是一致性：job 与 subagent run 记录在创建时就持久化了自己的 `workingDirectory`，恢复时用 record 自己的目录，不重读频道 current scope（040/042 已经这样做）。task 应当采用同一原则——task 记录创建时的 `projectRoot` 快照，唤醒时按快照运行；找不到快照的老 task 按频道当前 selection 运行并记录一次 migration 日志。

用"存在任何 active/sleeping/waiting task 就拒绝切换"来保证一致性，在实践中会让 `/project set` 基本不可用（多数频道都挂着 sleeping task），而且和同一份 spec 里对 job/subagent 的处理自相矛盾。被阻塞时，错误必须点名持有者：

```text
无法切换项目：子智能体 run r-3f9a（claude-code）仍在运行。
等待它结束，或先 /subagents cancel r-3f9a，再重试 /project set …。
```

## D5 AgentWorkspace 与 ProjectRoot 的资源分工

Pipiclaw 不采用 nanobot"选了独立项目就不继承 agent workspace AGENTS"的规则：Pipiclaw 的 workspace `AGENTS.md` 承载实例/团队操作规范，必须始终存在。project rules 是更具体但更低权限的一层。

| 资源 | 来源 | 说明 |
|---|---|---|
| `SOUL.md` | AgentWorkspace | 身份与语气，不读取 project SOUL |
| workspace `AGENTS.md` | AgentWorkspace | runtime/团队级规则，始终存在 |
| project `AGENTS.md` | ProjectRoot | 当前项目约定；不能覆盖 runtime security 或 workspace policy |
| `MEMORY.md`、频道 SESSION/HISTORY | AgentWorkspace / channelDir | 跨项目保持频道连续性 |
| `skills/`、`sub-agents/`、`events/` | AgentWorkspace | 继续遵守"workspace skills only"（spec 033） |
| 相对文件路径、shell cwd | ProjectRoot | 项目工作面 |

约束：

1. pi 的 `agentsFilesOverride` 继续关闭；project `AGENTS.md` 由 Pipiclaw 自己读取、预算、标注来源，避免 project `.pi/` 扩展、skills 或 append prompt 顺带进入 runtime。
2. Prompt section 顺序：project AGENTS 放在 workspace AGENTS 之后、其他高变内容之前。全局 section 仍构成稳定 cache prefix，只有 project section 及其后缀随项目变化。
3. 每回合 dynamic capsule 明示 `projectRoot`、enforcement level、AgentWorkspace 路径；`application` 级必须写清"shell 不受 OS 沙箱约束"。
4. 切换项目后的首回合，capsule 增加一次性边界说明：此前对其他项目的路径与结果只是历史，不得当作当前文件状态。
5. project `AGENTS.md` 超预算时，走与 workspace resource 相同的 head/tail 截断与 `/context detail` 诊断，不可静默消失。
6. ProjectRoot 与 AgentWorkspace 的 realpath 相同时（用户显式把 workspace 选为项目），两层指向同一个文件：按 realpath 去重，正文只注入一次。

规则冲突顺序：runtime hard boundary > workspace AGENTS 的实例策略 > project AGENTS 的项目约定 > 普通历史文本。当前用户请求可以在这些边界内做具体选择，不能提升文件或宿主权限。

## D6 工具与安全边界

### D6.1 SecurityRuntimeContext

S0 已经把字段改名，A 阶段把值换成真的：

```ts
export interface SecurityRuntimeContext {
	agentWorkspaceDir: string;
	project: ProjectScope;
	homeDir?: string;
}
```

`project.projectRoot` 同时是相对路径基准与默认边界；`agentWorkspaceDir` 只用于审计文件与 runtime-owned 例外，**不再让 generic file tool 默认读写整棵 agent workspace**。

### D6.2 工具矩阵

| 能力 | `boundary: "project"` | `boundary: "unbounded"`（兼容态） |
|---|---|---|
| `read` / `grep` / `send_media` | ProjectRoot 内 + 下列只读例外 | 既有 pathGuard 默认与 allow/deny 规则 |
| `edit` / `write` | 仅 ProjectRoot 内，realpath 与 symlink 写规则继续生效 | 既有 pathGuard |
| sync `bash` | cwd = ProjectRoot；application 级仅 best-effort，system 级由宿主沙箱强制 | cwd = ProjectRoot，可访问范围受既有 command/path/host 权限约束 |
| async `bash` / job | 启动时持久化同一 projectRoot，恢复时用 record 自己的目录 | 同左 |
| internal subagent | 默认 ProjectRoot；显式 `workingDirectory` 必须位于 ProjectRoot 内 | 默认 ProjectRoot；显式目录仍过既有 guard/lease |
| external subagent | cwd = ProjectRoot，其余边界见 D6.4 | 保持 040/042 边界 |
| memory / task / event / skill 管理 | 各 domain tool 继续只访问自己固定的 AgentWorkspace 路径 | 同左 |
| web | 与文件边界正交，继续由 networkGuard 管 | 同左 |

`boundary: "project"` 是 pathGuard 的**外层上限**：`security.json.pathGuard.readAllow/writeAllow` 不能把 generic tool 放宽到项目外，否则项目边界只是 UI 标签。runtime-owned 例外只能在代码里以最窄形式表达：

- bundled playbooks：只读（`path-guard.ts` 已有 `isBundledPlaybookRead`）；
- AgentWorkspace `skills/`：只读，供模型按 skill 指引加载；
- runtime 自己刚创建并返回的 bash spill artifact：按精确文件只读，不开放整个 `/tmp`；
- `session_search`、`memory_manage` 等不接受 generic path 参数，由各自 domain confinement 访问频道文件。

控制面工具能写 task/event/skill，不等于 generic `write` 获得 AgentWorkspace 写权限：前者的 schema 与实现都把目标限制在单一 domain，那是更窄的 capability。

### D6.3 enforcement 必须诚实展示

`/project`、`/status` 和 turn capsule 使用同一份 `ProjectSandboxStatus`：

```text
Project: ~/projects/pipiclaw
Enforcement: application-level（文件工具受约束；shell 未被 OS 沙箱隔离）
```

或：

```text
Project: ~/projects/pipiclaw
Enforcement: system（Bubblewrap）
```

`system` 只在 bootstrap 显式注入宿主 sandbox 能力时出现，绝不通过"检测到 bwrap 二进制"推断。兼容态则直白写明：

```text
Project: /home/me/projects/pipiclaw（未配置 projectAccess，沿用旧的全局文件权限）
下一步：在 ~/.pipiclaw/security.json 写入 projectAccess 后即可使用 /project set。
```

### D6.4 外部 Agent

AGENTS.md 已经明确：外部 Agent 绕过 Pipiclaw guards，它的 role command、CLI 自身 sandbox、宿主账号和环境才是 permission boundary。本 spec 对它只做两件事：

1. 把 `workingDirectory` 默认设为 ProjectRoot，并随 run record 持久化；
2. 在角色详情与回合 capsule 里如实声明"该进程不经过 Pipiclaw 的 path/command/network guards"。

**不**引入 role 级 `projectBoundary` 声明，也不去校验最终 argv 里是否出现某个 CLI 的沙箱 flag。在已经承认 application 级不是沙箱的前提下，验证外部 CLI 的命令行形态既是安全剧场，又会把 Pipiclaw 绑死在这些 CLI 随时会变的 flag 细节上。要禁止某个外部角色，operator 删掉或禁用那个角色即可——那是既有的、真实生效的控制点。

## D7 用户操作面

```text
/project                       纯读，busy 时可用，不必创建 runner
/project set <absolute-path>   更换 root
/project reset                 回到 app default
```

- 所有 mutation 在 runtime 层处理，不发送给模型。参数缺失、目录不存在、超出可选根，属于用户必须知道的普通错误；文案给出允许的根与需要修改的 `security.json` 字段。
- mutation 在 busy 或有 running job/subagent 时拒绝，并列出具体阻塞项及对应的 cancel 命令（D4.3）。
- DingTalk 与 TUI 共用同一个 parser/store/policy；前端只负责回复与 runner slot 替换，不各自实现校验（既有 `src/runtime/task-commands.ts`、`subagent-commands.ts` 就是这个形状）。

`/status` 增加一行：

```text
Project: ~/projects/pipiclaw · application
```

有 stale selection、pending recovery 或未配置 projectAccess 时展开 warning。`/context detail` 增加 AgentWorkspace、ProjectRoot、workspace/project AGENTS 的独立预算，便于确认模型实际收到了哪套规则。

---

# B · 回合恢复

## D8 目标

只修一件事：**重启后，活动分支里不存在"声明了却没有结果"的 tool call**，并且这个修复不会执行任何工具、不会重投任何消息。

## D9 为什么不做 checkpoint / WAL

这一节记录本 spec 最重要的一次删减，供后来者判断要不要加回来。

一个直觉方案是：回合准入时写 `<channelDir>/turn-checkpoint.json`，每个 tool 执行前把 pending call 记进去并 fsync，形成 write-ahead intent。它被否决，因为：

1. **它和"branch 是事实源"自相矛盾。** 任何诚实的恢复算法都必须从分支推导 `declared − fulfilled`，因为 checkpoint 自己也可能落后。一旦这样做，checkpoint 里的 phase、pending 数组就是不被信任的冗余字段——一份自己声明不被采信的 WAL。
2. **它没有 redo。** 数据库 WAL 的价值在重放；而 P6 明确永不重放。没有 redo 的 WAL，最终产物只是一句"这次调用可能已生效"的话术，而这句话术从 `declared − fulfilled` 同样能推出来。
3. **它只在掉电场景有增量收益。** SDK 的 session 写入是同步 `appendFileSync`（F3）。进程崩溃、SIGKILL、OOM、部署重启都不丢已写字节，分支扫描给出的修复结果与带 WAL 时**逐字节相同**。只有主机掉电或内核 panic 才可能出现"tool call 记录丢了但副作用已发生"，而那时 WAL 也只能把静默丢失升级成一个 blocked 状态。
4. **它的成本是系统性的**：每个副作用边界 fsync、revision CAS、turnId 所有权栅栏、跨阶段的 fault-injection 矩阵，以及（在原方案里）一个必须先落地的上游 SDK 契约变更。

对一个单进程、单宿主的聊天 daemon，这个交换比不成立。若将来实测确实出现掉电导致的静默丢失，再补 WAL：它那时是一个纯 additive 的文件，不需要回头推翻本节任何结论。

顺带说明：原方案里"user entry 必须在 provider 请求前落盘"需要上游支持，这个依赖已经被 S0 的 D1.2 消除——materialize durable header 之后，user entry 本来就是同步 append 的（F4）。

## D10 触发位置与并发前提

恢复由 `recoverInterruptedTurn(channelDir)` 实现，在两处调用：

1. daemon 在对外接收消息之前，扫描 `workspace/*/`；
2. 每个 `ChannelRunner` 初始化时，对本频道再执行一次 barrier（覆盖 lazy channel、TUI，以及第一次扫描失败后已被人工修复的情况）。

两处共用同一个纯函数计划器，并由既有的 channel path serial queue 防止并发修复。

**"分支里的 dangling call 一定是崩溃残片"这个判断成立的前提**（必须写进代码注释，将来动了这些前提就要重审）：

- 一个 app home 只有一个活着的 daemon 进程；
- daemon 的启动扫描发生在开始接单之前；
- 同频道的回合由 `ChannelQueue`（`src/runtime/channel-queue.ts`）串行，runner 初始化 barrier 先于第一次回合完成；
- 因此扫描时不可能有"正在进行中、结果马上就到"的 tool call。

## D11 分支验证与状态推导

1. 读 `active-session.json`，校验 `file` 是 channelDir 下的单层 `.jsonl` basename；打开该文件并核对 header 的 sessionId 与 ref 一致。
2. 取活动分支（`SessionManager.getBranch()`），从最后一个 compaction 边界（或分支起点）向后扫描：
   - `declared`：所有 assistant 消息里的 `toolCall`，按消息顺序与消息内 source order 排列；
   - `fulfilled`：后续 `toolResult.toolCallId` 集合；
   - `missing = declared − fulfilled`。
3. 判定分支尾部形态：最后一条是 user、是含 tool call 的 assistant、是 tool result 前缀，还是一条完整的无 tool call assistant。

进入 `recovery-blocked`（不改 transcript、不动文件）的条件：

- `active-session.json` 与文件 header 矛盾，或 `file` 非法；
- 同一个 `toolCallId` 出现多于一个 result；
- `missing` 里的 call 之后已经出现新的 user 消息、或另一条不依赖该结果的 assistant 消息——说明这不是正常的崩溃窗口，把 synthetic result 追加到那个位置只会制造更难解释的历史。

blocked 时，`/status` 与该频道的下一条普通消息给出：session 文件路径、失败类别、以及"在宿主上备份并移走该文件，再用 `/new` 建立新会话"的顺序。blocked 期间 `/new` 本身必须可用（它建立的是另一个文件，不触碰坏的那个）——这是与项目 stale 状态不同的地方，因为这里的修复出口就是换一个 session。

静默猜测分支，比暂时把频道停下来危险得多。

## D12 修复动作

| 分支状态 | 修复 |
|---|---|
| 尾部是完整的无 tool call assistant | 无事可做 |
| 尾部是 user，之后没有 assistant | 追加一条 runtime-authored assistant，`stopReason: "aborted"` |
| 存在 missing tool calls | 按 assistant 内 source order，为每个 missing call 追加 synthetic `ToolResultMessage` |
| tool result 已齐、但还没有下一条 assistant | 保留结果，结束恢复，**不自动 `continue()`**（见 D13） |

synthetic tool result 的标准正文：

```text
Error: Pipiclaw restarted before a durable result was recorded for this tool call.
The operation may or may not have taken effect. Inspect the current target state before retrying;
do not repeat the operation blindly.
```

并按工具补一条可行动指引：

- `subagent`：先用 `subagent_manage op=list` / `show` 查 durable run；
- async `bash` / `job`：先用 job `list` / `poll` 查记录；
- `write` / `edit` / sync `bash`：用 read/grep/git status 检查目标；
- 对外发送类：查询目标系统或请用户确认，不自动再发。

字段固定：`isError: true`，timestamp 为恢复时间，不带伪造 usage，不触发 effect ledger，不写 usage ledger。

runtime-authored 的 aborted assistant 必须是 pi 接受的完整 `AssistantMessage`：`api`/`provider`/`model` 取分支中最近一条 assistant 消息的对应字段（没有则取该频道当前配置的模型），usage 全为 0，`stopReason: "aborted"`，正文明确标注是 Pipiclaw 重启，不伪装成 provider 生成的回答：

```text
Error: Pipiclaw restarted before a response was generated. Re-send the request if it is still needed.
```

所有修复经由 `SessionManager.appendMessage()` 追加（它负责 parentId 链接与 leaf 推进），**绝不直接改写或插入 JSONL 中间行**。修复完成后写一条审计事件。

## D13 为什么不自动 `continue()`

tool result 齐了就自动继续模型，看起来方便，但它会在 daemon 启动时产生新的费用、新的消息和可能的后续副作用，而且此刻没有承载 DingTalk 卡片生命周期的 ChannelContext。本 spec 只保证 transcript 合法且结局诚实；下一次真人消息、task driver wake 或用户显式重试会在正常准入路径上继续。

## D14 force-end 与晚到事件

`forceEndTurn()` 当前会先把频道暴露为 idle，旧 teardown 仍可能在跑。与恢复无关但同属并发正确性，本 spec 保留这层 fence：

- transport busy 可以释放，让 `/status`、`/stop` 恢复响应；
- 新回合在 `run()` 前必须等待旧 AgentSession abort/settle 完成；
- 新回合不复用仍可能发事件的 Agent 实例；必要时 retire 整个 runner generation，由 owner 创建新实例；
- session topology 事务（D1.3）与项目切换（D4.2）在有进行中回合时一律拒绝。

**用户可见的 idle，与 session 可写，是两个不同的状态**；后者必须由 fence 守住，否则两个回合会同时向同一个 append-only leaf 写入。

## D15 崩溃窗口矩阵

| 崩溃点 | 磁盘上的状态 | 重启动作 | 是否重放 |
|---|---|---|---|
| 回合开始前 | 无本回合记录 | 无事可做 | 否 |
| user append 后、assistant 前 | user 已落盘（D1.2 保证） | 补 aborted assistant | 否 |
| assistant tool call append 后、tool 执行前 | declared，无 result | 补 interrupted result（措辞覆盖"尚未执行"的情况） | 否 |
| tool 产生副作用中 | declared，无 result | 补 interrupted result，要求检查目标状态 | 否 |
| tool 返回后、result append 前 | declared，无 result | 同上 | 否 |
| result append 后、下一次模型请求前 | 分支完整 | 不自动 continue | 否 |
| final assistant append 后、投递前 | 分支完整 | 无事可做；投递结局记为 unknown | 否 |
| 已投递钉钉、进程随即退出 | 分支完整，投递不可判定 | 无事可做，不重发 | 否 |
| 主机掉电，丢失尚在 page cache 的字节 | 可能整条 tool call 消失 | 分支自洽，恢复无事可做；副作用静默发生 | 否 |

最后一行是本设计明确接受的残余风险，见 D9 第 3 点与"风险与后续"。

"tool 执行前"这一行理论上可以区分，但恢复代码无法证明进程不是死在调用边界上，因此与"执行中"统一使用保守措辞，不给模型虚假的 exactly-once 信号。

## D16 与 durable job/subagent/task 的关系

恢复不接管既有 durable manager：`SubAgentRunManager` 仍是 run settlement/usage/lease/wake 的唯一所有者，`ChannelJobManager` 仍恢复后台进程记录，DurableDispatch 仍恢复 wake lease，TaskDriver 仍管理 task transition。

turn recovery 只修"主 agent 这次 tool call 没拿到结果"。例如外部 subagent 已成功 spawn、主进程却在 tool result 落盘前退出：`SubAgentRunManager` 照常接管那个 run；主 session 拿到一条 interrupted synthetic result，并被指引去查 run 列表。**绝不能由 turn recovery 再 dispatch 一次。**

---

# 落地

## D17 实现落点

新增文件，按 domain 组织，不新增 root-level generic manager：

```text
src/runtime/active-session-store.ts     ref schema、basename 约束、materialize header、rebind 提交
src/security/project-scope.ts           policy schema、canonicalize、allowed-root 判定、sandbox status
src/runtime/project-scope-store.ts      channel project.json 的 load / materialize / 原子写
src/runtime/project-commands.ts         /project parser、阻塞项检查、runner slot 替换
src/agent/prompt/project-resources.ts   project AGENTS.md 的读取、预算、diagnostic
src/agent/turn-recovery.ts              分支验证、repair plan 纯函数、synthetic message 追加
```

主要改造点：

- `src/agent/channel-runner.ts`：从 ActiveSessionRef 打开 session（替换 `:224` 的固定路径）；`:1095/1252/1289/1348/1407` 的 `process.cwd()` 换成 scope root；在 `AgentSessionRuntime` 工厂回调（`:1100-1110`）里提交 ref；初始化时执行 recovery barrier；
- `src/agent/runner-factory.ts`：构造参数带 effective scope；
- `src/security/types.ts` / `path-guard.ts`：拆 agent/project 根，`boundary: "project"` 作为 pathGuard 外层上限；
- `src/tools/index.ts` / `registry.ts` 及各 leaf tool：删掉自建的 `process.cwd()` 兜底（`grep.ts:174`、`bash.ts:147`、`edit.ts:142`、`write-content.ts:35`），统一接收同一份 scope；domain tool 继续收 agentWorkspaceDir/channelDir；
- `src/agent/job-manager.ts`、`src/subagents/runs.ts`、`src/runtime/task-driver.ts`：record 保存 `workingDirectory` 快照（前两者已有，task 补上）；
- `src/runtime/bootstrap.ts`：bot 启动前的 workspace recovery 扫描、runtime 命令注册、runner cache 替换；
- `src/tui/app.ts`：把固定的 runner 引用（`:113`）改成可替换的 slot，启动时执行同频道 recovery；
- `src/paths.ts`：只增加真正 app-level 的路径；频道级 `project.json` / `active-session.json` 路径留在各自 domain helper（与 `src/runtime/channel-paths.ts` 的现有分工一致）。

## D18 分阶段实施

### S0 · 会话身份（先合，最小）

1. `active-session-store.ts`：schema、basename 约束、materialize durable header、原子写；
2. `ChannelRunner` 从 ref 打开 session；`AgentSessionRuntime` rebind 时提交 ref；
3. `/new` 与 fork/switch 走 idle control transaction；
4. `SecurityRuntimeContext` 机械改名（`workspaceDir → agentWorkspaceDir`、`cwd → projectRoot`），**行为零变更**，独立 commit。

### A · 项目作用域

1. `projectAccess` policy schema、canonicalize、diagnostic；
2. `project.json` store 与老频道首次准入 materialize；
3. runner 构造显式接收 scope，消灭生产路径上的项目 `process.cwd()`；
4. pathGuard 外层上限与 runtime 只读例外；
5. bash/job/subagent 的 `workingDirectory` 传递与 record 快照（含 task 快照）；
6. project `AGENTS.md` 注入与 prompt accounting；
7. `/project`、`/status`、`/context detail`；TUI 与 DingTalk 对齐。

先做 1–3（读路径）再做 4–7，中间可以停：那时所有消费点已经读同一份 snapshot，但边界尚未收紧，风险最低。

### B · 回合恢复

1. 分支扫描与 repair plan 纯函数；
2. synthetic tool result / aborted assistant 的构造与 provider converter 契约测试；
3. daemon 启动扫描 + runner 初始化 barrier + TUI；
4. blocked 状态展示与审计事件；
5. 顶层用户文档与 `security.json` 模板更新。

每个阶段都必须通过 `npm run typecheck` 与 `npm run test`；A/B 涉及 runtime/security 持久化改动，合并前额外跑 `npm run check`。

## D19 错误、审计与可观察性

新增结构化事件：

| event | 关键字段 |
|---|---|
| `project.scope.selected` | channelId、old/new root、actor（不记录用户消息正文） |
| `project.scope.denied` | requested root、原因类别 |
| `agent.turn.recovered` | sessionId、修复的 assistant/tool result 条数、耗时 |
| `agent.turn.recovery_blocked` | sessionId、类别、文件路径 |

Project root 与 session 路径属于本机敏感元数据：跟随现有 file log 策略，不发往模型，审计文件保持 owner-only。

错误分类遵守 AGENTS.md：

- project 参数非法：runtime 命令直接回复人，不进入模型；
- 持久化 scope stale、active ref 与文件矛盾、目录不可写导致准入无法安全进行：普通 Error，用户必须知道并行动；
- recovery synthetic tool result：这是合法的历史修复，不向当前用户弹红色 progress，也不计为本回合的 tool failure。

`/status` 在最近一次恢复后保留一条进程内摘要。

## D20 测试与验收

### S0

- 缺 `active-session.json` 时迁移到 `context.jsonl` 并 materialize header；
- `/new` → 重启 → 打开的仍是新 session；fork/switch 同理；
- `file` 字段为绝对路径、含分隔符、含 `..`、指向频道外时被拒绝；
- materialize header 之后，新会话的**首条 user 消息**可以从另一个进程读回（直接覆盖 F4）；
- 事务在 commit 前失败时，ref 仍指旧 session，且不存在指向不存在文件的 ref。

### A

- 缺 `projectAccess` 的升级兼容（`boundary: "unbounded"`，行为不变）与有配置时的安全默认；
- `~`、相对路径、null byte、不存在目录、symlink retarget、可选根前缀混淆（`/repo-a` vs `/repo-ab`）；
- `boundary: "project"` 下 read/write/grep/send_media 的边界与只读例外；
- generic file tool 不能借 `readAllow/writeAllow` 穿透项目上限；
- domain tool 仍只能操作自己的 AgentWorkspace 子树；
- bash/job/internal subagent 的 cwd 与 external run 的 record 快照；
- scope mutation 被 busy 回合、running job、running subagent 分别阻止；有 sleeping task 时**不**被阻止，且该 task 唤醒后仍按自己的快照运行；
- mutation 后旧 runner 确实 dispose，新 runner 的 AgentSession、ResourceLoader、tools、prompt 全部使用新 root，且 active session 不变；
- project SOUL/skills/extensions 不被加载，workspace skills 仍可用，workspace/project AGENTS 顺序稳定，同 realpath 时只注入一次。

### B

纯函数层：

- 从分支推导 declared/fulfilled/missing；多 tool 的 source order；已落盘的 result 前缀；重复 result；missing 之后出现新 user → blocked；ref 与 header 矛盾 → blocked 且不修改任何文件；
- synthetic assistant / tool result 可被 `buildSessionContext()` 与**所有已配置 provider 的 converter** 接受；
- repair 不复制 usage、不触发 effect ledger、不调用任何 tool。

端到端（child process + SIGKILL，不是同进程 throw）：

1. 启动真实 `SessionManager` 与一个会写唯一 token marker 的 fake tool；
2. 在 D15 的各个边界杀进程；
3. 新进程运行恢复；
4. 断言：marker 至多写一次、每个 declared call 恰有一个 result、频道能正常处理下一条消息；
5. 再运行一次恢复，断言完全幂等。

至少覆盖"一条 assistant 声明三个并行工具、前两个 result 已写、第三个未知"的情况。

### 验收不变量

- 一个频道的活动 session 在 `/new`、runner 淘汰、项目切换、daemon 重启之后仍然一致；
- 任一正常回合内所有项目 I/O 的 canonical root 相同；
- 展示面永远不把 application 级写成 enforced sandbox；
- 重启后活动分支中不存在缺 result 的 tool call；
- 恢复从不调用 tool、不启动 job、不派发 subagent、不对外发送；
- scope 或 session 状态不明确时，新回合 fail closed 且错误带下一步。

## 被驳回的替代方案

| 方案 | 驳回理由 |
|---|---|
| 只把 `process.cwd()` 换成一个全局 `PROJECT_ROOT` | 不支持 per-channel identity；重启/切换仍会漂移；后台工作没有快照 |
| 继续把 agent workspace 传给 pathGuard 当作 project | generic tool 会拿到 MEMORY、skills、频道状态的写面；职责仍混在一起 |
| 允许每条消息 metadata 覆盖 scope | busy steer、task wake、prompt cache、tool closure 与 session cwd 会在同一回合分叉 |
| scope 切换时热改存活 runner 的几个字段 | AgentSession、ResourceLoader、Executor、tool closure 都捕获旧 cwd，无法证明切换是原子的 |
| 保留 `restricted` / `full` 两个访问模式轴 | 与"可选根"表达的是同一件事，却多出 selected≠effective 的降级展示、policy 指纹和一整套 UI 状态；把广度交给可选根，语义不减而状态减半 |
| 给外部 role 加 `projectBoundary: sandbox` 并校验最终 argv | 在已承认 application 级不是沙箱的前提下属于安全剧场，且把 Pipiclaw 绑死在外部 CLI 的 flag 细节上；禁用角色是已有的真实控制点 |
| 往 job/subagent record 里写 policy fingerprint | 恢复以 record 自己的 `workingDirectory` 为准，fingerprint 没有消费者 |
| 有任何 active/sleeping task 就禁止切换项目 | 实践中让 `/project set` 基本不可用，且与同一 spec 对 job/subagent 采用的快照原则自相矛盾 |
| 引入 turn checkpoint / WAL 作为 durable intent | 见 D9：与 branch-as-truth 矛盾、没有 redo、只在掉电时有增量收益，成本却是全局 fsync + CAS + 所有权栅栏 + 上游契约变更 |
| 为 user-persist barrier 修改上游 SDK | 已被 D1.2 的 durable header 消除；`_persist()` 在文件存在时本就同步 append |
| 重启后自动重跑 pending tool | 未知副作用会变成重复写、重复发、重复派发 |
| 直接改写/插入 JSONL 中间行 | 破坏 append-only tree 与 parentId 链；失败时难以回滚 |
| transcript 完整后自动重投最终回答 | 钉钉缺 exactly-once receipt，可能给用户发两遍 |
| 一个通用 `channel-meta.json` 同时装 scope/session/未来状态 | 不同写者与生命周期会形成新的 lost-update 中心 |

## 风险与后续

1. **掉电仍可能静默丢失一次 tool call。** 这是 D9 明确接受的取舍：不为一个需要主机掉电才会触发的场景，长期背上 WAL 的复杂度。若实测出现，再加 checkpoint——它是 additive 的。
2. **application 级边界下 shell 仍可逃逸。** 本 spec 通过诚实展示与 prompt 约束降低误解，不把它宣称为系统安全。需要强隔离的部署必须由宿主 sandbox 提供；bwrap backend 可另开 spec。
3. **投递仍不是 exactly-once。** 恢复只让 transcript 与工具副作用保守；钉钉 receipt/幂等需要 delivery 层自己的 spec。
4. **同频道跨项目记忆会继续存在。** 这是 AgentWorkspace 连续性的有意取舍。若实际使用中相关召回经常串项目，再给 memory candidate 加 project 维度，不在这里顺手改变记忆语义。
5. **首次迁移只能继承旧行为。** 老版本从未持久化 project cwd，runtime 无法还原"某个历史回合当时从哪里启动"；首次 materialize startup cwd 是唯一不含猜测的兼容答案，必须记录 migration 日志。
6. **上游时序是关键依赖。** 用契约测试固定：`_persist` 在文件已存在时同步 append、assistant `message_end` 的持久化先于工具执行、`getBranch()` 的顺序语义。升级 `@earendil-works/pi-coding-agent` 时这些测试必须先跑。

三个阶段完成后，Pipiclaw 才拥有一个可依赖的本地运行边界：频道知道自己在哪个会话、在哪个项目工作，模型与工具共享同一 scope；即使 daemon 在最坏时刻退出，下一次启动也能把会话修成诚实、合法、不会偷偷重放副作用的状态。

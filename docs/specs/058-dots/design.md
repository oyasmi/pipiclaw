# Dot：把"助手个体"从频道里独立出来

| 字段 | 值 |
|------|------|
| 状态 | 设计已确认，待实施（[实施计划](./plan.md)） |
| 日期 | 2026-10-17 |
| 触发 | 用户希望把调校好的助手共享到多个钉钉群或私聊里使用，对外是同一个 agent；现在 channel 与记忆、任务、文件一一绑死，做不到 |
| 前置 | 043 项目范围（本 spec 将其**整体删除**）、050 记忆 v2、051/052 任务、053 对外文案、054 分层与 `npm run arch` |
| 关联实现 | 新模块 `src/dot/`；`src/runtime/` 新增 `dot-runtime.ts`；`channel/ agent/ memory/ tasks/ events/ jobs/ subagents/ tools/ dingtalk/ tui/ usage/ security/ commands/` 全部改用 dot 寻址；新脚本 `scripts/migrate-to-dots.mjs`；`AGENTS.md`、`CLAUDE.md`、`docs/` 顶层手册与 playbooks |
| 明确不含 | 权限控制（`admins` 留待后续）；dot 改名、删除、合并；每个 dot 独立的 SOUL / skills / 模型；跨频道同步最近上下文；TUI 写入绑定；多进程同时写同一个 dot |

## 摘要

现在一个 `channelId` 同时扮演两个角色：

- **地址**：消息从哪个钉钉会话进来、回复发回哪里。
- **本体**：它的目录 `workspace/<转义后的 channelId>/` 装着这个助手的全部积累。包括记忆、日记、任务、会话、项目范围，以及 agent 的工作文件（它就是 cwd）。

两个角色绑死在一起，带来两个问题：

1. 调校好的助手没法同时服务两个群；
2. 为了把含 `/` 的群 id 当目录名，代码里长出了一整套转义、去重、反查机制，并且已经造成过真实故障（见 §1）。

本 spec 引入 **dot**：一个有名字、显式创建的独立助手个体。

- **dot 拥有**长期的东西：记忆、日记、任务、事件、工作文件，以及每个频道在它里面的对话记录。
- **频道只是地址**，通过一张绑定表指向 dot。一个频道同一时刻只绑一个 dot，一个 dot 可以被多个频道绑定。
- **各频道的会话上下文彼此分开**，长期记忆共享。
- **project 概念整体删除**：dot 自己的目录就是工作目录。
- **channelId 从此只作数据键**，永远不再出现在路径里，转义机制随之消失。

| 决策 | 内容 |
|---|---|
| D1 | dot 是一等概念；dot、频道、workspace 三者的所有权划分 |
| D2 | 磁盘布局：`workspace/dots/<dot>/`，频道在 dot 里的对话记录放在 `conversations/<会话区>/` |
| D3 | dot 名规则、`dot.json`、会话区的分配 |
| D4 | 绑定表 `dots/bindings.json`；未绑定频道的行为 |
| D5 | 命令：`/dot`（list）、`/dot new <dot>`、`/dot bind <dot>` |
| D6 | `DotRuntime`：dot 的激活与休眠、按 dot 运行的后台服务；daemon 与 TUI 共享 dot 时的跨进程短锁 |
| D7 | 投递目标：没有主频道，每项后台工作显式写明投递频道；只投给仍绑定在本 dot 上的频道 |
| D8 | 挂起：整个 dot 休眠，以及单项后台工作挂起；两者都自动恢复 |
| D9 | 删除 project（`/project`、`project.json`、`projectAccess`、项目边界） |
| D10 | 删除 channelId 的路径转义：channelId 只作数据键 |
| D11 | 新模块 `src/dot/` 与分层调整；全仓命名从 channel 改为 dot |
| D12–D19 | 各子系统改造：记忆、任务、事件、委派与 job、会话与提示词、钉钉传输、TUI、用量 |
| D20 | 独立迁移脚本 `scripts/migrate-to-dots.mjs` |
| D21 | 启动时检测旧布局并拒绝启动；删除 v3→v5 任务迁移代码 |
| D22 | v1 不做权限控制；风险说明 |
| D23 | 文档、playbook 与评测 |

---

## 1. 背景与问题

| # | 问题 | 证据 |
|---|---|---|
| 1 | 助手个体不能共享 | channel 目录同时是记忆、任务和工作文件的唯一归属。`bootstrap.ts` 的 `getRunner` 用 `ensureChannelDir(workspaceDir, channelId)` 为每个频道建一个目录，两个群无法指向同一份积累 |
| 2 | 新群会自动长出一个新个体 | 任何一条消息都会触发 `ensureChannelDir`，在磁盘上留下一个目录。workspace 下 `dm_tester`、`dm_162403` 这类目录没人认领，也没有名字 |
| 3 | 频道 id 当路径，转义机制脆弱 | 群 id 是 base64，含 `/`。`channel-paths.ts` 把 `/` 折成 `__`，但这一步不可逆，于是又衍生出：`dedupeChannelIdsByDirectory`、`discoverWorkspaceChannelIds` 的"索引优先、目录兜底"、`run-registry.ts` 读记录反查真实 id、`task-migration` 的严格模式报错 |
| 4 | 转义已经造成过真实故障 | `subagents/runs.ts` 的注释写明：用裸 `join` 时，每个群的委派记录都会多嵌一层目录，重启后全部丢失。**`jobs/manager.ts` 至今仍用裸 `join(jobsStateDir, channelId)`**，群频道的后台 job 重启后无法恢复 |
| 5 | project 概念鸡肋 | 用户的 `security.json` 没有配置 `projectAccess`，`boundary` 始终是 `unbounded`。`project.json` 唯一的作用是把 cwd 设成 `/home/oyasmi`。为了它，path-guard 多了一套 `boundary: "project"` 分支和 `isChannelDirAccess` 例外，还有 `/project` 命令和一个 159 行的 store |
| 6 | 隐式依赖目录层级 | `skills/loader.ts` 用 `join(channelDir, "..", "skills")` 找技能目录；`ChannelRunner` 和 `maintenance-context.ts` 用 `dirname(channelDir)` 推出 workspace。这些写法都依赖"channel 目录是 workspace 的直接子目录" |

## 2. 目标

- **G1 一个个体，多个入口。**同一个 dot 可以同时在多个钉钉群和私聊里使用：长期记忆、任务、事件和文件共享，各频道的对话上下文分开。
- **G2 个体只能显式创建。**dot 只能由 `/dot new`（或迁移脚本，或 TUI 的 `--create`）显式创建。运行时绝不因为某条消息而自动建出一个 dot。
- **G3 后台工作的去向都写明。**每项后台工作都明确写出投递到哪个频道，不存在"主频道""默认频道"这类推断。
- **G4 路径里没有频道 id。**磁盘上任何路径段都不由 channelId 推导，转义、去重、反查代码全部删除。
- **G5 dot 取代 project。**dot 的目录就是工作目录，project 相关的代码、配置和文档全部清理。
- **G6 平滑迁移。**现有频道目录由一个独立脚本迁移成指定名字的 dot，并建立好绑定；迁移前自动备份，支持先在副本上演练。

## 3. 概念与术语

| 术语 | 含义 | 用户界面 |
|---|---|---|
| **dot** | 一个有名字的独立助手个体，拥有自己的记忆、日记、任务、事件和工作文件 | 保持英文 `dot` |
| **频道（channel）** | 消息的入口和出口：`dm_<staffId>`、`group_<conversationId>`、TUI 的 `tui`。只是一个地址 | 频道 |
| **绑定（binding）** | 频道到 dot 的指向。一个频道最多一条，记录在 `dots/bindings.json` | 绑定 |
| **会话区（conversation）** | 某个频道在某个 dot 里的对话记录目录，存放会话 jsonl、active-session 指针和消息归档。它属于 dot，频道换绑走以后会话区仍然留在原 dot 里 | 不对用户出现 |
| **投递频道** | 一项后台工作（任务、事件、委派或 job 的完成唤醒）要把结果发往的频道，在该工作自己的数据里显式写明 | 投递频道 |
| **激活 / 休眠** | daemon 正在服务某个 dot，叫激活；dot 没有任何绑定、daemon 已放手不管，叫休眠 | 休眠的 dot 在 `/dot list` 中显示为"未绑定频道，后台工作已暂停" |
| **挂起** | 一项后台工作因为投递频道不再绑定在本 dot 上而暂停，绑定恢复后自动继续 | 已暂停 |

文案沿用 053 的规则：设计用词"会话区""激活""休眠"只出现在 spec 和模型可见的文本里。用户界面只说 dot、频道、绑定、暂停，并在 053 D4 术语表中追加"dot""绑定""投递频道"三项。

## 4. 决策

### D1 dot 是一等概念：所有权划分

| 归属 | 内容 | 说明 |
|---|---|---|
| **workspace（全部 dot 共享）** | `SOUL.md`、`AGENTS.md`、`ENVIRONMENT.md`、workspace 级 `MEMORY.md`、`skills/`、`sub-agents/`、`CHANNELS.md`，以及 workspace 根下用户自建的目录（如 `automation/`、`prompts/`） | 不变 |
| **dot** | `MEMORY.md` 索引、`memory/`、`journal/`、`memory-review.jsonl`、`tasks/`（任务说明、循环日志、`.sessions/`、`archive/`）、`events/`、`subagent-runs.jsonl`、`subagent-artifacts/`、`inbox/`、`web-cache/`、`logs/`，以及全部工作文件（dot 目录就是 cwd） | 原来 channel 目录里的东西基本都归这里 |
| **dot 里的会话区** | 会话 jsonl、`active-session.json`、`context.jsonl`、`log.jsonl`、`log.jsonl.1`、`.sync-offset` | 一个（dot, 频道）组合一个会话区 |
| **频道** | 绑定（`dots/bindings.json` 中的一条），以及钉钉路由元数据（`state/dingtalk/conversations.json` 中的一条） | 频道自己不拥有任何目录 |

两条直接推论：

- **会话属于 dot。**频道 A 在 dot X 里的对话用的是 X 的记忆，X 的 reflect 也需要读到它。所以 A 换绑到 Y 以后，A 在 X 里的会话区原样留在 X。将来 A 绑回 X，会接着之前的会话继续。
- **同一个 dot 下，各频道的上下文互不可见。**群 B 不会在上下文里看到私聊 A 刚说的话。A 中沉淀下来的东西经 reflect 进入记忆和日记后，B 才能看到；需要原文时可以用 `session_search`，它的检索范围是整个 dot（D12）。

### D2 磁盘布局

```
~/.pipiclaw/
  workspace/
    SOUL.md AGENTS.md ENVIRONMENT.md MEMORY.md skills/ sub-agents/ …   ← 共享，不变
    CHANNELS.md                       ← 频道索引；新增「dot」列（D17）
    dots/
      bindings.json                   ← 频道 → dot，唯一事实来源（D4）
      <dot>/
        dot.json                      ← 名字、创建时间、会话区登记（D3）
        .locks/                       ← 跨进程短锁：memory.lock、dot-json.lock、task-<id>.lock（D6）
        MEMORY.md memory/ journal/ memory-review.jsonl
        tasks/  events/
        conversations/
          dm-1/                       ← 某个私聊在本 dot 里的会话区
            <ts>_<uuid>.jsonl … active-session.json context.jsonl log.jsonl .sync-offset
          group-1/
          tui-1/                      ← TUI 运行期间在其中持有 .lock（D6）
        subagent-runs.jsonl subagent-artifacts/ inbox/ web-cache/ logs/
        …工作文件（cwd）
    .legacy/                          ← 迁移脚本放置未迁移内容的地方（D20）
  state/
    memory/<dot>/<会话区>.json         ← 记忆维护状态，每个会话区一份（D12）
    subagent-runs/<dot>/run_*.json
    jobs/<dot>/*.json
    dingtalk/conversations.json       ← 原来每个频道一个 .channel-meta.json（D17）
    dispatch/  events/history.jsonl  usage/  logs/   ← 位置不变，记录里增加 dot 字段
```

规则：

- **路径段只来自四种来源**：dot 名、会话区名、固定文件名，以及资源自己的 id（任务 id、run id、job id、事件名）。这四种都在各自的入口校验过字符集。
- **新代码不得把 channelId 拼进路径**（INV-3）。

### D3 dot 名、`dot.json` 与会话区

**dot 名**

- 必须匹配 `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`：1–32 个字符，只有小写字母、数字和连字符，不能以连字符开头或结尾。
- 命令参数先转小写再校验。
- 不支持中文名。dot 名会出现在目录名、事件 JSON、日志、dispatch id 和 shell 命令里，只允许 ASCII 能避免一整类问题。需要给人读的说明，以后可以放在 `dot.json` 里加的 `title` 字段中，v1 不做。

**`dot.json`**

```json
{
  "version": 1,
  "name": "news",
  "createdAt": "2026-10-20T10:00:00+08:00",
  "conversations": {
    "dm_015262473638858016": { "dir": "dm-1", "createdAt": "2026-10-20T10:00:00+08:00" },
    "group_cidL1/dcU8u+SV7I9YuUXLeXg==": { "dir": "group-1", "createdAt": "2026-10-21T09:12:00+08:00" },
    "tui": { "dir": "tui-1", "createdAt": "2026-10-22T20:00:00+08:00" }
  }
}
```

- **`name` 必须等于目录名。**不一致的 dot 视为不可用，并给出诊断信息。
- **`conversations` 是只增不减的登记**：哪些频道在本 dot 里有过对话，以及对应的会话区目录名。频道 id 在这里只作 JSON 的键。
- **会话区目录名**：
  - 格式为 `<kind>-<n>`。kind 由频道 id 前缀决定：`dm_` 对应 `dm`，`group_` 对应 `group`，`tui` 对应 `tui`。
  - n 取该 kind 在本 dot 已用最大序号加 1。
  - 目录名在分配时确定，此后永不改变。可读，并且与频道 id 的字符集无关。
- **何时分配**：频道第一次绑定到本 dot 时分配（TUI 是第一次打开本 dot 时），必须在写绑定表之前先写好（D5）。
- **写入要求**：daemon 和 TUI 都可能写 `dot.json`，所以"读、改、写"整个过程要持有跨进程短锁 `.locks/dot-json.lock`（D6），落盘仍用原子写。

### D4 绑定表与未绑定频道

**`workspace/dots/bindings.json`**

```json
{
  "version": 1,
  "bindings": {
    "dm_015262473638858016": { "dot": "main", "boundAt": "2026-10-20T10:00:00+08:00" },
    "group_cidL1/dcU8u+SV7I9YuUXLeXg==": { "dot": "invest", "boundAt": "2026-10-20T10:00:00+08:00" }
  }
}
```

- **它是"频道 → dot"的唯一事实来源**（INV-1），只有 daemon 写；TUI 不写绑定。
- **daemon 启动时读入内存**，之后内存为准，每次变更原子写回磁盘。运行中不支持手工编辑这个文件，要改须先停 daemon。
- **文件缺失**表示还没有任何绑定，属于全新安装的正常状态。
- **文件损坏或 `version` 不认识**时，daemon 拒绝启动，并给部署者一条英文错误。理由是：静默把所有频道当作"未绑定"会让后台工作全部挂起而无人察觉；而且用户重新绑定时，可能误绑到错误的 dot 上。
- **绑定指向不存在或不可用的 dot**（目录缺失、`dot.json` 损坏、名字不一致）时，该频道视为"已绑定但不可用"：人发的消息收到原因说明，后台工作不投递。**不会**退化成"未绑定"。

**未绑定频道**（新拉进的群、新的私聊、绑定已被手工移除的频道）：

- **不创建任何目录或文件**，不建 runner，不归档消息，不下载图片（`persistInboundImage` 直接返回 `null`）。
- **只响应两类命令**：`/dot ...` 照常处理；`/help` 照常回复。
- **其他消息**一律回复一条提示，不调用模型。建议文案（按 053 的报错形状写：一个原因、一个下一步）：`本频道还没有绑定 dot。用 /dot 查看已有的 dot，再用 /dot bind <名字> 绑定；需要新的就先 /dot new <名字>。`
- **`/stop`、`/new`、`/steer`、`/followup`**：没有 runner 可操作，同样回复上面这条提示。
- **后台工作**不会以未绑定频道为目标；即使出现（比如手写的事件），也会在入队和准入两处被丢弃（D7）。
- **频道索引**仍然记录这个频道（D17），这样 `/dot` 列表里能显示群名。

### D5 命令

命令只有一个 `/dot`，包含三个动作：

| 命令 | 语义 | 忙碌时 |
|---|---|---|
| `/dot` 或 `/dot list` | 列出所有 dot：每个 dot 绑定了哪些频道（显示频道名称），哪个是本频道当前的 dot，哪些处于休眠或不可用 | 可用 |
| `/dot new <dot>` | 创建一个空 dot：建目录，写 `dot.json`。**不绑定**任何频道。名字不合法或已存在时报错 | 可用 |
| `/dot bind <dot>` | 把本频道绑定到这个 dot，同时自动解除原来的绑定 | 拒绝，提示等本回合结束后再执行 |

命令按 054 的约定放置：

- catalog 条目放在 `commands/catalog.ts`。删掉 `project`，加上 `dot`，`availableWhileBusy: true`；`bind` 在忙碌时由处理器自己拒绝。
- 处理器放在 `dot/commands.ts`，通过一个端口调用运行时能力：

  ```ts
  interface DotCommandPort {
    list(): DotSummary[];
    create(name: string): Promise<CreateOutcome>;
    bind(name: string): Promise<BindOutcome>;   // TUI 不提供
  }
  ```

- `commands/router.ts` 里加一个 `case "dot"`。daemon 端由 `DotRuntime` 实现这个端口；TUI 不提供 `bind`，`/dot bind` 回复"终端不支持绑定，用 `--dot` 选择 dot"。

**`/dot bind <dot>` 的执行顺序**

所有步骤都在本频道的队列项里执行。空闲时的运行时命令本来就经过频道队列，所以后面排队的消息会在绑定完成之后才处理。

1. **校验**：名字合法；dot 存在且可用；本频道不忙。如果本频道已经绑定在这个 dot 上，回复"本频道已经绑定在 dot `x` 上。"，不做任何事。
2. **激活目标 dot**（D6）：启动它的事件 watcher，把它加入后台扫描。目标 dot 此时是否正被 TUI 打开，都不影响绑定。
3. **分配会话区**：本频道在目标 dot 里第一次出现时，分配会话区并写 `dot.json`。这一步是幂等的，即使后续步骤失败也无害。
4. **写绑定表**：绑定表一写入，绑定就算成功。
5. **移出并释放旧 runner**：先把它移出 runner 缓存，再 `await runner.dispose()`。`dispose` 里的 `flushForShutdown` 会对旧 dot 做最后一次 reflect，让这段对话的积累落进旧 dot 的记忆。dispose 失败只记日志，不影响已经提交的绑定。
6. **处理旧 dot**：
   - 旧 dot 如果已经没有任何绑定，交给 `DotRuntime` 安排休眠（D6）。
   - 旧 dot 里以本频道为投递频道的任务和事件，从此处于挂起状态（D8）。
7. **回复**：一句确认，必要时附上影响说明。例如：
   - `本频道已绑定到 dot \`news\`。`
   - `原 dot \`old\` 已没有绑定的频道，它的定时事件和任务已暂停，重新绑定后自动恢复。`
   - `原 dot \`old\` 中以本频道为投递频道的 2 个任务、1 个定时事件已暂停。`

**再次绑回**一个 dot 时，沿用本频道在那里的会话区和其中 active 的会话，接着之前的对话。想重新开始就用 `/new`。

**`/dot list` 的回复**按 053 的报告形状写：粗体首行，下面一层扁平的 `- ` 列表，经过 `capReply`。频道名称取自频道索引；查不到名称的频道显示 id。示例：

```
**dot 列表**
- `news`（本频道）：私聊「泙漫」、群「投资成长」
- `main`：私聊「齐渊」
- `lab`：未绑定频道，后台工作已暂停
```

### D6 `DotRuntime`：激活、休眠与跨进程共享

新增 `runtime/dot-runtime.ts`，它是 daemon 里唯一回答以下问题的地方：

- 某个频道绑定在哪个 dot 上；
- 哪些 dot 处于激活状态；
- 绑定如何变更。

文件读写交给 `dot/registry.ts`；`DotRuntime` 负责把它和事件 watcher、job、run 的生命周期串起来。

**激活**的时机：daemon 启动时，以及某个 dot 获得第一条绑定时。在每个 dot 的串行队列里依次执行：

1. 对本 dot 中**当前绑定频道**的会话区做中断回合修复扫描，即原来 `scanWorkspaceForInterruptedTurns` 做的事；
2. 启动本 dot 的 `EventsWatcher`；
3. 把本 dot 加入 task driver 和记忆调度器的遍历集合。

**休眠**的时机：dot 失去最后一条绑定时。在同一个串行队列里依次执行：

1. 停止事件 watcher；
2. 从后台扫描集合中移除。

正在运行的 run 和 job 不受影响：照常跑完、照常结算，只是唤醒不投递（D7）。它们的 manager 一直保留到进程结束。

**job 和 run 的恢复不依赖绑定。**daemon 启动时，按 `state/subagent-runs/<dot>/` 和 `state/jobs/<dot>/` 中存在的目录逐个恢复，不管这个 dot 有没有绑定。这样在休眠前还在跑的外部 run，重启后仍然有人负责接管和结算。

**为什么没有绑定的 dot 要休眠**："没有任何频道能收到结果"时，后台工作就不该继续花钱。这一点是用户确认过的取舍（§8 第 10 条）。

**daemon 和 TUI 共享一个 dot**

TUI 能打开任何 dot，不论它有没有绑定、daemon 是否正在服务它（D18）。所以同一个 dot 可能同时被两个进程写入。应对方式是：**不让任何进程独占整个 dot，只在真正共享写入的文件上加跨进程短锁。**

| 文件 | 可能的写入方 | 保护方式 |
|---|---|---|
| 记忆：`MEMORY.md`、`memory/`、`journal/`、`memory-review.jsonl` | daemon 的工具调用、reflect、lifecycle；TUI 的工具调用、lifecycle | `DotMemoryQueue`：先过进程内串行队列，再持有跨进程锁 `dots/<dot>/.locks/memory.lock`（INV-8） |
| 任务：`tasks/<id>.md`、`<id>.jsonl` | daemon 的 task driver、工具调用、`/tasks`；TUI 的工具调用、`/tasks` | `withTaskMutation`：先过进程内串行队列（可重入，不变），再持有跨进程锁 `dots/<dot>/.locks/task-<id>.lock` |
| `dot.json` | daemon 的 `/dot bind`；TUI 第一次打开 dot 时 | 跨进程锁 `dots/<dot>/.locks/dot-json.lock`（D3） |
| 会话区 `conversations/<会话区>/` | 只有它的所有者：已绑定频道的会话区只由 daemon 写；`tui-N` 由打开它的那个 TUI 写 | 后者需要会话区锁（见下）；daemon 的记忆调度器和中断回合修复只处理已绑定频道的会话区，从来不碰 `tui-N` |
| `state/memory/<dot>/<会话区>.json` | 该会话区的所有者 | 按会话区分开存放，本身就不共享 |
| `events/*.json` | 两个进程的 `event_manage` 都会写；daemon 的 watcher 读 | 整文件原子写，与现在相同。两个进程同时写同名事件时以后写的为准，可以接受 |
| `state/subagent-runs/`、`state/jobs/`、`bindings.json`、`state/dingtalk/` | 只有 daemon 写。TUI 的 run 和 job 现在就不落盘，这一点保持不变 | 不需要 |
| 用量账本、工作文件 | 两边都写 | 用量账本是追加写，现在就是两个进程共写。工作文件不加保护，就像两个人同时编辑同一批文件 |

**跨进程锁**（`shared/file-lock.ts`）是一个不含领域知识的通用工具：

- **获取**：用 `open(path, "wx")` 独占创建锁文件，内容为 `{ pid, hostname, acquiredAt }`。
- **锁文件已存在时**：同主机且 pid 已不存在，判定为陈旧锁，删除后重试；否则按退避间隔等待，直到超时。超时时间是代码常量。记忆锁会跨着一次 reflect 的模型调用一直持有，所以它的超时要比一次 reflect 的最长时间更长。
- **释放**：只删除自己持有的锁，删除前再核对一次 pid。
- **使用方式**：提供两种形式。
  - 短锁 `withFileLock(path, fn)`：给记忆、任务、`dot.json` 用；
  - 长锁 `acquireFileLock(path)`，返回句柄：给 TUI 的会话区锁用。
- **超时后的处理**：工具调用抛出 `RecoverableToolError`，告诉模型"记忆或任务正在被另一个进程写入，稍后重试"；后台任务跳过这一轮，下一轮再试。

**同一个会话区同一时刻只能有一个写入进程。**两个 TUI 同时打开同一个 dot 时，会共用 `tui` 频道的会话区，同时写一个会话文件。所以 TUI 运行期间持有 `conversations/tui-N/.lock`，第二个 TUI 打开同一个 dot 时报错退出。这条规则针对的是同一个会话文件，与 dot 有没有绑定无关：daemon 已经在服务的 dot，TUI 照样能打开。

### D7 投递目标：没有主频道

每项后台工作都在自己的数据里**显式**写明投递频道，运行时不做任何推断（INV-4）：

| 后台工作 | 投递频道写在哪里 | 由谁写入 |
|---|---|---|
| 前台回合 | 回合就是由这个频道的消息触发的 | — |
| 委派完成唤醒和进度通知 | run 记录的 `channelId`（发起委派的那个会话所属的频道） | `SubAgentRunManager` 注册 run 时 |
| 后台 job 完成唤醒 | job 记录的 `channelId` | `DotJobManager` 启动 job 时 |
| 任务（每一步、停止回执、周期实例跳过回执） | 任务 frontmatter 的 `channel:` 字段（D13） | `task_create` 写入当前频道；事件模板生成实例时写入事件的 `channelId` |
| 定时事件（`text` 或 `task` 模板） | 事件文件的 `channelId`（D14） | `event_manage` 写入当前频道；也可以手工编辑 |

**有效性规则**：一项后台工作只投递给"当前仍绑定在产生它的那个 dot 上"的频道（INV-5）。不满足时，这项工作进入挂起状态（D8），不改投到别的频道，不报错打扰任何人。

**两道检查**，缺一不可：

1. **生产时检查**：task driver、事件 watcher、run 和 job 的唤醒生产者在产生事件之前，先查 `DotRuntime.isBoundTo(channelId, dot)`。不满足就不产生，各自记录挂起，避免无谓的 dispatch 记录。
2. **准入时检查（权威）**：
   - `ChannelEvent` 新增 `dot?: string` 字段，表示"这个合成事件是为哪个 dot 产生的"。所有进程内生产者都必须填它。
   - `DurableDispatchService.dispatch()` 拒绝没有 `dot` 的事件，返回 `false` 并记 warn。
   - `runEventTurn` 在 `getRunner` 之前核对：`event.dot` 存在，并且频道当前绑定的 dot 不等于它，就把这条 dispatch 记录标记为 completed，记 `dispatch.wake.dot_mismatch`，**不调用模型**。

   这一道检查兜住所有时间差：比如重启前排队、重启后才投递的唤醒；在队列里等待期间频道被换绑；迁移前遗留的 dispatch 记录。

**不经过 dispatch、直接发送的后台通知**也必须过同一道守卫。共有 4 处，都在 `bootstrap.ts`：

- dispatch 耗尽通知；
- run 进度和结算通知；
- 周期实例跳过回执；
- 任务停止回执。

统一改为调用 `DotRuntime.sendFromDot(dot, channelId, text)`：绑定不符时不发送，只记 info。前台路径（命令回复、`/stop` watchdog、忙碌提示）不经过这道守卫，因为它们本来就是对当前频道当前消息的回应。

**dispatch id 的格式**：去掉 channelId，换成 dot。

- `task:<dot>:<taskId>:…`
- `subagent:<dot>:<runId>:done`
- `job:<dot>:<jobId>:done`
- `event:<dot>:<name>:…`

这样 dispatch id 的组成部分全部来自已经校验过的安全字符集。`durable-dispatch.ts` 对文件名的 `encodeURIComponent` 是针对任意不透明 id 的通用编码，与频道无关，保留不动。

### D8 挂起与恢复

| 层级 | 何时发生 | 表现 | 何时恢复 |
|---|---|---|---|
| **整个 dot 休眠** | dot 没有任何绑定 | daemon 不为它建 runner，不扫描任务，不运行事件 watcher，不做 reflect；正在运行的 run 和 job 照常跑完、结算，只是不投递。这时 TUI 仍然可以打开它正常对话 | 有频道绑定上来、dot 重新激活时 |
| **单个任务挂起** | 任务的 `channel` 没有绑定在本 dot 上（包括字段缺失） | task driver 对这个任务什么都不做：不兑现等待条件，不检查最晚时间，不派发步骤，不发回执。整个任务原样冻结 | 投递频道重新绑定到本 dot 后，下一次扫描时从冻结前的状态继续 |
| **单次事件跳过** | 事件触发时，`channelId` 没有绑定在本 dot 上 | 本次不派发、不生成实例，history 记一条 `skipped`，reason 为 `channel_not_bound` | 事件本身没有暂停，下一次触发时再检查 |
| **完成唤醒丢弃** | run 或 job 结算时，发起它的频道已不在本 dot 上 | 照常结算，包括用量、产物和任务的 `settle` 记录，只是不派发唤醒；同时把唤醒的幂等标记置位，避免以后重放 | 不恢复。结果留在 run 或 job 记录和产物里，可以用 `/subagents` 查看 |

任务挂起时**整体冻结**（连等待条件的兑现和最晚检查时间都暂停），而不是只停派发，原因是：

- 最晚检查时间的兜底（051 D3）会在连续两次过期后暂停任务，并发一条回执；
- 在没人能收到回执的状态下继续计数，只会在绑定恢复的那一刻弹出一个"已暂停"，这不是用户想要的。

冻结只读不写，所以恢复时等待条件仍然有效。已经过期的会在恢复后的第一次扫描里按原规则处理。

**挂起状态如何可见**：

- `/tasks` 列表里，挂起的任务带上"（已暂停：投递频道未绑定到本 dot）"字样；投递频道不是本频道时，显示频道名。
- `/events list` 对 `channelId` 未绑定的事件做同样的标注。
- 进入挂起状态时记一次 info 日志（同一个任务只在状态切换时记），不在每次扫描时刷屏。

### D9 删除 project

删除内容：

- **命令**：`/project`，以及 `channel/commands.ts` 里的 `handleProjectCommand`。
- **存储**：`channel/project-scope-store.ts`、`project.json`。
- **安全层**：`security/project-scope.ts`、`ProjectScope`、`ProjectAccessPolicy`；`SecurityRuntimeContext` 里的 `projectRoot`、`boundary`、`channelDir`；path-guard 里的 `boundary: "project"` 分支、`isWithinProjectRoot`、`isAgentWorkspaceSkillsAccess`、`isChannelDirAccess`；`security.json` 的 `projectAccess` 键。
- **工具和委派**：`tools/index.ts` 的 `projectScope`；subagent 的 `projectBoundary` 和 `assertWithinProjectBoundary`。
- **turn-handler**：`/new` 里用来求 cwd 的那段 project 解析，以及 `onScopeChanged` 回调。

替代规则：

- **cwd 就是 dot 目录。**shell 的 cwd、通用文件工具解析相对路径时的基准、`SessionManager` 和 `DefaultResourceLoader` 的 `cwd`、委派默认的 `workingDirectory`，全部用 dot 目录。`SecurityRuntimeContext` 改为 `{ agentWorkspaceDir, cwd, homeDir }`。
- **路径守卫**保持现在"未配置 `projectAccess`"时的全局默认，也就是 workspace、临时目录和 home。用户现在的配置正是这种状态，所以守卫行为不变。
- **`security.json` 里仍有 `projectAccess` 时**：加载时报一条退役键 warn（与 `RETIRED_SETTINGS_KEYS` 的做法一致），然后忽略。
- **行为变化**：用户现在的 cwd 是 `project.json` 里的 `/home/oyasmi`，改为 dot 目录以后：
  - 依赖默认 cwd 的相对路径和委派会落到 dot 目录里；
  - 访问别处要用绝对路径，委派代码仓库要显式传 `workingDirectory`；
  - `runtime-orientation.md` 和 `agent-delegation.md` 两个 playbook 必须同步改写（D23）。
- **以后需要"默认工作目录"时**，在 `dot.json` 里加字段，v1 不做。

### D10 删除 channelId 的路径转义

channelId 从此只作数据键：JSON 的键、记录里的字段、日志字段、CHANNELS.md 表格里的单元格。**永远不作路径段**（INV-3）。删除的代码：

| 代码 | 现在的用途 | 之后 |
|---|---|---|
| `channel/channel-paths.ts`（`getChannelDir`、`getChannelDirName`、`ensureChannelDir`、`dedupeChannelIdsByDirectory`） | 频道目录与转义 | 整个文件删除。channelId 的格式校验和类型判断移到新的 `channel/channel-id.ts`（D11） |
| `channel/channel-index.ts` 里的 `discoverWorkspaceChannelIds`、`readChannelIndexIds` | 后台服务从索引和目录里拼出频道列表 | 删除。后台服务改为遍历激活的 dot 和绑定表 |
| `memory/scheduler.ts` 的 `listStateChannels` 和 `discoverMemoryMaintenanceChannels` | 从状态目录反查频道 | 删除。改为遍历当前绑定，每个绑定对应一个（dot, 会话区）组合 |
| `subagents/run-registry.ts` 的 `listRecordChannelIds` | 读记录反查真实 id | 删除。按 dot 目录名恢复，dot 名就是目录名，不需要反查 |
| `runtime/task-driver.ts` 的 `discoverTaskChannels` | 同上 | 删除。改为遍历激活的 dot |
| `jobs/manager.ts` 里的 `join(jobsStateDir, channelId)` | job 记录目录，这处现在还有 bug | 改为 `join(jobsStateDir, dot)` |
| `dingtalk/conversation-meta.ts` 里每个频道一个的 `.channel-meta.json` | 路由元数据 | 合并成一个文件 `state/dingtalk/conversations.json`，以频道 id 为键（D17） |
| `turn-recovery.ts` 的 `CHANNEL_DIR_PREFIXES` 扫描 | 启动时修复 | 改为在激活时，对该 dot 中当前绑定的会话区做修复（D6） |

验收时用一条检索证明 INV-3：`src/` 下不存在由 channelId 拼成路径的代码（具体检索式见 plan P2 闸门）。

### D11 模块与分层

**新模块 `src/dot/`**，放在 layer 2，可以 import 第 0–1 层：

| 文件 | 职责 |
|---|---|
| `dot/types.ts` | `DotRecord`（`dot.json`）、`DotBinding`、`DotConversation`（`{ dot, dotDir, channelId, conversation, conversationDir }`）、`DotSummary` |
| `dot/paths.ts` | `DOTS_DIRNAME`、`getDotsDir`、`getDotDir`、`getConversationDir`、`getBindingsPath`、`isDotName`、`normalizeDotName` |
| `dot/registry.ts` | 读写 `dot.json` 和 `bindings.json`：列出 dot、创建 dot、分配会话区、读取和替换绑定、加载时的诊断。分配会话区所需的频道 kind 由调用方传入，dot 不解析频道 id 的格式（格式规则在 `channel/channel-id.ts`） |
| （不在 `dot/` 里）`shared/file-lock.ts` | 跨进程锁的通用实现（D6）。不含领域知识，tasks、memory、dot 都会用到，所以放在 layer 0 |
| `dot/commands.ts` | `/dot` 的解析、渲染和 `DotCommandPort` 接口 |

**`check-architecture.mjs` 与 `AGENTS.md` 模块表的变更**（两处必须一起改）：

- 新增 `dot: L01`。
- 以下模块的"可以 import"里加入 `dot`：`channel`、`memory`、`events`、`jobs`、`subagents`。`BELOW_TOOLS` 也加入 `dot`，这样 `tools`、`agent` 以及更上层都能用。
- `tasks` 保持 L01，**不** import `dot`。任务模块只接收一个 `dotDir: string`，参数命名用 dot 的术语，这样任务模块仍然是叶子。

**全仓命名迁移**：凡是表示"本体"的地方都改成 dot，不保留 channel 的旧名。

| 旧 | 新 |
|---|---|
| 参数和字段 `channelDir`（表示本体时） | `dotDir`；表示会话区时用 `conversationDir` |
| `memory/channel-maintenance-queue.ts`、`ChannelMemoryQueue` | `memory/dot-memory-queue.ts`、`DotMemoryQueue`，**以 dot 名为键** |
| `ChannelJobManager` | `DotJobManager`（每个 dot 一个） |
| `SubAgentRunManager`（每个频道一个） | 名字保留，改为每个 dot 一个；`run-registry` 的 `get(dot)` |
| `MemoryMaintenanceRuntimeContext.{channelId, channelDir}` | `{ conversation: DotConversation }` |
| `createRunner(channelId, channelDir, …)` | `createRunner(conversation: DotConversation, …)` |
| turn capsule 里的 "Channel directory" | "Dot directory" 等（D16） |
| 文档中的"频道记忆""频道目录" | "dot 记忆""dot 目录" |

`ChannelRunner` **保留原名**：它确实是一个频道一个，持有一个 `DotConversation`。`ChannelQueue`、`ChannelContext`、`ChannelEvent`、`ChannelStore`（消息归档）也是频道或地址层面的概念，名字不变。

**消除隐式的目录层级依赖**：

- `loadPipiclawSkills(channelDir)` 改为 `loadPipiclawSkills(workspaceDir)`；
- `ChannelRunner` 和 `maintenance-context.ts` 里的 `dirname(channelDir)` 改为显式传入 `workspaceDir`。

`DotConversation` 本身不携带 workspace 路径，是否携带由调用方的 paths 决定。

### D12 记忆

- **存储在 dot 级**：`MEMORY.md`、`memory/`、`journal/`、`memory-review.jsonl`。050 的一事一文件机制不变，只是根目录从频道目录换成 dot 目录。
- **所有写入方共用以 dot 为键的队列**：`memory_save` 和 `memory_forget`、reflect job、lifecycle 的边界 reflect、`/memory` 命令。**这是正确性要求**：同一个 dot 下的两个频道如果用不同的键，就会并发写同一份记忆。验收用例覆盖它（plan P2）。
- **队列同时持有跨进程锁** `.locks/memory.lock`（D6）：daemon 和 TUI 可能在同一个 dot 上同时写记忆，进程内队列管不到另一个进程。
- **reflect 的单位是"会话区"**：素材是某个频道在本 dot 里的会话，写入目标是 dot 的记忆。维护状态（脏标记、空闲计时、`lastReflectedEntryId`、退避时间）是会话的属性，所以按会话区存放在 `state/memory/<dot>/<会话区>.json`。
- **调度器遍历当前绑定**：每条绑定对应一个（dot, 会话区）候选。
  - 没有 runner 的候选，用 detached 上下文从会话区加载会话；
  - 已解绑的会话区不再参与空闲 reflect，因为解绑时 `dispose` 已经做过最后一次 reflect；
  - 休眠的 dot 不参与。
- **`session_search` 检索整个 dot**：所有会话区的会话 jsonl 和 `log.jsonl`。每条结果标注它来自哪个会话区，并显示频道名。
- **首回合注入**（`<memory_bootstrap>`）在 dot 级，不变。
- **日记行**由 reflect 追加。v1 不在日记里标注来自哪个频道。

### D13 任务

- **存储在 dot 级**：`tasks/<id>.md`、`<id>.jsonl`、`.sessions/`、`archive/` 都在 dot 目录下。task store、ticket、budget、bound-work 的机制全部不变，只把根目录换成 dot 目录。
- **任务修改跨进程串行**：`withTaskMutation` 在进程内队列之外，再持有 `.locks/task-<id>.lock`（D6）。所有修改任务文件的路径本来就要经过它，实施时逐个核对。`mutation-lock.ts` 里"一个 workspace 只支持一个进程"的注释要同步改掉。
- **在 TUI 里创建的任务和事件**，投递频道是 `tui`。`tui` 不会出现在绑定表里，所以 daemon 永远不会推进或投递它们，这和现在 TUI 的行为一致：TUI 本来就不运行 task driver。要让任务在后台运行，就在钉钉频道里创建，或者手工把 `channel` 改成某个已绑定的频道。
- **frontmatter 新增 `channel:`**，值是投递频道 id，写成一行纯文本，例如 `channel: group_cidL1/dcU8u+SV7I9YuUXLeXg==`。
  - `FIELD_ORDER` 改为 `state, paused, channel, origin, ticket, usage, budget`；归档时也保留这个字段。
  - **写入方**：`task_create` 写当前回合的频道；事件模板生成实例时写事件的 `channelId`；在任务步骤里新建的任务，写当前步骤所在的频道，也就是父任务的投递频道。
  - **v1 不提供用工具修改**，`task_update` 不加这个参数。需要改投递频道时，用户手工编辑 frontmatter；内容是纯文本，可读可改。
  - 字段缺失或无法解析时，任务进入挂起状态（D8），由 `/tasks doctor` 报告。
- **task driver 的遍历**改为"激活的 dot → 任务"，`channel` 未绑定在本 dot 上的任务直接跳过（D8）。
  - 派发时检查的忙碌状态，是投递频道 runner 的忙碌状态；
  - `maxDispatchesPerTick` 仍然是全局上限；
  - 轮转公平性的游标从按频道改为按 dot。
- **任务步骤在投递频道的 runner 上运行**（`bindTaskSession`）。`prepareTaskStep` 要额外核对 `event.dot` 等于这个 runner 的 dot；准入检查已经保证了这一点，这里再做一次断言，作为防御。
- **`/tasks`** 列出本 dot 的全部任务。投递频道不是本频道时，显示投递频道名称，并标注挂起状态。`/tasks steer`、`/tasks reply` 可以在本 dot 的任意绑定频道里执行：`reply` 兑现等待条件以后，下一步仍然在投递频道里运行。
- **`/stop` 暂停任务**的逻辑不变，任务文件在 dot 目录下。

### D14 事件

- **事件归 dot 所有**：事件文件从 `workspace/events/` 移到 `dots/<dot>/events/`。事件名只需在本 dot 内唯一，`MAX_EVENT_FILES` 的上限也按 dot 计算。
- **每个激活的 dot 有一个 `EventsWatcher`**（这个类本来就是"一个目录一个实例"），dot 激活时启动、休眠时停止。
- **`channelId` 保留为必填字段**，含义改为"投递频道"；事件的归属由文件所在的 dot 隐含。
  - 触发时检查投递频道是否绑定在本 dot 上（D7、D8）；
  - `event_manage` 写入当前频道，模型不能传这个字段（现有行为不变）；
  - 用户可以手工把它改成本 dot 的另一个绑定频道。
- **dispatch id** 改为 `event:<dot>:<name>:…`。
- **history 记录**新增 `dot` 字段；`/events history` 只显示本 dot 的事件。
- **task-spawn** 改为接收 dot 目录，生成的实例 frontmatter 带上 `channel`。spec 052 INV-8（事件不读写任务文件）不变。
- **`/events`** 列出、查看、删除和查询 history 的范围都是本 dot。

### D15 委派与后台 job

- **manager 按 dot 组织**：`runs.get(dot)`、`jobs.get(dot)`；记录目录为 `state/subagent-runs/<dot>/`、`state/jobs/<dot>/`。
- **记录里保留 `channelId`**，表示发起方频道，用于唤醒和通知（D7）。记录格式不新增 dot 字段，dot 由所在目录隐含。
- **产物和日志**：`subagent-artifacts/`、job 的 spill 日志 `logs/` 放在 dot 目录下。
- **完成唤醒**发往记录里的 `channelId`，事件带上 `dot`。
  - 生产时检查不通过时，不派发，并把唤醒的幂等标记置位（D8）；
  - 任务绑定的 run 和 job 照常写 `settle` 记录、兑现 `work` 等待条件。这一步与能否投递无关，所以任务状态始终正确。
- **结算、用量、租约和完成唤醒**仍然只归 `SubAgentRunManager` 所有，idempotency 标记一个都不能少。
- **主机级的并发准入计数**、按工作目录计算的写租约，都保持现有语义。
- **委派默认的 `workingDirectory` 改为 dot 目录**（D9）。
- **`/subagents`** 列出本 dot 的 run，包括其他频道发起的；取消操作不受发起频道限制。

### D16 会话、turn capsule 与提示词

- **runner 由 `DotConversation` 构造**：
  - `SessionManager` 的 sessionDir 用会话区目录，cwd 用 dot 目录；
  - `active-session-store.ts` 的全部函数改为接收会话区目录，逻辑不变；
  - `/new` 只重置本频道的会话区。
- **每回合的 capsule**（`renderChannelTurnContext`，改名为 `renderDotTurnContext`）改写为：

  ```
  Dot: news — directory /home/…/workspace/dots/news (your working directory).
  This conversation: 群「投资成长」 (channel group_cid…).
  The dot's MEMORY.md index, memory/, journal/, tasks/ and events/ live in the dot directory.
  ```

  这段放在每回合的上下文里，不进 system prompt，所以不影响 prompt cache 的共享前缀。只写当前 dot 和当前频道，不列出这个 dot 还绑定了哪些频道。

- **委派任务说明**（`task-envelope.ts`）里的 "Channel directory" 改为 "Dot directory"，任务文件路径改为 dot 下的路径。
- **SDK 基于 cwd 的自动发现**：`agentsFilesOverride` 已经清空了 cwd 下的 AGENTS 文件，但 pi 还可能按 cwd 发现 skills、prompt templates 和 extensions。cwd 从 `/home/oyasmi` 改成 dot 目录后，实施时要核对 pi 1.2 的发现路径，确认既不会意外加载、也不会意外丢失资源，并把结论写进实施记录。

### D17 钉钉传输与频道索引

- **路由元数据集中存放**：`ConversationMetaStore` 改为单文件 `state/dingtalk/conversations.json`，以频道 id 为键。
  - 内容没有变化时不写盘。现在每条消息都会同步原子写一次，这条约束顺便消除了这个开销。
  - 路由元数据不依赖绑定，未绑定频道同样记录，这样以后绑定后可以主动推送。
- **入站图片**：先通过 `DotRuntime` 解析绑定。已绑定就存到 `<dot>/inbox/`；未绑定或不可用时不下载、不保存。归档里的图片路径相对于 dot 目录。
- **消息归档**（`ChannelStore`）：`log.jsonl` 写入会话区，`subagent-runs.jsonl` 写入 dot 根目录。目录由运行时注入的解析函数提供；频道未绑定时不归档。
- **CHANNELS.md**：
  - 列变为「频道 ID｜名称｜dot｜最近消息｜主题」。「dot」列由运行时根据绑定表渲染；绑定变化算作结构性变化，立即写盘。
  - 它不再承担"频道发现"的职责，只用来给频道 id 起名字，同时作为 `/dot list` 的名称来源。
- **`DingTalkBot` 和 `DingTalkHandler`** 在 `src/index.ts` 中的导出名称不变。

### D18 TUI

- **命令行参数**：`pipiclaw tui --dot <name>` 取代 `--channel`，并且必须提供。
  - dot 不存在时报错，列出已有的 dot，并提示可以加 `--create` 显式创建。`--create` 也算显式创建，不违反 INV-2。
- **能打开任何 dot，不做限制**：有没有绑定、daemon 是否正在服务它，都可以打开。与 daemon 共享写入的文件由跨进程短锁保护（D6）。
- **频道 id 固定为 `tui`**，不写绑定表；在 dot 里的会话区为 `tui-N`。
- **运行期间持有 `conversations/tui-N/.lock`**，退出时释放，包括 SIGINT 的退出路径。这把锁防的是两个 TUI 同时写同一个会话文件：第二个 TUI 打开同一个 dot 时报错退出，错误里给出持有者的 pid。
- **TUI 只运行前台对话和它自己会话区的记忆 lifecycle**，不运行 task driver、事件 watcher 和空闲 reflect 调度（现状不变）。dot 的后台工作只由 daemon 负责，所以 TUI 打开一个已绑定的 dot，不会让它的后台工作被执行两遍。
- **TUI 的 run 和 job 不落盘，也没有持久化的唤醒**（现状不变）。TUI 退出后，它发起的 run 不会被 daemon 接管。
- **`/dot list`、`/dot new`** 在 TUI 中可用；`/dot bind` 回复不支持。

### D19 用量

- 用量记录新增 `dot` 字段；`channelId` 保留，表示发生在哪个频道。
- `/usage` 统计范围从本频道改为**本 dot**：任务和委派都归属于 dot，按频道统计会把同一个 dot 的花费拆散。
- 迁移脚本按映射关系给历史记录补上 `dot`（D20）。

### D20 迁移脚本

**形式**：独立的 `scripts/migrate-to-dots.mjs`，零依赖的 Node ESM，**不 import `src/` 或 `dist/`**。这样它不会被新代码里删掉的旧布局逻辑牵连。从仓库检出目录运行（用户的部署是 `npm pack` 安装的，安装包里没有 `scripts/`；这是一次性的个人迁移，可以接受）。

```
node scripts/migrate-to-dots.mjs [--home <dir>]
    --map <旧频道目录名>=<dot> …      # 每个旧目录迁成一个 dot，原频道自动绑定到它
    [--drop <旧频道目录名> …]          # 不迁移，移到 workspace/.legacy/
    [--dry-run]                       # 只打印完整计划，不写任何东西
    [--no-backup]
node scripts/migrate-to-dots.mjs [--home <dir>] --verify   # 只读校验迁移后的布局
```

**前置检查**，任何一条不满足就拒绝执行，并且什么都不写：

- `<home>/workspace/` 存在，`workspace/dots/` 不存在（已经迁移过的不能再迁一次）。
- `state/task-migration-v5.done` 存在。v3→v5 的任务迁移必须先完成（D21 会删掉那段代码）。
- 没有在运行的 pipiclaw 进程：扫描 `/proc/*/cmdline`，排除脚本自身。
- **每个旧频道目录都已被 `--map` 或 `--drop` 指定**。旧频道目录指 workspace 根下名字以 `dm_`、`group_`、`tui_` 开头的目录。有遗漏就列出来，拒绝执行，不提供"其余自动处理"这种选项。
- dot 名合法、互不重复。每个旧目录最多映射到一个 dot（脚本不合并两份记忆，要共享就迁移后用 `/dot bind`）。
- **每个旧目录都能还原出真实的频道 id**，按以下优先级：
  1. 目录里的 `.channel-meta.json`：`conversationType` 为 `"2"` 时是 `group_<conversationId>`，否则是 `dm_<senderId>`；
  2. CHANNELS.md 中某一行，把 id 按旧规则转义后正好等于目录名；
  3. 目录名不含 `__` 时，直接取目录名。

  两个来源给出的结果不一致，或者都没有结果、目录名又含 `__` 时，拒绝执行。`tui_*` 目录对应新的 TUI 频道 id `tui`，只登记会话区，不写绑定。

**执行步骤**（都写进计划和报告）：

1. 写 `state/dots-migration.inprogress`。备份 `workspace/` 和 `state/` 到 `<home>/backups/pre-dots-<时间戳>/`，用 `cp -a` 的语义，保留权限和符号链接。
2. 对每个 `--map`：
   - 建 `workspace/dots/<dot>/`；把旧目录中的会话文件移到 `conversations/<kind>-1/`。会话文件包括根目录下的 `<ts>_<uuid>.jsonl`、`context.jsonl`、`active-session.json`、`log.jsonl`、`log.jsonl.1`、`.sync-offset`；
   - 其余内容原样移到 dot 根目录；
   - `.channel-meta.json` 合并进 `state/dingtalk/conversations.json`；
   - 删除 `project.json`，但在报告里记下它原来的 `projectRoot`；
   - 写 `dot.json` 登记会话区；绑定表增加"原频道 → dot"。
3. 对每个 `--drop`：整个目录移到 `workspace/.legacy/<目录名>/`。
4. **事件**：逐个读 `workspace/events/*.json`（连同对应的 `.error.txt`）的 `channelId`。频道对应某个已迁移的 dot，就移到 `dots/<dot>/events/`；对应的是被 drop 的频道或未知频道，就移到 `workspace/.legacy/events/`。最后删除空的 `workspace/events/`。
5. **任务**：在每个 dot 的 `tasks/*.md`（不含 `archive/`）的 frontmatter 里，按 `FIELD_ORDER` 的位置插入一行 `channel: <原频道 id>`。来自 `tui_*` 的 dot 写 `tui`，这些任务在 TUI 打开之前一直挂起。
6. **状态**：
   - `state/memory/<旧目录名>.json` 移到 `state/memory/<dot>/<kind>-1.json`；
   - `state/subagent-runs/<旧目录名>/` 移到 `state/subagent-runs/<dot>/`；
   - `state/jobs/` 下的记录**按记录里的 `channelId` 归类**（群频道的旧记录可能因为 D10 提到的 bug 嵌了多层目录），移到 `state/jobs/<dot>/`；
   - `state/dispatch/*.json` 的 `event` 里补上 `dot`，映射不到的移到 `.legacy`；
   - `state/usage/*.jsonl` 每行补上 `dot`，写临时文件后 rename。
7. **路径改写**：把旧的绝对路径前缀替换成新路径。
   - **替换表**：先放会话文件的逐个映射（旧文件路径到新的会话区文件路径），再放目录前缀映射（`<home>/workspace/<旧目录名>` 到 `<home>/workspace/dots/<dot>`），按长度从长到短匹配。`~/.pipiclaw/workspace/<旧目录名>` 这种写法同样替换。
   - **边界规则**：匹配到的前缀后面必须紧跟 `/`、引号、空白、行尾，或者不属于路径的字符。这样 `dm_1624031` 不会被当作 `dm_162403` 替换。
   - **扫描范围**：`workspace/dots/**`、workspace 根下的其他用户目录和顶层 md 文件、`state/subagent-runs/**`、`state/jobs/**`、`state/dispatch/**`。
   - **跳过**：二进制文件（前 8KB 含 NUL）和超过 20MB 的文件。也不改写 `state/usage`、`state/logs`、`state/events/history.jsonl`，它们是历史记录。
   - 每个文件的替换次数都写进报告。
8. 写 `workspace/dots/bindings.json`，写 `state/dots-migration.done`（含映射摘要），删除 `inprogress`。报告写到备份目录下的 `migration-report.json`，并在终端打印摘要。

**`--verify`**（只读）检查以下几项，任何一项失败就以非零码退出：

- 所有绑定指向存在且可用的 dot；
- `dot.json` 的 `name` 与目录名一致；
- workspace 根下没有残留的旧频道目录；
- 迁移范围内的文件里不再出现任何旧的绝对路径前缀；
- 每个未归档任务都有 `channel` 字段；
- 每个事件都在某个 dot 的 `events/` 下。

**演练**：先 `cp -a ~/.pipiclaw <副本>`，再用 `--home <副本>` 跑一遍迁移和 `--verify`，然后用 `PIPICLAW_HOME=<副本> pipiclaw tui --dot <x>` 进去核对记忆和任务。**演练时不能在副本上启动 daemon**：daemon 会用同一套钉钉凭据连上钉钉，等于多了一个机器人。

**失败处理**：脚本不支持断点续跑。失败时保留 `inprogress` 标记，打印"从备份目录恢复"的命令。daemon 看到这个标记会拒绝启动（D21）。

### D21 启动检查；删除 v3→v5 迁移代码

daemon 启动时，在任何服务启动之前做旧布局检测。发现以下任意一种，就以英文错误退出，错误信息给出迁移脚本的用法和文档链接：

- workspace 根下有名字以 `dm_`、`group_`、`tui_` 开头的目录；
- `workspace/events/` 下有 `.json` 文件；
- 存在 `state/dots-migration.inprogress`。

全新安装时没有旧布局，`workspace/dots/` 按需创建，不需要任何标记。

因为迁移脚本以 `task-migration-v5.done` 为前置条件，`runtime/task-migration.ts`（v3→v5 转换）、启动时对 `migrateTasksToV5` 的调用，以及 `scripts/rehearse-task-migration.mjs` 一并删除。它们都按频道目录工作，移植到 dot 上没有意义。

### D22 权限（v1 不设）

按用户的决定，v1 的 `/dot` 命令对所有能给机器人发消息的人开放。这在现有配置下会带来以下风险，记录于此：

- 用户的 `channel.json` 里 `allowFrom` 为空，任何人都能发消息。群里的任何成员都可以执行 `/dot bind <某个 dot>`，把这个群接到包括私人 dot 在内的任意 dot 上，然后通过对话接触那个 dot 的记忆和文件。
- `/dot list` 会暴露所有频道的名称（群名和私聊对象的昵称）。

后续计划：在 `channel.json` 加 `admins: [staffId]`，`/dot new` 和 `/dot bind` 仅限 admin 使用，未配置 admins 时拒绝执行（这是用户已经认可的方向）。v1 的代码结构要为它留好接入点：`DotCommandPort` 的调用方能拿到发送者的 staffId。

### D23 文档、playbook 与评测

- **顶层手册**：
  - `architecture.md`；
  - `memory.md`：频道记忆改为 dot 记忆；
  - `events-and-tasks.md`：投递频道、事件归属、挂起；
  - `interaction-and-commands.md`：`/dot`，并删除 `/project`；
  - `security.md`：删除项目边界；
  - `sub-agents.md`：默认 `workingDirectory`；
  - `configuration-reference.md`：`projectAccess` 退役，新增 `dots/` 文件；
  - `deployment-and-operations.md`：目录布局、迁移流程、TUI 与 daemon 共享 dot；
  - `scaling-and-concurrency.md`：dot 级的记忆队列、跨进程短锁、会话区锁；
  - `runtime-mechanisms.md`、`tools.md`、`README.md`。
- **`AGENTS.md`**：Runtime Model 一节（workspace 级、dot 级、会话区级文件）和模块表；**`CLAUDE.md`**：Architecture 中的 Memory、Tasks、Delegation、Config & state 各节。
- **playbooks**：
  - `runtime-orientation.md`：删掉 ProjectRoot 和 `/project`，cwd 改为 dot 目录，`<channelDir>` 改为 dot 目录；
  - `agent-delegation.md`：默认 `workingDirectory` 改为 dot 目录，委派代码仓库必须显式传路径；
  - `memory-and-learning.md`、`event-scheduling.md`、`task-lead.md`：凡提到频道目录的地方都要改。
- **评测**：playbook 是模型可见的文本，按 AGENTS.md 的"Behavior-eval iteration"规则，用 `npm run eval -- plan --changed-since <ref>` 规划受影响的探针，并在有凭据时跑相关的 dev 用例，记录 run id 和失败归因。
- **053 术语表**追加"dot""绑定""投递频道"。`docs/specs/README.md` 登记本 spec。

## 5. 不变量

| 编号 | 不变量 | 由谁保证 |
|---|---|---|
| INV-1 | 一个频道最多绑定一个 dot；`bindings.json` 是唯一事实来源 | `dot/registry.ts` 的数据结构（以频道为键的映射）；只有 daemon 写 |
| INV-2 | dot 只能被显式创建：`/dot new`、TUI 的 `--create`、迁移脚本 | 运行时创建 dot 只有这三条路径；入站消息和后台服务都不调用创建函数 |
| INV-3 | channelId 永远不作路径段 | 删除 `channel-paths.ts`；P2 闸门的检索证明 |
| INV-4 | 每项后台工作都在自己的数据里显式写明投递频道，不存在主频道或默认频道 | D7 的写入方表 |
| INV-5 | 后台工作只投递给仍绑定在产生它的 dot 上的频道 | 生产时检查，加上 `runEventTurn` 的准入检查和 `sendFromDot` 守卫 |
| INV-6 | 多个进程可以同时使用同一个 dot。共享写入的 dot 文件（记忆、任务、`dot.json`）都经跨进程短锁串行；每个会话区同一时刻只有一个进程写入；dot 的后台工作只由 daemon 执行 | `shared/file-lock.ts`；`DotMemoryQueue`、`withTaskMutation`、registry 都接入它；TUI 的会话区锁；TUI 不运行后台服务 |
| INV-7 | 一个会话区只属于一个（dot, 频道）组合，登记在该 dot 的 `dot.json` 里，目录名分配后不再改变 | `registry.allocateConversation` |
| INV-8 | 同一个 dot 的所有记忆写入方以 dot 名为键串行 | `DotMemoryQueue` 唯一实例 |
| 既有 | 051/052 的等待条件和 `resolveTicket`、spec 052 INV-8、`SubAgentRunManager` 独占结算，全部不变 | 原有测试 |

## 6. 非目标

- **权限控制**（D22）。
- **dot 的改名、删除、合并、复制**。v1 要改名只能停掉 daemon 后手工改，文档不承诺这个操作。
- **每个 dot 独立的 SOUL、AGENTS、skills、sub-agents、模型配置**。
- **跨频道同步最近上下文**：其他频道刚聊了什么，靠记忆、日记和 `session_search` 获取。
- **TUI 写入绑定、TUI 与 daemon 同时服务同一个 dot**。
- **一个频道同时绑定多个 dot**、按话题分流到不同 dot。
- **从 `dot.json` 里配置默认工作目录**（D9 留的口子）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 记忆队列有遗漏，没换成以 dot 为键，导致同一个 dot 下两个频道并发写坏记忆 | INV-8；P2 增加一个确定性 e2e 用例：两个频道同时触发记忆写入，断言没有丢失（含 mutation check） |
| 迁移改写路径时误伤，或有漏网 | 先备份；`--dry-run` 打印逐文件计划；边界规则；`--verify` 检查残留；在副本上演练 |
| 换绑与在途唤醒竞争，旧 dot 的结果投到新 dot 的会话里 | 准入检查是权威的一道（INV-5），e2e 用例覆盖"重启前排队、换绑后才投递" |
| cwd 变化导致模型的默认行为变化（委派落到 dot 目录） | 同步改写 playbook；跑评测探针；在 changelog 中说明 |
| daemon 和 TUI 同时写同一个 dot，有某个写入方漏接跨进程锁 | INV-6 列出了全部共享写入的文件；`file-lock` 单测用子进程真实持锁；记忆队列和任务修改各有一个用例，验证另一个进程持锁时会等待 |
| 记忆锁跨着 reflect 的模型调用持有，另一个进程的 `memory_save` 要等较久 | 与现在进程内的队列语义一致；等待超时抛出 `RecoverableToolError`，模型可以稍后重试 |
| 陈旧锁 | 同主机 pid 不存在时自动回收；锁内容可读，报错里带上 pid |
| 进程意外退出，锁没有释放，pid 又被别的进程复用 | 概率很低。报错给出锁文件路径和持有者，由部署者手工删除 |
| 群成员执行 `/dot bind` 越权 | v1 已接受此风险（D22），后续加 admins |
| `ChannelEvent` 新增字段遗漏，某个生产者没填 `dot` | `dispatch()` 拒绝没有 `dot` 的事件，单测覆盖每个生产者 |

## 8. 已确认的取舍（用户决策记录，2026-10-17）

1. **会话上下文按频道分开**，长期的东西归 dot（方案 B）。
2. **名字定为 dot**，借用 OpenAI 2026-09 发布的 Dots 的说法：常驻的个人 agent，可以从多个入口访问同一个个体。
3. **dot 只能用 `/dot new` 显式创建**；现有频道目录由独立脚本迁移，并在迁移时指定 dot 名。
4. **各层模块都要看到 dot 这个概念**，不再沿用 channel 的命名。
5. **没有主频道**：前台回合回到它所在的频道，委派和 job 回到发起方频道，后台任务和事件显式写明 channelId。
6. **TUI 改为直接打开一个 dot**，有没有绑定都能打开，不做限制（2026-10-18 修订：取消了原先"daemon 独占已绑定 dot"的进程锁，改为在共享文件上加跨进程短锁）。
   **每回合的上下文里也不列出 dot 的其他绑定频道**（2026-10-18 决定）。
7. **迁移时的路径全量替换**获认可。
8. **删除 channelId 的路径转义机制**。
9. **v1 不设权限**，后续再加。
10. **一个 dot 失去所有绑定后允许继续存在**，它的后台工作挂起。
11. **project 概念整体删除**，由 dot 取代。
12. 命令只有 `/dot`、`/dot new`、`/dot bind`，保持精简。

## 实施记录

> 由实施 Agent 按 [plan.md](./plan.md) 的「通用规则」逐阶段填写：基线与用例数变化、偏差及理由、D16 SDK 发现路径核对结论、迁移演练报告、评测执行情况。

### 分支

用户指示在 `dev/dots` 上实施；plan 写的是 `feat/dots`。`dev/dots` 从 `feat/dots`（含 spec 提交 `ba10670`）切出。

### P0 基线与 `src/dot/`

**基线**（`ba10670`，全部闸门通过）：单测 136 个文件 / 959 例；确定性 e2e 23 个文件 / 56 例；`src/` 257 个 `.ts` 文件 / 48,684 行；`eval:typecheck` 通过；`node dist/main.js --version` 输出 `0.9.4`。

**交付**：`src/dot/{types,paths,registry,commands}.ts`、`src/shared/file-lock.ts`、`src/channel/channel-id.ts`；`check-architecture.mjs` 与 AGENTS.md 模块表加入 `dot`。

**偏差与决定**：

- **锁文件的独占创建用 `link` 而不是 `open(path, "wx")`**：先把内容写进私有临时文件，再 `link` 到锁路径（已存在时 `EEXIST`）。语义同样是独占创建，但锁文件不会出现"已创建、还没写内容"的空窗，否则一个进程恰好在那一刻崩溃会留下无法判定持有者的空锁。陈旧锁回收先 `rename` 到旁路再核对 token，避免两个回收者互相删掉对方刚建的新锁。锁内容在 `{ pid, hostname, acquiredAt }` 之外多一个 `token`，`release` 同时核对 pid 和 token。
- **`FileLockTimeoutError` 不用构造函数参数属性**：测试的子进程用 Node 的 type stripping 直接加载 `file-lock.ts`（跨进程结论必须由真实的另一个进程、用真实实现来证明），而 strip 模式不支持参数属性。
- **`/dot` 的参数解析用例推迟到 P3**：`commands-subcommands.test.ts` 只遍历 catalog 里带 `subcommands` 的命令，而 `dot` 的 catalog 条目在 P3 才加（提前加会让 `/help` 宣传一个还不能执行的命令）。P3 加 catalog 条目时同步把 `parseDotCommand` 登记进该测试的 `PARSERS`。
- **knip 临时入口**：`knip.json` 的 `entry` 临时加入 `src/dot/*.ts` 和 `src/channel/channel-id.ts`，P2 接入运行时后移除（P2 闸门核对）。
- `BindOutcome` 比 plan 多一个 `unavailable`：D5 第 1 步要求"dot 存在且可用"，存在但 `dot.json` 损坏的情况需要单独的回复。

**用例数**：单测 959 → 969（+10）。

- `test/file-lock.test.ts` +4：等待另一个进程释放、超时报出持有者 pid、持有者被杀后回收陈旧锁、不删除别人的锁。故障模式都是跨进程互斥失效；现有用例没有任何跨进程锁。
- `test/dot-registry.test.ts` +6：名字语法边界（一个表驱动用例）、重名创建、会话区按 kind 编号且幂等、另一个进程持有 `dot-json.lock` 时分配会等待、绑定表缺失与损坏、`dot.json` 名字与目录不符判为 invalid。全部是新机制。
- mutation check：去掉 `allocateConversation` 外层的锁，"分配会等待"变红；让陈旧判定恒为 false，"回收陈旧锁"变红。

e2e：56 → 56。

### P1 删除 project

**交付**：删除 `channel/project-scope-store.ts`、`security/project-scope.ts`、`channel/commands.ts`（只剩 `/project`，整个文件删除）及其测试；`SecurityRuntimeContext` 改为 `{ agentWorkspaceDir, cwd?, homeDir? }`；path-guard 删除 `boundary: "project"` 分支和三个运行时例外（`isWithinProjectRoot`、`isAgentWorkspaceSkillsAccess`、`isChannelDirAccess`），相对路径基准改为 `ctx.cwd`；`security.json` 的 `projectAccess` 加载时报退役 warn 后忽略（`docs/configuration-reference.md`、`docs/security.md` 已登记）；`tools/index.ts` 的 `projectScope` 换成 `cwd`；委派删除 `projectBoundary` 与 `assertWithinProjectBoundary`（`dispatch.ts` 的 realpath 规范化保留）；`/project` 从 catalog、router、TUI 删除。

**偏差与决定**：

- **P1 的临时 cwd 用进程启动目录，而不是 plan 写的"频道目录"**。pi 会把 cwd 追加进 system prompt 的尾部，cwd 一旦等于 `workspace/<channelId>/`，频道 id 就进了 system prompt：`system-prompt.test.ts` 当场变红，它守的是 spec 048 的约定（频道身份只走每回合上下文，system prompt 在频道之间共享，以便复用 prompt cache）。改用 `process.cwd()`，也就是没有 `project.json` 的频道原本的默认值，闸门和约定都保住。P2 起 cwd 是 `dots/<dot>`，路径里没有频道 id，那条断言照常成立。P1 不单独上线，这个临时状态不会被用户看到。
- **router 上下文里只服务 `/project` 的字段一并删除**：`actor`、`runningJobLines`、`onScopeChanged`。TUI 里只为 `/project` 换 runner 而存在的 `createRunnerSlot` 代理也删了。
- **`subagent-manage.ts` 的 `workingDirectory` 选项一并删除**：它唯一的用途是 follow_up 时重做项目边界检查。
- **e2e A19 的越界目标**：没有项目边界以后，"越界"指的是不在默认允许根（workspace、home、临时目录）之内。用例改为写 `/srv/pipiclaw-e2e-guard/out.txt`：它不在系统拒绝前缀里，拒绝来自允许根检查本身。mutation check：让 `pathAllowedByDefaults` 恒为 true，用例变红（模型收不到拒绝，也没有审计）。
- 第 11 步的检索结果剩下这些，都是正当的：两处文档对退役键的说明、`security/config.ts` 对退役键的检查、`~/projects/` 之类的示例路径、记忆类型 `project`。

**用例数**：单测 969 → 943（−26），全部是被删除机制的测试：`project-commands` 5、`runtime-project-scope-store` 9、`security-project-scope` 6、path-guard 的 `boundary="project"` 3、委派的项目边界 1、follow_up 重查项目边界 1、`commands-subcommands` 里自动生成的 `/project` 用例 1。`security-config` 的诊断用例扩展为同时覆盖退役键（用例数不变）。

e2e：56 → 55（−1）：第二个 A19（"`/project set` 在忙碌时被拒绝"）删除，P3 改写为 `/dot bind` 后补回。

### P2 存储模型切换

提交：`5153eac`（纯改名 channelDir→dotDir）、`a295667`（任务 `channel` 字段 + 跨进程任务锁），其余按模块分提交（见 git log）。

**闸门**（2026-10-18）：`npm run check` 全绿（lint 无告警、typecheck、arch「基线剩余 0 条 R1、0 个 R2 循环、3 个 R3 超长文件」、knip、单测 133 个文件 905 例）；`npm run test:e2e` 24 个文件 57 例全绿；`npm run eval:typecheck` 通过，`npm run test:evals` 69 例全绿；`npm run build` 后 `node dist/main.js --version` 输出 `0.9.4`。INV-3 三条检索在 `src`、`test` 中均为空；`rg -n "channelDir" src` 为空（`legacy-layout.ts` 中指旧频道目录的变量改名为 `legacyChannelDirs`）。

**用例数**（与 P1 结束时 `14ef524` 逐文件对比）：

- 单测 943 → 905（−38）：
  - −37 `task-migration.test.ts`（18）与 `task-migration-faults.test.ts`（19）——删除的 v3→v5 迁移机制（plan 估计 30，实际 37）；
  - −2 `channel-paths.test.ts`——删除的 channelId 路径转义；
  - −3 `channel-index.test.ts`——删除的目录发现（3 例），四列兼容并入原往返用例；
  - −2 `memory-maintenance-scheduler.test.ts`——删除的频道发现与斜杠去重；
  - `memory-maintenance-state.test.ts` +1：新增「另一进程持有 memory.lock 时等待」（故障：daemon 与 TUI 并发写坏同一 dot 的记忆）；斜杠扁平文件用例改写为「按 dot/会话区落盘」，队列用例改为按 dot；
  - `subagent-runs.test.ts` +1：新增「换绑后丢弃唤醒但仍兑现任务的 work 票」（故障：换绑期间任务永久停在 work 票上）；斜杠转义目录用例改写为「按 dot 目录恢复并唤醒各 run 自己的频道」；
  - `task-store.test.ts` +1：跨进程任务锁（`a295667`）；
  - `dot-runtime.test.ts` +3：激活/休眠（故障：休眠 dot 的 watcher 泄漏、修复前就接流量）、`sendFromDot` 绑定校验（故障：跨 dot 投递）、启动拒绝旧布局（故障：在未迁移的 home 上静默忽略全部旧状态）。
  - 原地扩展、不增用例：`job-manager.test.ts` 的重载用例改为经 `createJobRuntime().restore()` 的按 dot 目录扫描（mutation：去掉状态目录里的 dot 一级，变红）；task driver 冻结、events 绑定跳过、durable dispatch 拒绝无 dot 事件、job 唤醒抑制，均为扩展原用例。
- 确定性 e2e 55 → 57（+2）：
  - DOT-1 并入 `memory.test.ts` 的 M2（「跨 project」换成「同一 dot 的两个频道」），mutation：首回合注入改读会话区目录、两频道共用一个会话区，均变红；
  - +1 DOT-2（`memory.test.ts`），mutation：`memory_save` 绕过 dot 队列，约 3 秒内变红；
  - +1 DOT-4（`dots.test.ts`），mutation：`DotRuntime.resolve` 对未绑定频道回落到其他绑定，模型请求数变为 2，变红；
  - A18（独立进程 SIGKILL 重启）扩展：重启前不再重写绑定，只靠盘上的 `bindings.json`；重启后同一频道的新消息到达 provider。mutation：把 `log.jsonl` 归档到 `join(workspaceDir, channelId)`，重启后的 daemon 拒绝启动，变红；
  - **DOT-3 移到 P3**：它需要运行中换绑，而绑定表只在启动时加载，换绑要等 P3 的 `DotRuntime.bind`。

**D16 核对结论**：pi 1.2 按 cwd 发现 `<cwd>/.pi/{extensions,skills,prompts,themes}` 与 cwd 到 git 根之间各级的 `.agents/skills`（Pipiclaw 的 SDK settings 默认信任项目）。本机旧 cwd `/home/oyasmi` 与新 cwd `dots/<dot>`（workspace 是 git 仓库，向上止于 workspace 根）均无这些目录；`~/.agents/skills` 为用户级、与 cwd 无关。结论：不新增、不丢失资源。残留风险：模型若在 dot 目录写 `.pi/extensions/`，下次加载时会生效（与旧 cwd 下同类风险一致）。

**偏差与按代码事实所做的决定**：

- **`work` 等待条件的兑现并非与唤醒无关**（plan 的说法与代码不符）：它只在唤醒被认领时发生。唤醒因频道未绑定被丢弃时，run/job 的 owner 在丢弃处经 `redeemTicket` 兑现 `work` 票，绑回后任务立即继续。
- run 结算归档 `subagent-runs.jsonl` 显式写入 run 所属 dot，而不是按频道当前绑定解析（换绑后结算会写错 dot）；因此 `ChannelStore` 只需解析会话区目录（`resolveArchiveDir`），不是 plan 写的返回两个目录。
- run/job manager 以自身 dot 目录记账任务，不再依赖记录里持久化的目录字段。
- 后台 reflect 的 detached 上下文读取会话区的 active session（新增无副作用的 `peekActiveSessionFile`），而不是固定读 `context.jsonl`。
- `last_prompt.json` 写到会话区目录。
- 单发事件因投递频道未绑定被跳过时，保留文件并写错误标记（与队列满的处理一致）。
- `event_manage` 的 list 覆盖整个 dot（标注投递到其他频道的事件、只读），update/delete 仍只限本频道的事件。
- `/tasks doctor` 补上 `capReply`（dot 级列表可能超出 053 的长度预算）。
- `legacy-layout.ts` 放在 `src/dot/` 而不是 plan 写的 `src/runtime/`：TUI 也要调用它，而 `tui` 不允许依赖 `runtime`（arch R1）；它只依赖 `paths`。
- workspace 脚手架建 `dots/`，不再建 `events/`（否则新装的 home 会自带一个旧布局目录名）。
- P4 的 TUI 核心（`--dot` 必填、`--create`、`--channel` 报错、会话区 `.lock`）提前到 P2 完成，因为 P2 闸门包含 TUI 的 e2e；P4 剩下文档与手动核对。
- **knip 临时入口**：`src/dot/*.ts`、`src/channel/channel-id.ts` 已移除；无调用方的 `isChannelId` 删除（`channelKind` 覆盖同一判断）。只剩 `src/dot/commands.ts` 一条，因为 `handleDotCommand` 由 P3 的 `/dot` 命令接入；P3 结束前移除。
- 评测框架：`channelDir` 改名为 `dotDir`、`{{CHANNEL_DIR}}` 改为 `{{DOT_DIR}}`，新增 `evals/harness/layout.ts` 在首段建 dot `eval` 并绑定 `dm_eval`；归档证据的 `mounts.channelDir` 仍可读（regrade 兜底），产物根的持久化取值 `"channel"` 不改，以免旧基线无法 regrade。M-search-01 的对照事实移到另一个 dot 的会话区，事件用例改读 dot 的 `events/`。评测本身（需要凭据）未运行。

### P3 `/dot` 命令与动态绑定

**闸门**（2026-10-18）：`npm run check` 全绿（单测 133 个文件 908 例）；`npm run test:e2e` 24 个文件 59 例全绿；`npm run eval:typecheck` 通过。knip 的最后一条临时入口 `src/dot/commands.ts` 已移除（`handleDotCommand` 由 router 接入）。

**实现要点**：

- `/dot` 进入 catalog（`availableWhileBusy`，`bind` 在忙碌时由 `DotRuntime.bind` 自己拒绝）。router 的上下文改为联合类型 `ReportCommandContext | UnboundCommandContext`：未绑定频道只带 `dotPort` 和拒绝文案，`/dot` 在两种上下文里都能执行，其余命令在未绑定时直接返回拒绝文案；类型上不需要 `!`。
- 空闲时的 `/dot` 在 `runEventTurn` 里于准入之前执行：不归档、不建 runner、`reserveEvent` 不为它占回合。这样 `/dot bind` 看到的频道是空闲的，排在它后面的消息按新绑定解析。忙碌时由传输层的运行时命令分支执行（与其他报告命令一致）。
- `DotRuntime.bind` 按 D5 七步实现，整个过程在一个绑定写队列里串行（不同频道的 bind 也是对同一个 `bindings.json` 的读改写）。绑定表写入失败时抛错，内存中的绑定、runner 都不变，为这次 bind 而激活的目标 dot 重新休眠。第 5 步复用 bootstrap 抽出的 `releaseCachedRunner`（先移出缓存，再 `dispose`，LRU 淘汰也改用它），失败只记日志。挂起计数只读旧 dot 的 `tasks/` 与 `events/`。
- 绑定变化时 `channelIndex.noteBindingChanged()` 立即重写 CHANNELS.md。
- `/dot list` 截断提示给出 `CHANNELS.md` 的绝对路径（由端口提供 `channelIndexPath`）：053 的形状规则要求截断提示交出命令或绝对路径，相对路径会被 `user-copy-shape` 判为不合格。
- 与 plan 的出入：D5 第 3 步之后没有再做一次中断回合修复。目标 dot 中该频道的会话区只在绑定于该 dot 时被写入，崩溃后重启时它仍绑定在那里，激活时已经修复过。

**用例数**：

- 单测 905 → 908（+3）：
  - `dot-runtime.test.ts` +2：「拒绝时无副作用，换绑后释放旧 runner、旧 dot 挂起或休眠」（覆盖 busy/same/unknown/invalid、dispose 失败不回滚、挂起计数、最后一个频道离开后旧 dot 休眠、盘上状态可被新进程读回）；「绑定表写入失败时绑定、runner、目标 dot 的休眠都不变」。mutation（均变红）：去掉写入失败时的目标休眠、release 失败向上抛、去掉旧 dot 休眠、去掉忙碌检查。
  - `commands-subcommands.test.ts` +1：该文件按 catalog 中带 subcommands 的命令逐个生成用例，新增 `/dot` 自动多一例（`PARSERS` 接上 `parseDotCommand`）。
  - `user-copy-shape.test.ts` 不增用例：`/dot` 各动作、各 bind 结果、TUI 端口、未绑定/不可用拒绝文案并入原有用例。mutation：把截断提示改回相对路径，变红。
- 确定性 e2e 57 → 59（+2）：
  - +1 A19「`/dot bind` 在回合进行中被拒绝」（`guards.test.ts`，抵消 P1 的 −1）。mutation：去掉 `DotRuntime.bind` 的忙碌检查，`bindings.json` 改变，变红。
  - +1 DOT-3（`dots.test.ts`）：通过 `/dot new`、`/dot bind` 命令换绑；旧 dot 的在途唤醒被丢弃（模型请求数不变、durable 记录删除），旧 dot 中以本频道为投递频道的任务不上 outbox，换绑后的下一回合落在 `lab` 的会话区，绑回后任务步骤被派发。mutation：去掉 `runEventTurn` 的准入检查（模型请求数变为 2）、去掉 task driver 的绑定过滤（任务步骤上了 outbox），均变红。
  - DOT-3 的一个发现：只换绑唯一的频道时，旧 dot 整体休眠，task driver 根本不扫描它，任务级过滤测不到；即使去掉任务级过滤，准入也会把误派的步骤丢掉，模型请求数看不出来。因此用例给旧 dot 多绑一个频道使其保持激活，并在 driver→outbox 边界断言（spy `DurableDispatchService.dispatch`）。

### P4 TUI

TUI 核心已在 P2 完成。本阶段：

- `/dot list` 和 `/dot new` 在 TUI 中可用（端口直接用 `dot/registry.ts`，名称来自 `loadChannelNames` 读一次 CHANNELS.md），`/dot bind` 回复不支持。TUI 中当前 dot 标为「（当前打开）」而不是「（本频道）」：TUI 打开的 dot 不一定有绑定，「本频道：未绑定频道」读起来自相矛盾。
- 会话区锁的释放：获取锁之后的全部启动步骤都放进 `try/finally`，之前在两者之间失败会留下锁（只能靠陈旧回收）。交互模式的 Ctrl-C 经 controller 走到 `finally`；`--print` 下的 Ctrl-C 或 kill 会留下陈旧锁，下次启动时（同主机、pid 已不存在）回收。
- 核对：`src/tui/` 不创建 task driver、事件 watcher、记忆调度器；jobs/runs 的 runtime 没有 state 目录，不落盘（与现状一致）。
- 文档：TUI 的用法实际写在 `docs/interaction-and-commands.md`、`docs/configuration-reference.md` 和两份 README（plan 写的 `deployment-and-operations.md` 没有 TUI 一节），已改为 `--dot`/`--create`。
- **手工核对**（2026-10-18，临时 app home：`~/.pipiclaw` 只读地复制了 `auth.json`、`models.json`、`settings.json`，没有对真实 home 运行任何命令，因为 TUI 的 bootstrap 会先建脚手架）：不带 `--create` 打开不存在的 dot 报错并提示 `--create`；`--create --print "/dot"` 列出新 dot；`/dot new side` 创建成功并提示去钉钉绑定；`/dot bind side` 回复终端不支持；一次真实模型对话回答了正确的 dot 名和工作目录（`dots/manual`），落盘为 `conversations/tui-1/` 与 `dot.json` 中的 `tui` 条目，退出后 `.lock` 已释放。交互式全屏界面没有手工跑（这里没有交互终端），只跑了 `--print`。

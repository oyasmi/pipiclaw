# 智能体委派（Sub-Agents）

> **读者**：想把 reviewer / researcher 这类轻量角色，或 Claude Code / Codex CLI 这类重型外部智能体，接入同一套工作流的使用者与管理员。
> **前置**：已完成 [README](../README.md) 的安装与配置。
> **读完你能**：启用一个现成角色，理解内置与外部委派的差异，查看和控制异步 run，并按真实权限边界编写自己的角色。

智能体委派让主智能体把某一步工作交给更合适的执行者：轻量检索可以交给进程内的隔离角色，跨文件实现和独立评审可以交给真实的外部 coding agent。主智能体仍然负责选择角色、提供完整任务、接收结果并向用户交付。

它和[事件与任务](./events-and-tasks.md)是正交能力：事件与任务解决“什么时候继续、在途状态保存在哪里”，委派解决“这一步由谁来做”。当前回合中的一次临时委派不需要创建 task；需要跨时间恢复、记录目标和验收时，再用 task 承载长期状态。

从 spec 040 起，子代理有两种 **runtime**：

- **`internal`**（默认）：在 Pipiclaw 进程内运行的隔离上下文子智能体。它使用 Pipiclaw 的模型、工具和安全守卫，启动快，适合检索、筛查和窄范围分析。
- **`external`**：一次委派启动一个真实的 Claude Code、Codex CLI 或任意脚本进程。它适合长时间、跨文件、需要自行测试迭代的工作，并使用目标 CLI 自己的认证、模型和 sandbox。

两者共用一个角色目录（`workspace/sub-agents/`）、一个调用面（`subagent` 工具）、一套 run 生命周期和控制面（`subagent_manage` 工具 / `/subagents` 命令）。角色目录会同时展示 runtime、工作量和是否写入，主智能体据此选择最合适的执行者。

在独立验收（verifier）场景里，子代理会和任务台账咬合（`purpose: verify` + `taskId`）；这些接缝会在下面点明，并链接回 [events-and-tasks.md](./events-and-tasks.md)。

## 五分钟启用一个外部角色

外部角色的前提是：目标 CLI 已经安装在**运行 Pipiclaw 的同一账号**下，能从该进程的 `PATH` 找到，并已完成登录。先在 shell 中自行验证 `claude` 或 `codex` 能运行。

全局 npm 安装会把推荐角色一起安装。以下示例复制一个 Claude Code builder 和一个 Codex reviewer：

```bash
mkdir -p ~/.pipiclaw/workspace/sub-agents
PIPICLAW_PACKAGE_DIR="$(npm root -g)/@oyasmi/pipiclaw"
cp "$PIPICLAW_PACKAGE_DIR"/examples/sub-agents/{builder,reviewer}.md \
  ~/.pipiclaw/workspace/sub-agents/
```

如果你正在源码 checkout 中开发，也可以从仓库的 `examples/sub-agents/` 复制。设置了 `PIPICLAW_HOME` 时，把目标目录改成 `$PIPICLAW_HOME/workspace/sub-agents/`。

不必重启 daemon；角色目录会在资源刷新时重新发现。先发送：

```text
/subagents roles
/subagents roles builder
```

确认角色显示为可用后，直接给主智能体目标、范围和验收方法：

```text
请把这次跨模块实现交给 builder，工作目录是 /srv/project；完成后让 reviewer 检查当前 diff，并把结论和剩余风险交付给我。
```

外部委派会立刻返回 `runId`，完成时自动唤醒原频道。过程中可用 `/subagents` 查看，用 `/subagents cancel <runId>` 终止。不要为了等结果反复轮询或重复派发。

> **运行入口边界**：完成唤醒、`state/subagent-runs/` 持久化和 daemon 重启对账由钉钉常驻 runtime 装配。TUI 可以发现和启动角色，但当前不会主动显示外部 run 的完成通知，也不会在退出后重新认领它；长时间外部委派请使用 daemon。

## 它是什么

工作区配置子代理是放在 `~/.pipiclaw/workspace/sub-agents/*.md` 中的 Markdown 文件。Pipiclaw 只加载这个目录中实际存在且有效的文件；不会自动注入任何默认角色。主代理在合适的时候可以调用它们，把某类任务交给更聚焦的角色处理。

仓库及 npm 包提供了可复制、可修改的建议模板：[`examples/sub-agents/`](../examples/sub-agents/)，既有内置角色也有外部角色。在源码 checkout 中可以直接使用：

```bash
# 内置角色（无需额外安装）：
cp examples/sub-agents/{explorer,log-sifter,git-committer}.md ~/.pipiclaw/workspace/sub-agents/
# 外部角色（需要在宿主机安装对应 CLI 并完成登录）：
cp examples/sub-agents/{planner,builder,builder-hard}.md ~/.pipiclaw/workspace/sub-agents/                # 需要 claude
cp examples/sub-agents/{reviewer,verifier,scout,worker,documenter}.md ~/.pipiclaw/workspace/sub-agents/   # 需要 codex
```

八个外部角色构成一个可直接改造的开发闭环（planner → reviewer → builder → reviewer → verifier → documenter，闭环外由 worker 和 scout 承接），细节见 [`examples/sub-agents/README.md`](../examples/sub-agents/README.md)。模板中的模型、sandbox 和授权取舍不是普适默认值，使用前必须按本机账号和风险边界审阅。

不复制模板也完全可以使用 inline `systemPrompt` 委派——但 inline 委派永远是 `runtime: internal`，外部角色必须以配置文件的形式存在（需要 `harness`/`command`，无法通过调用参数临时拼出）。`purpose: verify` 的验收约束由 runtime 执行，不要求一定配置名为 `verifier` 的文件。

适合内置角色的场景：

- 代码审查
- 信息收集
- 风险检查
- 某类固定格式的总结
- 把工作区改动整理成提交（读 diff、写提交消息是上下文密集的，适合隔离给 git-committer）

适合外部角色的场景：

- 跨多文件的实现，需要自己写测试、自己跑测试、自己迭代
- 单次可能运行几十分钟的重型工作
- 需要另一家模型/CLI 的独立判断（例如用 codex-cli 复核 claude 自己的实现）

不适合任何一种子代理的场景：

- 只需要主代理顺手完成的一步小事
- 需要继续递归创建下级代理的复杂代理树（子代理没有 `subagent` 工具，外部 agent 是否会自己 spawn 子代理不受 pipiclaw 控制或约束，见下文"明确不可控的部分"）

## 文件结构（File Structure）

一个子代理文件由两部分组成：

1. **YAML frontmatter**：定义名字、描述、runtime，以及内置或外部各自的字段。
2. **Markdown 正文**：作为这个子代理的系统提示词（system prompt）。内置角色直接使用；外部角色里，claude-code 通过 `--append-system-prompt-file` 引用它，其余 harness 会把它拼进发给 CLI 的 stdin 最前面。

最小内置示例（`~/.pipiclaw/workspace/sub-agents/reviewer.md`）：

```md
---
name: reviewer
description: 当需要只读审查代码改动、查找正确性问题、回归风险和缺失测试时使用；不要用于实现修复或最终验收。任务中应给出改动范围和验收背景。
tools: read,bash
contextMode: contextual
memory: relevant
thinkingLevel: medium
paths:
  - src/
  - test/
maxTurns: 24
maxToolCalls: 48
maxWallTimeSec: 300
bashTimeoutSec: 120
---

你是专注于正确性和回归风险的代码审查子代理。

只审查任务指定的改动，不修改文件。优先报告正确性缺陷、行为回归、危险假设和缺失测试，并为每条发现提供 `path:line` 证据。没有发现时明确说明已检查的范围和剩余风险。
```

最小外部示例（`~/.pipiclaw/workspace/sub-agents/builder.md`）：

```md
---
name: builder
description: 重型实现者（外部 claude-code，异步）。用于边界清楚但跨多文件、需要自测的编码任务；返回 runId，完成时唤醒。不要用于只读定位或单点事实查询。
runtime: external
harness: claude-code
command: claude --dangerously-skip-permissions
model: sonnet
thinkingLevel: medium
workload: heavy
mutates: write
maxWallTimeSec: 3600
---

（正文即 system prompt，通过 `--append-system-prompt-file` 传入 claude）
```

## Frontmatter 字段说明（Frontmatter Reference）

`runtime` 缺省为 `internal`，因此所有既有内置角色文件零改动继续工作。**每个字段只对一种 runtime 有意义，写在错误的一侧会被驳回（产生 discovery warning），不会被静默忽略。**

### 内置（`runtime: internal`，或省略）

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | - | 子代理名称，必须唯一 |
| `description` | 是 | - | 给主代理看的简短用途描述 |
| `tools` | 否 | `read,bash` | 允许的工具，支持 `read`、`grep`、`bash`、`edit`、`write`、`web_search`、`web_fetch` |
| `model` | 否 | 当前主代理模型 | 精确模型引用，建议写成 `provider/modelId`，按 `models.json` 校验 |
| `contextMode` | 否 | `isolated` | `isolated` 或 `contextual` |
| `memory` | 否 | `isolated` 时为 `none`，`contextual` 时为 `relevant` | `none`、`session`、`relevant` |
| `paths` | 否 | 空 | 建议优先关注的文件或目录 |
| `thinkingLevel` | 否 | 普通委派为 `off`，`purpose=verify` 为 `medium` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `maxTurns` | 否 | `24` | 最大 assistant 轮数 |
| `maxToolCalls` | 否 | `48` | 最大工具调用次数 |
| `maxWallTimeSec` | 否 | `300` | 最大总执行时长，秒；超过 120s 的部分会异步化，见下文"同步宽限窗口" |
| `bashTimeoutSec` | 否 | `120` | 子代理内 bash 命令默认超时，秒 |
| `workload` | 否 | `light` | `light` 或 `heavy`，只影响系统提示里的目录分组展示 |
| `mutates` | 否 | 按 `tools` 是否含 `write`/`edit` 推定 | `read` 或 `write`；决定是否参与 workspace 写锁、能否用于 `purpose=verify`。推定只看 `write`/`edit`，**不看 `bash`**——含 `bash` 却未显式声明 `mutates` 的角色会在 discovery 里收到一条提示（该角色可通过 bash 写入但未声明 mutates），角色仍会加载，行为不变，只是可见 |
| `harness` / `command` / `shell` / `env` / `cwd` | 驳回 | - | 只对外部角色有意义（`cwd` 对两种 runtime 都驳回，见下） |

### 外部（`runtime: external`）

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` / `description` | 是 | - | 同上 |
| `harness` | 是 | - | `claude-code`、`codex-cli` 或 `exec` |
| `command` | 是 | - | 目标 CLI 的命令行，按 shell 词法分词后直接 argv 调用，**不经过 shell** |
| `mutates` | 是 | - | `read` 或 `write`，无默认值——这是一次显式声明，决定是否取 workspace 写锁、是否可用于 `purpose=verify` |
| `model` | 否 | - | 目标 harness 自己的模型字符串（如 `sonnet`），**原样透传，不经过 `models.json` 校验** |
| `thinkingLevel` | 否 | 同内置词表 | 由结构化 harness 翻译成目标 CLI 的推理参数（见下） |
| `workload` | 否 | `heavy` | 同内置 |
| `shell` | 否 | `false` | 仅 `exec` 可设为 `true`，此时整条 `command` 交给 `/bin/sh -lc`；结构化 harness 使用时会被 discovery 驳回，因为它会绕过协议 argv 组装 |
| `env` | 否 | 空 | 追加或覆盖继承自 pipiclaw 进程的环境变量 |
| `maxWallTimeSec` | 否 | `1800` | 外部角色只有这一个执行预算——没有轮数/工具调用次数上限，因为那些概念对外部 CLI 不适用 |
| `contextMode` | 否 | `isolated` | 同内置词表，见下文"`contextMode` 与 `memory`" |
| `memory` | 否 | **`none`，不跟随 `contextMode`** | 与内置不同：内置的 `contextual` 隐含 `relevant`，外部永远默认 `none`，必须显式声明才会把会话/记忆内容发给外部进程 |
| `paths` | 否 | 空 | 同内置 |
| `tools` / `maxTurns` / `maxToolCalls` / `bashTimeoutSec` / `cwd` | 驳回 | - | 对外部进程无意义或工作目录不允许写死在角色里 |

**工作目录永远不写在角色文件里**，无论内置还是外部——它是每次委派时通过调用参数 `workingDirectory` 现场决定的，见下文"调用参数"。

**二进制缺失时角色仍会被列出**，标记为不可用并给出安装提示；调用它会得到明确的错误，不会静默回落到内置角色。

## 调用参数（Invocation Parameters）

上面的 frontmatter 是**人**的配置面：你在配置文件里精确设定角色的模型、工具（内置）或命令（外部）和执行预算。下面是**主代理**每次委派时能填的参数，刻意比 frontmatter 窄——执行策略应当来自配置和台账，而不是模型每次调用时的临场判断。内置和外部角色共用同一份调用 schema，不因 runtime 而增减字段；但字段对某个 runtime 是否**生效**并不对称——见每行说明。**对外部角色无效的字段会被直接驳回（`RecoverableToolError`），不是静默忽略。**

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `label` | - | 必填。展示给用户的进度标签 |
| `task` | - | 必填。完整任务描述；子代理看不到主对话，目标/范围/路径/约束/验收方法都要写进来 |
| `agent` | - | 使用 `workspace/sub-agents/` 里某个已配置角色（内置或外部） |
| `systemPrompt` | - | 不使用配置角色时，用它定义一个临时**内置**子代理；与 `agent` 二选一。外部角色没有 inline 形式 |
| `name` | `dynamic-subagent` | inline 子代理的显示名，进入运行记录 |
| `tools` | 角色配置或 `read,bash` | 工具白名单（仅内置）。**对外部角色传入会被驳回**：外部智能体的能力边界由它自己的命令决定，这个参数对它没有意义 |
| `model` | 见[模型解析顺序](./configuration.md) | 精确模型引用（仅内置）。**对外部角色传入会被驳回**：外部角色的模型只能在角色文件里配，且从不按 `models.json` 校验 |
| `effort` | `standard` | 执行预算档位：`quick`、`standard`、`deep`。内置替换四个数值预算；外部只有 `maxWallTimeSec` 一个维度，`quick`/`deep` 按外部量级取值，`standard`/不传沿用角色自身的 `maxWallTimeSec` |
| `context` | `none` | 上下文注入：`none`、`session`、`relevant`。对内外角色都生效——这是模型每次委派的显式决定，与角色文件里的 `memory` 默认值是两回事（见下文 `contextMode` 与 `memory`） |
| `paths` | 角色配置 | 建议优先关注的路径；对内外角色都生效 |
| `workingDirectory` | runtime 自身工作目录 | **每次委派都应显式传**；必须是已存在目录。并行写入的分片必须各自 `git worktree add` 后指向不同 checkout |
| `thinkingLevel` | `off`（`verify` 为 `medium`） | 推理强度；外部角色由 runtime 翻译成对应 harness 的写法 |
| `purpose` | `work` | `verify` 进入独立验收协议，需同时传 `taskId` |
| `taskId` | - | 绑定任务台账；`purpose: verify` 要求它 |
| `returns` | `text` | `artifact` 要求子代理把主产出写成文件并以 `ARTIFACT: <filename>` 结尾（仅内置）。**对外部角色传入会被驳回**：`artifact` 协议假定产物在 `artifactDir` 内，而外部角色的真实产出在它自己的工作目录里，两者语义不同；外部角色的完整产出始终落在 `output.md`，需要指定产物位置时把要求写进 `task` |

### `effort` 与 frontmatter 数值的关系

`effort` 是执行预算的命名组合，内置和外部各有一套换算，都以**整组替换**（不传则沿用角色 frontmatter 里的精确数值，没有配置角色时用默认）而不是逐字段合并。

内置（四个数值预算都受影响）：

| `effort` | maxTurns | maxToolCalls | maxWallTimeSec | bashTimeoutSec |
|---|---|---|---|---|
| `quick` | 8 | 16 | 120 | 60 |
| `standard` | 24 | 48 | 300 | 120 |
| `deep` | 48 | 96 | 900 | 180 |

`standard` 与内置默认值完全一致，所以不传 `effort` 时行为不变。

外部（没有轮次/工具调用预算，`effort` 只移动 `maxWallTimeSec`，数值是外部量级，不是内置表格里的秒数）：

| `effort` | maxWallTimeSec |
|---|---|
| `quick` | 600 |
| `standard` | 角色自身 `maxWallTimeSec`（未设置时 1800） |
| `deep` | 5400 |

### `context` 与 frontmatter 的关系

`context` 是 `contextMode` + `memory` 的调用侧写法：`none` → `isolated`/`none`，`session` → `contextual`/`session`，`relevant` → `contextual`/`relevant`。对内外角色都生效——传 `context: relevant` 会让外部角色也拿到会话/记忆上下文，这是模型每次委派的显式决定，不是角色文件里被遗忘的默认值。frontmatter 仍可单独设置这两个字段，包括 `contextual` + `memory: none`（只注入 `paths`）这种调用面无法表达的组合。

## 同步宽限窗口：一次调用，两种返回（Sync Grace Window）

无论内置还是外部，`subagent` 工具调用只是**可选地等待**结果：

- 在 `min(角色的 maxWallTimeSec, 120s)` 内结算完成 → 直接把结果内联返回，和今天完全一样。内置角色的 `quick`/`standard` 档基本总是落在这个窗口内。
- 超过这个窗口仍未结算 → 返回 `{ runId, status: "running" }` 和一句"完成时会唤醒你"，委派本身继续在后台跑。这不是失败，是降级。**外部角色的宽限窗口恒为 0**——它们是重型工作，一律走异步。

收到 "still running" 占位结果后：**不要轮询、不要重复派发，结束当前回合**；委派完成时 runtime 会自己唤醒本频道，带回结果与产物路径。想主动看进度用 `subagent_manage op=list` 或 `/subagents list`，不要用委派工具本身当轮询手段。

**`/stop` 不再连带杀掉已派发的委派**（有意变更）。停止一个正在跑的委派永远需要显式调用 `subagent_manage op=cancel` 或运行时命令 `/subagents cancel <runId>`；后者不经过模型，在模型不可用或回合卡死时依然能用。

## 控制面：`subagent_manage` 与 `/subagents`

`subagent` 工具的调用 schema 完全不变；内外差异全部封装在角色配置和 runtime 内部。查看/控制在途或历史 run 用另一个工具/命令：

**模型侧**——`subagent_manage` 工具，三个 op：

| op | 语义 |
|---|---|
| `list` | 本频道 run 快照：runId、角色、状态、已运行时长、taskId、产物目录、锁持有情况 |
| `cancel` | 按 runId 终止。外部杀进程组，内置调用 abort；不触发完成唤醒——这是模型自己的决定 |
| `follow_up` | 在一个已结束、且 harness 支持续接（`claude-code`/`codex-cli`）的外部 run 上追加一轮，产生**新的 runId**。内置 run 没有可续接的会话，会得到明确拒绝而不是回落 |

`follow_up` 派发时走的是与首次派发**同一套信封构造**：运行时上下文（含这次续接自己新分配的产物目录）、`paths`/会话/记忆上下文块、以及 `purpose=verify` 时的验收协议，而不是一段只把原始指令转发过去的手写文本。verify 的准入检查（`mutates: write` 角色不能验收、`exec` 不能验收）也在 `follow_up` 上重新核对一遍——角色如果在原始 run 之后被改成 `mutates: write`，续接会被拒绝,不会因为"上次派发时它还是只读"就放行。

**角色改过之后还能续接吗**：能否续接取决于改了什么。pipiclaw 在首次派发时会记下角色的 `command`/`model`/`shell` 指纹；`follow_up` 时如果这三者中任何一个变了（换了 CLI 参数、换了模型、切换了 shell 模式），续接会被拒绝并提示改派新任务——旧会话不应该被一套它从未写过的调用方式重新解读。**只改系统提示词正文不受影响**，续接照常进行，因为一次续接本来就带着旧会话的上下文，修一个措辞或错别字不该打断所有在途续接。

**人侧**——运行时命令，不经过模型：

```text
/subagents                      # 运行中的 run + 最近完成的几条 + 角色目录摘要
/subagents list [running|failed|all]  # 按状态筛选
/subagents show <runId>         # 完整记录、实际 argv、stderr 尾部
/subagents output <runId>       # 该 run 的文本产出（output.md 尾部）
/subagents cancel <runId|all>   # 直接杀进程组 / abort，不经过模型；all 终止本频道所有在途 run
/subagents roles [name]         # 角色目录；带 name 查看单个角色详情（tools、预算、system prompt……）
```

`runId` 是短小可读的 `run_` + 6 位字符（例如 `run_a1b2c3`），不再是派发它的那次工具调用自身的 id（后者在某些 provider 上是一长串 `call_…|fc_…` 复合 id）。命令支持不带 `run_` 前缀的简写，只要能唯一匹配即可，例如 `/subagents show a1b2c3`。

## 关键字段怎么理解（How to Use the Key Fields）

### `tools`（仅内置）

建议尽量收窄，而不是一上来给满。常见组合：

- `read,bash`：只读检查、分析、审查。
- `read,edit,write,bash`：需要实际修改文件。

外部角色没有 `tools` 概念——它的能力边界由目标 CLI 自己的命令行决定（例如 `codex exec --sandbox read-only`），pipiclaw 不在配置层假装能限制它。

### `contextMode` 与 `memory`

这两个字段一起决定子代理"看得到多少背景"。**内外角色都可以设置**，但默认值不同——外部角色的默认更保守，见下。

| `contextMode` | 含义 |
|----|------|
| `isolated` | 默认值，不自动带入主会话上下文 |
| `contextual` | 自动注入一小部分相关会话 / 记忆上下文 |

| `memory` | 含义 |
|----|------|
| `none` | 不注入额外记忆 |
| `session` | 注入会话工作态摘要 |
| `relevant` | 注入筛选后的相关记忆与上下文 |

**默认值按 runtime 不同**：内置角色里 `contextMode: contextual` 隐含 `memory: relevant`；**外部角色的 `memory` 默认永远是 `none`，不跟随 `contextMode`**——一个只想要 `paths` 注入（`contextMode: contextual`，未写 `memory`）的外部角色不会因此意外开始把频道会话状态发给第三方进程。

**这是一条真实的数据外发路径，如实说明**：显式声明 `memory: session` 或 `memory: relevant` 的外部角色，会把 `SESSION.md` 摘要（`session`）或召回的 `MEMORY.md`/`HISTORY.md` 片段（`relevant`）写进发给外部进程的 stdin，交给第三方 CLI 及其背后的 API。这是一次显式、知情的选择，声明后 discovery 会给出一条提示级 warning 提醒这件事，`/subagents roles <name>` 也会展示当前生效的 `contextMode`/`memory` 并在非 `none` 时标出这条提示。

推荐搭配：

- 必须继承会话决策或团队背景的审查、研究任务：`contextMode: contextual` + `memory: relevant`（外部角色需显式声明 `memory`，不能只靠 `contextMode`）。
- 任务描述已经自包含、强调独立判断或无需会话背景的角色：`contextMode: isolated` + `memory: none`（外部角色的默认值本就如此）。

外部角色自己也会读取目标仓库的 `CLAUDE.md` / `AGENTS.md` 建立上下文，这条路径不受 pipiclaw 的 `memory` 设置影响，见下文"明确不可控的部分"。

### `model`

内置角色：如果要指定，建议使用精确模型引用，例如：

```text
anthropic/claude-sonnet-4-5
my-gateway/gpt-4.1
```

如果引用不唯一或模型不存在，这个子代理定义会被忽略。

外部角色：`model` 是目标 harness 自己的字符串（如 `sonnet`、`gpt-5.6-luna`），pipiclaw 原样透传、不做任何校验——它无法验证另一个 CLI 的模型名称是否有效。

### `thinkingLevel`

`thinkingLevel` 控制子代理的推理强度。运行时为了控制普通委派成本，默认将 work 子代理设为 `off`；独立验收默认使用 `medium`。可复用的生产配置建议显式填写，避免角色行为依赖隐藏默认值：

- 机械性定位、明确范围内的信息提取：通常使用 `low`。
- 多来源综合、代码审查、改动分组和独立验收：通常使用 `medium`。
- 只有任务确实需要更深推理且预算允许时才使用 `high` 或 `xhigh`。

外部角色使用同一词表，由结构化 harness 自动翻译：claude-code 追加 `--effort <level>`，codex-cli 追加 `-c model_reasoning_effort=<level>`。角色的 `command` 只负责选择可执行文件、权限模式和用户自定义的固定参数，不应重复编码 model 或 thinkingLevel。某些档位在目标 CLI 没有更低等价物时会夹取到最接近的档位。`/subagents show <runId>` 能看到实际生成的 argv，供核实结果。通用 `exec` harness 不知道目标脚本的参数协议，因此不自动追加 model 或 thinking 参数。

结构化 harness 对角色字段和协议参数的组装如下；这些都由 runtime 负责，不需要写进 `command`：

| harness | `model` | `thinkingLevel` | system prompt / task | 续接与输出协议 |
|---|---|---|---|---|
| `claude-code` | `--model <model>` | `--effort <level>` | system prompt 使用 `--append-system-prompt-file`，task 走 stdin | `--session-id` / `--resume`，`-p --output-format stream-json --verbose` |
| `codex-cli` | `-m <model>` | `-c model_reasoning_effort=<level>` | system prompt 与 task 合并后走 stdin | `resume <thread-id>`，`--json -` |
| `exec` | 不自动追加 | 不自动追加 | system prompt 与 task 合并后走 stdin | 不支持续接，无结构化终态协议 |

### `mutates`（写权限声明）

`mutates` 承担的是"这个角色会不会改动宿主机"这一件事，三处消费：

1. **Workspace 写锁**：只有 `mutates: write` 的 run 会在其 `workingDirectory` 上取一把排他写锁，直到结算才释放；同一目录（含父子目录）上第二个写角色会被直接拒绝，错误会点名持有者的 runId 与工作目录。`mutates: read` 的 run 不取锁，也不会被写锁阻塞。
2. **`purpose=verify` 准入**：声明 `mutates: write` 的角色不能同时用作验收者；`exec` harness 因为没有可验证的完成协议，一律不能用于验收，无论 `mutates` 怎么写。
3. **审计**：外部角色每次派发都会记一条包含 `mutates` 的审计事件。

内置角色不填时按 `tools` 是否含 `write`/`edit` 自动推定；外部角色必须显式声明。

**如实说明它的可信度**：内置角色的 `mutates` 是**推定**（且只看 `write`/`edit`，不看 `bash`——`bash` 能做的事不受工具白名单约束，这是已知盲区），外部角色的 `mutates` 是角色作者的**自述**，两者 pipiclaw 都无法从 runtime 层面核实。写锁保证的是"**声明了写的委派之间**不会并发写同一棵树"，不是"这棵树上只有一个写入者"——一个含 `bash` 却未声明 `mutates: write` 的角色，或谎报 `mutates: read` 的外部角色，都不受这把锁保护。含 `bash` 且未声明 `mutates` 时，discovery 会给出提示级 warning，但不阻止角色加载，也不改变它的行为。

## 正文怎么写（System Prompt Body）

frontmatter 后面的正文就是子代理的系统提示词。它应该明确说明：角色职责、工作边界、判断和证据标准、停止条件、输出契约，以及不该做什么。

`description` 不是普通简介，而是主代理选择角色时直接看到的路由规则。建议使用"当……时使用；不要用于……；任务中必须提供……"的结构，并明确该角色是否会修改文件、Git 或外部状态，以及它是重量级（heavy）还是轻量级（light）。只把使用时机写在正文里是不够的，因为主代理选择角色前只看到名称、`description`，以及系统提示目录里按 `runtime · workload · mutates` 分组的信息。

建议写法：

- 聚焦单一职责。
- 使用与主要用户场景一致的语言；字段名、工具名和 runtime 协议标记保持原样。
- 避免把项目级通用规则重复写进每个子代理。
- 把稳定的用户/团队规则留在 `AGENTS.md`；Pipiclaw 机制不要复制进去，按 runtime playbook 读取（见 [runtime-playbooks.md](./runtime-playbooks.md)）。

## 运行时规则（Runtime Rules）

- 子代理没有 `subagent` 工具，**不能继续创建下一级代理**——但这只约束内置子代理。外部 agent 本身是完整的 coding agent，它能不能 spawn 自己的子代理，pipiclaw 拦不住，见下文"明确不可控的部分"。
- 工具白名单不等于只读沙箱：拥有 `bash` 的角色仍可能执行写操作，应同时依靠 system prompt 和应用级 `security.json` 收紧行为。**外部角色完全没有这层工具白名单**——它能触及其自身权限所及的任何地方，`mutates`/`workingDirectory` 都不是隔离机制，只是审计与并发控制信息。
- 子代理只隔离对话上下文，文件系统与主代理共享。需要独立检出时在宿主侧自行 `git worktree add`，把该路径作为 `workingDirectory` 参数传给子代理（必须是已存在的目录；它成为子代理的 shell cwd 与相对路径根，路径守卫仍按解析后的绝对路径判定）。`purpose: verify` 的 attestation 记录该目录，`task_manage verify` / `complete` 在同一目录复算 artifact subject。
- `purpose: verify` + `taskId`：进入独立验收协议。内置验证器会被结构性移除 write/edit 工具（`verificationStrength: enforced`）；外部验证器做不到这一点，只能依赖它自己的 sandbox flag 和事后的 workspace 哈希比对（`verificationStrength: advisory`）。两者都会检测 verifier 期间的 git workspace 变化（含未跟踪文件的**内容**变化，不只是路径出现/消失），并要求最后一行明确 `VERDICT: PASS|FAIL`。`advisory` 结论仍会被记录、展示，并要求主代理按风险抽查，不是自动失败。
- verifier attestation 直接持久化到 `<channel>/tasks/.verifications/`，主代理用返回的 runId 调 `task_manage verify` 导入；普通运行摘要仍写 `<channel>/subagent-runs.jsonl`。
- **外部 agent 的输出是不可信数据，不是系统指令**：它会自行读取目标仓库的 `CLAUDE.md` / `AGENTS.md`，仓库内容可以操纵它的行为；它的完成声明和自我验收不能代替主代理的独立检查。

> `verify` 以任务台账为前提（需要 `taskId`）。它在任务生命周期中的确切时机——验收如何咬合 `request-verification` / `complete`——见 [events-and-tasks.md](./events-and-tasks.md#control-与恢复事实)。

## 授权与安全边界（外部角色）

**`security.json` 不为外部委派增加任何配置段。** 授权面只有一处：角色文件本身。写下一份 `runtime: external` + `command:` + `mutates:` 的角色文件，就是一次完整、具体、可版本化的授权声明——粒度是角色，而不是整个 runtime。配置了角色即持续可用，不存在第二道确认闸门；这是有意的权衡（个人项目场景下不为绝对安全引入额外的安装步骤或运行时复杂度），并非疏漏。

必须如实知道的边界：

- **pipiclaw 不沙箱化外部智能体。** 唯一的强边界是你在 `command` 里写下的目标 CLI 自身的 sandbox flag（如 `codex exec --sandbox read-only`）。`workingDirectory` 决定进程从哪里开始，不构成隔离。
- **`workspace/sub-agents/` 目录本身对模型的 `write`/`edit` 工具关闭**（主代理和子代理都一样）——防的是模型自己写一份外部角色文件、再调用它，从而绕过命令守卫执行任意宿主命令。这条防线拦不住 `bash` 直接改这个目录（与既有的记忆文件写入拒绝同一个已知缺口），角色目录建议纳入版本控制作为兜底：任何变更都可见、可回滚。
- 每次外部派发都会写一条审计事件（runId、角色、harness、完整 argv、工作目录、`mutates`、model），不受"只记录被拦截的动作"这个开关影响。
- 外部进程继承 pipiclaw 自身的环境变量（它需要自己的认证，如 `ANTHROPIC_API_KEY`）；角色 `env:` 可以在此基础上追加或覆盖。
- 外部 agent 本身是完整 coding agent，能否 spawn 自己的子代理、递归到多深，pipiclaw 不保证也不限制。
- 显式声明 `memory: session` 或 `memory: relevant` 的外部角色会把频道会话状态/召回的记忆片段写进发给外部进程的 stdin——这与继承环境变量属于同一类如实声明的暴露面，不是隐藏行为（默认值是 `none`，见上文"`contextMode` 与 `memory`"）。

## 并发与重启

- **Workspace 写锁**（纯排他，无读写区分）：见上文"`mutates`"一节。
- **并发上限**：每个频道最多 6 个、单个 Pipiclaw 实例最多 20 个在途 run，防止失控派发；触发时错误会给出可执行的下一步（等待，或取消一个在跑的 run）。
- **daemon 重启**：外部 run 是 `detached` 进程，重启后依然存活，runtime 会按持久化的 pid 做存活探针，进程已退出则解析产物目录里的 `events.jsonl` 补判终态、补发迟到的完成唤醒。内置 run 随 daemon 一起消失，重启后会被判定为结局未知（`lost`）并唤醒频道说明情况，不会留下一条永远"running"的孤儿记录。

## 从 agentmux 迁移

如果之前用 `agentmux` CLI + skill 驱动外部 Agent，迁移是把 `~/.config/agentmux/config.yaml` 里的模板逐个翻译成角色文件——一次性工作，模板数量通常是个位数：

| agentmux | 角色文件字段 | 备注 |
|---|---|---|
| `templates.<name>` | 文件名 + `name` | - |
| `description` | `description` | 建议补充量级（workload）与是否改动宿主（mutates）的措辞 |
| `command` | `command` | 原样搬过来，runtime 会分词后直接 argv 调用，不再拼进 shell 字符串 |
| `harness_type: claude-code-ndjson` | `harness: claude-code` | - |
| `harness_type: codex-cli-execjson` | `harness: codex-cli` | - |
| `model` | `model` | 原样 |
| `effort` | `thinkingLevel` | **换了名字**：agentmux 的 `effort` 和 pipiclaw 内置委派已有的 `effort`（预算档位）撞名，外部角色统一用 `thinkingLevel` 表达推理强度 |
| `system_prompt` | 正文 | - |
| （新增） | `mutates` | agentmux 没有这个概念，按角色实际行为填：`planner`/`reviewer`/`scout` 类通常是 `read`，`builder`/`documenter` 类通常是 `write` |
| `cwd` | 不迁移 | 工作目录改为每次委派通过 `workingDirectory` 参数传入 |
| `defaults.shell` | 仅 `exec` 可迁移为 `shell: true` | claude-code / codex-cli 请改用包装脚本作为 `command`，否则会绕过 harness 的协议参数 |
| `defaults.env` | `env:` | - |

`harness_type: pi-rpc` 或基于 tmux 的 claude-code 配置不在迁移范围内——discovery 会产生 warning 并在 `/subagents list` 尾部列出，不会静默丢失。tmux/人工 attach 场景仍可以继续用独立的 `agentmux`，两者不冲突；pipiclaw 只是不再依赖它作为默认路径。

## 推荐写法（Recommended Presets）

[`examples/sub-agents/`](../examples/sub-agents/) 里的成品按下面的思路配置。内置角色的价值是**低延迟和上下文隔离**，外部角色的价值是**算力和跨会话续接**——按这条线分工，而不是按任务听起来重不重。

**Explorer**（内置）—— 定位仓库实现、追踪调用链、梳理模块关系：

- `tools: read,bash`
- `contextMode: isolated` + `memory: none`
- `thinkingLevel: low`

**Log sifter**（内置）—— 从大体量日志或命令输出中筛出证据，避免原文进入主会话上下文：

- `tools: read,bash`
- `contextMode: isolated` + `memory: none`
- `thinkingLevel: low`
- 输出契约明确要求「宁可少带并说明未覆盖范围」，否则它会把日志整段搬回来，失去存在意义

**Git committer**（内置）—— 将用户明确指定的现有改动整理成 commit：

- `tools: read,bash`
- `contextMode: isolated` + `memory: none`
- `thinkingLevel: medium`
- 默认只创建本地 commit；只有用户明确要求时才 push

**Planner / Builder / Builder-hard**（外部，claude-code）—— 方案收敛与跨多文件的重型实现：

- 三者均为 `workload: heavy`。planner 使用 `--permission-mode plan` + `mutates: read`；builder / builder-hard 才使用 `--dangerously-skip-permissions` + `mutates: write`
- `model` 原样透传（`opus` / `sonnet`）；claude-code harness 自动把 `model` 和 `thinkingLevel` 翻译为 `--model` 与 `--effort`
- `maxWallTimeSec` 按职责给足（2400～5400）——它们是重活，不指望在同步宽限窗口内返回
- 两个写角色并行派发时必须使用不同的 `workingDirectory`，否则第二个会被工作区写锁拒绝

**Scout**（外部，codex-cli，只读）—— 单点事实查询：

- `command` 用 `codex exec --sandbox read-only`，让 `mutates: read` 是被 CLI 强制的声明而不只是一句话
- 只读角色不参与工作区写锁，可以与 builder 并行

**Reviewer / Verifier / Worker / Documenter**（外部，codex-cli）—— 独立挑错、运行取证、通用分析、文档：

- reviewer 使用 `--sandbox read-only` + `mutates: read`；完整输出由 runtime 自动保存到 run 的 `output.md`，无需为评审报告授予写权限。它也可承担外部 `purpose=verify`，但 attestation 强度仍是 `advisory`
- verifier / worker / documenter 使用 `--sandbox workspace-write` + `mutates: write`，可以生成工作区产物，但模板不允许它们修改 Git 历史或外部系统
- verifier 因运行测试可能写构建产物，不能承担要求只读的 `purpose=verify`；需要只读终验时用 reviewer，并按风险补充主代理抽查
- 提交统一交给内置 git-committer；只有用户明确要求时才 push

## 常见错误（Common Mistakes）

- 缺少 `name` 或 `description`。
- 同一个目录里定义了重复的 `name`。
- `tools` 写了不支持的工具名（仅内置）。
- `contextMode` 或 `memory` 写了不支持的值。
- 正文为空，只有 frontmatter。
- `model` 只写了模糊名字，结果无法精确匹配（内置角色；外部角色的 `model` 不做校验）。
- 只在正文描述使用时机，导致主代理无法从目录中的 `description` 正确选择角色。
- 把 `read,bash` 误认为 runtime 强制只读，未约束 bash 的写命令；含 `bash` 却没声明 `mutates` 时 discovery 会提示，别忽略它。
- 在任务 Goal 未覆盖目标仓库或 ref 时让 Git 子代理自动 push。
- 给外部角色写 `cwd`、`tools`、`maxTurns` 等只对内置有意义的字段，或给内置角色写 `harness`、`command`、`shell`、`env`——都会被直接驳回，不是被忽略。
- 在调用面对外部角色传 `tools`、`model` 或 `returns: "artifact"`——这些参数对外部角色无效，会被直接驳回而不是静默忽略。
- 把 `mutates: write` 的外部角色用于 `purpose=verify`——会被直接拒绝派发（`follow_up` 上同样会被拒绝，不只是首次派发）。
- 以为 `mutates: read` 或工具白名单是安全边界——外部进程不受它们约束，真正的边界只有目标 CLI 自己的 sandbox flag。
- 给外部角色写 `memory: relevant` 却没意识到这会把频道会话/记忆内容发给第三方进程——这是一次真实的数据外发，不是无副作用的开关。
- 改了外部角色的 `command`/`model`/`shell` 之后还指望 `follow_up` 能续接旧会话——指纹不匹配会被拒绝，需要改派新任务。

## 该看哪份文档

- 定时事件与任务台账（含 verifier 在任务生命周期里的时机）：[events-and-tasks.md](./events-and-tasks.md)
- Runtime playbooks 与知识分层：[runtime-playbooks.md](./runtime-playbooks.md)
- `channel.json`、`auth.json`、`models.json`、`settings.json`：[configuration.md](./configuration.md)
- 委派纪律（选人、工作目录、等待与验收，运行时读取的版本）：`src/playbooks/agent-delegation.md`

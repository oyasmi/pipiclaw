# 智能体委派指南（Sub-Agents）

> **适合谁**：想让 Pipiclaw 调用本机的 Claude Code、Codex CLI、Cursor CLI、Antigravity CLI 或轻量内置子智能体协同完成编码、调研与独立审查的用户与管理员。
> **读完你会得到**：启用内置或外部角色的方法、`/subagents` 控制命令、后台异步唤醒与多轮续接（`follow_up`）机制，以及自定义角色文件的完整字段与安全边界参考。

智能体委派让主智能体把某一步具体工作交给最擅长它的执行者：**进程内轻量角色**适合快速只读检索与筛查，**外部 Coding Agent** 适合跨多文件实现、自测迭代与异构模型交叉审查。它与 [事件与任务](./events-and-tasks.md) 正交——单次聊天回合里即可直接发起委派，无需先建长程任务；在任务步骤内发起委派则会自动归入[团队看板与工作项](./events-and-tasks.md#3-团队看板与工作项)。

### 两种执行方式（`runtime`）对比

| 维度 | 内置子代理（`internal`，默认） | 外部智能体（`external`） |
|---|---|---|
| **运行位置** | Pipiclaw 进程内隔离上下文 | 独立宿主机子进程（`claude`、`codex`、Cursor `agent`、Antigravity `agy` 或自定义脚本） |
| **模型与凭据** | 复用 Pipiclaw 的 `auth.json` / `models.json` | 使用目标 CLI 自身的登录态、模型目录与配置文件 |
| **权限与安全边界** | 受 Pipiclaw 工具白名单与 `security.json` 守卫约束 | **不经过 Pipiclaw 守卫**；真实边界为目标 CLI 自身的 sandbox 参数与系统运行账号 |
| **典型场景** | 快速代码检索、局部审查、固定格式摘要 | 跨模块编码实现、跑测试自修复、几十分钟重型重构、异构模型独立复核 |

---

## 1. 启用示例角色

外部角色需要在运行 Pipiclaw 的系统账号下安装目标 CLI、加入 `PATH` 并登录。内置 `pi-scout` 复制后可用，优先使用 `settings.subagentModel`，缺省时使用主会话模型。

Pipiclaw 安装包附带十二个角色模板，位于包内或源码仓库的 [`examples/sub-agents/`](../examples/sub-agents/README.md)。

- **`*-flash`**：做法明确、易检查的轻量快速修改；
- **`*-main`**：日常功能开发、问题排查与文档编写主力档；
- **`*-high`**：复杂架构取舍、疑难诊断与高风险变更；
- **`codex-review`**：通过 `--sandbox read-only` 强制只读的独立代码审查角色。
- **`pi-scout`**：使用 `read`、`grep` 和 `glob` 快速检索代码、日志与配置，并汇总证据。

十个外部执行模板声明 `mutates: write` 并配置了 CLI 自动写入权限。目录加载为**平铺扫描**，路径为 `workspace/sub-agents/*.md`。

```bash
mkdir -p ~/.pipiclaw/workspace/sub-agents
PIPICLAW_PKG="$(npm root -g)/@oyasmi/pipiclaw"

# 内置只读侦察
cp "$PIPICLAW_PKG"/examples/sub-agents/pi-scout.md ~/.pipiclaw/workspace/sub-agents/

# 按本机已安装的 CLI 选装外部角色
cp "$PIPICLAW_PKG"/examples/sub-agents/{claude-main,codex-review}.md \
  ~/.pipiclaw/workspace/sub-agents/
```

复制完成后，直接在聊天或终端验证并交办任务：

```text
/subagents roles
/subagents roles pi-scout
```

确认状态可用后，直接用自然语言交代目标与工作目录（主智能体会按角色描述自动挑选合适的执行器，也可直接点名）：

```text
请把这次导出模块改造委派给合适的执行器，工作目录是 /srv/order-service；实现并跑通测试后，再用只读角色独立审查当前 diff，把结论和剩余风险告诉我。
```

---

## 2. 查看与控制委派（`/subagents` 命令）

所有 `/subagents` 命令由运行时直接处理（零模型消耗），即使当前回合卡住或忙碌也可随时执行。`runId` 形如 `run_a1b2c3`，命令支持省略 `run_` 前缀的唯一简写：

| 命令 | 说明 |
|---|---|
| `/subagents` | 查看当前运行中的委派、最近结束的记录与角色目录概览 |
| `/subagents list [running\|failed\|all]` | 按状态筛选本工位的委派运行记录 |
| `/subagents show <runId>` | 查看运行详情，包括实际命令行、工作目录、失败分类和 `stderr` 尾部 |
| `/subagents output <runId>` | 查看该次委派产出的正文尾部（完整文件位于工位 `subagent-artifacts/<runId>/output.md`） |
| `/subagents cancel <runId\|all>` | **立即强杀外部进程组或中止内置子代理**（`all` 终止本工位全部在途委派） |
| `/subagents roles [name]` | 列出全部已加载角色（格式：`runtime, mutates, model, thinking`）；带 `name` 查看完整配置与告警 |

> **切记**：聊天里的 `/stop` **只停止当前聊天回合**，已派发的后台委派会继续运行；需要终止委派请用 `/subagents cancel <runId>`。长期运行外部委派请保持常驻 `pipiclaw` daemon 在线（重启后会自动按 PID 接管对账；已结算记录与产物保留 30 天）。

---

## 3. 异步返回、进度通知与多轮续接

- **同步宽限与自动唤醒**：
  - 聊天中调用**内置角色**共享 **10 秒**快速窗口：10 秒内完成直接内联返回，超时自动转为后台运行并返回 `runId`；
  - **外部角色**及**任务步骤内的所有委派**在启动确认后立即异步返回 `runId`；
  - 后台委派结束时自动唤醒原发起频道（多个结果在频道忙碌期间陆续完成会自动合并进同一唤醒回合，单回合最多合并 6 条；若频道已换绑到其他工位则抑制唤醒，结果仍保留在记录中）。收到“仍在运行”提示后**切勿轮询或重复派发**。
- **旁路进度播报（`delegation.notices`）**。默认 `"live"` 模式下，长耗时委派会在聊天中推送当前步骤和完成回执。外部进程静默满 **10 分钟**后，服务会检查整个进程组是否仍在消耗 CPU。编译或测试继续占用 CPU 时会推迟提醒，宿主机休眠也从静默时长中扣除。若系统无法提供 CPU 数据，服务会根据输出文件的静默时长提醒。运行时限照常生效。`mutates: write` 的委派结算时会与派发前的快照比较，附带本次实际修改的文件摘要。
- **在途重复委派**。同一个任务内，或同一个频道的聊天委派中，角色、用途、工作目录和任务正文相同的委派只允许同时运行一次。可以等待当前委派结束后重跑，或为并行写入使用各自的隔离工作树。
- **内置瞬时容错**：内置子代理遇到供应商 429 / 5xx / 网络闪断会自动原地退避重试（最多 3 次：2s / 4s / 8s），仍失败且配了 `fallbackModel` 时自动切换备用模型重试。
- **外部会话多轮续接（`subagent_run op=follow_up`）**：
  - `claude-code`、`codex-cli`、`cursor-cli` 与 `antigravity-cli` 支持在已结束的外部 run 基础上追加指令。新 run 用独立 `runId` 和产物目录，标准输入携带增量指令。Claude 继续通过 `--append-system-prompt-file` 接收角色正文。
  - 修改角色的 `command`、`model` 或 `shell` 后需要重新派发。Codex、Cursor 和 Antigravity 的续接会使用原会话已有的角色正文，需应用正文改动时请发起新委派。
  - 会话失效后，请发消息说明要继续的工作，助手会带上必要的上下文重新委派。登录、额度或模型配置问题需要先解决，再发起新委派。

### 外部委派失败怎么处理

`/subagents show <runId>` 会给出失败原因和下一步。任务车道也会把失败分类和建议交给任务负责人。

| 失败分类 | 下一步 |
|---|---|
| 需要重新登录、额度已用尽或模型配置无效 | 在服务所在机器重新登录、等待额度恢复或修正角色的模型配置，再发起新委派 |
| 会话无法继续 | 发起新委派，带上所需上下文和已有产物 |
| 上游服务暂时异常 | 如果显示“未进入执行”，可以重试一次。其他情况先检查产物和工作目录 |
| CLI 输出协议不匹配 | 核对 CLI 和适配器版本，检查产物目录里的 `events.jsonl` |
| 超过运行时限或运行出错 | 查看部分产物与 `stderr.log`，再决定继续、拆分或重试 |

“未进入执行”表示结构化输出中未观察到模型文本、工具活动或非零用量。输出损坏、无法识别或使用 `exec` 时，运行时会按已有执行活动处理重试风险。

---

## 4. 编写自定义角色文件

每个角色是 `~/.pipiclaw/workspace/sub-agents/<name>.md` 下的一个 Markdown 文件：**YAML Frontmatter** 定义运行方式与边界，**Markdown 正文**作为子代理的系统提示词（`description` 字段是主智能体挑选角色时唯一先看到的路由依据，建议写清“何时用、何时不用、需要什么输入”）。

**工作目录从不写死在角色文件里**——每次委派由主智能体通过调用参数 `workingDirectory` 指定（缺省为当前工位工作目录）。

### 最小角色模板对比

**外部角色示例（`claude-main.md`）**：

```markdown
---
name: claude-main
description: 主力编码档，适合跨文件功能实现、测试编写与问题修复；任务中需给出仓库绝对路径与验收命令。
runtime: external
harness: claude-code
command: claude --dangerously-skip-permissions
model: sonnet
thinkingLevel: medium
workload: heavy
mutates: write
maxWallTimeSec: 5400
---

按任务要求完成代码修改并运行相关验证命令，最后清楚列出改动文件、验证输出与剩余风险。
```

**内置只读角色示例（`reviewer.md`）**：

```markdown
---
name: reviewer
description: 轻量只读代码审查角色，用于查找逻辑缺陷、回归风险与缺失测试；不修改任何文件。
tools: read,grep,glob
contextMode: contextual
memory: index
thinkingLevel: medium
mutates: read
maxTurns: 32
maxToolCalls: 96
maxWallTimeSec: 600
---

你是专注于正确性与回归风险的审查子代理。只检查指定改动，每条问题给出 `path:line` 证据。
```

---

### Frontmatter 字段字典

每个字段严格归属对应 `runtime`，填错一侧会在发现阶段直接驳回告警（不会静默忽略）：

#### 内置角色字段（`runtime: internal` 或省略）

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `name` / `description` | 是 | — | 唯一角色名；给主智能体看的路由说明 |
| `tools` | 否 | `read,bash` | 允许的工具子集：`read,grep,glob,bash,edit,write,web_search,web_fetch` |
| `model` | 否 | `settings.subagentModel` 或主模型 | 精确 `provider/modelId` 引用（须在当前模型目录可解析） |
| `thinkingLevel` | 否 | `medium` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max`（按模型能力自动夹取） |
| `contextMode` | 否 | `isolated` | `isolated`（不带背景）或 `contextual`（允许注入 `paths` 与记忆） |
| `memory` | 否 | `isolated` 为 `none`；`contextual` 为 `index` | `none` 或 `index`（注入工作区共享背景 + 工位记忆索引 + 当日日记尾部） |
| `paths` | 否 | `[]` | 建议优先关注的相对路径提示列表 |
| `mutates` | 否 | 含 `write`/`edit` 推定为 `write`，否则 `read` | 决定是否申请目录排他写锁（`bash` 不参与自动推定，建议显式声明） |
| `workload` | 否 | `light` | `light` 或 `heavy`（用于目录分组提示） |
| `maxTurns` / `maxToolCalls` | 否 | `32` / `96` | 最大模型轮数 / 最大工具调用次数（单次输出上限 50KB，勿盲目调大以免撑爆上下文） |
| `maxWallTimeSec` / `bashTimeoutSec` | 否 | `600` / `120` | 单次委派总超时秒数 / 内部单条 `bash` 命令默认超时秒数 |

#### 外部角色字段（`runtime: external`）

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `name` / `description` | 是 | — | 同上（外部角色正文允许留空） |
| `harness` | 是 | — | `claude-code` \| `codex-cli` \| `cursor-cli` \| `antigravity-cli` \| `exec` |
| `command` | 是 | — | 目标 CLI 启动命令与权限参数（按词法切分直接 `argv` 调用，默认不经 shell） |
| `mutates` | 是 | — | **必须显式声明** `read` 或 `write`（决定是否获取工作目录排他写锁） |
| `model` | 否 | 由目标 CLI 自行决定 | 目标 CLI 自身的模型名（如 `sonnet`、`gpt-5.4`），原样透传 |
| `thinkingLevel` | 否 | 普通委派不追加；`purpose=verify` 默认 `medium` | 由结构化 harness 自动翻译为目标 CLI 推理参数（不要在 `command` 里重复写） |
| `maxWallTimeSec` | 否 | `3600` | 外部进程最大运行秒数 |
| `contextMode` / `paths` | 否 | `isolated` / `[]` | 同内置 |
| `memory` | 否 | **恒为 `none`（不随 `contextMode` 改变）** | 设为 `index` 会将工位记忆与当日日记通过 `stdin` 发往外部 CLI，属**显式数据外发选择** |
| `env` | 否 | `{}` | 追加或覆盖传给外部子进程的环境变量 |
| `shell` | 否 | `false` | 仅 `harness: exec` 允许设为 `true`（走 `/bin/sh -lc`）；结构化 harness 严禁开启 |
| `workload` | 否 | `heavy` | `light` 或 `heavy` |

---

### 五大外部 Harness 参数组装与注意事项

运行时自动负责组装模型、推理档位、任务输入与会话续接参数，**请勿在 `command` 中重复硬编码这些协议标志**：

| `harness` | 可执行命令 | `model` 映射 | `thinkingLevel` 映射 | 提示词与任务传递 | 续接与流式协议 |
|---|---|---|---|---|---|
| `claude-code` | `claude` | `--model <m>` | `--effort <lvl>` | 正文走 `--append-system-prompt-file`，任务走 `stdin` | `--session-id` / `--resume`，`-p --output-format stream-json --verbose` |
| `codex-cli` | `codex exec` | `-m <m>` | `-c model_reasoning_effort=<lvl>` | 正文与任务合并走 `stdin` | `resume <thread-id>`，`--json -` |
| `cursor-cli` | `agent` | `--model <m>[effort=<lvl>]` | 折入模型 ID（`off`/`minimal` 夹为 `low`） | 正文与任务合并走 `stdin` | `--resume <id>`，自动补 `-p --output-format stream-json --trust` |
| `antigravity-cli` | `agy` | `--model <m>` | `--effort <lvl>`（`off`/`minimal` 夹为 `low`） | 正文与任务合并走 `stdin`（或 `--agent` 且正文留空） | `--conversation <id>`，仅补 `--output-format stream-json`（**严禁加 `-p`**） |
| `exec` | 任意脚本/程序 | 不追加 | 不追加 | 正文与任务合并走 `stdin` | 无会话续接、无结构化事件（不可用于 `purpose=verify`） |

**Claude Code 的环境与隔离**。默认将 `CLAUDE_CODE_DISABLE_AUTO_MEMORY`、`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` 和 `CLAUDE_CODE_DISABLE_CRON` 设为 `1`。服务会静默清除继承的 `CLAUDECODE` 和 `CLAUDE_CODE_ENTRYPOINT`，并在委派详情标明清除的 OAuth、API 凭据和路由变量名，例如 `ANTHROPIC_BASE_URL`。角色的 `env:` 可以覆盖默认值或显式恢复需要的变量。

需要更多隔离的角色可以在 `command` 中显式配置 `--strict-mcp-config`、`--setting-sources project` 或 `--disallowedTools`。先确认所用 Claude CLI 版本支持对应选项，并检查角色需要的 MCP 服务器和工具。

**Codex CLI 的用量**。缓存命中的输入单独计入缓存读取。输入总量由新增输入和缓存读取组成，每个 token 计入总量一次。

**`cursor-cli`（`agent`）与 `antigravity-cli`（`agy`）特别注意**：
- **Cursor CLI（`agent`）**：无头 print 模式下若未传 `--force`（或 `-f` / `--yolo`），CLI 只提议修改而不落盘；因此写入角色推荐 `command: agent --force`，只读角色推荐 `command: agent --mode ask`。请勿在 `command` 中加 `--worktree`（会写到 `~/.cursor/worktrees/` 绕过目录写锁）。
- **Antigravity CLI（`agy`）**：
  1. **严禁在 `command` 中写 `-p` / `--print` / `--prompt` / `--conversation`**：`agy` 的 `-p` 接收字符串参数而非布尔开关，会吞掉后续参数或屏蔽 `stdin`；非空管道 `stdin` 配合 `--output-format stream-json` 即自动进入无头模式。
  2. **续接会话强校验**：`agy` 在找不到 `--conversation <id>` 时可能静默新建会话 ID；Pipiclaw 会严格核对返回的父会话 `conversation_id`，不一致时直接判为 `failed` 防止上下文错乱。
  3. **权限与环境变量**：`--mode plan` + `--sandbox` 并不保证绝对文件只读，无法证明完全只读的验证角色应声明 `mutates: write` 以通过写锁串行化；Pipiclaw 默认从外部子进程环境剥离 `GEMINI_API_KEY` / `GOOGLE_API_KEY` 以优先使用本机 `agy` 登录态（需用 API Key 时请在角色 `env:` 中显式映射）。

---

## 5. 模型调用参数与运行时安全边界

### 模型侧调用工具对比

主智能体平时优先使用 `subagent` 路由到已配置角色；没有合适角色时才用一次性内置工具 `subagent_inline`（可通过 `tools.json` 的 `tools.subagentInline.enabled: false` 关闭）：

- **`subagent`**：仅含路由参数 `agent`、`task`、`workingDirectory`（委派代码库时须传仓库绝对路径）、`worktree`（布尔值：在 Git 仓库内对 `mutates: write` + `purpose: work` 委派设为 `true` 时，运行时自动在 `.git/pipiclaw-worktrees/<runId>` 创建分支 `pipiclaw/<runId>` 的隔离工作树，并在结算时结构化返回 `branch` / `headSha` / `changedFiles`）、`purpose`（`work` 或 `verify`）、`item`（任务内关联工作项如 `"W2"`）。不允许在调用时覆盖角色的模型、工具或预算。
- **`subagent_inline`**：恒为内置运行，接收 `task`、`systemPrompt`、`tools`、`model`、`thinkingLevel`、`mutates`、`worktree`、`context`（`none` 或 `index`）以及整组预算档位 `effort`：
  - `quick`：8 轮 / 16 次工具 / 120s 总时长 / 60s 命令超时
  - `standard`（默认）：32 轮 / 96 次工具 / 600s 总时长 / 120s 命令超时
  - `deep`：64 轮 / 160 次工具 / 1800s 总时长 / 300s 命令超时

### 运行时规则（Runtime Rules）

1. **读写租约（Checkout RW Lease）与托管 Worktree 隔离**：声明 `mutates: write` 的委派在目标目录（含父子重叠目录）持独占写租约，`purpose: verify`（`mutates: read`）持共享读租约（允许并行检查、阻止并发写入），且**主会话与任务步骤的 `write` / `edit` 工具同样受活跃租约保护**。在 Git 仓库内并行实现时，优先传 `worktree: true` 由运行时托管独立工作树（无改动结算即删，已合并的干净工作树在父任务关闭或 24 小时巡检时自动回收，未合并改动自动保留并提示）。注意租约防的是并发覆盖，`mutates` 依赖声明且不拦截任意 `bash` 命令，**不是操作系统沙箱**。
2. **外部智能体的真实边界在宿主与 CLI 自身**：外部进程不经过 Pipiclaw 的 `security.json`，且会自动读取目标仓库内的 `CLAUDE.md` / `AGENTS.md` / `.cursor/rules`。请将外部进程输出视为待核实产物而非系统指令，高权限外部角色务必审阅 CLI sandbox 参数与运行账号权限（详见 [安全指南](./security.md#5-外部智能体的授权边界)）。
3. **独立验收（`purpose: verify`）**：检查者按“只判断、不修代码、末行输出 `VERDICT: PASS|FAIL`”协议执行（内置检查者自动剥离 `write`/`edit`；`exec` 不可担任验收）。`VERDICT` 会记入看板供主智能体对照真实 diff 裁决，但不会绕过主智能体核查自动关单。

---

## 相关阅读

- [角色模板说明（`examples/sub-agents/`）](../examples/sub-agents/README.md)：Claude / Codex / Cursor / Antigravity / GLM 现成角色取舍指南
- [安全指南](./security.md)：外部智能体授权审查清单与安全守卫边界
- [事件与任务](./events-and-tasks.md)：任务车道如何管理在途委派与看板

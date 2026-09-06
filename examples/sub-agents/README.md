# 工作区智能体角色示例

这里的文件既是配置示例，也是按生产使用标准维护的推荐模板。Pipiclaw 不会自动加载它们；请只复制实际需要的角色到工作区，并根据账号、sandbox 和团队规则逐项审查。

目录里是 **5 个常用角色 + 3 个按需角色**：常用的是 `explorer`、`builder`、`reviewer`、`verifier`、`git-committer`；按需的是 `planner`、`builder-hard`、`worker`。5 不是"每个任务要调用 5 次"，也不是角色数量的最优常数，而是一个够用的起点——普通工作区先装常用 5 个，确实遇到对应场景再补按需角色。

下面的命令适用于源码 checkout：

```bash
# 常用五角色（内置的 explorer / git-committer 无需额外安装；builder 需要 claude，reviewer / verifier 需要 codex）：
cp examples/sub-agents/{explorer,git-committer,builder,reviewer,verifier}.md ~/.pipiclaw/workspace/sub-agents/

# 按需补充：
cp examples/sub-agents/{planner,builder-hard}.md ~/.pipiclaw/workspace/sub-agents/   # 需要 claude
cp examples/sub-agents/worker.md ~/.pipiclaw/workspace/sub-agents/                   # 需要 codex
```

通过 npm 全局安装时，模板位于包目录：

```bash
PIPICLAW_PACKAGE_DIR="$(npm root -g)/@oyasmi/pipiclaw"
cp "$PIPICLAW_PACKAGE_DIR"/examples/sub-agents/{builder,reviewer}.md \
  ~/.pipiclaw/workspace/sub-agents/
```

## 内置角色（`runtime: internal`）

内置角色在 pipiclaw 进程内运行，使用 pipiclaw 自己的工具集和安全守卫，轻量、便宜、通常在同一回合内同步返回。它们的价值是**低延迟**和**上下文隔离**，不是算力。

- **explorer**：只读调查一个明确问题——代码在哪、调用链怎么连、指定日志里发生了什么，返回结论与 `path:line` 或命令证据，不让几十万行原文进入主会话。
- **git-committer**：把用户明确指定的现有改动整理成本地 commit；默认不 push。

## 外部角色（`runtime: external`）

外部角色一次委派启动一个真实 coding agent CLI 进程，异步执行：派发后立刻返回 `runId`，完成时唤醒频道。适合几十分钟量级的重活，详见 [../../docs/sub-agents.md](../../docs/sub-agents.md)。

| 角色 | 常用性 | harness | `model` | `mutates` | `thinkingLevel` | 用途 |
|---|---|---|---|---|---|---|
| `builder` | 常用 | claude-code | `sonnet` | `write` | medium | 边界明确的产品改动：代码、必要测试、相关文档和仓库必跑检查一起交付 |
| `reviewer` | 常用 | codex-cli | `gpt-5.6-sol` | `read` | high | 与产出者分离的方案 / 代码 / 文档挑错，也可承担只读 `purpose=verify` |
| `verifier` | 常用 | codex-cli | `gpt-5.6-luna` | `write` | xhigh | 对最终产物逐项核验完成标准，运行必要检查并取证 |
| `planner` | 按需 | claude-code | `opus` | `read` | high | 调查一个会显著影响方案或返工成本的未决问题 |
| `builder-hard` | 按需 | claude-code | `opus` | `write` | xhigh | 高不确定性、跨契约耦合的实现与修复；代价显著更高 |
| `worker` | 按需 | codex-cli | `gpt-5.6-sol` | `write` | medium | 独立的数据分析、批处理、报告和文档产物 |

## 按任务选角色，不按固定流水线

不存在 `planner → reviewer → builder → reviewer → verifier → documenter` 这样的必经链条。按这一轮要消除哪种不确定性来选：

| 工作 | 推荐形状 | 什么时候再加一次委派 |
|---|---|---|
| 一个路径、默认值或状态问题 | 主代理直接查 | 需要多次检索、会挤占主会话时用 `explorer` |
| 明确的小改动 | 主代理自己完成并检查，或一个 `builder` | 契约或风险需要独立证据时再加验收 |
| 普通非平凡功能或修复 | `builder` 完成代码、测试、相关文档，再做一次独立验收 | 设计、并发、权限、迁移等风险值得单独判断时加 `reviewer` |
| 高代价设计取舍 | 一次问题边界清楚的 `planner` 调查，再实施与验收 | 只有当调查结论确实会改变后续选择时才调用 |
| 根因不明的回归 | 带着失败证据交给实现者，必要时直接用 `builder-hard` | 只缺一条可查的事实时先做窄调查，不自动升级模型 |
| 整本手册或数据报告 | `worker` 完成独立产物并自查 | 需要独立事实核验或完整 task 验收时再加检查者 |
| 用户要求提交已有改动 | `git-committer` 按准确范围提交 | 混合暂存、混合 hunk、hook 失败时返回具体阻塞 |

**顺序上有一条硬约束：文档要在正式验收之前完成。** 验收针对的是最终产物；PASS 之后再补文档、改测试或让 hook 改文件，都会改变被验收的内容，使那份证明过期（runtime 会据此判 FAIL）。推荐顺序是：完成实现、相关测试和文档 → 必要的审查与返工 → 对最终交付位置做正式验收 → 提交收尾。

reviewer 发现的问题回流给产出角色；verifier 失败也回流给实现者，不在验证环节就地修复。

## 权限与验收边界

`planner` 用 Claude 的 `--permission-mode plan`，`reviewer` 用 Codex 的 `--sandbox read-only`；两者的 `mutates: read` 都有目标 CLI 的权限模式支撑，而不只是提示词声明。它们不占工作区写锁，但评审仍应针对稳定的 diff / commit，不要一边让 builder 改同一工作树、一边评审移动中的目标。内置的 `explorer` 声明 `mutates: read`，但它拥有 `bash`——那是工具白名单加提示词约束，不是强只读沙箱。

`reviewer` 的完整输出由 runtime 自动保存在 run 的 `output.md`，无需为了"落盘报告"给它工作区写权限。它可以承担不产生工作区写入的 `purpose=verify` 检查；runtime 会追加验收协议并检查工作区 subject 未变化。需要运行会生成产物的测试或构建时，应另派 `verifier`；外部 attestation 仍是 `advisory`，主代理需要按风险补充抽查。

`verifier` / `worker` 使用 `--sandbox workspace-write`：足以在 checkout 和系统临时目录中生成测试或文档产物，同时不授予任意宿主文件访问。`verifier` 用于 `purpose=verify` 时会持有目标工作区排他写锁，且 attestation 明确是 `advisory`。它可以在仓库根目录的 `.run/`、`coverage/`、`build/`、`dist/` 或系统临时目录里新建取证产物，**但不能在产品源码或仓库正式测试目录里新建文件**——那些位置属于被验收的 subject，新增文件会让这次验收失效。需要新增正式回归用例时，交回实现者补齐再重新验收。模板不让这些角色操作 Git 历史或外部系统；如任务确实需要网络、额外可写目录或更高权限，请复制角色后按目标 CLI 的能力最小化放宽，而不是把通用模板整体改成无沙箱。

`builder` / `builder-hard` 仍用 Claude 的 `--dangerously-skip-permissions`，因为它们需要非交互地完成实现；这是本目录权限最高的默认配置。务必在可信 checkout、最小权限宿主账号中使用。角色文件只声明 `model` 和 `thinkingLevel`，具体的 `--model` / `--effort` 参数由 claude-code harness 自动拼接，不应重复写进 `command`。

**每个角色都应显式写 `thinkingLevel`**（本目录 8 个模板均已如此，见上表），不要依赖隐藏默认值——内置委派未声明时默认 `medium`，但外部 work 角色未声明时**不追加任何推理参数**，沿用该 CLI 自己的配置（`~/.claude/settings.json` / `~/.codex/config.toml` 等）；只有 `purpose=verify` 的外部角色仍会兜底 `medium`。可复用的角色请显式写，让行为不随宿主机的本地配置漂移。

## 使用原则

- `description` 会进入主代理的子代理目录，是路由的**主要依据**——正文不在那个目录里，所以改正文修不了选错角色。每条 description 回答三件事：本轮能得到什么结果、什么时候值得调用、最关键的边界。`runtime` / `workload` / `mutates` 已由目录分组展示，不必在文字里重复。
- 正文是子代理的 system prompt，应明确职责、禁止事项、证据标准、停止条件和输出契约。它只写跨任务不变的东西；具体任务信息属于委派时的 `task`。注意这只是一个概括：内置执行者直接使用角色 `systemPrompt`，claude-code harness 通过 `--append-system-prompt-file` 追加，codex-cli 则把正文和 task 一起写进 stdin。调 prompt 时请核对 run 里实际的 `system-prompt.txt` / `prompt.txt` 和 argv，不要只审模板 Markdown。
- 子代理默认看不到主会话。委派时的 `task` 仍须包含目标、范围、相关路径、约束、验收方法和期望返回格式，不能只写「按上文处理」。
- **工作目录每次委派现场决定**。角色文件里不能写 `cwd`（会被驳回），只能在调用时传 `workingDirectory`。两个 `mutates: write` 的委派不能指向同一棵工作树——runtime 的排他写锁会拒绝第二个，并点名持有者；并行实现请先 `git worktree add` 再分别指向。
- 内置角色的 `tools`、上下文模式和四个数值预算在模板中显式配置，方便审查和按成本调整。**调用 `subagent` 指定已配置角色时没有任何覆盖字段**：工具、模型、预算、上下文和推理档位全部来自角色文件，要改就改 frontmatter。`effort` 只属于 `subagent_inline`（内联委派恒为内置），传了就整组替换四个数值预算。
- `tools` 只是工具白名单，不等同于只读沙箱。拥有 `bash` 的内置角色仍须遵守正文和应用级 `security.json` 的限制。
- 外部角色**没有** `tools` 字段（写了会被驳回）。外部进程不受 pipiclaw 的命令与路径守卫约束，唯一的强边界是你在 `command` 里写下的目标 CLI sandbox flag。
- 所有 Git 提交统一交给 `git-committer`；它只有在任务明确转述用户要求 push 时才可推送。创建 commit 不会自动获得 push 授权。
- 委派运行和完成时，频道会收到一条独立于唤醒的状态提醒（`⏳ 进度` / `✅ 完成`，见 `settings.json` 的 `delegation.notices`）；这只是"活着/结束了"的信号，不含内容——角色最终消息的结论仍要由主代理读到并转述给用户，不能假设用户已经看到了。

Pipiclaw 只加载工作区 `sub-agents/` 中实际存在且有效的 Markdown 文件。空目录是合法配置；没有合适的预定义角色时仍可使用 inline `systemPrompt`。`purpose: verify` 的验收约束由 runtime 执行，不要求配置文件必须名为 `verifier`。

## 从早期模板迁移

早期版本还提供 `scout`、`log-sifter`、`documenter` 三个模板，现已退出推荐目录：

- `scout`（外部单点事实查询）和 `log-sifter`（日志筛证据）的能力并入 `explorer`——它的正文保留了日志时间窗、首次异常、恢复节点和统计范围这些方法，预算也相应提高到 900 秒 / 300 秒 bash 超时。一个单点事实查询不值得默认启动另一个外部异步进程。
- `documenter` 的工作被拆开：随实现一起变的文档属于 `builder` 的交付（省掉一次接口背景的重建），独立手册、迁移指南和报告交给 `worker`（它的正文带上了文档事实纪律）。

已经复制到工作区的同名角色不会被自动删除。迁移时请先确认接收角色已经拿到对应方法，跑过代表任务，再清理旧文件；有在途或待续接的 run 时先让它们结束。个人部署已经证明某个专门角色有效的，可以继续保留。

## 需要按本机调整的地方

- **`command` 用的是裸命令**（`claude` / `codex`），它们必须在 pipiclaw 进程的 `PATH` 上。如果你本机用的是包装脚本（换 base URL、换额度账号、注入环境变量），把 `command` 换成那个脚本即可——pipiclaw 只做 shell 词法分词，不解释命令内容。找不到可执行文件时角色不会消失，而是标为 `unavailable` 并在调用时给出安装提示。
- **`model` 原样透传给目标 CLI，pipiclaw 不校验**。Claude 角色使用 `opus` / `sonnet`；Codex 角色使用 `gpt-5.6-sol` 或 `gpt-5.6-luna`。如果本机账号不可用，请按目标 CLI 支持的模型替换。未写 `model` 的内置角色（`explorer` / `git-committer`）先取角色配置，再取 `settings.subagentModel`，最后回退主代理当前模型——`runtime: internal` 本身不保证便宜。
- **目标 CLI 参数会变化**。模板按当前 Claude Code / Codex CLI 维护；升级 CLI 后先用 `claude --help`、`codex exec --help` 核对命令。Pipiclaw 只分词和追加协议参数，不会替你校验 flag 是否仍受支持。
- **`--dangerously-skip-permissions`** 是 Claude Code 自身的权限跳过标记，Pipiclaw 原样传入。若不接受这个边界，只使用只读角色，或为写角色换成你已验证可在非交互模式工作的更严格权限配置。
- **`maxWallTimeSec` 是墙钟上限**，超时会杀进程组但仍解析并回传已产生的输出。它是故障上限，不是鼓励角色用满的配额；按仓库规模和任务量级调整，不要为了"省钱"随意压缩到检查跑不完。
- 第三种 harness `exec`（任意脚本，无协议终态）本目录不提供示例：它没有完成事件，`usageKnown` / `costKnown` 恒为 false，且不能承担 `purpose=verify`。需要接入其他 CLI 时再参考 [../../docs/sub-agents.md](../../docs/sub-agents.md)。

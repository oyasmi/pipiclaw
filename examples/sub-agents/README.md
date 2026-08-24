# 工作区智能体角色示例

这里的文件既是配置示例，也是按生产使用标准维护的推荐模板。Pipiclaw 不会自动加载它们；请只复制实际需要的角色到工作区，并根据账号、sandbox 和团队规则逐项审查。下面的命令适用于源码 checkout：

```bash
# 内置角色（无需额外安装）：
cp examples/sub-agents/{explorer,log-sifter,git-committer}.md ~/.pipiclaw/workspace/sub-agents/

# 外部角色（需要先在宿主机安装并登录对应 CLI）：
cp examples/sub-agents/{planner,builder,builder-hard}.md ~/.pipiclaw/workspace/sub-agents/          # 需要 claude
cp examples/sub-agents/{reviewer,verifier,scout,worker,documenter}.md ~/.pipiclaw/workspace/sub-agents/  # 需要 codex
```

通过 npm 全局安装时，模板位于包目录：

```bash
PIPICLAW_PACKAGE_DIR="$(npm root -g)/@oyasmi/pipiclaw"
cp "$PIPICLAW_PACKAGE_DIR"/examples/sub-agents/{builder,reviewer}.md \
  ~/.pipiclaw/workspace/sub-agents/
```

## 内置角色（`runtime: internal`）

内置角色在 pipiclaw 进程内运行，使用 pipiclaw 自己的工具集和安全守卫，轻量、便宜、通常在同一回合内同步返回。它们的价值是**低延迟**和**上下文隔离**，不是算力。

- **explorer**：只读定位仓库实现、追踪调用链、梳理模块关系。
- **log-sifter**：从大体量日志、构建输出或宿主机状态中筛出证据，只把结论带回主会话——避免几十万行原文进入上下文。
- **git-committer**：把用户明确指定的现有改动整理成本地 commit；默认不 push。

## 外部角色（`runtime: external`）

外部角色一次委派启动一个真实 coding agent CLI 进程，异步执行：派发后立刻返回 `runId`，完成时唤醒频道。适合几十分钟量级的重活，详见 [../../docs/sub-agents.md](../../docs/sub-agents.md)。

八个角色构成一个可直接使用的开发闭环：

```
planner（需求 / 方案 / 验收 / 拆解）
  → reviewer（方案评审）
  → builder（代码 + 单元测试）      ← 卡住时换 builder-hard
  → reviewer（实现评审）
  → verifier（实际运行取证）
  → documenter（文档 / 变更记录）
  → git-committer（用户明确要求时提交）
```

reviewer 发现的问题回流给产出角色；verifier 失败回流给 builder，不在验证环节就地修复。闭环之外：worker 承接通用多步分析与产出，scout 只做单点事实查询。

| 角色 | harness | `mutates` | `thinkingLevel` | 用途 |
|---|---|---|---|---|
| `planner` | claude-code (opus) | `read` | high | 只读需求收敛、方案设计、验收定义、任务拆解 |
| `builder` | claude-code (sonnet) | `write` | medium | 边界清晰、验收已定义的实现 + 单元测试 |
| `builder-hard` | claude-code (opus) | `write` | xhigh | builder 已失败、根因难定位或多契约耦合的实现 |
| `reviewer` | codex-cli（只读沙箱） | `read` | high | 与产出者分离的方案 / 代码 / 文档挑错，也可承担只读 `purpose=verify` |
| `verifier` | codex-cli（工作区写沙箱） | `write` | medium | 实际运行系统、复现、冒烟、回归、取证 |
| `scout` | codex-cli（只读沙箱） | `read` | low | 大仓库里的单点事实查询 |
| `worker` | codex-cli（工作区写沙箱） | `write` | medium | 闭环外的数据对比、指标计算、批量处理、专项报告 |
| `documenter` | codex-cli（工作区写沙箱） | `write` | medium | 文档、变更记录和迁移说明；提交统一用 `git-committer` |

`planner` 用 Claude 的 `--permission-mode plan`，`reviewer` / `scout` 用 Codex 的 `--sandbox read-only`；三者的 `mutates: read` 都有目标 CLI 的权限模式支撑，而不只是提示词声明。它们不占工作区写锁，但评审仍应针对稳定的 diff / commit，不要一边让 builder 改同一工作树、一边评审移动中的目标。

`reviewer` 的完整输出由 runtime 自动保存在 run 的 `output.md`，无需为了“落盘报告”给它工作区写权限。它可以承担 `purpose=verify`；runtime 会追加验收协议并检查工作区 subject 未变化。不过外部 attestation 仍是 `advisory`，而且只读沙箱会阻止产生工作区构建产物的测试，主代理需要按风险补充抽查或另派 verifier。

`verifier`、`worker`、`documenter` 使用 `--sandbox workspace-write`：足以在 checkout 和系统临时目录中生成测试或文档产物，同时不授予任意宿主文件访问。模板不让这些角色操作 Git 历史或外部系统；如任务确实需要网络、额外可写目录或更高权限，请复制角色后按目标 CLI 的能力最小化放宽，而不是把通用模板整体改成无沙箱。

`builder` / `builder-hard` 仍用 Claude 的 `--dangerously-skip-permissions`，因为它们需要非交互地完成实现；这是本目录权限最高的默认配置。务必在可信 checkout、最小权限宿主账号中使用。角色文件只声明 `model` 和 `thinkingLevel`，具体的 `--model` / `--effort` 参数由 claude-code harness 自动拼接，不应重复写进 `command`。

**每个角色都应显式写 `thinkingLevel`**（本目录全部 11 个模板均已如此，见上表），不要依赖隐藏默认值——内置委派未声明时默认 `medium`，但外部 work 角色未声明时**不追加任何推理参数**，沿用该 CLI 自己的配置（`~/.claude/settings.json` / `~/.codex/config.toml` 等）；只有 `purpose=verify` 的外部角色仍会兜底 `medium`。可复用的角色请显式写，让行为不随宿主机的本地配置漂移。

## 使用原则

- `description` 会进入主代理的子代理目录，必须写清楚「何时使用、何时不用、调用前提、是否修改状态、大概多重」。这是路由的主要依据。
- 正文是子代理的 system prompt，应明确职责、禁止事项、证据标准、停止条件和输出契约。它只写跨任务不变的东西；具体任务信息属于委派时的 `task`。
- 子代理默认看不到主会话。委派时的 `task` 仍须包含目标、范围、相关路径、约束、验收方法和期望返回格式，不能只写「按上文处理」。
- **工作目录每次委派现场决定**。角色文件里不能写 `cwd`（会被驳回），只能在调用时传 `workingDirectory`。两个 `mutates: write` 的委派不能指向同一棵工作树——runtime 的排他写锁会拒绝第二个，并点名持有者；并行实现请先 `git worktree add` 再分别指向。
- 内置角色的 `tools`、上下文模式和四个数值预算在模板中显式配置，方便审查和按成本调整。这四个数值只在 frontmatter 里精确设置——调用时主代理只能选 `effort` 的 quick/standard/deep 三档，传了就整组替换这里的数值。
- `tools` 只是工具白名单，不等同于只读沙箱。拥有 `bash` 的内置角色仍须遵守正文和应用级 `security.json` 的限制。
- 外部角色**没有** `tools` 字段（写了会被驳回）。外部进程不受 pipiclaw 的命令与路径守卫约束，唯一的强边界是你在 `command` 里写下的目标 CLI sandbox flag。
- 所有 Git 提交统一交给 `git-committer`；它只有在任务明确转述用户要求 push 时才可推送。创建 commit 不会自动获得 push 授权。

Pipiclaw 只加载工作区 `sub-agents/` 中实际存在且有效的 Markdown 文件。空目录是合法配置；没有合适的预定义角色时仍可使用 inline `systemPrompt`。`purpose: verify` 的验收约束由 runtime 执行，不要求配置文件必须名为 `verifier`。

## 需要按本机调整的地方

- **`command` 用的是裸命令**（`claude` / `codex`），它们必须在 pipiclaw 进程的 `PATH` 上。如果你本机用的是包装脚本（换 base URL、换额度账号、注入环境变量），把 `command` 换成那个脚本即可——pipiclaw 只做 shell 词法分词，不解释命令内容。找不到可执行文件时角色不会消失，而是标为 `unavailable` 并在调用时给出安装提示。
- **`model` 原样透传给目标 CLI，pipiclaw 不校验**。Claude 角色用了 `opus` / `sonnet`；Codex 角色**没有写 `model`**，交给 CLI 自身的默认配置——请按你的账号可用模型自行填写。
- **目标 CLI 参数会变化**。模板按当前 Claude Code / Codex CLI 维护；升级 CLI 后先用 `claude --help`、`codex exec --help` 核对命令。Pipiclaw 只分词和追加协议参数，不会替你校验 flag 是否仍受支持。
- **`--dangerously-skip-permissions`** 是 Claude Code 自身的权限跳过标记，Pipiclaw 原样传入。若不接受这个边界，只使用只读角色，或为写角色换成你已验证可在非交互模式工作的更严格权限配置。
- **`maxWallTimeSec` 是墙钟上限**，超时会杀进程组但仍解析并回传已产生的输出。按仓库规模和任务量级调整，不要把示例值当成固定答案。
- 第三种 harness `exec`（任意脚本，无协议终态）本目录不提供示例：它没有完成事件，`usageKnown` / `costKnown` 恒为 false，且不能承担 `purpose=verify`。需要接入其他 CLI 时再参考 [../../docs/sub-agents.md](../../docs/sub-agents.md)。

# 工作区子代理示例

这里的文件既是配置示例，也是按生产使用标准维护的推荐模板。Pipiclaw 不会自动加载它们；请只复制实际需要的角色到工作区，并根据团队规则调整：

```bash
# 内置角色（无需额外安装）：
cp examples/sub-agents/{explorer,log-sifter,git-committer}.md ~/.pipiclaw/workspace/sub-agents/

# 外部角色（需要先在宿主机安装并登录对应 CLI）：
cp examples/sub-agents/{planner,builder,builder-hard}.md ~/.pipiclaw/workspace/sub-agents/          # 需要 claude
cp examples/sub-agents/{reviewer,verifier,scout,worker,documenter}.md ~/.pipiclaw/workspace/sub-agents/  # 需要 codex
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
  → documenter（文档 / 变更记录 / 交付，随任务顺带提交）
```

reviewer 发现的问题回流给产出角色；verifier 失败回流给 builder，不在验证环节就地修复。闭环之外：worker 承接通用多步分析与产出，scout 只做单点事实查询。

| 角色 | harness | `mutates` | `thinkingLevel` | 用途 |
|---|---|---|---|---|
| `planner` | claude-code (opus) | `write` | high | 需求收敛、方案设计、验收定义、任务拆解 |
| `builder` | claude-code (sonnet) | `write` | medium | 边界清晰、验收已定义的实现 + 单元测试 |
| `builder-hard` | claude-code (opus) | `write` | xhigh | builder 已失败、根因难定位或多契约耦合的实现 |
| `reviewer` | codex-cli | `write` | high | 与产出者分离的方案 / 代码 / 文档挑错，并落盘评审报告 |
| `verifier` | codex-cli（无沙箱） | `write` | medium | 实际运行系统、复现、冒烟、回归、取证 |
| `scout` | codex-cli（只读沙箱） | `read` | low | 大仓库里的单点事实查询 |
| `worker` | codex-cli（无沙箱） | `write` | medium | 闭环外的数据对比、指标计算、批量处理、专项报告 |
| `documenter` | codex-cli（无沙箱） | `write` | medium | 文档、变更记录，随文档任务顺带 commit 与最终交付；独立提交任务用 `git-committer` |

`scout` 用 `--sandbox read-only` 启动 codex，因此它的 `mutates: read` 是被目标 CLI 真正强制的，而不只是一个声明——这也是它不参与工作区写锁、可以与 builder 并行的原因。

`reviewer` 需要落盘评审报告，因此用 `--sandbox workspace-write` 并如实声明 `mutates: write`：它的正文约束「只写报告、不改被评对象」，但那是提示词纪律而非沙箱边界。代价有两处——它会取工作区写锁（不能与 builder / verifier 并发指向同一棵工作树，并行评审请先 `git worktree add`），并且不能承担 `purpose=verify`。

`purpose=verify` 只接受 `mutates: read` 的外部角色，本目录里没有这样的验收角色（`scout` 的定位是单点查询，不适合终验）。需要外部独立验收时，自行复制一份 `reviewer` 改成 `--sandbox read-only` + `mutates: read` 并去掉报告落盘；外部验收的 attestation 强度是 `advisory`，主代理仍需按风险抽查。

`documenter`、`verifier`、`worker` 用 `--sandbox danger-full-access --ask-for-approval never`，即完全不沙箱化，而不是 `workspace-write`。原因：Codex 的 `workspace-write` 沙箱把 `.git/` 强制设为只读（这是 Codex 自身的安全策略，与 pipiclaw 无关），`git add` 需要创建 `.git/index.lock` 会直接失败，`git commit` 还需要写 `objects`、`refs`、`logs`。三者的正文都把「任务明确授权时执行 git commit / push」列为职责的一部分，`workspace-write` 会让这个职责始终不可用，所以只能退到 `danger-full-access`；这意味着目标 CLI 对文件系统和网络完全不设限，唯一的边界回到正文纪律和派发时给出的授权范围。`reviewer` 正文明确「不改配置、依赖和 git 历史」，从不需要提交，因此仍用 `--sandbox workspace-write`，不做这个放宽。

## 使用原则

- `description` 会进入主代理的子代理目录，必须写清楚「何时使用、何时不用、调用前提、是否修改状态、大概多重」。这是路由的主要依据。
- 正文是子代理的 system prompt，应明确职责、禁止事项、证据标准、停止条件和输出契约。它只写跨任务不变的东西；具体任务信息属于委派时的 `task`。
- 子代理默认看不到主会话。委派时的 `task` 仍须包含目标、范围、相关路径、约束、验收方法和期望返回格式，不能只写「按上文处理」。
- **工作目录每次委派现场决定**。角色文件里不能写 `cwd`（会被驳回），只能在调用时传 `workingDirectory`。两个 `mutates: write` 的委派不能指向同一棵工作树——runtime 的排他写锁会拒绝第二个，并点名持有者；并行实现请先 `git worktree add` 再分别指向。
- 内置角色的 `tools`、上下文模式和四个数值预算在模板中显式配置，方便审查和按成本调整。这四个数值只在 frontmatter 里精确设置——调用时主代理只能选 `effort` 的 quick/standard/deep 三档，传了就整组替换这里的数值。
- `tools` 只是工具白名单，不等同于只读沙箱。拥有 `bash` 的内置角色仍须遵守正文和应用级 `security.json` 的限制。
- 外部角色**没有** `tools` 字段（写了会被驳回）。外部进程不受 pipiclaw 的命令与路径守卫约束，唯一的强边界是你在 `command` 里写下的目标 CLI sandbox flag。
- `git-committer` 和 `documenter` 只有在任务明确转述用户要求 push 时才能推送；创建了 commit 不代表自动获得 push 授权。
- `documenter` 和 `git-committer` 的提交职责按任务性质分：任务同时要求文档/变更记录与提交时派 `documenter`，commit 是文档交付的收尾；与文档无关的独立提交任务派 `git-committer`。

Pipiclaw 只加载工作区 `sub-agents/` 中实际存在且有效的 Markdown 文件。空目录是合法配置；没有合适的预定义角色时仍可使用 inline `systemPrompt`。`purpose: verify` 的验收约束由 runtime 执行，不要求配置文件必须名为 `verifier`。

## 需要按本机调整的地方

- **`command` 用的是裸命令**（`claude` / `codex`），它们必须在 pipiclaw 进程的 `PATH` 上。如果你本机用的是包装脚本（换 base URL、换额度账号、注入环境变量），把 `command` 换成那个脚本即可——pipiclaw 只做 shell 词法分词，不解释命令内容。找不到可执行文件时角色不会消失，而是标为 `unavailable` 并在调用时给出安装提示。
- **`model` 原样透传给目标 CLI，pipiclaw 不校验**。claude 角色用了 `opus` / `sonnet`；codex 角色**没有写 `model`**，交给 CLI 自身的默认配置——请按你的账号可用模型自行填写。
- **`--dangerously-skip-permissions`** 是 claude-code 自身的权限跳过标记，pipiclaw 不解释、不校验，原样传给目标 CLI。这样写是因为 pipiclaw 本身不沙箱化外部进程（见 [../../docs/sub-agents.md](../../docs/sub-agents.md) 的「授权与安全边界」一节）。如果不接受这个权衡，改成该 CLI 自己的确认模式或只读 flag，或者只用 `mutates: read` 的角色。
- **`maxWallTimeSec` 是墙钟上限**，超时会杀进程组但仍解析并回传已产生的输出。按仓库规模和任务量级调整，不要把示例值当成固定答案。
- 第三种 harness `exec`（任意脚本，无协议终态）本目录不提供示例：它没有完成事件，`usageKnown` / `costKnown` 恒为 false，且不能承担 `purpose=verify`。需要接入其他 CLI 时再参考 [../../docs/sub-agents.md](../../docs/sub-agents.md)。

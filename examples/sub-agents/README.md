# 工作区智能体配置示例

这里的文件是配置示例，Pipiclaw **不会自动加载**。只有复制到 `~/.pipiclaw/workspace/sub-agents/` 才会生效，而且加载是**平铺**的——只读该目录下的 `*.md`，不会递归子目录。所以本目录的两个子目录只是分类方式，复制时要把文件放到 `sub-agents/` 下，不要连目录一起复制。

- [`agents/`](./agents/) — **推荐**。按能力与成本组织：把 agent、模型和推理档直接交给 Pipiclaw，由它按需选择。
- [`roles/`](./roles/) — 早期的岗位角色（planner / builder / reviewer / verifier …），保留作参考和迁移对照。

两套**不要同时装**：同一件事有两种选法，只会让主代理多做一次无意义的判断，还会一起占用系统提示词里子代理目录的预算。

## 为什么从「角色」改成「能力条目」

一个角色文件过去同时承担三件事：能力与成本绑定（harness / command / model / thinkingLevel）、权限姿态（sandbox + `mutates`）、以及一段岗位说明书式的正文。前两件属于部署者，第三件不属于——它是在不知道本轮任务的情况下提前写死的任务框架，而真正掌握上下文的是发起委派的主代理。

结果就是路由变成「任务 → 猜别人起的职位名」，而且正文会反过来限制场景：让 codex 读一张图，`worker` 的正文开头是"你负责交付独立的数据分析、批处理、报告或文档产物"；想让实现者顺带提交，`builder` 的正文写死"不 commit、push"。

`agents/` 把岗位说明书去掉，只留能力声明和一段与任务无关的交付约定。路由变成「任务 → 需要什么能力、能付多少代价」，这是主代理做得了的判断，因为它知道任务是什么。

## 安装 `agents/`

```bash
# 源码 checkout：
cp examples/sub-agents/agents/*.md ~/.pipiclaw/workspace/sub-agents/

# npm 全局安装：
PIPICLAW_PACKAGE_DIR="$(npm root -g)/@oyasmi/pipiclaw"
cp "$PIPICLAW_PACKAGE_DIR"/examples/sub-agents/agents/*.md ~/.pipiclaw/workspace/sub-agents/
```

只装你真的有账号的那几个：条目里的 CLI 不在 PATH 上时不会被丢弃，而是标成 `unavailable` 并在调用时才报错。

| 条目 | harness | `model` | `thinkingLevel` | 多模态 | 定位 |
|---|---|---|---|---|---|
| `claude-high` | claude-code | `opus` | high | 否 | 代码与推理最强，成本最高：设计、取舍分析、根因不明的疑难 |
| `claude-main` | claude-code | `sonnet` | medium | 否 | 代码能力最强的主力档：实现、修改、文档、排查 |
| `codex-high` | codex-cli | `gpt-6-astra` | high | 是 | 高智能档，可读图片：设计、方案权衡、复杂分析 |
| `codex-main` | codex-cli | `gpt-6-astra` | medium | 是 | 主力档，可读图片：常规实现、排查、文档 |
| `codex-flash` | codex-cli | `gpt-5.6-luna` | medium | 是 | 最快最便宜，可读图片：明确、简单、重复的工作 |
| `glm-high` | claude-code | `glm-5.3` | high | 否 | 高智能档，额度宽松：高频使用不挤占 claude/codex 配额 |
| `glm-flash` | claude-code | `glm-5.3-flash` | medium | 是 | 最便宜，可读图片：大批量简单重复工作的首选 |

三档的分工是这套配置的主要内容：**flash** 用于「做什么和怎么做都已清楚，只差有人去做」，可以大量派发；**main** 是主力，绝大多数实现、排查、文档都在这里，也包括 token 消耗很大的长任务；**high** 只留给这一轮真正需要新判断或取舍的工作。对已经定好的活派 high，只是更贵，不会更对。

额度是真实约束：claude 和 codex 的订阅有周/月上限，GLM 只有 5 小时滚动限额、没有周月上限。所以简单重复的批量工作优先走 `glm-flash`，把受限额度留给难题。

### GLM 条目需要一个包装脚本

`glm-high` / `glm-flash` 走 claude-code harness，但要用独立的配置目录指向 Z.ai 的 Anthropic 兼容端点，因此 `command` 是一个包装脚本而不是 `claude` 本身。把它放到 PATH 上：

```bash
#!/bin/bash
# ~/bin/claude-zai.sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-zai"
exec claude --dangerously-skip-permissions "$@"
```

首次使用前在 `CLAUDE_CONFIG_DIR` 里完成一次登录/配置。用其他供应商同理：换配置目录和脚本名，`harness` 仍是 `claude-code`。

## 正文：一段与任务无关的交付约定

每个条目的正文是同一段 9 条约束，逐字相同。它**不描述这个条目做什么工作**——那是每次 `task` 的事——只约束怎么取证和怎么交付：不做未授权的动作、不动任务外的既有改动、结论不超过证据、不编造检查结果、不靠削弱断言制造通过、先结论后证据位置、用中文并保留原文。

留着它是因为这几条跨每一个任务都成立，漏掉的代价又很高（尤其是伪造绿色检查结果和把未验证写成已验证），而让主代理每次委派重打一遍既费 token 又会漂移。

要改就 7 个文件一起改。也可以整段删掉：runtime 允许外部条目的正文为空，此时不会生成 `system-prompt.txt`，claude-code 不追加 `--append-system-prompt-file`，codex 的 stdin 就是 task 本身。

## 这套配置的代价，别忽略

- **全部是放开权限的写条目。** 7 个条目都用 yolo 参数（`claude --dangerously-skip-permissions` / `codex exec --dangerously-bypass-approvals-and-sandbox`）并声明 `mutates: write`，没有 sandbox 兜底。实际边界只剩宿主账号和 `task` 里写明的范围，**必须在可信 checkout 和最小权限账号下使用**。需要真只读时，自己加一个 `--permission-mode plan` 或 `--sandbox read-only` 的条目。
- **同一工作目录同时只容得下一个外部委派。** `mutates: write` 会取目标工作区的排他 lease（含父子目录冲突），并行必须各自 `git worktree`。这是把只读条目去掉换来的。
- **`purpose=verify` 的 attestation 一律是 `advisory`。** `enforced` 只在 `mutates: read` 且工具集不含 `bash` 时才成立，这套条目里没有这样的。PASS 不能直接采信，要自己核对真实产物、diff 和检查输出。
- **独立性不再由角色提示词提供。** 要评审或验收时，必须在 `task` 里写明"你是检查者，不修实现，不把实现者的总结当作预期行为的来源"，并给出同一份验收口径和待检版本。换一个条目不会自动带来独立性。

## `roles/` 里的岗位角色

[`roles/`](./roles/) 保留了早期的 8 个角色：`explorer`、`git-committer`（内置）和 `planner`、`builder`、`builder-hard`、`reviewer`、`verifier`、`worker`（外部）。它们仍然可用，在两种情况下仍有价值：

- 需要**真正的只读执行边界**：`planner` 的 `--permission-mode plan`、`reviewer` 的 `--sandbox read-only` 是目标 CLI 提供的真实限制，不只是提示词声明；`reviewer` 承担 `purpose=verify` 时也不占工作区写锁。
- 需要**固定的、反复出现的作业纪律**：`git-committer` 的暂存区隔离规则就是一例——它约束的是一类操作的正确做法，不是一个岗位。

反过来，`builder` / `builder-hard` / `worker` 和 `agents/` 里的对应档位重叠严重，正文里的岗位设定是净损失，不建议再装。

## 从早期模板迁移

已经复制到工作区的旧角色文件不会被自动删除，需要手动处理：

```bash
cd ~/.pipiclaw/workspace/sub-agents
rm -f builder.md builder-hard.md worker.md planner.md reviewer.md verifier.md
cp /path/to/pipiclaw/examples/sub-agents/agents/*.md .
```

迁移期间历史 task 的委派记录里仍会出现旧角色名；`subagent_run op=follow_up` 只能续接条目仍然存在且 `command`/`model`/`shell` 未变的 run，删掉旧文件后这些 run 需要重新委派。

## 自己写条目

- **`description` 是唯一的路由依据。** 它进入主代理的系统提示词（子代理目录，预算 2400 字符），正文不在那里——改正文修不了选错条目。每条写清：能力特征、相对成本、适用场景，以及会改变选择的边界（能不能读图片、额度是否受限）。`runtime` / `workload` / `mutates` 已由目录分组展示，不要在文字里重复。
- **描述必须属实且可核查。** 写错一句"支持图片输入"，代价是一次几十分钟后才失败的委派，比不写更糟。
- **不要扩到十几个条目。** agent × 档位 × 权限很容易组合爆炸。每加一个都先问：主代理会因为它做出不同的路由决定吗？答不上来就不该存在。
- **调 prompt 时看实际发出的内容。** 正文对 claude-code 经 `--append-system-prompt-file` 追加，对 codex-cli 与 task 一起写进 stdin；核对 run 目录里真实的 `system-prompt.txt` / `prompt.txt` 和 argv，不要只审模板 Markdown。
- 委派的写法、并行隔离、等待与续接见 [../../docs/sub-agents.md](../../docs/sub-agents.md) 与运行时的 `agent-delegation.md` playbook。

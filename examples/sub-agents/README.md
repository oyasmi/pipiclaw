# 工作区智能体配置示例

[`agents/`](./agents/) 按执行器、能力与成本组织，不按 planner / builder / reviewer 等岗位预设工作。每次做什么、范围多大、怎样验收，由主代理在 `task` 中交代；配置文件只绑定模型、工具、权限姿态、预算与跨任务的交付约定。

这些文件**不会自动加载**。只安装自己需要且有账号的条目，平铺复制到 `~/.pipiclaw/workspace/sub-agents/`；运行时只读该目录下的 `*.md`，不会递归子目录。

## 安装

```bash
# 源码 checkout：
mkdir -p ~/.pipiclaw/workspace/sub-agents
cp examples/sub-agents/agents/codex-main.md ~/.pipiclaw/workspace/sub-agents/

# npm 全局安装：
PIPICLAW_PACKAGE_DIR="$(npm root -g)/@oyasmi/pipiclaw"
cp "$PIPICLAW_PACKAGE_DIR"/examples/sub-agents/agents/codex-main.md ~/.pipiclaw/workspace/sub-agents/
```

CLI 不在 PATH 上时条目仍会列出，但标为 `unavailable`，调用时给出安装提示。删除包内示例不会删除已经复制到工作区的配置；现有配置由部署者自行管理。删除条目或更改其 command/model/shell 后，旧 run 不能再原样续接。

## 选择能力条目

| 条目 | harness | model | thinkingLevel | 选择条件 |
|---|---|---|---|---|
| `claude-high` | claude-code | `opus` | high | Claude 高推理候选：需求冲突、架构取舍、疑难排查 |
| `claude-main` | claude-code | `sonnet` | medium | Claude 主力候选：范围和验收较明确的实施、排查、文档 |
| `codex-high` | codex-cli | `gpt-6.1-sol` | high | Codex 高推理候选：关键取舍、根因未明或难验证的工作 |
| `codex-main` | codex-cli | `gpt-6.1-terra` | high | Codex 主力候选：常规实施、排查、文档 |
| `codex-flash` | codex-cli | `gpt-6-luna` | high | Codex 低成本候选：做法明确、易检查且易恢复的批量工作 |
| `cursor-high` | cursor-cli | `grok-4.7-high` | — | Cursor 固定高推理候选：关键取舍与疑难排查 |
| `cursor-main` | cursor-cli | `auto` | — | Cursor 自动路由：常规实施、排查、文档 |
| `glm-high` | claude-code | `glm-5.3` | high | GLM 高推理候选，使用独立于 Claude/Codex 的额度 |
| `glm-flash` | claude-code | `glm-5.3-flash` | medium | GLM 低成本候选：做法明确、易检查且易恢复的批量工作 |
| `codex-review` | codex-cli | `gpt-6.1-sol` | high | CLI 强制只读；独立审查与 `purpose=verify` |

先满足输入能力、权限与可用状态，再按不确定性和错误代价选档。**flash** 用于做法明确、结果易检查、失败易恢复的工作；**main** 用于常规实施；**high** 用于关键取舍、疑难诊断或难以验证的工作。缺输入、缺权限或环境故障不能靠升级模型解决。

这些是候选用途，不是跨供应商能力排名。成本取决于输入、推理与重试，额度取决于实际账号；`codex-review` 与 `codex-high` 的模型和推理档相同，只读不意味着更便宜。部署者可根据本地评测在 description 中声明默认偏好，注明适用任务，不将体验写成永久排名。

图片不会自动继承自聊天。需要读图时在 task 中给出执行器可读的本地路径，并确认当前 CLI、模型与端点支持；模型原生支持图片不等于整个调用链支持。`opus`、`sonnet`、`auto` 等别名会变化，升级后应重验实际任务。

`cursor-*` 不写 `thinkingLevel`：当前适配器会将它编码为 model 的 `[effort=…]` 后缀，而示例用的 Cursor CLI 不接受此形式。需要换档时改 model（以本机 `agent models` 为准）。

### GLM 包装脚本

`glm-*` 使用 claude-code harness，通过独立配置目录指向 Z.ai 的兼容端点。将包装脚本放到 PATH 上：

```bash
#!/bin/bash
# ~/bin/claude-zai.sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-zai"
exec claude --dangerously-skip-permissions "$@"
```

首次使用前在该配置目录完成登录和端点配置。其他兼容供应商同理，需核对其模型和推理参数。

## 交付约定与执行边界

十个条目共用九条正文约定：授权与改动范围、输入来源、缺口处理、真实证据、失败保留、验收范围、检查复用和交付表达。它们不规定本轮岗位，也不要求固定的规划—实施—审查流水线。

- **九个写条目放开 CLI 权限。** 除 `codex-review` 外都声明 `mutates: write`，使用 bypass/force 参数；实际权限边界由 CLI、宿主账号与环境提供，task 文字不能替代隔离。
- **并行写必须隔离。** 同一及父子目录只能有一个写委派，独立写分片各用 worktree；主代理也不要同时修改活跃委派的工作树。
- **`codex-review` 的只读由 CLI sandbox 提供。** 它不能运行需写文件的测试或构建；可核查已有且对应当前产物的检查证据，或将缺失检查交给具备适当权限的执行器。
- **独立性来自验收依据与取证。** 给检查者原始要求、待检版本和入口，不把实现者总结当预期行为；先保证独立检查，再考虑不同模型。
- **`VERDICT` 是信息，不是门禁。** PASS 要有本次范围内的证据；FAIL 应区分已证实缺陷和验证受阻，由负责人决定修复还是补检查。

正文对 Claude 经 `--append-system-prompt-file` 追加，对 Codex/Cursor 与 task 拼入 stdin；相同文字的指令层级并不相同。调优时检查实际 run 的 `system-prompt.txt`、`prompt.txt`、argv 和结果。外部条目正文可以为空，但会失去这些交付约定；内置执行能力仍由运行时支持，不依赖本目录提供模板。

## 自己写条目

- **description 管路由，正文管执行。** 主代理目录只展示 description 及分组元数据，不展示正文；必须让执行者遵守的约束写进正文或 task。目录预算为 2400 字符，描述优先放会改变选择的条件。
- **声明可核查的能力与边界。** 输入能力以实际链路为准；本地模型偏好写明适用范围，额度与成本不作永久承诺。
- **每个条目都应改变一次选择。** 只有岗位名称不同不值得新增；本轮方法、检查与交付要求交给 task 或适用 skill。

委派、等待、续接和授权规则见[委派文档](../../docs/sub-agents.md)与运行时 `agent-delegation.md`。

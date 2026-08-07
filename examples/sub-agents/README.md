# 工作区子代理示例

这里的文件既是配置示例，也是按生产使用标准维护的推荐模板。Pipiclaw 不会自动加载它们；请只复制实际需要的角色到工作区，并根据团队规则调整：

```bash
cp examples/sub-agents/{explorer,researcher,reviewer,verifier,git-committer}.md ~/.pipiclaw/workspace/sub-agents/
# 外部角色（需要先在宿主机安装并登录对应 CLI：claude / codex）：
cp examples/sub-agents/{builder,external-reviewer}.md ~/.pipiclaw/workspace/sub-agents/
```

五个内置模板分别覆盖常见且边界清晰的委派场景：

- **explorer**：只读定位仓库实现、追踪调用链和梳理模块关系。
- **researcher**：检索当前或仓库外的信息，核对来源并综合结论。
- **reviewer**：独立审查非平凡代码改动，发现缺陷、回归风险和缺失测试。
- **verifier**：对受治理任务执行独立终验；必须使用 `purpose: verify` 和 `taskId`。
- **git-committer**：把用户明确指定的现有改动整理成本地 commit；默认不 push。

两个外部（`runtime: external`）模板覆盖重型、异步的场景，详见 [../../docs/sub-agents.md](../../docs/sub-agents.md)：

- **builder**（claude-code，`mutates: write`）：跨多文件的重型实现，自己写测试、自己跑测试。派发后立即返回 `runId`，完成时唤醒频道——不要轮询，见 `subagent_manage op=list`。
- **external-reviewer**（codex-cli，`mutates: read`，只读沙箱）：用另一家模型独立复核实现，也可作为 `purpose=verify` 的验收者，但其结论是 `advisory`（仅供参考），仍需按风险抽查。

## 使用原则

- `description` 会进入主代理的子代理目录，必须写清楚“何时使用、何时不用、调用前提和是否修改状态”。
- 正文是子代理的 system prompt，应明确职责、禁止事项、证据标准、停止条件和输出契约。
- 子代理默认看不到主会话。委派时的 `task` 仍须包含目标、范围、相关路径、约束、验收方法和期望返回格式，不能只写“按上文处理”。
- `thinkingLevel`、上下文模式和执行预算在这些模板中显式配置，方便审查和按成本调整；不要依赖隐藏默认值。这四个数值预算只在 frontmatter 里精确设置——调用时主代理只能选 `effort` 的 quick/standard/deep 三档，传了就整组替换这里的数值。
- `tools` 只是工具白名单，不等同于只读沙箱。拥有 `bash` 的角色仍须遵守正文和应用级 `security.json` 的限制。
- `git-committer` 只有在任务明确转述用户要求 push 时才能推送；创建了 commit 不代表自动获得 push 授权。

Pipiclaw 只加载工作区 `sub-agents/` 中实际存在且有效的 Markdown 文件。空目录是合法配置；没有合适的预定义角色时仍可使用 inline `systemPrompt`。`purpose: verify` 的验收约束由 runtime 执行，不要求配置文件必须名为 `verifier`。

## 关于外部角色

`builder.md` 的 `command` 里带了 `--dangerously-skip-permissions`——这是 claude-code 自身的权限跳过标记，pipiclaw 不解释、不校验这条命令行，原样传给目标 CLI。这样写是因为 pipiclaw 本身不沙箱化外部进程（见 [../../docs/sub-agents.md](../../docs/sub-agents.md) 的"授权与安全边界"一节），唯一的强边界就是你在 `command` 里自己声明的目标 CLI flag。如果不接受这个权衡，改成该 CLI 自己的确认模式或只读 flag，或者只用 `mutates: read` 的角色（如 `external-reviewer`）。

# 工作区子代理示例

这里的文件既是配置示例，也是按生产使用标准维护的推荐模板。Pipiclaw 不会自动加载它们；请只复制实际需要的角色到工作区，并根据团队规则调整：

```bash
cp examples/sub-agents/{explorer,researcher,verifier,git-committer}.md ~/.pipiclaw/workspace/sub-agents/
```

四个模板分别覆盖常见且边界清晰的委派场景：

- **explorer**：只读定位仓库实现、追踪调用链和梳理模块关系。
- **researcher**：检索当前或仓库外的信息，核对来源并综合结论。
- **verifier**：对受治理任务执行独立终验；必须使用 `purpose: verify` 和 `taskId`。
- **git-committer**：把用户明确指定的现有改动整理成本地 commit；默认不 push。

## 使用原则

- `description` 会进入主代理的子代理目录，必须写清楚“何时使用、何时不用、调用前提和是否修改状态”。
- 正文是子代理的 system prompt，应明确职责、禁止事项、证据标准、停止条件和输出契约。
- 子代理默认看不到主会话。委派时的 `task` 仍须包含目标、范围、相关路径、约束、验收方法和期望返回格式，不能只写“按上文处理”。
- `thinkingLevel`、上下文模式和执行预算在这些模板中显式配置，方便审查和按成本调整；不要依赖隐藏默认值。
- `tools` 只是工具白名单，不等同于只读沙箱。拥有 `bash` 的角色仍须遵守正文和应用级 `security.json` 的限制。
- `git-committer` 只有在任务明确转述用户要求 push 时才能推送；创建了 commit 不代表自动获得 push 授权。

Pipiclaw 只加载工作区 `sub-agents/` 中实际存在且有效的 Markdown 文件。空目录是合法配置；没有合适的预定义角色时仍可使用 inline `systemPrompt`。`purpose: verify` 的验收约束由 runtime 执行，不要求配置文件必须名为 `verifier`。

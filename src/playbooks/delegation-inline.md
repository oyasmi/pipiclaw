---
name: delegation-inline
description: 无合适角色时配置 subagent_inline。
requires-tools: subagent_inline
order: 61
---

# 临时内置执行者

仅当没有合适配置角色且确需委派时读；普通角色直接用 subagent。先读过 [普通委派](agent-delegation.md) 且仍在上下文就复用，重点补这里的配置。没有 subagent_inline 时自己完成或请部署者补角色，不改配置绕过。

subagent_inline 不读取角色文件，必须提供 task 和 systemPrompt：前者交代自足的本次工作，后者定义临时执行者的职责、约束、交付标准。没有角色代填配置，不能只给 agent/task 风格的半份调用。

| 字段 | 判断 |
|---|---|
| tools | 按实际工作给白名单，内置只支持暴露的文件/shell/web 工具，不允许嵌套派发 |
| model | 精确模型引用，默认父级当前模型；缺权限/输入不靠升档解决 |
| thinkingLevel | 内置执行者的推理档，默认 medium，不继承聊天的推理档 |
| effort | quick：窄查询；standard：默认；deep：长分析；控制回合、工具调用和墙钟预算 |
| context | none 默认完全隔离；index 仅加 workspace 背景、工位记忆索引和当天 journal 尾部，仍没有聊天历史 |
| mutates | 有任何可能写入（含 bash）就明确 write，取得独占租约；自动推断只认识 write/edit，不认识 shell 写入 |

workingDirectory、worktree、purpose、item 与普通委派相同；cwd 不隔离写入。配置为只读的文字不提供 sandbox，带 bash 的 verifier 仍可能写。独立检查需原始标准和待检版本，不能靠复制实施者结论生成 PASS。

inline 仅创建内置执行者，不能内联外部 CLI 命令；外部角色由部署者配置。确认完整配置后调用一次，正常返回/等待按普通委派处理。

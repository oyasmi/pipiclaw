---
name: delegation-inline
description: 无合适角色时配置 subagent_inline。
requires-tools: subagent_inline
order: 61
---

# 临时内置执行者

仅当没有合适配置角色且确需委派时读。有符合范围的角色直接用 subagent。没有 subagent_inline 时自己完成或请部署者补角色。

subagent_inline 必须提供 task 和 systemPrompt。task 按**结果 → 已核实证据 → 约束 → 路径 → 验收**交接，systemPrompt 定义临时执行者的职责和交付约定。

| 字段 | 判断 |
|---|---|
| tools | 按实际工作给白名单，内置只支持暴露的文件/shell/web 工具，不允许嵌套派发 |
| model | 精确模型引用，默认父级当前模型；缺权限/输入不靠升档解决 |
| thinkingLevel | 内置执行者的推理档，默认 medium，不继承聊天的推理档 |
| effort | quick：窄查询；standard：默认；deep：长分析；控制回合、工具调用和墙钟预算 |
| context | none 默认完全隔离；index 仅加 workspace 背景、工位记忆索引和当天 journal 尾部，仍没有聊天历史 |
| mutates | 有任何可能写入（含 bash）就明确 write，取得独占租约；自动推断只认识 write/edit，不认识 shell 写入 |

workingDirectory 默认当前实际 cwd。Git 仓库里并行写用 worktree:true 隔离。独立检查用 purpose=verify，提供原始标准、待检版本和入口；带 bash 的 verifier 仍可能写。任务步骤可用 item 绑定工作项。

临时执行者在进程内运行。聊天委派共享 10 秒快速窗口，超时转后台；任务步骤启动后立即返回。只剩等待时结束本轮，运行时自动回流结果。失败或卡顿查 [委派恢复](delegation-recovery.md)。

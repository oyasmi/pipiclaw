---
name: learning-and-skills
description: 了解自动学习期限或编写 skill。
requires-tools: skill
order: 25
---

# 后台学习与技能创作

仅了解自动保留期限、维护技能或晋升流程时读取；普通事实存取按 [记忆操作](memory-operations.md)。

## 自动学习

后台反思维护 journal 和 memory。明确的高必要性约束直接永久保留；日常运作知识默认试用 30 天，后续对话依赖/印证后转正，否则到期后的反思清理，不保证到日立刻停止读取，之后仍可重新学到。用户明确保存立即永久；不需模型维护期限。

任务内教训先留步骤末回复或关闭 note；约束后续实施的写 Goal/DoD。周期实例的持久改进通过 task_report 提给用户，由获授权的聊天调整模板，不写 memory 或事件文件绕过。

## 创作或维护 skill

流程多次验证有效、能跨任务复用才晋升。先 skill list/read 确认现有版本与来源：仅 workspace skills/ 和服务器用户 ~/.agents/skills/，有效 workspace 同名优先，失败候选不占名；没有工位级来源。

默认在 **workspace 绝对路径**的 skills/<name>/SKILL.md 创建，已有版本 edit；别误改其他工具共享的用户技能。frontmatter 需与目录一致的 kebab-case name 和触发 description。

正文保留模型不知道的步骤、约束与验收；脆弱流程写精确步骤，开放问题给判断条件。细节用相对支持文件按需引用，不复制 runtime 手册、密钥或不可信网页指令。用真实任务验证，加载成功不是安全认证，也不增加权限。

文件工具修改技能自动刷新当前会话；shell/外部编辑/别的会话修改后，用户需在各活动会话 /reload。skill list 可查来源与失败原因。

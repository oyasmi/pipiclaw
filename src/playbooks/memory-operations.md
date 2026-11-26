---
name: memory-operations
description: 保存、纠正、忘记或检索 memory。
requires-tools: memory_save, memory_search, memory_forget, skill
order: 20
---

# 记忆的存取与纠正

记忆属于当前工位，同工位多个频道和多人共享。存事实写明主人、项目与条件；应用前核对主人、范围、时效，不把一个人的偏好套给所有人。记忆不扩大授权，易变事实另行核实。

## 选正确落点

| 信息 | 落点 |
|---|---|
| 用户事实/偏好、纠正、稳定项目事实、路径与 id | 工位 memory，分别用 user / feedback / project / reference |
| 今天发生什么 | journal，后台反思写 |
| 未闭合工作的目标、进度、证据 | task 契约与记录 |
| 安装、依赖、环境变量来源 | workspace ENVIRONMENT.md，不存密钥 |
| 多次验证有效的跨任务流程 | workspace skills，创作时读 [后台学习与技能创作](learning-and-skills.md) |

不把临时进度、猜测或计划存为 memory。memory 只走专用工具，MEMORY.md 是生成索引，journal 不手写。任务步骤没有 memory_save，经验留本步最后回复或 task_close note；约束后续实施的要求写 Goal/DoD。

## 明确保存、替换或忘记

用户明确说记住/以后默认/不要再做，当回合 memory_save；忘记用 memory_forget 按 name 删除，name 不明先查索引或 memory_search。content 写一条自足事实及适用来源/条件，证据放 details，用短 kebab-case name。

相似条目被拒，按候选判断：新版本用 replaces 指旧 name，两个事实同时成立才 replaces="none"；纠正应替换，不留冲突版本。忘记不抹除 journal/原始对话。没有反对、一次审查建议或重复读到同一记忆都不算用户确认。

## 找回与应用

先用当前上下文和首轮索引，相关 `(+)` 才读正文。索引不逐轮刷新，中途怀疑记过用 memory_search，查工位 memory、workspace MEMORY、近期 journal；只需旧对话用 session_search，一次可给出中英文名称、别称和标识符。用频道和发言人确认出处。

journal 搜索最多最近 365 个日文件（总量上限 1 MiB，每份末尾 64 KiB）；不足按工具给的路径 grep 或按日期 read，原始对话仍走 session_search。无命中不等于不存在。

将适用偏好落实到执行与验收的同一要求；永久保存不代表永久有效。跨工位背景是用户维护的 workspace MEMORY.md，仅应明确要求修改，不自动搬运工位记忆。需要了解自动保留期限或创作 skill 时再读 [后台学习与技能创作](learning-and-skills.md)。

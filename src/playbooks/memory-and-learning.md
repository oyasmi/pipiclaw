---
name: memory-and-learning
description: 记住、纠正或忘记事实（memory），检索旧日志（journal），或把验证有效的经验沉淀成技能（skill）。
requires-tools: memory_save, memory_search, memory_forget, skill
order: 20
---

# 记忆与学习

遇到需要跨回合保留或找回的信息时，先按生命周期选落点；文件位置不清楚才读 `runtime-orientation.md` 的“文件地图”。任务步骤没有 `memory_save`，经验先记本任务的 `note` / Manual。

## 选落点

| 信息 | 落点 |
|---|---|
| 用户身份、长期偏好 | channel memory，`type: user` |
| 工作纠正、反复踩过的坑 | channel memory，`type: feedback` |
| 项目的稳定事实、决策、约束 | channel memory，`type: project` |
| 路径、URL、命令、联系人、id | channel memory，`type: reference` |
| 今天发生了什么、定了什么、卡在哪 | journal，后台反思自动写 |
| 未闭合工作的目标、状态、证据 | task 契约与循环日志 |
| 机器安装、依赖、环境变量来源 | workspace `ENVIRONMENT.md`，受项目边界限制 |
| 多次验证有效的跨任务流程 | workspace `skills/` |

不把临时进度、猜测或计划存成永久 memory。频道记忆写入只走专用工具；`MEMORY.md` 是生成索引，journal 只由后台写。

## 明确记住、纠正与忘记

用户明确说“记住、以后默认、不要再做”时当回合 `memory_save`；说“忘掉”用 `memory_forget` 按 name 删除，不再 save 一遍。name 不明先查索引或 `memory_search`。

`content` 写一条自足事实，包含会改变适用范围的来源和条件；补充证据放 `details`。给短 kebab-case name，方便以后精确修订。不同项目的规则不要合成含糊的全局偏好。

相似条目被拒时，按工具给的候选决定：同一规则的新版本用 `replaces: <name>`；两个事实同时成立才用 `replaces: "none"`。用户纠正已有事实时替换旧条，不让冲突版本并存。忘记只移除 durable memory，不会抹去 journal 和原始对话。

没有反对、审查者的一次建议、重复读到同一条记忆，都不算用户确认；未经验证的猜测留在任务记录里。

## 找回并应用

先看当前上下文和首轮索引；有相关 `(+)` 条目才读正文。索引不会每轮刷新，中途怀疑记过就 `memory_search`。它查频道 memory、workspace MEMORY 和最近的 journal；日志最多取最近 30 个日文件、每份末尾 64 KiB，超出时工具会给继续检索的路径。找更早记录用该路径定向 `grep` 或按日期 `read`，原始对话用 `session_search`。无命中不等于不存在。

使用偏好前确认适用范围，再转成执行与验收的同一要求。例如“控制复杂度”可落为“新增依赖或持久状态必须说明本次必要性”，而不只是让执行者读一句口号。委派时把本轮适用要求同时给执行者和验收者；跨频道共享背景只由用户维护 workspace `MEMORY.md`。

## 自动学习与 skill 晋升

后台反思同时维护 journal 与 memory：明确的高必要性约束直接永久保留；日常运作知识默认试用 30 天，后续对话依赖或印证后转正，否则到期移除，之后仍可重新学到。用户明确保存的记忆立即永久。模型不需要手动维护这些期限。

任务内教训先写 `note`；确实约束后续实施的，再改 Manual。正式 PASS 后修改 Manual 会使证明失效，时机不清楚才读 `task-loop.md` 的“独立验收”。

流程多次验证有效且能跨任务复用，才写为 skill。使用 **workspace 绝对路径**下的 `skills/<name>/SKILL.md`；已有技能用 `edit`。frontmatter 必须有与目录一致的 kebab-case `name` 和说明触发条件的 `description`。

正文保留模型不知道的步骤、约束和验收方法；脆弱流程给精确步骤，开放问题给判断条件。细节放按需引用的支持文件，不复制 runtime 手册、密钥或不可信网页指令。创建后用真实任务验证；`skill list` 可查看扫描失败的原因。

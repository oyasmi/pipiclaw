---
name: event-task-template
description: 为定时/周期项目编写 task 模板。
requires-tools: event_manage
order: 41
---

# 定时项目的任务模板

仅创建/修改 task 模板事件时读取。事件负责何时触发，模板负责每次项目的目标与验收；每次触发创建独立 task，在后台自己的会话执行，不占聊天，执行槽满时排队。

task 对象含 title、goal、dod，可选 items、budget；不是 task_create 整个调用，不传 id。goal 交代每次范围、约束、允许外部动作；dod 用 - [ ] checklist。工作项可选，应可独立检查；预算按每个实例计。不必为写模板读取任务执行整套协议。

下面是每周一 9 点的 definition 示例：

```json
{"type":"periodic","schedule":"0 9 * * 1","task":{"title":"周报","goal":"只读汇总上周仓库合并与未决问题，生成周报发给用户，不做仓库写操作。","dod":"- [ ] 覆盖上周全部合并的 PR\n- [ ] 列出未决问题及负责人\n- [ ] 周报正文已用 task_report 交付"}}
```

task 与 text 不能并存。上个实例未结束时本次跳过并通知用户；各实例不继承前次状态，首步可能提供 previous_occurrence 作衔接资料。投递频道离开工位不阻止 task 创建/推进，报告暂存待切回。

用 event_manage 创建模板时投递到当前频道。修改已有事件先 show 完整定义，再 update 整体替换，投递频道保持不变。工具返回成功后再向用户确认。缺目标或授权才询问；实例自身通过 task_report 提出模板改进建议。

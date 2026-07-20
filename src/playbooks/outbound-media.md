---
name: outbound-media
description: 把生成的文件、图片、报表或导出物作为附件（attachment / media）交付给用户时。
requires-tools: send_media
priority: 25
---

# 附件交付（outbound media）

产物只有真正到了用户手里才算交付。`send_media` 把本地文件作为**原生附件**发进当前 channel：图片内联展示，其余作为可下载文件。

## 什么时候用

用 `send_media`：生成的报表、截图、图表、导出文件、日志片段打包——**用户需要拿到文件本身**。

不要用：

- 给自己看文件内容用 `read`，不要先发给用户再阅读。
- 几行文本、一小段代码、一个结论：直接写在回复里，附件反而更难读。
- 只把路径贴给用户（如 `/home/.../report.pdf`）。用户在钉钉里打不开主机路径；这正是本工具存在的原因。

## 调用约定

```
send_media label="本周巡检报告" path="reports/2026-W29.pdf" fileName="巡检报告-2026-W29.pdf"
```

- `label`：说明你在发什么、为什么发，会展示给用户。
- `path`：workspace 相对路径或绝对路径，经与 `read` 相同的 path guard。
- `fileName`：可选的收件显示名，默认取文件本身的名字。想让用户看到有意义的名字就显式传。

`.jpg .jpeg .png .gif .webp .bmp` 按图片内联，其余一律按文件下载。**目标 channel 由运行时绑定**，不是参数——你无法也不需要指定发给谁，当前对话就是目的地。

## 失败与下一步

| 报错 | 含义 | 下一步 |
|---|---|---|
| `Path blocked [...]` | 路径被 path guard 拒绝 | 把产物写到 workspace 内再发，不要绕守卫 |
| `not a regular file (does it exist?)` | 路径不存在或是目录 | 先确认产物真的生成了；目录先打包成单个文件 |
| `the file is empty` | 生成步骤静默失败了 | 回去查生成命令的退出码和输出，别重发空文件 |
| 发送失败（transport 报错） | 渠道侧拒绝或超限 | 文件过大时改发摘要 + 关键片段，或拆分后重试 |

## 与任务台账的关系

任务（task）的产物交付属于**结果**，不是日志：发送成功后，把"已作为附件发给用户"写进该轮的 progress note 或 done evidence，让后续唤醒不会重复投递同一份产物。若发送是任务的外部副作用（`sideEffects: external`）的一部分，遵守 `task-closeout.md` 的审批（approval）门禁，不要先发后批。

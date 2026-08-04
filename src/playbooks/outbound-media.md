---
name: outbound-media
description: 把生成的文件、图片、报表或导出物作为附件（attachment / media）交付给用户时。
requires-tools: send_media
priority: 25
---

# 附件交付（outbound media）

产物真正到了用户手里才算交付。使用 `send_media` 发送 workspace 内的文件；成功后把附件名、目标 channel、message id 和时间写进任务 Current Cycle 或 completion evidence。

发送前检查：

- 文件已经生成且非空；
- 目标仍在 task Goal 范围内；
- 查询或记录已有 message/request id，避免 crash replay 重复发送；
- 发送后查询真实投递状态，失败则 progress 为 active/waiting 并写 recovery source。

send_media 的 path guard、文件类型和 transport 失败信息会给出可执行 next step。不要把主机路径当作用户可下载附件；不要因为一次调用返回成功就跳过真实结果核对。

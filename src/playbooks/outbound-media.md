---
name: outbound-media
description: 把生成的文件、图片、报表或导出物作为附件（attachment / media）交付给用户时。
requires-tools: send_media
order: 25
---

# 附件交付（outbound media）

产物真正通过当前 transport 发出才算交付。使用 `send_media` 发送 workspace 内的文件；成功后把工具返回的 receipt（附件名、类型、大小和已发送到当前 channel）及记录时间写进任务 Current Cycle 或 completion evidence。

发送前检查：

- 文件已经生成且非空；
- 目标仍在 task Goal 范围内；
- 查询任务 Current Cycle 或 completion evidence 中是否已有同一附件的成功 receipt，避免明显的重复发送；
- 只有 `send_media` 返回成功 receipt 才记录已发送；失败则 progress 为 active/waiting 并写 recovery source。

`send_media` 的 path guard、文件类型和 transport 失败信息会给出可执行 next step。不要把主机路径当作用户可下载附件。当前接口不返回 message/request id，也不提供二次投递状态查询；不要虚构这些证据。若任务要求更强的送达确认，明确记录现有 receipt 的证据边界，并向用户确认或等待 transport 增强。

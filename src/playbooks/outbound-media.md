---
name: outbound-media
description: 把生成的文件、图片、报表或导出物作为附件（attachment / media）交付给用户时。
requires-tools: send_media
order: 30
---

# 附件交付（outbound media）

产物真正通过当前 transport 发出才算交付。`send_media` 把一个本地文件作为原生附件发到**当前 channel**——目标不由你选，主机路径也不是附件。

## 工具边界

- 图片扩展名（`.jpg` `.jpeg` `.png` `.gif` `.webp` `.bmp`）内联展示，其余作为可下载文件发送。要改接收方看到的名字就传 `fileName`。
- 上限 5MB，超出直接拒绝：先压缩，或者把路径告诉用户让他自己取。
- 空文件、不是常规文件、被 path guard 挡住的路径都会拒绝并给出可执行的下一步。这些检查工具会做，不必自己预检。

## 记录 receipt

`send_media` 返回成功 receipt 才算送到。成功后把 receipt（附件名、类型、大小、已发送到当前 channel）和时间写进任务 Current Cycle 或 completion evidence；发送前先看这份记录里有没有同一附件的成功 receipt，避免重复投递。外部动作的通用幂等纪律见 `task-driving.md`。

失败时按同一份纪律 progress 为 active 或 waiting 并写恢复来源，不要把"调用返回了"当成"用户收到了"。

## 证据边界

当前接口不返回 message / request id，也不提供二次投递状态查询，不要虚构这些证据。任务要求更强的送达确认时，明确记录现有 receipt 的证据边界，并向用户确认。

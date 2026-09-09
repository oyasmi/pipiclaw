---
name: outbound-media
description: 把生成的文件、图片、报表或导出物作为附件（attachment / media）交付给用户，或处理发送失败时。
requires-tools: send_media
order: 30
---

# 附件交付

`send_media` 把本地文件发到当前 channel。产物通过 transport 成功发出才算交付，主机路径本身不是附件；普通聊天发送不需要创建 task。

## 发送与恢复

按发送文件名的扩展名选择展示：jpg/jpeg/png/gif/webp/bmp 内联，其余作为文件；`fileName` 改接收者看到的名字。传当前项目内或允许读取位置的文件路径。

上限 5 MiB。空文件、非常规文件、超限和 path guard 拒绝都由工具检查，无需重复预检。超限先压缩或拆分；仍无法发送时说明未交付，并提供用户可访问的取件方式。

依据成功回执确认附件名、类型和大小。失败按原因修复后重试；如果结果不确定，先核对已有证据，不能把工具返回或主机文件存在当成送达。

## task 中的交付证据

**仅在 task 步骤中**，发送前用已有 `<task_log>` 或 `task_log` 查同一产物的成功回执；发送成功后将回执、产物标识和时间写入 `task_step_end.note`，避免重复投递。失败可自行修复用 continue，等待真实来源用 park，需要用户决定用 blocked。外部动作涉及多步恢复时再读 `task-loop.md` 的“外部动作”。

接口没有 message/request id，也不能二次查询投递状态。记录工具实际提供的证据；任务要求更强送达确认时，把这一缺口告知用户，不虚构标识。

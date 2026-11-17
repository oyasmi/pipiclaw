# 历史版本升级与数据迁移说明

> **新安装用户请直接跳过本目录**（直接阅读 [快速上手指南](../quickstart.md)）。
> 本目录仅面向**从早期旧版本升级已有 `~/.pipiclaw`（或 `PIPICLAW_HOME`）实例**的维护者。

Pipiclaw 运行时只读写当前版本的存储格式，不内置旧格式兼容读取或自动搬迁脚本。升级遇到存储结构或上游 SDK 模型目录变更时，请先**停止全部运行进程并完整备份 `PIPICLAW_HOME`**，再让本机 AI Agent 对照以下文档完成一次性离线整理：

| 适用场景 | 迁移指南 |
|---|---|
| 从旧版单段 `channel.json`、无渠道前缀频道 ID（`dm_*` / `group_*` / `tui`）或 Brave 搜索配置升级（Spec 061） | [渠道层迁移说明](./channel-migration.md) |
| 从早期按频道分目录或 `dots/` 目录布局升级到 `desk-<name>/` 工位布局（Spec 060） | [工位布局迁移说明](./desk-migration.md) |
| 从早期带等待票（`ticket` / `parked` / `.steer/`）的任务格式升级到任务车道格式（Spec 064） | [任务数据迁移说明](./task-migration.md) |
| 升级上游 Pi SDK（1.2 / 1.4 / 1.5）涉及的 Azure 身份、`kimi-coding` 协议、下架模型名与 OpenAI OAuth 安装身份说明 | [SDK 与模型供应商升级说明](./sdk-upgrades.md) |

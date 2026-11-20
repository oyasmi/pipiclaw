---
name: runtime-files
description: 定位状态文件、凭据与产物路径。
order: 11
---

# 文件地图

仅定位路径时读取。以 runtime_turn_context 的 workspace、工位目录、实际 cwd 为准，不从 cwd 猜状态路径；default 对应 workspace/desk-default/，其他工位同构。

| 位置 | 内容与入口 |
|---|---|
| App home，默认 ~/.pipiclaw/，PIPICLAW_HOME 可覆盖 | channel.json / settings.json / tools.json / security.json；auth.json / models.json；state/。部署配置与运行状态，凭据按敏感信息处理 |
| workspace SOUL.md / AGENTS.md | 身份与共同工作原则，注入 system prompt；工位同名文件不替代 |
| workspace MEMORY.md | 共享背景，用户维护；明确要求时 read/edit，首轮按预算注入，memory_search 可查 |
| workspace desk-bindings.json | 唯一频道→工位绑定，运行时管理，不用文件写入模拟切换 |
| workspace skills/ 与 ~/.agents/skills/ | 两来源共享技能，有效 workspace 同名版本优先；skill list/read，创作见 [后台学习与技能创作](learning-and-skills.md) |
| workspace sub-agents/ | 配置角色，系统目录给出名称；部署者维护，模型不 write/edit 角色 |
| workspace ENVIRONMENT.md / CHANNELS.md | 机器事实/频道索引；CHANNELS 仅主题列可补写，其余由运行时重建 |
| 工位 memory/<name>.md / MEMORY.md | 一文件一事实/生成索引；正文可 read，写用 memory_save / memory_forget 串行维护索引 |
| 工位 journal/YYYY-MM-DD.md | 后台反思写；memory_search 或按日期 read |
| 工位 tasks/<id>.md / <id>.jsonl | 契约/记录；正文可 edit，frontmatter 归运行时；历史 task_log |
| 工位 events/ | 调度定义；聊天 event_manage 管理，channelId 是投递目标 |
| 工位 inbox/ / logs/ / subagent-artifacts/ | 入站图片与超长消息/完整命令输出/委派产物，按工具给的绝对路径 read |
| 工位 conversations/<会话区>/log.jsonl / context.jsonl | 原始对话冷存储，用 session_search 检索当前工位 |

中间产物和自建日志放 <deskDir>/work/<taskId>/；长期产物留目标项目/工位。多个工位即使 cwd 相同也不应默认写同一外部 logs 目录，共享须明确路径和写入范围。契约正文锁不覆盖任意 shell 或外部执行者。

文件工具默认访问 workspace、主目录、临时目录及只读内置 playbook；显式 deny、敏感路径和符号链接规则仍生效。守卫拒绝时用专用工具；没有合法入口就说明用户需提供什么，bash 不是绕过路径。

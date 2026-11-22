# Pipiclaw 项目开发文档

这里汇集维护 Pipiclaw 源码、运行评测和追溯设计决策所需的资料。安装、配置、集成和运维请查阅[用户文档](../docs/README.md)。

## 开发与验证

| 文档 | 内容 |
|---|---|
| [工程规范](../AGENTS.md) | 模块边界、代码与测试约定、开发检查命令 |
| [架构](./architecture.md) | 当前源码布局、运行时拓扑、消息生命周期和磁盘布局 |
| [行为评测指南](./evals.md) | 如何选例、运行评测、核对证据和比较结果 |
| [Runtime Playbooks](./runtime-playbooks.md) | 内置模型手册的编写约定、加载机制与体积预算 |

## 设计与历史

| 文档 | 内容 |
|---|---|
| [设计哲学](./design-philosophy.md) | 状态持久化、运行时边界、分层记忆与可验证交付的设计原则 |
| [设计记录](./specs/README.md) | 按编号查找设计、实施计划和验收证据 |
| [历史规格归档](./specs/archive/README.md) | 已归档的规格和实施清单 |
| [研发评审与设计复盘](./reviews/README.md) | 按主题回查测试、运行时恢复、记忆、SDK 和提示词的验证证据 |

判断当前行为时，以当前源码与测试为准。设计记录和评审用于追溯当时的背景与取舍。

## 调研笔记

- [主动工作与实时语音调研](./research/personal-agent-proactivity-and-voice.md)
- [主动性机制与设计取舍](./research/personal-agent-proactivity-design-notes.md)
- [Grok Bot 与 Pipiclaw 的产品形态对比](./research/grok-bot-comparison.md)

# 研发评审与设计复盘

这里按主题保留设计取舍、故障证据和待验证方向。当前实现见[架构文档](../architecture.md)，操作方式见[用户文档](../../docs/README.md)。评审中的数字对应当时的版本和试验条件。

| 主题 | 适合回查的问题 |
| --- | --- |
| [测试质量与成本](./test-quality.md) · [历史单测基线](./unit-test-quality-baseline.json) | 哪些回归需要真实进程，如何验证测试能检出故障，哪些夹具改动确实降低了成本 |
| [运行时恢复与投递](./runtime-recovery.md) | 何时确认输入消费、如何恢复半完成的交付、什么情况下可以回收工作树 |
| [记忆一致性与恢复](./memory-consistency.md) | 分批游标、部分写入、替换与遗忘的保证，何时值得扩大机制 |
| [Pi SDK 接入与升级验证](./pi-sdk-integration.md) | 从 1.2 到 1.5.2 的宿主接线教训、协议变化、候选能力 |
| [提示词、手册与请求缓存](./prompt-and-cache.md) | 如何测量缓存、缩短常用工具路径，以及如何判断延迟声明有无收益 |
| [个人研发工作流的设计取舍](./personal-workflow.md) | 工位、任务、频道与 checkout 的边界，仍值得探索的方向 |
| [工具按需发现与 Codemode](./2026-11-17-tool-orchestration-proposal.md) | 研究草稿，含旧基线的离线探针和独立试点方案 |

各篇列出原报告的 Git 提交。需要核对当时的完整说法、失败样本或测量流水时，可以使用 `git show <提交>:docs/reviews/<原文件名>` 查看。真实模型运行以原 run ID 为准，封存产物由本地 `evals/results/<run-id>/` 管理。

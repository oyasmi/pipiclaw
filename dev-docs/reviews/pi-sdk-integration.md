# Pi SDK 接入与升级验证

覆盖 0.84.3 到 1.5.2 的几次升级，以及宿主补接认证的验证。部署操作、模型下架与旧网关兼容项见[升级指南](../../docs/migrations/sdk-upgrades.md)。

## 升级时查整条请求链

| 时点 | 可复用的教训 |
| --- | --- |
| 1.2.0 | Agent 内存里有全部工具，真实首轮请求仍可能没有工具。持久会话的 canonical projection 也可能把内存里裁掉的历史重新带回，导致备用请求重复用户输入。升级时检查首次及备用请求体、实际 JSONL、重启恢复和工具副作用。原型到正式实现的取舍见 [Spec 055 设计](../specs/055-pi-1.2-upgrade/design.md)与[验收](../specs/055-pi-1.2-upgrade/acceptance.md)。 |
| 1.5.0 | 原有 schema 由 `typebox` 构造，普通 JSON Schema 可以继续使用。新增复杂类型、引用或边界数字时应走实际 SDK 解析与校验。SDK 单次 append 失败回滚改变了旧断言，但多个 context edit 仍可能部分提交，宿主要保留故障隔离与重建。增量参数解析的微基准只衡量宿主解析时间。 |
| 1.5.2 | 发布包实测收紧了非有限数值校验，并修复根 `$id` 与本地 `$ref` 的组合。域内预算和数量上限仍须自行校验。升级前从 npm 产物核对模型目录和传递依赖，同步检查默认、备用、内部委派模型，以及网关空工具字段和长输出预算。 |

先锁定正式发布的整组版本，分别验证干净安装、实际 provider 负载、旧会话回放、发布包和最低支持 Node。上游 CLI 工厂启用的扩展、工具与默认策略，需要确认自建会话是否真的装配。Spec 067 的实验曾尝试 SDK 分段工具调度，正式交付采用官方发布包，分段调度方案已撤销。[Spec 067 验收](../specs/067-execution-latency/acceptance.md)

## 完整认证与关闭

模拟网关要求一个已在 SDK 解析出的额外请求头。原来只取 API key 的 compat 路径漏掉请求头而收到 401，完整 `ModelRuntime.streamSimple()` 路径成功。主会话、任务、内部代理、记忆和压缩现共用 `ModelRequests` 的认证解析路径。备用模型应解析自己的 key、请求头、端点与环境，预检只判断可用性。

调用者取消后，SDK 中已经开始的 OAuth 轮换可能仍在写文件。运行时跟踪被取消调用留下的工作，关闭阶段在总预算内等待。无法确认写入已停止时保留 daemon 锁，直至进程退出。测试用真实 SDK、合成网关和可控凭据轮换，核实 caller 先取消、轮换实写以及子进程锁交接顺序。将请求端口退回 key-only、或跳过关闭等待，相关断言均失败。真实 OAuth 端点仍需单独验收。

## 能力候选

- 已为主会话和内部 worker 接入稳定请求身份。现有 SDK 对满足前提的端点可能使用消息线程，仍需验证实际线程发送、过期回退和恢复后的历史。空闲缓存保温需单独装配和费用证据。缓存接线与验证口径见[缓存复盘](./prompt-and-cache.md)。
- 工具按需发现与 Codemode 分别验证。优先找重声明、低频的工具和多页查询、结构化过滤的真实工作流。测试应覆盖现有直接工具、并行和 shell/skill 路径。这两项均为试验候选，见[工具编排研究草稿](./2026-11-17-tool-orchestration-proposal.md)。
- MCP 值得从一个现有工具覆盖不足、可独立验收的服务开始，先明确认证、调用边界和连接生命周期。图片生成、虚拟模型路由与分类器也各需真实工作需求及独立的成本和质量证据。

## 评估与实施出处

- 1.2.0 原型与交付见 `380337d:docs/reviews/2026-10-13-pi-1.2.0-upgrade-assessment.md`。
- 1.5.0 兼容矩阵与实施见 `e3d6321:docs/reviews/2026-11-09-pi-1.5.0-upgrade-assessment.md`。
- 在 `b66286f` 查阅 1.5.2 评估、1.x 能力复盘、会话候选和认证验收。对应文件为 `docs/reviews/2026-11-17-pi-1.5.2-upgrade-assessment.md`、`docs/reviews/2026-11-17-pi-1.x-feature-retrospective.md`、`docs/reviews/2026-11-17-pi-session-features-assessment.md`、`docs/reviews/2026-11-17-model-request-auth.md`。

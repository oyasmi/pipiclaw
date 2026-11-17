# 完整模型认证请求链与凭据关闭收尾

日期：2026-11-17。实现范围来自 [pi 1.x 复盘](2026-11-17-pi-1.x-feature-retrospective.md)第 1 项。使用官方 pi 1.5.2 发布包，未修改 SDK。

## 问题与结果

此前主会话、内部代理和记忆辅助推理只从 ModelRegistry 取 API key，再调用 compat 流。SDK 已解析的额外请求头可能丢失，要求这些头的网关会返回 401；只有请求头而没有 key 的认证也无法通过旧预检。压缩摘要另行拼装部分认证信息，接线不一致。进程关闭没有等待 SDK 中已开始的凭据轮换写入。

现在 models 域提供 `ModelRequests` 端口，调用真实 `ModelRuntime.streamSimple()`。每次请求由 SDK 同时解析 API key、headers、baseUrl 和 provider env，并选择对应 provider 实现。宿主不再保存或传递预检获得的 key，也不复制 SDK 的请求头合并规则。流入口丢弃上层可能带来的旧 apiKey，避免备用模型沿用其他供应商的 key。

| 入口 | 接入方式 |
| --- | --- |
| 聊天、Web API、任务会话 | SessionHost 的 Agent streamFn 使用同一个请求端口，保留请求追踪 |
| 内部代理与备用模型 | 分派/切换前检查认证可用性；每次推理重新解析，worker state 不存 key |
| 记忆反思、历史检索摘要、脱离活动 runner 的维护 | 端口沿既有领域接口传入；认证和推理共享原有取消信号与超时 |
| 前台/后台压缩 | 保留 trace、输出预算、usage 与摘要协议，通过 session 的完整认证流发请求 |
| 模型目录刷新、SDK session reload 与树摘要 | 记录可能触发凭据工作的异步操作，含调用者超时或取消后的收尾 |
| 认证 CLI 与可选评测裁判 | 使用同一实例的 auth.json，并在返回前有限等待凭据工作 |

预检只判断认证是否可用，不输出凭据。内部代理一旦分派成功，仍由其自己的取消/预算控制；父对话 `/stop` 不会取消已分派的工作。

SDK 流返回的“未配置供应商”错误与预检错误均归入已有的缺凭据分类，继续向用户提示登录或检查服务器配置。复用现有分类场景覆盖这些来源，不增加用例。

## 取消与关闭

`credential-work.ts` 按实际 auth.json 路径记录仍在进行的操作。操作成功或失败后，都继续等待 SDK 的 `settleCredentialWrites()`，然后移除记录。这样可保留“调用者已停止，OAuth 刷新仍在写入”的责任，又不会永久积累空闲或脱离会话的 ModelRuntime。宿主不读取、复制或重写 OAuth token。

关闭顺序为停止入口和后台调度、等待/中止工作、释放空闲 runner、关闭传输、等待凭据、持久化其他状态、刷新日志，最后释放 daemon.lock。凭据阶段上限 45 秒，并受原有 90 秒关闭总预算约束。超时/失败沿用已有锁保留机制，避免旧进程仍能写入时把 app home 交给新进程。CLI 与独立 judge 的凭据等待上限为 15 秒。

这是正常退出的收尾保证。SDK 的等待结束表示已有修改已写入或失败；它不保证网络刷新必然成功，也无法保护 SIGKILL、机器掉电或底层存储故障。调用者的取消不被无限延长。

## 验证设计与准入

- 单元用例净增 **1**：原 API-key lookup 场景迁入新的请求端口测试，改为使用真实 SDK、临时配置和截获 fetch，检查网关头、无 key 的原生认证、端点/env、每次请求重新认证、旧 key 隔离和缺凭据提示。新增一个取消后轮换落盘用例：用可控屏障暂停真实 SDK 的 OAuth refresh，确认 caller 先取消，flush 仍等待，释放后替换 token 落盘。现有 worker/lease/预算/取消场景只更新接口。
- 确定性 e2e 净增 **1**：现有 in-process 网关统一要求配置中的认证头，使现有聊天、任务、委派、记忆和压缩路径实际验证接线。新增真实子进程场景证明 bootstrap → 请求取消 → SDK 凭据写入 → daemon 锁交接与进程退出的顺序；原有重启测试和领域单元无法证明这个进程生命周期风险。
- 现有关闭预算单元场景增加凭据挂起分支，确认不会无限关闭或过早解锁，不增加 case。
- 故障注入已执行并恢复：把请求端口改回 compat + key，现有 A22 收到 `__auth_rejected` 后失败；去掉凭据关闭阶段，新子进程用例在等待实际 drain 检查点时失败。恢复后通过实际落盘和解锁断言。

## 验收结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | lint、typecheck、arch、deadcode 与 148 文件 / 1,036 单元用例通过 |
| `npm run test:e2e` | 先构建当前 daemon，29 文件 / 73 用例通过 |
| `npm run test:evals` | eval 构建与 5 文件 / 98 离线工具链用例通过 |
| 请求认证与用户错误分类定向检查 | 2 文件 / 21 用例通过 |
| `npm ls` 四个直接 pi 依赖 | 均为正式 `1.5.2` |
| `git diff --check` | 通过 |

评测工具测试首次与其他全量门禁并行时，一个 core controls 场景超过原有 30 秒；单独重跑完整 `test:evals` 后 98 用例全通过，未改超时、用例或断言。保留首次失败记录，不能用并行超时声称模型行为失败或通过。最终检查日志位于 `/tmp/pipiclaw-auth-check-final2.log`、`/tmp/pipiclaw-auth-e2e-final2.log`、`/tmp/pipiclaw-auth-evals-isolated.log`；故障注入证据为 `/tmp/pipiclaw-auth-mutation-header.log` 与 `/tmp/pipiclaw-auth-mutation-drain.log`。

变更没有调整模型提示、记忆召回策略、委派决策、默认模型或缓存策略，因此无需以付费模型评测证明行为改进。没有访问真实 OAuth 账户；离线测试验证宿主与真实 SDK 的机制，不能代替具体供应商线上验收。

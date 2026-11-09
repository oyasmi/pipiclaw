# W2：钉钉统一进度的最小闭环

首次主控 review 未通过；五项阻断的返工与最终证据见 [R1 记录](2026-11-09-dingtalk-unified-progress-r1.md)。下述验证数字保留为初始实现的历史记录。


基线 `0a0719817c15380c0cccb1794c2f812e24b903aa`；开发分支 `feat/dingtalk-unified-progress`。这是有边界的实现记录，不代表设计全文或 W4 已完成。未提交、推送、部署或启停个人 daemon；没有调用真实钉钉、真实模型或外部业务，没有读取个人配置、凭据和运行数据。

## 实际实现

- `src/channel/delivery-scope.ts` 定义不可由模型指定的 owner `(desk, channelId, scopeId)`，区分 `request:<uuid>` 与 `task:<taskId>`。完整 owner 的 SHA-256 同时隔离卡片和状态文件；channel id 不进入路径。
- human 普通排队输入在 ingress 分流后取得 request owner；执行前重新核验 desk。注入当前 SDK turn 的 steer/followup 沿用该 turn，重排输入取得新 owner。session 中长期复用的工具在调用入口捕获 owner，贯通 internal/external run、follow_up、job、record、notice 和 completion wake；task runner 使用独立 task owner。委派在 admission 内检查 abort，只阻止尚未注册的工作，保留已注册工作的 `/stop` 语义。
- `src/runtime/delivery-scopes.ts` 在 SDK turn 外保存 scope；每次 writer 有独立 generation，结束或被替换后拒绝迟到 callback。run/job manager 仍独占业务结算、usage、lease 和 completion wake；scope 只读取其事实。wake 合并及 run sibling 计数都限制到同 owner，未知 owner 不与已知 owner 合并。
- answer 在 turn 结束时才成为 final candidate。必须没有 pending work，且所有应唤醒的 completion id 都已由成功回合消费；初始 ack、未消费最后一个 sibling 的 wake 都只能更新进度。通知配置不影响这些事实。没有有效 answer / `[SILENT]` 时不拿 settled notice 冒充结果。
- DingTalk 每个 owner 复用现有 `ChannelDeliveryController`、`ProgressWindow` 与 `CardController`；路由地址与卡片 key 分开，沿用 generation/create single-flight、800ms 节流、1000B request / 2900B document 上限、append unknown 后 rebase。正常默认模式为一张卡和一个 plain final，waiting-only 同步回复也采用此模式；显式 `final_card_only` 保留配置行为。
- run progress/settled 进入所属 scope；stalled、ask、明确操作 warning 和不可恢复错误保留 interaction。owner 缺失或 transport 没有 scopes capability 时保留明确的旧路径，不把结果挂到当前 request。Web API 继续使用原 turn/push 输出。
- TaskSender 接收完整 `TaskDelivery`，所有 drain 调用点一起修改。正常有模板的 report 更新 task 卡，原 `.delivery` FIFO、完整 task log、report_delivered、fsync、关闭检查和 archive recovery 保留。唯一 close receipt 的稳定 id 同时关联 scope final intent。同频道用户 cancel 由原命令答复，另做 best-effort 卡片关闭，不补发第二份取消摘要。
- final intent 原子保存后才进行 I/O，保存 attempts、nextAttemptAt 和 `confirmed/unknown/blocked`。未知或失败不写 confirmed。远端尝试/确认存储故障在已持久化 intent 上重试，不重跑模型；intent 本身保存失败则 runtime 即使遇到 agent 吞掉 finish rejection，也不会删除 durable completion。

## 明确缩小的范围及风险

- **不恢复旧卡引用。** epoch 只区分本次进程和恢复的 scope，不是平台 generation。本轮没有持久 outTrackId、message id、processQueryKey，没有查询/对账接口；恢复时不盲目 CREATE 替代卡。原卡在异常退出后可能仍未收口。
- **兼容 fallback 真实发送报告。** 无模板、关闭进度（含 final_card_only 的 report），或恢复后不能安全续写旧卡时，task report 沿用 plain 发送，并等待确认后才写 report_delivered；不会新增“仅本地 retained 也可完成”的事实。此例外可能有多条报告，不能声称这些环境也满足“一卡一 final”。有模板但 create/update unknown 时保留原 outbox 和 close gate，不无条件 plain 双发。
- **协议确认不等于用户看到。** `confirmed` 仅表示 adapter 核对了响应结构。CREATE 核对 success、返回 owner 标识和投放结果；UPDATE 核对 success/result；SEND 要有查询回执且收件人未出现在拒绝/限流列表。依据为阿里官方 [card SDK 模型](https://github.com/alibabacloud-go/dingtalk/blob/master/card_1_0/client.go) 与 [robot SDK 模型](https://github.com/alibabacloud-go/dingtalk/blob/master/robot_1_0/client.go)，不是本地函数 resolve。没有已读、客户端可见或 exactly-once 保证。
- **at-least-once。** 远端成功、本地确认前 SIGKILL 仍会重复 HTTP，但保留同一 final intent id 和内容。没有按 429/5xx/timeout 细分重试策略；未确认均保留 unknown 并退避。
- **未完成 W4。** 没有 scope/card 的平台寿命、恢复、多卡真实端验证、状态保留/容量回收策略；terminal scope 文件及 adapter 缓存会随 scope 数增长。工具进度窗口不持久化为完整快照；业务证据继续在 run/job record、task log 和已有 durable outbox 中。坏 scope 文件拒绝启动并保留原证据。
- **runtime 依赖边界。** 没有新增 runtime → DingTalk import，也没有下沉 DingTalk 类型；基线 `runtime/transports.ts` 的两个动态 import 原样保留，没有顺带更改 loader/public bootstrap。

## 测试 admission 与覆盖

单元 case-count delta **+5**（1016 → 1021），deterministic e2e delta **0**（71 → 71）。既有报告/恢复/委派场景继续扩展，最终完整 gate 没有跳过或删除用例，没有放宽 gate 或通过超时掩盖竞态。定向 mutation 用 `-t` 选择目标，其日志的 skipped 是未选中用例，不能当作全量通过。

| 新 unit case | 具体错误实现及项目影响；为何原覆盖不足 |
| --- | --- |
| scope owner / completion gate / late writer | 只看 pending=0 会把 ack 或未覆盖最后结果的 wake 发成 final，或旧 writer 串 owner；原 per-turn delivery 不拥有跨 turn completion 集合 |
| unknown final / recovery / rebind / corruption | 把本地 enqueue 当确认、恢复时造新 intent 或投到新 desk 会丢结果/泄漏；原 durable dispatch 只拥有 wake，不拥有 final outbox |
| report acknowledgement | 卡片本地排队成功即写 report_delivered 会错误打开 task close gate；原 TaskSender 只有 plain boolean，不能覆盖 scope publisher 的确认边界 |
| 同频道并发 scope 的 stateful HTTP | channel-keyed card 或空 2xx 响应会串卡/假确认；原 HTTP case 仅有一个 turn owner |
| runtime finish rejection | agent 吸收 finish 失败后 runtime 仍 markCompleted，会删除未持久 final 的唯一 completion；原 settlement 测试只覆盖 dispatch 存储错误 |

扩展的 e2e：A17 从真实 human 工具入口启动 job 和 internal run，释放 runner 后回答第二个 request，最后 sibling 在第一个 wake 已到 provider 后才结算；仅最后消费齐全后发布原 owner final。T-lane-1 在 task 独立 session 连发三份报告并关闭，检查完整报告确认、outbox 清空、task 卡归属和唯一 final。task-close-recovery 保持真实 daemon SIGKILL 链，额外检查两次远端尝试具有相同 final id/owner/content。`hold/arrived/release` 或结算完成事件控制新增并发窗口，没有新增 sleep/polling。

已执行的 mutation（均 exit 1，随后恢复）：

- 删除 final gate 的未消费 completion 检查：A17 在最后 wake 到达时已有两个 SEND，预期仅独立 request 的一个 SEND。
- 卡片 key 改为仅 channelId：stateful HTTP 场景只有一张卡，预期两张。
- 绕过 bootstrap 的 scoped task delivery：T-lane-1 失去 task-owned final/progress。

## 验证记录

| 命令 | 最终结果 | 原始日志 |
| --- | --- | --- |
| `npm run check` | lint、typecheck、arch、deadcode 通过；146 文件 / 1021 unit cases 通过 | `pipiclaw-w2-check-final-2.log` |
| `npm run test:e2e` | 先 build 当前 daemon；28 文件 / 71 cases 通过，包含 SIGKILL 进程恢复 | `pipiclaw-w2-e2e-final.log` |
| `npm run typecheck`、`npm run arch` | 单独执行通过；随后也由最终 check 再验证 | `pipiclaw-w2-typecheck-final.log`、`pipiclaw-w2-arch-admission.log` |
| 三项 mutation | 三次预期失败，恢复后完整 gate 通过 | `pipiclaw-w2-mutation-*.log` |

原始日志保存在 `/home/oyasmi/.pipiclaw/workspace/desk-default/subagent-artifacts/run_q868en/w2-validation.r7egJQ/`，其中 `manifest.json` 列出文件和 SHA-256；中间失败也保留。

已完成只读 `npm run eval -- plan --changed-since 0a0719817c15380c0cccb1794c2f812e24b903aa`：选出 12 cases / 12 families（包含 T-run、T-job、D-merge 等）。本轮禁止读取真实凭据/调用模型，因此没有 paid dev probes/run id，不构成行为质量通过；没有修改 evals。

首轮 unit 的两处失败来自 HTTP 成功 fixture 仍返回空 body，已改为官方协议样本并补负面样本。首轮 e2e 的四个失败分别涉及 waiting-only 输出策略、旧 finalizeCard 等待条件、task report 文本分类夹具、800ms final 节流导致的 task 自动调度竞态；已分别修正策略断言、结构化 metadata 夹具和 final 调度，没有缩减用例。另一次 check 被 formatter 拒绝，已改写对应链式表达式；整理文件注释时的语法错误也已修复。早期 arch 也曾因 jobs/manager.ts 增长失败，已抽出本域 types.ts，未增加 baseline 例外。已收集日志按原样留存，早期仅工具输出的错误保留在会话记录；不将失败计为通过。


## 关键证据入口

- owner/端口：`src/channel/delivery-scope.ts:6`。
- writer/final gate、task outbox 适配、持久 final：`src/runtime/delivery-scopes.ts:131`、`:157`、`:208`、`:245`。
- 独立卡片 key、恢复/无模板 fallback：`src/dingtalk/scope-delivery.ts:14`、`:47`。
- finish 拒绝不能确认 durable wake：`test/turn-run.test.ts:182`。
- 双 scope 的真实离线 HTTP 请求：`test/dingtalk-delivery.test.ts:747`。
- 混合 run/job 闭环：`test/e2e/deterministic/job-chain.test.ts:16`；三份 task report + 唯一 final：`test/e2e/deterministic/tasks.test.ts:59`。
- 真实进程崩溃后保持同一 final：`test/e2e/deterministic/task-close-recovery.test.ts:104`。

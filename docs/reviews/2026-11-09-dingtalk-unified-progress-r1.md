# 统一进度 W2：第一次 review 返工

这是对主控提出的五项阻断的定向修复。保留原工作树，未提交、推送、部署、启停个人 daemon 或读取个人凭据/运行数据；所有出站验证均使用离线 fake / scripted provider。前一份 W2 实现说明是历史记录，不能作为本轮 review 已通过的结论。

## 修复与证据

| 阻断 | 最终控制流 | 证据入口 |
| --- | --- | --- |
| R1 首次 final 保存失败 | `commit` 先原子写盘，再替换内存字段。消费 completion 与保留 final 是一次提交；失败时二者均不提交。重复 finish 返回同一拒绝，retry 不读取未持久化 final；wake 保留用于重放。attempt/confirmation、task report 及 receipt 也使用相同提交纪律 | `src/runtime/delivery-scopes.ts` 的 `commit`、`openTurn`、`finish`、`publishFinal`；`test/delivery-scopes.test.ts` 的 first final-intent save 场景 |
| R2 poll 内联消费 | job 终态记录带 `completionMode: inline|wake`，在原有 record 落盘中保存。`jobScopeWork` 对 inline 结果不产生 completionId；已经实际产生 wake 的结果保持 wake 语义。notify=false 仍不阻挡 scope final | `src/jobs/manager.ts` 的 `finish`，`src/jobs/completion-wake.ts` 的 `jobScopeWork`；既有 suppressed-jobs unit 增加落盘/restore 断言 |
| R3 失败 primary | 对 scoped wake，runner throw、stopReason=error/aborted、stop 或输出结算失败均保留 primary 为 retryable，与未消费输入一致。无 owner 的旧 /stop 行为保留。失败 scope 本身也不标 closed，从而允许重放 | `src/runtime/turn-run.ts` 的 `retryPrimary`；新 mechanism 的 failed-wake 场景、unit 的 error stopReason 场景 |
| R4 换绑 race | runtime 注入动态 owner/binding/reachability guard。adapter 一旦观察到撤销，就永久停用该 writer；controller 在 flush/final 前重查；CardController 在内部写队列及 token await 后重查，plain API 在 token await 后、POST 前重查 | `src/dingtalk/scope-delivery.ts` 的 `canWrite`，`src/dingtalk/cards.ts` 的 `streamCardRequest`，`src/dingtalk/api.ts` 的 token 后 guard |
| R5 CREATE 未确认后永久等待 | 不重试一个可能已成功的 CREATE，不换 outTrackId 猜测重建。第一次 report 保持 unknown；检测到本 generation 的 CREATE 未确认后记明降级告警，下一次原 durable report 重试走实际 plain SEND。只有真实协议确认才返回 confirmed 并打开原 report_delivered gate | `src/dingtalk/cards.ts` 的 `hasUnconfirmedCreation`；`src/dingtalk/scope-delivery.ts` 的 fallback；stateful HTTP fake 的 ambiguous CREATE 场景 |

没有增加 runtime → DingTalk import，没有下沉 DingTalk 类型，没有修改 task close gate、模型 schema、business outcome 或 SubAgentRunManager 的结算所有权。jobs manager 的只读 scope-work 映射移到本域 completion-wake 文件，已登记超长文件继续缩小；architecture baseline 原样保留。

## 复现、测试 admission 与 mutation

- 初次红测见 `reproduce-unit.log`：R1 磁盘已消费 completion、R2 inline job 多出 phantom completionId、R3 primary 被 markCompleted、R4 多出 PUT 都有直接断言失败。R5 初次夹具缺少一次 fake-clock 推进而超时；修正该夹具调度后，移除 fallback 的 mutation 明确得到 `unknown`，与要求的 `confirmed` 相反，不再依赖超时判断。
- 新增 unit **+4**（1021 → 1025）：首次 final-save 的内存/磁盘一致性与重复 finish；failed primary 的 error stopReason；换绑后的 paced/内部队列/token 等待窗口；未知 CREATE 的可确认降级。旧场景没有覆盖这些跨 turn、磁盘提交及 HTTP 前授权窗口。原 job suppression 场景扩展，case 数不增加，保留 notify=false、cancel、inline poll，并验证 mode 落盘和恢复。
- 新增 deterministic e2e **+3**（71 → 74），在 `test/e2e/deterministic/scope-recovery.test.ts`：真实 job 产生 wake 后首次 final 保存失败，经 runtime 重新初始化再重放；首个 primary 失败、后续 sibling 合法合并两份输入后唯一 final；模型工具 poll 内联消费真实 job 后 final，不产生 phantom wake。此处 runtime restart 仅证明优雅重新初始化；原独立 daemon SIGKILL 套件保留并随全量运行。
- 新并发窗口使用 held command、provider hold/arrived/release、持久 settlement 完成事件和 exit-file 原子发布的原生文件事件。poll 场景只关闭自动 completion observer 以保证 poll 拥有消费权，真实 producer、poll、runtime、scope、disk 和 delivery 均保留；未使用 sleep 或放大 timeout。
- 机制夹具曾假设 sibling 只能消费自身；真实 coalescer 会吸收同 owner 的失败 primary。保留该失败输出 `mechanism-first.log`，改为严格断言成功请求包含两份结果、两份 consumption 和唯一 final，没有改生产 coalescer，也没有删除最终性断言。

五项 mutation 均 exit 1，随后恢复源码；`mutation-r*.log` 保留完整输出：

| mutation | 失败证据 |
| --- | --- |
| R1 把内存赋值放到写盘前 | 首次提交失败后仍从内存推进了 SEND；按回滚/交由 durable wake 重放的约定，重放前不应 SEND |
| R2 inline 仍带 completionId | poll 完成的 scope 没有 final |
| R3 删除 failed-primary 的 retry 条件 | producer wake 文件被删除 |
| R4 删除 CardController 内部队列的实际写入 guard | 换绑后的 queued write 返回 true / 执行 HTTP |
| R5 删除 unknown CREATE 的 fallback 切换 | 报告 retry 仍 unknown，无法确认 |

定向 mutation 的 `-t` 会显示未选用例 skipped；它们不是完整 gate。完整 gate 不筛选或跳过原有用例。

## 验证结果

最终全量均通过。执行位置明确为 `/home/oyasmi/projects/pipiclaw`：

- `cd /home/oyasmi/projects/pipiclaw && npm run check`：exit 0；lint、typecheck、arch、deadcode 全过，146 文件 / **1025 unit** 全过。日志 `check-final.log`。
- `cd /home/oyasmi/projects/pipiclaw && npm run test:e2e`：exit 0；先构建当前 daemon，29 文件 / **74 e2e** 全过。日志 `e2e-final.log`。
- 单独 typecheck 与定向 unit / mechanism 结果、中间错误输出、mutation 全部保存在 `/home/oyasmi/.pipiclaw/workspace/desk-default/subagent-artifacts/run_crfe8j/`。

## 保留边界

- 无法撤回换绑前已经提交的 HTTP。guard 保证撤销后尚未发出的请求不再发出；已经撤销的旧 writer 不会因换回 desk 自动复活。其未确认 outbox 保留，恢复按既有 epoch / plain fallback 处理。
- CREATE unknown 后可能有一张远端状态未知的等待卡。降级不新建第二张卡，也不把本地 enqueue 算确认；报告与 final 仍须真实 SEND 确认。
- 远端成功、本地确认前崩溃仍是 at-least-once。跨重启续卡、真实平台多卡/寿命/查回及容量回收仍未实现或验证；没有真实钉钉或真实模型行为质量通过的结论。

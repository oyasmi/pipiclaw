# 统一进度：合入前收口（R2）

在 W2 / R1 之后，针对主控 review 的阻断与 P1 项做的最小收口。目标是降低长尾复杂度，而不是再堆状态机。

## 变更摘要

| 项 | 做法（刻意保持简单） |
| --- | --- |
| CREATE/close 终态 | 明确 4xx（除 429）立即放弃句柄；unknown 终止重试上限 5；不再依赖不存在的 `hasUnconfirmedCreation` |
| final 重试终态 | `attempts >= 8` 后用 `nextAttemptAt = MAX_SAFE_INTEGER` 停掉，不新增 abandoned 枚举 |
| Web API 隔离 | 仅 `transport.scopes` 存在时分配 / 生效 scope；`retryPrimary` 同样受能力门约束 |
| `/stop` | 消费当前 completion ids 并收口进度；不再 `markRetryable` |
| 取消/失败文案 | close 可带 summary；scope writer **懒建卡**，idle cancel 不再 CREATE |
| `retry()` | 单 key try/catch，一个 scope 故障不阻断整轮 |
| suppress / exhausted | suppress 将 `completionMode` 置 `inline`；exhausted 调 `acknowledge` |
| report 归档 | scoped report 成功后走既有 archive，失败只记日志 |
| holdConnection | `Transport.hold()` 单点；scoped 与 openTurn 共用，去掉 transport 内双包一层 |

## 明确不在本轮

- scope / card 的容量 GC 与跨重启续卡（仍属 W4）
- 真实钉钉冒烟（部署前）
- 新增 formal spec 068（行为已写入 `AGENTS.md` Runtime Model 与 `docs/architecture.md`）

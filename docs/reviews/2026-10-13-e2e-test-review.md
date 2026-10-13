# 确定性 e2e 价值审计

日期：2026-10-13。审计基线：`83b593d`，spec 054 分层优化后的 `test/e2e/deterministic/` 全部 24 个文件、55 个用例。只审计机制层；真实模型的表达质量仍属于 evals/live。

## 数量与取舍

删除 `pilot.test.ts` 的两个用例：首次 `/help` 已由 commands A1 覆盖；普通问答的 provider、delivery、持久化链路已由并发、progress、restart 等更具体的场景覆盖。新增两个独立缺口：跨频道并行/历史隔离，忙碌 `/new` 丢弃旧队列并跨重启维持新会话。最终 **23 个文件、55 个用例，净增 0**。没有合并无关故障、跳过用例或缩小测试发现范围。

测试数量不是唯一成本。本次为真实 daemon 崩溃增加一个很小的 IPC 进程 fixture，替换旧的弱恢复测试；不为该 fixture 再添加单测。其收益是删除旧进程的所有回调和缓存，真正检查启动恢复，而不是在一个进程里重新创建对象。

## 全部 55 个原用例的审查结论

以下文件名均在 `test/e2e/deterministic/` 下。数量为清理前的实际用例数；同组列出保留或改进理由。

| 文件 | 原数量 | 结论与保护的故障 |
| --- | ---: | --- |
| `pilot.test.ts` | 2 | 删除重复的 help/普通问答 smoke；用更明确的隔离、忙碌重置故障替换。 |
| `commands.test.ts` | 3 | 保留首次 SDK session 未就绪、报告命令零模型与事件删除落盘、未知命令和技能路由分流。去掉中文失败文案断言；首次 help 检查可操作命令标识。 |
| `concurrency.test.ts` | 2 | 保留同频道串行顺序、连续空闲 `/new` 的会话边界；挂起请求改为 arrival 信号。增加两个不同缺口，详见上文。 |
| `stop.test.ts` | 1 | 重写关键断言：provider 仍挂起时必须恢复空闲，正常回答不得送达，随后可进入新一轮。原来立即 release，正常完成也可能假装成功停止。 |
| `interrupt.test.ts` | 1 | 保留真实忙碌 `/steer` 与 `/followup` 分流，改用 arrival 信号。脚本回复只作为消息传递标记，不判断模型回答质量。 |
| `progress.test.ts` | 2 | 保留完成/错误后的 card 最终化和迟到回调护栏；已有请求/工具 barrier，断言 delivery 方法和顺序。 |
| `restart.test.ts` | 2 | 保留 session header/parentId 跨初始化延续。密钥用例增加 reflect provider 输入脱敏断言，drain 真正维护队列后再检查磁盘。原来只等 provider 收到请求便查磁盘，而且存储层拒绝会掩盖请求泄漏。普通 restart 明确只证明同进程的优雅重新初始化。 |
| `external-run.test.ts` | 1 | 用独立 daemon、真实挂起的 detached exec、SIGKILL 和新 daemon 替换瞬间结束的 echo。新进程在接纳 `/stop` 前必须能按 run id 查到仍运行的记录，pid 不变、进程存活；`/stop` 不得取消已派发工作。删除“任意终态都算通过”的断言；本用例明确保护接管，不声称验证完成结算。 |
| `tasks.test.ts` | 6 | 保留创建/关闭、过期票恢复与工具集、任务绑定委派日志、任务忙碌时聊天不被误 steer。命令扩展用例从展示 `/model` 改成真实切换并检查下一次 provider 的 model。事件实例用例替换直接调用 spawner/空 nudge/捕获 notify，走真实 watcher → spawner → driver → task session，检查运行中/归档后的重放、重叠实例通知、归档和前序结束后的下一次实例。用历史日期与保留的旧 mtime 发布 overdue 定义，避免未来日期触发真实等待。 |
| `wake-auth.test.ts` | 2 | 保留伪造文字不能兑票、真实委派结算必须进入任务 session。去掉普通回复文案检查；使用 child/step arrival 和 delivery 信号，等待闲置后检查旧 work 票已替换为 ask 票。原来的 parked 状态在操作前就成立，不能单独证明 completion 已完成。 |
| `wake-coalescing.test.ts` | 1 | 保留三个真实 detached run 结算后的聚合唤醒与每个 run id 的覆盖；结算状态属于异步真实持久化，保留最终状态等待。 |
| `wake-coalescing-failures.test.ts` | 9 | 全部保留：claim 失败、异步 admission/文件失败、stop、迟到 teardown、cancel/reset 等窗口会导致唤醒丢失或重复；已有可控 fault barrier、磁盘 outbox 和重放断言。不能因复杂或较慢删除。 |
| `subagent-chain.test.ts` | 1 | 保留真实内部子代理结果返回及写 lease 释放后第二次委派能够运行，防止链路只派发一次或永久占锁。 |
| `subagent-fallback-cancel.test.ts` | 2 | 保留 fallback 认证等待期间取消/切换中的 lease 与第二次委派隔离；已有受控认证 barrier。 |
| `subagent-toolset.test.ts` | 1 | 保留对子代理实际 provider 请求的工具名单检查；名单单测无法发现 session 装配把主代理工具给了子代理。 |
| `job-chain.test.ts` | 1 | 保留真实后台 shell 作业经 runtime 唤醒并携带输出；provider arrival 替换按脚本回复文本等待。 |
| `guards.test.ts` | 2 | 保留路径拒绝、审计、用户/模型拒绝隔离，以及忙碌期间禁止切项目。成功 `/project set` 检查持久化选择与实际写入，删除中文确认文案检查。 |
| `command-web-guards.test.ts` | 2 | 保留实际 bash/web 守卫接线、命令注入与审计副作用；真实工具安全边界不能靠 unit mock 替代。 |
| `events-guard.test.ts` | 1 | 保留真实 event tool 的自触发拒绝不落盘、SDK 把可恢复拒绝返回模型。改查持久化 toolResult 的 recoverable/kind/isError，以及 provider 的 tool 消息，不锁定拒绝文案。 |
| `inbound-media.test.ts` | 4 | 保留支持/不支持 vision、声明超限、busy steer 附件路径。改用 arrival，通知检查用户能定位的 path，删除中文措辞断言；超限用例只声称检查声明的大小门槛，不声称证明文件绝未读取。 |
| `memory.test.ts` | 6 | 保留日记搜索、首次 bootstrap、任务/聊天独立 bootstrap、空窗 cursor、用户事实不可被 reflect 删除、probation touch；都约束真实工具、持久化或下一轮 provider 输入。 |
| `fallback.test.ts` | 1 | 保留 429 主模型到备用模型的实际请求迁移与答复传递；不是单独复述 shouldFallback 分支。 |
| `system-prompt.test.ts` | 1 | 保留 SDK 实际 provider 请求的 prompt ownership、boundary 顺序、频道信息隔离；这是装配契约，不能由复制 prompt helper 的单测替代。 |
| `tui-command.test.ts` | 1 | 保留第二 transport 的 `--print` 路由，改为删除真实事件文件并检查零模型。非空 stdout 不足以区分成功与错误回复。 |
| **合计** | **55** | 删除 2 个重复场景，新增 2 个独立风险，其余按价值保留或增强。 |

## Fixture 和后续准入

- Mock `hold` 增加 `arrived` 信号及仅在等待 arrival 时启用的有界 watchdog；并发窗口通过请求到达控制，不能用轮询推测它已挂起。
- Delivery 用捕获时的信号唤醒等待者，保留超时诊断；真实文件/结算最终状态仍可按有界条件等待。
- Deterministic fixture 整个生命周期保持 `PI_OFFLINE=1`，覆盖 lazily created SDK registry 和 shutdown reflect，再恢复宿主设置。只在 boot 时设置不足以覆盖 session 后续 refresh；live fixture 不受影响。
- Unmatched-provider 检查移入 shutdown，包含末次 reflect 的调用，并通过 finally 保证资源清理；避免先抛断言导致 cleanup 根本未运行。
- `npm run test:e2e` 先 build，独立 daemon fixture 从当前 dist 运行，防止用旧构建验证新源码。
- 确定性命令使用最多两个隔离的 Vitest fork worker 并行跑文件，文件内仍按 maxConcurrency=1 串行。每个 fixture 有独立临时 home/端口；不改 live/external 命令的串行配置，不放宽超时。这样减少文件启动的总等待，不依赖删掉有效机制测试来换速度。
- 根 AGENTS.md / CLAUDE.md 已补充 e2e 默认不净增、跨模块缺口证明、真实生产者接线、进程重启与对象重建的区分、等待完成再断言等规则。

机器协议、实际操作 id/path、provider 请求参数、测试独有的 payload marker 可以精确断言；普通帮助、状态、确认和错误措辞不再逐条锁定。没有因 unit 层已经覆盖某个分支，就删除仍能检查 SDK/runtime 接线的 e2e；也没有把 unit 的边界矩阵一份份复制进 e2e。

## 故障注入与验证

已逐一临时破坏目标实现、运行对应场景、确认变红并恢复：

| 目标 | 注入的故障 | 失败证据 |
| --- | --- | --- |
| 跨频道隔离 | bot 的 queue map 使用共享键 | 被挂起的 A 阻塞 B，peer arrival watchdog 失败。 |
| 忙碌 `/new` | resetChannelQueue 返回 0，保留旧队列 | `STALE_QUEUED` 仍进入模型，新用例失败。 |
| 密钥反思 | redactSecrets 直接返回原文本 | 反思请求包含原始密钥，provider 输入断言失败。 |
| `/stop` | 不调用 runner.abort | provider 仍挂起，频道 idle 等待超时。 |
| 事件任务装配 | bootstrap 不传 spawnTask | 没有 task step 到达 provider，arrival watchdog 失败。 |
| 真进程接管 | 编译后的 bootstrap 跳过 runs.restore | 新 daemon 的 run lookup 为 null。此用例跑 dist，因此该 mutation 直接作用于 dist；已恢复，最终验证会重新 build。 |
| TUI 命令副作用 | router 返回非空文本但不执行 events handler | stdout 非空仍然成立，事件文件却未删除；磁盘断言失败。 |
| 任务后切换模型 | model 命令保留成功确认，但不调用 switchModel | 下一轮 provider 的 model 仍为 mock-main，期望 mock-fallback 失败。 |
| 真实完成唤醒 | completion-wake 不携带 internalWake | 不能验证/兑票，任务 step arrival watchdog 失败。 |

最终验证通过：

- `npm run check`：lint、typecheck、architecture、deadcode 全部通过；134 个单元/集成文件、952 个用例通过，Vitest 用时 77.64 秒。
- 最后一次修改事件用例后重新运行 `npm run typecheck`，通过。
- `npm run test:e2e`：先 build 当前 daemon 代码，通过；两个隔离 worker 下 23 个文件、55 个确定性用例全部通过，Vitest 用时 **77.13 秒**（不含预构建）。
- 上述九项 mutation 均捕获目标错误，临时变更全部恢复；生产 `src/` 没有差异。

首轮全量发现新事件断言误用了历史记录的 `filename` 字段；改为实际的 `eventName`，并引用 `EventHistoryRecord` 类型后，定向和最终全量均通过。历史记录断言检查 action/result 的计数，不锁定 reason 文案。

运行时间只报告本机单次观察值，不以删两个用例推断成比例加速；之前 check/e2e 并行时的 201 秒不是公平的独立运行基线。本次确定的收益是去掉重复场景、补齐机制缺口、减少 provider/delivery 轮询，并把默认确定性运行控制在两个 worker。

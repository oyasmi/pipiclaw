# 2026-11-08：命令判定、记忆替换与持久化隔离修复

基线为 `9f17fc7ccf3133678c9b819f78b15f4e5185519e`，开始时工作树干净。修改只保留在工作树；没有提交、推送、部署、操作真实 daemon 或真实运行数据。测试中的模型、钉钉投递、外部执行器均使用离线桩或临时夹具。

## 机制与改动文件

| 范围 | 文件 | 保证及边界 |
| --- | --- | --- |
| command guard | `src/security/command-guard.ts`、新增 `src/security/shell-parse.ts` | 一次词法解析定位执行位置，处理引号、逐行注释、管道、连接符、后台 `&`、子 shell、替换、赋值及重定向；保留已知 wrapper/find 的参数边界。未知语法、动态执行名、无法判定的参数和递归超预算均拒绝；不会把普通字符串当作可执行命令。原有实际 `find -exec rm` 拒绝策略保留。不是任意程序内部行为的沙箱。 |
| memory | `src/memory/store.ts`、`src/memory/reflect.ts` | 每个成功 add/update 或精确重复 add 都返回实际存活身份及内容。写入完成后确认这些事实仍存在；删除阶段保护实际 replacement 身份，而非模型请求的文件名。失败不进入删除阶段；重复原件被保留，成功合并可删除旧件。仍存活的相同描述不写删除 tombstone。运行时沿用已有每工位记忆队列，不新增迁移或存储格式。 |
| task delivery | `src/tasks/delivery.ts` | 单条损坏/读写故障留在原位并记录路径、类别及 I/O code。通过独立任务日志识别坏记录所属任务；只阻断该任务，其他任务继续，新报告仍可入队。日志推导的序号上界避免忽略坏文件后新报告排到它之前。所属任务完全无法确认时保守暂停整个投递队列，入队仍可用，修复后重试；绝不猜测跳过未知前置。严格读取接口仍明确报告坏记录。 |
| durable wake | `src/runtime/durable-dispatch.ts` | 仅 ENOENT 表示不存在；坏 JSON、结构错误、非规范文件名及 I/O 故障保留证据并诊断。直接访问失败会抛错，不会误报 accepted 或覆盖坏记录；扫描逐条隔离，健康记录继续；完成时 unlink 的真实错误不再吞掉。stop 关闭后台 admission，flush 等待已经开始的写入。保留原有 at-least-once 与 lease 恢复语义。 |
| stop | `src/agent/types.ts`、`src/agent/turn/turn-state.ts`、`src/agent/stop-watchdog.ts`、`src/runtime/ingress-deps.ts`、`src/runtime/ingress-busy.ts`、`src/runtime/ingress.ts`、`src/runtime/bootstrap.ts` | generation 标识回合；登记属于 channel、runner、generation 和该次登记对象。A→B 后能登记 B；A 的迟到 finally 只清理自己的登记，容量通知只看当前 generation。shutdown 后 watchdog 不再恢复或推送。 |
| shutdown | `src/runtime/shutdown.ts`、`src/runtime/task-lane.ts` | 关机各等待阶段受 90 秒总预算约束，abort 与回合共享 5 秒终止窗口，永不完成的 abort 不阻止退出。忙 runner 退役；已开始的 outbox 写入也要收束；task runner dispose 加入 `activeTasks`，释放锁前重新检查后来开始的清理。无法确认写入静止时保留 daemon 锁直到进程退出，防止新旧写入者并存；嵌入式调用者需退出该进程后才能重新打开同一 home。 |
| 文档 | `docs/deployment-and-operations.md`、`docs/desk-migration.md`、`docs/security.md`、本记录 | 补 `state/webapi/` 选择性备份及可重建 socket；区分旧 `tui` 语义与当前 `webapi:conv_<id>`；说明 guard 的有界语法与拒绝边界。 |

没有修改 jobs/subagents 的实现，没有增加架构例外、兼容读取器、迁移器或发布机制。

## 测试准入与数量

unit 净增 **4** 个，deterministic e2e 净增 **1** 个。其余优先扩展现有场景，没有提高 timeout、删除或削弱断言。原 find fixture 的 `;` 改为 shell 实际需要的 `\;`，继续要求危险命令被拒绝；generation 的既有精确断言同步新身份字段。

| 文件 | 数量变化 | 必须新增或扩展的风险 |
| --- | --- | --- |
| `test/security-command-guard.test.ts` | 0 | 扩展现有正反例：跨行注释、后台、引号、嵌套、重定向、wrapper/find 及 fail-closed；只调用 guard，不执行危险命令。 |
| `test/memory-reflect.test.ts` | 0 | 重复原件、复用另一个目标、新建/更新合并、失败及重试；验证事实与 tombstone，证明没有禁掉全部删除。 |
| `test/task-delivery.test.ts` | +1 | 原两例只覆盖网络失败和投递确认；不能发现坏 JSON/结构/EIO/EACCES 对其他任务的污染，或忽略坏前置导致越序。 |
| `test/durable-dispatch.test.ts` | +1 | 原有写错误场景不能发现读错误被当不存在、坏记录覆盖、静默 unlink 失败，以及健康记录恢复；新场景也验证 stop/flush 的在途写入。 |
| 新增 `test/runtime-stop.test.ts` | +1 | agent watchdog 单测不拥有 runtime 的登记表，无法发现跨 runner 登记/清理竞争。 |
| 新增 `test/runtime-shutdown.test.ts` | +1 | 既有 runtime context 测试只覆盖正常关机；用受控时钟与故障 Promise 验证永久 abort、写入未收束和迟到错误回调。 |
| `test/turn-state.test.ts`、`test/helpers/fake-turn-state.ts` | 0 | 既有状态场景确认 generation 递增；fake 同步真实接口变化。 |
| `test/task-lane.test.ts` | 0 | 以受控 dispose 屏障替换原有 sleep，验证 task step 结束后的清理仍登记为活动写入。 |
| `test/e2e/deterministic/stop.test.ts` | 0 | 扩展真实 transport→ingress→runner 链，持有 A 的通知与 B 的 provider，确认旧清理不影响 B 的 stop 恢复。 |
| 新增 `test/e2e/deterministic/shutdown.test.ts`、`test/support/daemon-worker.mjs` | +1 | 既有同进程 stop 测试不能证明真实 SIGTERM 退出与 PID 锁回收。故障只注入隔离 worker；用进程 exit、锁文件和新进程启动断言，不用直接域调用冒充进程证据。 |

## 失败证据与 mutation

原始输出保存在本机隔离目录 `/tmp/pipiclaw-repair-evidence/`，并非产品运行数据；该目录可能被系统临时文件清理移除。

- `before.log`：修复前扩展现有 guard/memory 用例，20 个中 2 个失败；分别是注释后下一行危险命令被放行、duplicate replacement 后原件被删除。
- `wake-status-before.log`：复核新增校验时发现 `String(status)` 将 `["pending"]` 错认成状态字符串；扩展同一结构损坏场景后确认返回 true 的失败，再收紧为严格字符串校验。
- `memory-identity-mutation.log`：去掉身份保护后 conflict 模式删除原件，断言失败。
- `delivery-fifo-mutation.log`：去掉坏前置 fence，后置报告提前发送，断言失败。
- `wake-corrupt-mutation.log`：把损坏当缺失，dispatch 返回 true 而非拒绝，断言失败。
- `watchdog-owner-mutation.log`、`watchdog-cleanup-mutation.log`：只按 channel 去重、无条件旧清理，各自导致登记归属断言失败。
- `shutdown-process-mutation.log`：恢复无限等待 abort，隔离子进程未在 30 秒验证窗口退出；测试失败，finally 用 SIGKILL 清理。
- `stop-e2e-mutation.log`：旧 watchdog 无条件清理后 B 无法恢复；用比常规配置更短的 12 秒 deadline 验证失败，未提高 suite timeout。
- `task-disposal-mutation.log`、`shutdown-late-disposal-mutation.log`：删除 task dispose 活动登记或释放锁前的二次检查，分别让活动写入断言或锁保留断言失败。
- 以上 mutation 均已恢复，`mutations.json` 记录前五项实际 exit=1。新增及扩展 e2e 的注释记录了对应 mutation。

实施中还遇到测试故障注入的 ESM namespace 不可 spy、编写新代码时的 TS nullable/测试 API 错误，以及完整 unit 首轮的 3 个失败（循环支持缺口、修改期间的 find 判定不一致、generation 新字段的旧预期）。这些都已保留在临时日志并逐项修正；没有将它们归为既有失败，没有删断言制造通过。最终结论以以下复验为准。

## 实际验证

| 命令 | 实际结果 | 原始输出 |
| --- | --- | --- |
| `git status --short`、`git rev-parse HEAD`（修改前） | 工作树为空，HEAD 与预期一致 | 首次命令输出 |
| `npm run typecheck`、`npm run arch` | 已执行；最终也由 check 完整重跑并通过，架构基线未增长 | `typecheck-final.log`、最终 check 日志 |
| `npm run check` | exit=0；lint、typecheck、arch、deadcode、test 均通过；144 个 unit 文件、1014 个用例全绿，无跳过（66.73 秒） | `check-verified.log` |
| `npm run lint`（最终注释格式复核） | exit=0；595 个文件检查通过，无修改 | `lint-verified.log` |
| `npm run test:e2e`（含 pretest build） | exit=0；build 通过，28 个 deterministic e2e 文件、71 个用例全绿，无跳过（101.45 秒） | `e2e-verified.log` |
| 核心 mutation | 9 项分别确认变红，均已恢复 | 上述 mutation 日志 |
| `git diff --check` | exit=0；最终复核无空白错误 | 命令输出 |

最终两套门禁包含 task dispose 登记、最终锁检查和严格 status 校验。`npm run test` 由 check 实际执行；`npm run build` 由 e2e 的 pretest 实际执行，二者均通过。架构结果为 0 条 R1、0 个 R2 循环、3 个既有 R3 超长文件，未增加例外。修改文件共 31 个（26 个已跟踪文件、5 个新增文件）；源码与测试预算均由门禁核验，`src/runtime/task-lane.ts` 为 786 行，`test/task-lane.test.ts` 为 800 行。

未运行付费 eval、live DingTalk、真实外部 CLI 或真实业务调用。无真实数据、真实 daemon 或部署环境验证；对任意第三方程序的内部语义、所有 shell 方言和所有硬件 I/O 故障不作完备保证。JSON/结构、EIO/EACCES 和可控等待/进程退出的保证以已列出的离线用例为限。

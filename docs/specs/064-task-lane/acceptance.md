# 064 验收记录

以下保留初次实施验收。审查后的修复、进程崩溃验证和行为评测证据见[审查修复记录](../../reviews/2026-10-29-spec-064-task-lane-fixes.md)。迁移演练与真实部署仍未执行。

对应 [实施计划 R3](./plan.md#r3-验收清单)。日期 2026-10-29，分支 `feat/task-lane`。**R4（真实部署上线）未执行**，需要用户在场批准后按 [任务迁移说明](../../task-migration.md) 进行。

## 门禁

| 项 | 结果 |
|---|---|
| `npm run check`（lint + typecheck + arch + deadcode + test） | 全部通过；单测 143 个文件、974 个用例（基线 145 个文件、975 个用例）；arch：基线剩余 0 条 R1、0 个 R2 循环、3 个 R3 超长文件（均为基线内既有） |
| `npm run test:e2e` | 26 个文件、68 个用例通过（先 build） |
| `npm run test:evals` | 5 个文件、69 个用例通过 |
| `npm run build && node dist/main.js --version` | 构建通过，输出 `0.9.5-beta.3` |
| `npm run playbooks:measure` | task-lead 2,689 units（基线 2,102）、agent-delegation 2,390（基线 2,277），合计 5,079（基线 4,379；审查目标 4,500，见设计 §20 偏差 6） |

## 不变量与删除清单

| 项 | 证据 |
|---|---|
| INV-1 响应 | `test/e2e/deterministic/tasks.test.ts` T-lane-1：步骤在 mock provider 上被 hold 时，同频道聊天消息完成一个回合并投递，任务步骤仍被 hold。变异：`createTaskRunner` 返回频道自己的 runner → 用例变红（任务工具集断言失败） |
| INV-2 状态归属 | `rg "fields\.(state|waiting|paused)\s*=|writeStoredTask|updateStoredTask" src/tools src/agent` 无命中（工具只读状态，唯一的引用是聊天 `task_close complete` 对 `running` 的判断）；`test/task-manage.test.ts` 的「registry」用例：聊天与任务会话各自的工具集，且没有 `task_update` / `task_step_end` |
| INV-3 形状 | `test/task-frontmatter.test.ts`「keeps `waiting` / `paused` in lockstep…」 |
| INV-4 存活 / 唤醒 | `test/task-state.test.ts`「what wakes a waiting task」「restart reconciliation」；`test/task-lane.test.ts`「results and messages wake the task」 |
| INV-5 并发 | `test/task-lane.test.ts`「runs at most three tasks per desk and five in all…」「keeps a slot while it waits for results」「gives its slot back…」 |
| INV-6 不丢输入 | `test/task-log.test.ts`「new input (INV-6)」；`test/task-store.test.ts`「begins by writing state and the step record together…」；T-lane-3（消息只送达一次） |
| INV-7 冻结 | `test/task-lane.test.ts`「a task whose report channel cannot be reached」；`test/e2e/deterministic/desks.test.ts` DESK-3（改写后：换绑离开后不开步骤，绑回后继续；变异：去掉车道的冻结判断） |
| INV-8 绑定 | `test/bash.test.ts`、`test/subagent-phase1.test.ts`（工具无 `taskId` 参数，只有会话绑定）；`rg "taskId" src/tools/bash.ts src/tools/subagent.ts` 只剩 `boundTaskId` |
| INV-9 日志 | 运行时只经 `appendTaskLog` 追加；`rg "writeFile" src/tasks/loop-log.ts` 无改写路径 |
| §17 删除清单 | `rg -w` 对 `ticket`、`redeemTicket`、`resolveTicket`、`expireTicket`、`task_step_end`、`task_update`、`internalWake`、`claimVerifiedWake`、`beginWakeConsumption`、`wakeClaim`、`bindTaskSession`、`getTaskLoop`、`TASK_DRIVER`、`parseDriverTaskId`、`queueTaskSteer`、`consumeTaskSteer`、`TaskDriver`、`requestScoped` 在 `src/` 中均为零引用（`src/config/settings.ts` 的 `taskDriver.*` 是保留的退役设置告警；`src/webapi` 的 `requestScoped` 是另一个概念） |
| 变异检查（e2e） | T-lane-1（见上）；T-lane-2：去掉作业运行时的 `onTaskInput` → 归档等待超时；T-lane-3：`LaneControl.message` 不再注入 → 「MSG_MARK」断言失败；T-lane-4：去掉事件监视器的 `spawnTask` → 保持的步骤从未到达 |

## playbook 自审（P5）

- [x] 每份手册先说明适用环境，再给合法操作和恢复分支
- [x] 「只剩等待时结束回合」在 `task-lead.md` 定义，`agent-delegation.md` / `background-jobs.md` 只留一句并指向它
- [x] 聊天侧的管理动作（查看、转达、暂停、取消）写清何时用哪个工具，以及「不替任务做它的工作」
- [x] 卡顿处理有判断条件（正常安静 vs 卡死）和可执行的下一步
- [x] JSON / frontmatter 样例与序列化代码一致（`renderTaskFrontmatter`）
- [x] 没有描述旧机制的句子（`rg "task_step_end|ticket|park|task_update|steer|reply|TASK_DRIVER|taskId|driver" src/playbooks` 为零）

## 评测（P6）

`npm run test:evals` 通过（离线控制样例、harness 与证据检查）。**未运行真实模型的 dev 用例**（本环境没有凭据）；因此「行为质量」没有评测证据，不当作通过。上线前建议用 `npm run eval -- plan --changed-since master` 规划后运行相关 dev 用例。

## 迁移演练（R2）

`docs/task-migration.md` 已按设计 D34 写成。**演练未执行**：需要用 master 的构建造出旧格式数据（`open` / `parked`×3 / `paused`、`.steer/`、`TASK_DRIVER` 与 `internalWake` 的 dispatch 记录、已归档任务）并在副本上转换后用新版本启动内嵌运行时验证，留待上线前由用户在场进行。

## 用例数

| 层 | before | after | 说明 |
|---|---|---|---|
| 单测（vitest 实际） | 975 | 974 | 见设计 §20 的逐项说明 |
| deterministic e2e（文件内 `it`） | 69 | 64 | 删除 `wake-auth`（2）、A13 / A13b / A14 / A17 / A18 / A19（6）、`M1b`（1），新增 T-lane-1…4（4） |

## 未验证的部分

- 真实模型下的行为质量（评测未运行）与真实钉钉部署（R4）。
- 压缩后全量 brief 是否如期恢复：`contextIncludes` 的判断与记忆 bootstrap 同源，但没有用真实压缩单独验证。
- 迁移演练（R2.2）与独立进程崩溃的 e2e（偏差 7）。


## 审查修复后验证（2026-10-29）

审查的 10 项发现均已核实并处理，R4 采取有限宽限、退休与暂停的安全收敛，不承诺任意工具副作用的物理强杀。具体机制、空间取舍和首轮失败归因见[审查修复记录](../../reviews/2026-10-29-spec-064-task-lane-fixes.md)。

- `npm run check`：974 个单测通过，架构无新增例外。
- `npm run test:e2e`：69 个用例通过；新增一个独立进程 SIGKILL 恢复场景，日志重放与输入边界均完成变异验证。
- `npm run test:evals`：69 个用例通过，实际 worker 覆盖提问、命令回复、继续完成。
- 行为评测 `2026-10-29T01-47-47-475Z-j34v4k`：四个任务 dev 场景全部通过；仅作开发反馈，不作为发布基线。首轮失败证据保留。
- 迁移演练与真实部署未执行。

# Pipiclaw 0.8.0 自主长程能力实测报告

- 测试日期：2026-07-11
- 测试对象：本地已安装的 `pipiclaw 0.8.0`（`pipiclaw --version` 确认，与本仓库 HEAD 一致）
- 测试方式：终端 TUI（`pipiclaw tui`），隔离的临时 `PIPICLAW_HOME`（复制真实 `auth.json`/`models.json`/`tools.json`/`security.json`/`settings.json` 以接入真实 LLM 与真实 web 工具，workspace 全新），未触碰真实 `~/.pi/pipiclaw` 下任何 channel 数据。所有测试 channel（`test_smoke`/`test_autonomy`/`test_events`/`test_approval`）与整个临时 app home 已在测试结束后删除。
- 覆盖范围：events 机制（`event_manage` 工具与四条硬闸门）、任务台账全生命周期（创建 → 驱动唤醒 → 独立验收 → 归档）、外部副作用授权、`/tasks`/`/events` 零 LLM 命令、TUI 传输层本身的边界行为。
- **说明**：内建 task driver 与 events watcher 是随 DingTalk daemon 启动的常驻扫描（`docs/tasks.md`：daemon 每分钟扫描；`configuration.md`：`tui_local` 之类纯 TUI channel 关闭后不能自行唤醒）。TUI 进程本身不跑这两个后台组件（见 `src/tui/app.ts`，未接线 `TaskDriver`/`createEventsWatcher`）。因此对"driver 定时唤醒"本身，本次采用生产代码同款的唤醒消息（`bootstrap.ts` 里 `createTaskDriverEvent` 生成的原始文本）手工注入，验证的是**模型侧对该唤醒的响应是否符合 SOP**；driver 的调度/退避/预算逻辑本身已有单元测试覆盖（spec 023/024 "Required tests"），不在本次范围内。

## 一、结论

**核心链路走通，且比预想的更扎实。** 完整跑通了一个"创建只读调研任务 → 模拟 driver 唤醒 → 模型自主调研 → 独立 verifier 子代理逐条核实事实 → 导入验收 → 归档"的全链路，中途模型两次用错工具参数（`subagent` 漏填必填字段、`task_manage verify` 编造了一个不存在的 runId），**两次都在没有人介入的情况下自行探查文件系统纠正并完成任务**——这正是"自主长程"应该有的韧性。四条 events 硬闸门（禁 immediate、one-shot ≥ 2 分钟、periodic ≥ 30 分钟、preAction 门控降至 ≥ 5 分钟）、外部副作用授权链（agent 无法自授予、schema 级拒绝、`/tasks approve` 正确记录审批人与任务体哈希）、DoD checkbox 验收闸门（正确格式下）全部按文档行为工作。

但过程中也揪出了 4 个此前只靠代码走读推不出来的**实测确认**问题，其中 1 个是会静默破坏产品承诺的功能性 bug（发现 A），1 个是验收闸门可被格式绕过的真实漏洞（发现 B，与既有评审报告发现 3 相互印证但机制不同）。详见下节。

## 二、测试矩阵与结果

| 场景 | 方式 | 结果 |
|---|---|---|
| 隔离环境接入真实 LLM | `--print` 简单问答 | 通过 |
| 自然语言创建一次性任务 | `--print`，无 checkbox 措辞 | 通过；`task_manage create` 生成的骨架与 control 字段均合法 |
| 模拟 driver 唤醒 → 完整独立验收 → 归档 | 手工注入生产同款唤醒文本 | 通过（过程含 2 次工具调用错误，均自愈） |
| `event_manage` 禁 immediate | 强制要求实际调用 | 通过，报错文本与文档一致 |
| `event_manage` one-shot < 2 分钟 | 强制要求实际调用 | 通过 |
| `event_manage` periodic < 30 分钟（无 preAction） | 强制要求实际调用 | 通过 |
| `event_manage` 创建带 preAction 的 5 分钟 periodic | 正常请求 | 通过，文件内容正确 |
| `/events list`（零 LLM） | 交互式管道，故意延迟 EOF | 通过 |
| 外部副作用任务：sideEffects=external 自动 required | 自然语言创建 | 通过 |
| 自授予 externalApproval=granted | 强制要求实际调用 `task_manage set` | 通过，**schema 级**拒绝（"must be equal to constant"），不到运行时校验就已被挡下 |
| checkbox 格式 DoD 下 `task_manage done` 拒绝未完成项 | 强制要求实际调用 | 通过，逐条报出未勾选项 |
| `/tasks approve` | 交互式管道 | 通过，正确写入 `externalApproval/approvalBy/approvedAt/approvalBodyHash` |
| `/tasks stats` / `pause` / `resume` / 列表 | 交互式管道 | 全部通过 |
| **`pipiclaw tui --print` 下的内建斜杠命令** | `--print` 传入 `/tasks`、`/tasks archive`、`/tasks doctor` | **失败**：见发现 A |
| **非 checkbox 格式 DoD 下的验收闸门** | 自然语言创建任务，DoD 写成编号列表而非 `- [ ]` | **失败**：见发现 B |

## 三、发现

### 发现 A（高，功能性 bug）：`--print` 模式下所有内建斜杠命令静默失效，直接喂给模型

`src/tui/turn-controller.ts` 的 `runOnce()`（`--print` 专用路径）直接调用 `beginTurn(text)`，从未经过 `dispatch()`（斜杠命令路由，见 `src/tui/commands.ts:49` 的 `parseBuiltInCommand`）。而交互模式的 `submit()` 会先过 `dispatch()`。

实测验证：`echo "/tasks" | pipiclaw tui --print` 没有触发零 LLM 的 `handleTasksCommand`，而是让模型把 `/tasks` 当自然语言请求处理——模型看懂了意图、自己调用 `task_manage list` 工具凑出了正确答案，但这是**运气**，不是设计保证。若换成 `/tasks doctor`（诊断 control 损坏、预算超限等确定性检查）或 `/events history`（读取审计 jsonl），模型没有对应工具可以精确复现这些确定性检查的输出，大概率会给出编造或不完整的结果，而不会报错提示"这条命令在 --print 下不受支持"。

**影响**：文档反复强调的"`/tasks`/`/events` 是零 token 成本、transport 层直接处理"的承诺，在唯一可脚本化的调用方式（`--print`，专为脚本/自动化设计）下不成立。这正是本次评审最看重的"自动化能力"的一个具体裂缝。

**建议**：`runOnce()` 复用 `submit()`/`dispatch()` 的判定逻辑（先 `parseBuiltInCommand`，命中则走零 LLM 路径，否则才 `beginTurn`），而不是无条件当作用户 prompt。

### 发现 B（高，验收闸门可绕过）：DoD/Verification 的"未勾选拦截"闸门依赖 checkbox 语法，模型不写 checkbox 时闸门形同虚设

`src/shared/task-ledger.ts` 的 `uncheckedTaskAcceptanceItems()` 只识别形如 `- [ ] ...` 的 Markdown 复选框行；`task_manage candidate`/`done` 的拦截逻辑（`src/tools/task-manage.ts:547,640`）只基于这个函数的返回值。**该函数对"根本没有复选框、只有编号列表或纯文字的 DoD"永远返回空数组**——即"零个未勾选项"，等价于"全部通过"。

实测复现：让模型自然语言创建一个调研任务（未指定格式要求），模型把 DoD 写成 `1. ... 2. ... 3. ...` 的编号列表。随后的完整 independent 验收流程（`task_manage candidate` → 委派 verifier 子代理 → `task_manage verify` → `task_manage done`）**全部顺畅通过，没有一步因"DoD 未勾选"被拦下**——因为从 `candidate` 那一步起，闸门看到的"未勾选项"数量就是 0。对照组：另起一个任务，我显式要求"DoD 用标准 markdown checkbox 格式"，`task_manage done` 就正确报出三条具体未勾选项并拒绝关闭。

两组对照证明：**这不是闸门坏了，而是闸门的生效与否完全取决于 maker 当初写 DoD 时有没有用对 Markdown 语法，而 `task_manage create` 的工具 schema 和系统提示都没有强制或校验这一点。** 对个人助手场景，这意味着"独立验收"这道号称硬门禁的机制，实际有效性系于模型一次随手的格式选择——而这次实测里，同一个模型在两种措辞下给出了两种格式，说明这不是小概率事件。

**建议**：二选一即可，不需要都做：
1. `renderStandardTaskBody`/`task_manage create` 侧强制 DoD/Verification 的每一行都规范化为 `- [ ] ` 前缀（对纯文字/编号输入做一次机械转换），从源头保证闸门有效；
2. 或者 `uncheckedTaskAcceptanceItems` 增加一个"DoD 段落里一个 checkbox 都没有"的显式判定，返回类似 `DoD has no checklist items — write DoD as \`- [ ]\` acceptance items` 的拦截，而不是静默放行。

第一种更符合"确定性门禁不依赖模型自觉"的项目一贯设计取向。

### 发现 C（低）：TUI 下 `/tasks approve` 记录的审批人恒为 `"unknown-user"`，审计字段失去意义

`src/tui/app.ts` 里 `runTasks: (args) => handleTasksCommand({ args, channelDir, workspaceDir, channelId })` 没有传 `approver`；DingTalk 侧（`bootstrap.ts:710-711`）会传 `event.userName`/`event.user`。`task-commands.ts:278` 在缺省时落到硬编码 `"unknown-user"`。

实测确认：TUI 下执行 `/tasks approve <id>`，`control.approvalBy` 写入的就是字面量 `"unknown-user"`。

**影响**：个人单人使用场景下不是安全问题（TUI 的操作者定义上就是你自己），但破坏了 spec 023 设计的"approver/时间/task body hash 三元审计记录"里 approver 这一项的实际意义——如果以后想从 `/tasks stats` 或 doctor 复盘"谁在什么时候批准了这次外部动作"，TUI 场景下这个字段永远查不出人。

**建议**：`runTuiApp` 把 `safeUserName()`（已经算出的本地用户名，用于欢迎语）一并传给 `runTasks`/`handleTasksCommand` 的 `approver` 参数，工作量很小。

### 发现 D（信息性，非 bug）：验收链路本身的质量令人意外地好，但也确认了既有评审报告发现 3 的真实代价

独立 verifier 子代理没有走过场——它对调研结果里的每一条技术论断和开源仓库地址都单独发起了 web_search/web_fetch 去交叉核实（Hinton 2015、DistilBERT 参数量与性能保留、HLDC 论文、MiniCPM OPD、Distily 仓库可访问性等），最终附带证据链给出 `VERDICT: PASS`，证据质量远超"象征性复核"。这印证了这道验收车道**设计本身没问题、执行也到位**。

但代价同样真实：这一个任务从"调研完成待验证"到"归档"，实测消耗了独立 verifier 的整整一轮多工具调用（10+ 次 web 搜索/抓取），加上 maker 侧两次工具调用纠错的往返，总耗时超过 3 分钟（首次尝试因我的测试脚本超时被杀，重试后完整耗时更长）。对一个"调研+写摘要"性质、本无需机器验证的任务，这个成本与既有评审报告《autonomy-review-0.8.0.md》发现 3（"independent 验收作为默认档对个人助手过重"）的判断完全吻合——这里是该判断的一次具体、可复现的实测印证，而不是新发现。

## 四、未覆盖 / 后续建议

- **真实 driver 定时扫描、attempt 预算耗尽升级、依赖就绪门禁**：这些逻辑绑定在 DingTalk daemon 里，TUI 无法触发，本次未做端到端复现，只验证了驱动唤醒后模型侧的响应。若要端到端验证，需要用测试用的 `channel.json`（而非生产凭证）短时间跑一次真实 daemon，风险和收益都需要单独评估，建议留到下次配合真实钉钉沙箱账号一起测。
- **worktree 隔离子任务**：本次未构造需要 `isolation: worktree` 的场景，建议后续单独测一次"父任务分解出 worktree 子任务 → 完成 → 父任务 review/merge"的路径。
- 发现 A、B 建议优先修——两者都直接影响"自主长程"的可信度：A 是"自动化脚本以为在走确定性路径，实际在偷偷调用模型"，B 是"验收门禁的有效性掷骰子"。C 优先级低，顺手修。

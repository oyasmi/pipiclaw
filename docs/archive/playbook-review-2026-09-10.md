**Pipiclaw runtime playbooks 深入审查 — 2026-09-10**

审查基线：`d5fedfb`，`0.9.3-beta.2`。范围包括七份 `src/playbooks/*.md`、catalog、system prompt、task brief、工具注册与实现、相关测试和 eval。以下审查记录保留修改前的问题与证据；实现结果见文末。证据链接固定到审查基线，行号不随本次修改漂移。

**结论：保留现有分层，优先修正可执行路径，再压缩正文。**

metadata 常驻、正文按需读取、随包升级、workspace 策略独立，这套组织适合本项目。主要问题是几次机制演进之后，正文、工具能力和运行时入口没有完全同步：agent 有时会被指向不存在的工具、不会完成验收的收尾路径，或检索不到目标数据的入口。同时，两份最长手册承担了过多通用指导和重复解释。

优化目标应是“完成正确工作所需的总成本”：包含读手册、重新建立上下文、无效工具调用、重复执行、验收和返工。只压缩常驻 prompt，或单纯减少文件行数，都不足以衡量收益。

**值得保留的设计**

- 七份文件的领域划分基本合理；不需要另建知识图谱、向量检索、自动路由服务或 playbook 管理平台。
- 工具 schema 管参数、playbook 管判断和跨工具流程，方向正确。`event_manage.definition` 是不透明 JSON，属于必须由文档补充结构的例外。
- 委派上下文自足、验收绑定实际产物、先裁决反馈再返工、达到约定标准即停，这些指导有助于降低失败率和无效开销，应该保留。
- 记忆、journal、task、skill 的生命周期分工有价值；尤其不把临时进度存为永久记忆。
- runtime 负责结算、等待兑现和停止回执，agent 负责目标与证据判断。优化不能把这些责任重新推给模型。

**已确认的高优先级问题**

**1. 普通聊天与 task 循环的工具边界没有进入操作指南。**

证据：普通聊天没有 `task_step_end`，见 [registry.ts:312](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/tools/registry.ts#L312)；task 循环则删除 `task_create`、`memory_save`、`event_manage`，见 [tools/index.ts:71](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/tools/index.ts#L71)。这是两个实际不同的执行环境。

但 [outbound-media.md:20](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/outbound-media.md#L20) 无条件要求把发送 receipt 写入 `task_step_end.note`；[agent-delegation.md:77](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/agent-delegation.md#L77) 只按“属于某个 task”要求停泊，没有检查当前是不是 task 会话；[event-scheduling.md:39](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/event-scheduling.md#L39) 讲 task-owned 传感器，却未说明应由聊天侧预先创建。task 循环中的事件手册还会被 catalog 门控隐藏。

可能后果：给用户发一个普通附件，却尝试调用不存在的 task 工具；在 task 步骤中临时创建传感器，发现 `event_manage` 不存在；为独立审查误建 task，只为满足 `purpose=verify` 的准入要求。

最小改法：在 `task-loop` 开头加一张两行入口表，并在三个通用手册的收尾处各加一句条件说明。

| 当前执行环境 | 正确操作 |
|---|---|
| 普通聊天 | 建立/修改/取消任务，预设 task-owned 事件；普通附件直接依据发送回执交付；临时委派无需 task |
| `[TASK_STEP:<id>]` / 存在 `task_step_end` | 推进当前契约，以 `task_step_end` 收尾；只使用已存在的传感器；任务经验记 `note` / Manual |

还要说明：普通审查可用 `purpose=work` 并给清晰检查要求；`purpose=verify` 是需要现存 `taskId` 的正式验收协议。创建 task 后，持续推进交给 runtime 的 task 会话；“带了 taskId”不等于当前聊天已进入该会话。

**2. 周期任务的“闭环”指向了跳过完成检查的路径。**

[task-loop.md:50](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/task-loop.md#L50) 把“周期任务闭环”列为 `park + schedule`。但 [step-end.ts:52](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/tools/task-manage/step-end.ts#L52) 只有 `done` 分支检查 DoD、验收证明并记录完成；它随后已经会自动停泊到下一个 schedule。[step-end.ts:123](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/tools/task-manage/step-end.ts#L123) 的 `park` 分支只记录等待。

已复现：建立 `verificationRequired:true`、DoD 未勾选的周期任务，调用 `park + schedule` 成功，日志没有 `close` 或验收 round。到期后 driver 会开启新 cycle，见 [task-driver.ts:267](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/runtime/task-driver.ts#L267)。这不是证明任务完成，只是绕开了完成路径。

最小改法：明确“本周期完成一律 `done`；runtime 自动安排下周期”。需要跳过一次 occurrence，说明 `task_close outcome=skip` 的独立语义；不能用 `park + schedule` 代替完成或跳过。无需新增状态或字段。是否进一步收紧 `schedule` 票的准入，可作为独立代码修复评估，先停止教出错误路径。

**3. 长跑命令手册遗漏了最容易导致重跑的参数语义：async 不延长 timeout。**

[background-jobs.md:10](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/background-jobs.md#L10) 推荐把“明显超过前台超时”的命令转后台，但没有说仍需设置更长 `timeout`。[bash.ts:205](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/tools/bash.ts#L205) 把同一个 `effectiveTimeout` 传给后台 job；默认仍是 300 秒。将一个前台超时的长构建原样改成 `async:true`，仍可能再次超时。

已用替身 job manager 捕获实际参数：省略 `timeout` 的 async 调用传入 300 秒，没有启动真实长命令。

最小改法：加一句“`async` 只释放聊天回合；根据预计耗时显式设置 `timeout`，单位秒”。给一个同时含 `async:true` 和 `timeout` 的紧凑样本，比重复解释自动唤醒更有价值。

另外，`notify:false` 只适合后续不需要结果的工作。不要再教“关闭通知后自行查结果”作为常规模式；有 task 在等待结果时保留默认通知。当前 job 票校验不检查 notify，而完成派发会检查，见 [ticket.ts:182](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/tasks/ticket.ts#L182) 和 [job-manager.ts:874](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/agent/job-manager.ts#L874)，关闭后不会正常发出完成唤醒，可能一直等到兜底恢复。

**4. 推荐的旧 journal 检索入口实际没有接入 journal。**

[runtime-orientation.md:55](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/runtime-orientation.md#L55) 推荐用 `memory_search` 查早先日期的 journal；工具 schema 也承诺查 memory、journal、workspace MEMORY。但 [memory-manage.ts:184](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/tools/memory-manage.ts#L184) 只加载 memory entries 和 workspace MEMORY，没有传 journal。底层 [search.ts:272](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/memory/search.ts#L272) 已支持 journal 输入。

已复现：只在临时 journal 写入唯一标记，实际工具返回 0 条；同一检索函数显式传该 journal 时返回 1 条。

这是实现与公开契约的接线缺口，不能只通过润色手册解决。优先评估用有界的 journal 读取接通现有实现；修复前，手册应引导按日期 `read` 或在当前 channel 的 journal 内定向 `grep`，避免把“没有检索命中”当成“历史上不存在”。无需新索引或向量库。

**其他重要的内容问题**

**5. 文件权限、路径和操作者有相互矛盾的指示。**

- [runtime-orientation.md:34](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/runtime-orientation.md#L34) 说 workspace `skills/` 只读，同文件第 46 行又说可写；实际 [path-guard.ts:267](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/security/path-guard.ts#L267) 提供读写例外，但显式 deny、符号链接等限制仍然适用。“始终放行”也应收窄为“项目边界的读写例外”。
- [agent-delegation.md:69](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/agent-delegation.md#L69) 要模型修改已配置角色文件里的 `mutates`，但 [discovery.ts:185](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/subagents/discovery.ts#L185) 特意禁止模型用 write/edit 修改 `sub-agents/`。应由模型报告需要的变更，部署者修改角色；inline 在自身调用中声明 `mutates`。不要暗示可以换 bash 绕过这道边界。
- [memory-and-learning.md:75](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/memory-and-learning.md#L75) 给出 `workspace/skills/...` 的相对写入路径，但通用工具 cwd 是 ProjectRoot。应标明它是位置示意，实际调用使用已知 workspace 绝对路径。task 正文编辑同理：使用 `task_create` 返回的路径或 `<channelDir>/tasks/<id>.md`，不要把裸 `tasks/...` 当成项目相对路径。

建议只在 orientation 维护权威文件地图；其他文件保留“入口 + 所需操作者”，不复制整段权限解释。

**6. event 手册缺少唯一必须由它提供的 preAction 数据形状。**

[event-scheduling.md:33](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/event-scheduling.md#L33) 解释了传感器用途，却没有完整 preAction 样例。工具 schema 只暴露 `definition: string`，模型无法从 schema 得知 `preAction.type="bash"` 必填，以及 `preAction.timeout` 用毫秒。实际校验见 [events.ts:137](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/runtime/events.ts#L137)；遗漏 `type` 已复现为解析失败。

建议用下面的结构替换一个较低信息量的普通 periodic 样本。命令和路径需按实际环境替换；这里的 `test -f` 只示范简单外部条件，不引入第三方工具约定。

```json
{"type":"periodic","text":"条件满足后检查并处理结果","schedule":"*/5 * * * *","preAction":{"type":"bash","command":"test -f /absolute/path/ready.flag","timeout":10000}}
```

`channelId` 可由工具填入当前频道。只补充跨工具闭环的必要顺序：聊天侧创建 task → 创建归属正确的 periodic sensor → task 步骤确认真实条件，不成立才 park 到 signal → 唤醒后核对结果 → 完成时清理/退役。完成前不要反复重建 sensor。

“工具不可用就直接改 events 文件”的建议也要加条件：task 环境刻意移除了该能力，project 边界也可能挡住该目录；缺工具不是自动获得文件写权限。

**7. 等待纪律把“避免空转”扩张成了“异步即停止一切工作”。**

[agent-delegation.md:77](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/agent-delegation.md#L77) 和 [background-jobs.md:22](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/background-jobs.md#L22) 都要求立即结束回合；[sections.ts:71](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/agent/prompt/sections.ts#L71) 与工具返回也重复这条规则。另一方面，委派手册又教并行分片。模型照第一条严格执行，可能派完第一个异步工作就停止，剩余独立分片和本地可做工作都要等下一次唤醒。

建议统一改成：“完成当前可独立推进的工作和计划中的独立派发；只剩等待时结束回合，不为等待而轮询。”保留活跃写委派期间主代理不得碰同一工作树的约束。

同时补齐两个分支：结果同步返回就直接处理，不 park；async 返回后若 park 被告知已结算，读取结果并继续。当前 [task-loop.md:72](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/task-loop.md#L72) 无条件要求验收派发后 park，但内置委派可同步完成且不再发通知，见 [tool.ts:1339](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/subagents/tool.ts#L1339)。此时票校验会直接拒绝。

不需要增加多票聚合器：多个独立 run 都关联 taskId；当前票指向实际阻塞下一阶段的 run，醒来后读取其余 run 的当前状态，只对尚未结束且确实需要的来源等待。

**8. 还有一些低成本、应一次清理的事实漂移。**

| 位置 | 当前问题 | 最小修正 |
|---|---|---|
| `memory-and-learning.md:31` | 把用户说“忘掉”也归入当回合 `memory_save` | 明分 remember/save 与 forget/forget；纠正走 replaces |
| `outbound-media.md:22` | 仍说 `progress` 为 `active` / `waiting` | 删除旧模型；task 环境用 continue/park/blocked，普通聊天按失败原因恢复 |
| `runtime-orientation.md:25` | agenda 仍列 status/enabled/wake/nextAction/最新记录 | 改成当前 state、paused、ticket、cycle 和 Plan；实际见 `memory/task-digest.ts:42` |
| `runtime-orientation.md:26,45` | workspace MEMORY 描述成全文、整份注入 | 说明受首轮预算裁剪，缺失不等于不存在；实际见 `memory/index-budget.ts:69` |
| `runtime-orientation.md:53`、`memory-and-learning.md:27` | 说直接修改 memory 源文件会被索引重建覆盖 | 正确理由是 runtime 所有权、串行写入和一致性；重建覆盖的是生成索引，见 `memory/store.ts:312` |
| `task-loop.md:31` | “契约有 4 KB 预算”容易被理解成有整体硬限制 | 明说作者需自行保持简短；目前裁剪对象是上次结果，不能借此保证每轮成本 |
| `task-loop.md:106` | 保证票过期后 brief 开头会说明 | 当前 bootstrap 调用 brief 未传 reason；不要承诺尚未进入模型输入的诊断，必要时补接线 |

前三项直接影响工具选择，应该在第一批修正；其余避免错误心理模型，属于同批低成本清理。

**组织与成本的优化空间**

**9. 正文的成本显著高于目录，行数约束掩盖了长段落。**

使用项目自己的 `countPromptUnits` 计算。units 是确定性长度代理，不是特定模型的 tokenizer 结果，也不是账单费用；下表“文件 units”包含 frontmatter，与整份 read 的输入接近。

| Playbook | 文件 units | 正文非空行 |
|---|---:|---:|
| runtime-orientation | 1,453 | 42 |
| memory-and-learning | 1,959 | 50 |
| outbound-media | 393 | 11 |
| event-scheduling | 895 | 27 |
| background-jobs | 551 | 14 |
| agent-delegation | 3,630 | 63 |
| task-loop | 2,272 | 62 |
| 合计 | 11,153 | 269 |

当前 checkout 路径下，完整常驻目录含标题约 **259 units / 666 字符**。这部分控制得不错；七份正文不是每轮自动注入，不能把 11,153 当作每轮固定开销。

但 task + delegation 一次读完就是 **5,902 units**；再沿引用读取 memory + orientation，则达到 **9,314 units**。这只是可能的读取组合，不代表观察到了模型必然这样读。后续上下文复用与 prefix cache 也会影响真实账单，但上下文容量、首次读取、压缩后重读和重复读的成本仍存在。

[docs/runtime-playbooks.md:79](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/docs/runtime-playbooks.md#L79) 的 60 非空行软上限无法反映这个差距：用更长的段落就能“符合行数”，却没有省任何上下文。

建议复用现有 units 计数，报告单文件大小与常见读取组合，不引入 tokenizer 依赖。先定人工优化目标：task + delegation 合计从 5,902 降到约 4,000–4,500 units，作为 24%–32% 的目标空间，而非已兑现的节省承诺。保住正确分支后再根据 eval 决定是否继续压缩。

**10. 先让每个关键判断只有一个主要归属，再考虑拆文件。**

当前最明显的重复包括：四层知识模型（orientation 与用户文档）、资源写入边界（orientation 与 memory）、自动唤醒（prompt、多个 schema/返回、三个手册）、验收 attestation/失效条件/自动记账（task 与 delegation）、适用要求传递和经验晋升（memory、task、delegation）。安全关键规则允许在 action 点保留一句提醒，但无需多次复制整个解释。

建议仍保留七份目录，以较小编辑完成以下归属调整：

| 文件 | 应主要回答的问题 | 优先压缩或迁移的内容 |
|---|---|---|
| orientation | 当前是什么执行环境，数据在哪里，用什么入口可达？ | 四层模型压成几行；删除旧字段和重复读写理由 |
| memory | 该记什么、怎么查/替换/忘记、何时晋升 skill？ | 删除 schema 全参数复述；后台阈值解释压短；偏好示例保留一个有区分力的例子 |
| outbound | 怎样算真正交付，失败后怎么办？ | 去掉对 task 的无条件依赖，保留 receipt 证据边界 |
| event | 时间提醒还是条件触发，怎样创建合法 sensor？ | 普通样例让位给 preAction；删去 job/run 等待纪律的长解释 |
| jobs | 同步还是 async，超时/通知怎样配，怎样回收结果？ | schema 已说清的 list/poll/cancel 只保留恢复判断 |
| delegation | 何时值得委派、选谁、交什么上下文、如何隔离与续接？ | attestation 绑定、正式验收闭环主要归 task；删泛化人设式劝告 |
| task | 普通聊天如何建立契约，循环如何推进、等待、验收、结束？ | 角色配置和上下文契约的细节归 delegation；正文只留下 task 特有差异 |

跨文件引用写成“遇到 X 才读 Y 的 Z 部分”，不能让“参见 Y”隐含“先把 Y 全读完”。开头几行应先给适用条件、主要分支、成功后的下一步，让 agent 能快速停止阅读。已经完整读过、仍在当前上下文中的手册不必重复 read；压缩后相关内容缺失、遇到新分支或版本变化时再读。

暂不建议拆成十几份更小手册：会增加常驻触发器、选择难度和 read 往返。若去重后 delegation 仍显著过大，并且试验显示普通派发很少需要配置/恢复章节，再把那部分移为不进入常驻目录的参考文件；不要为预想需求提前搭引用体系。

**11. 成本选择规则还可以更精准。**

[agent-delegation.md:17](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/agent-delegation.md#L17) 已按 light/heavy 选角色，但“值得不值得委派”只有可分离性，没有覆盖“主代理直接做几次工具调用就完成”的情况。应加一个轻量判断：只有独立上下文、并行收益、专用能力或独立判断的收益足以覆盖派发、上下文重建和整合成本时才委派。不要按文件数或任务字数强制委派。

[agent-delegation.md:22](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/agent-delegation.md#L22) 又把角色不可用推导成“轻量角色顶不了重活，告诉用户”。`light/heavy` 是工作量标记，不能单独决定可否替代。应先判断主代理能否直接完成、是否可拆成独立小片段或有等价能力；确实缺少必需能力才阻塞，替代方案的验证标准不降低。

[task-loop.md:29](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/playbooks/task-loop.md#L29) 将所有“代码、配置或可复现产物”都设为 `verificationRequired:true`，范围过宽：稳定流程每天生成一个可机械核对的报表，也可能因此每个 cycle 都重建独立验收上下文。建议按错误后果、复杂度、产物变化和是否有足够独立的确定性检查决定，遵守用户既定验收要求；高风险和实质实现改动保留正式验收。不要因为剩余预算充足就提高验收轮数。

另一个必须说清的成本边界：task 的 `wallMin` 当前按 cycle 开始后的实际经过时间计算，包含 park 等待，见 [budget.ts:53](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/tasks/budget.ts#L53)。默认 180 分钟的任务等待一整天，恢复后可能先被预算挡住；手册应指导建档时考虑等待跨度，或另行评估是否符合产品想要的预算语义。

**验证保障的缺口**

**12. 测试能证明目录存在，尚不能证明内容教对了当前能力。**

- [playbooks.test.ts:62](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/test/playbooks.test.ts#L62) 用 `## control 决策` 作为正文不会进入 prompt 的反例，但当前正文已不存在这句话；这条断言不能证明当前正文没有泄漏。
- [docs/runtime-playbooks.md:53](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/docs/runtime-playbooks.md#L53) 说测试会对账该文档目录表，但 `test/playbooks.test.ts` 没有读取此文档；它检查的是另一个手写 `EXPECTED_PLAYBOOKS` 数组。
- [evals/cases/regression.ts:545](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/evals/cases/regression.ts#L545) 的 `P-playbook-01` 仍要求 `read task-driving.md`，该文件已经不存在；当前正确入口是 `task-loop.md`。这会把正确行为判成失败，甚至奖励对旧路径的无效尝试。
- task driver 文本中有“读取 task-loop”的要求，但正常 runtime 会把原始文本替换成 brief，见 [bootstrap.ts:350](https://github.com/oyasmi/pipiclaw/blob/d5fedfbd27b44849ff1637410e0966ee9e6cb0d5/src/runtime/bootstrap.ts#L350)；brief 自身没有这条指定路径要求。现在依靠通用 system prompt 的按需读取纪律。要测实际 provider 收到的输入和真实选择，不能只测 driver 字符串。

建议采用低复杂度的三层校验：

| 层 | 值得增加/修正的检查 | 不应承担的任务 |
|---|---|---|
| unit / 静态检查 | catalog 用临时独有正文验证只渲染 metadata；手册引用路径存在；合法 JSON 示例交给真实 parser；关键工具注册/模式差异；正文 units 报告 | 固定中文句子或逐字快照 |
| deterministic e2e | 当实现有改动时，验证模式切换后的实际工具集合、done 的关闭记录和下周期、job 超时/唤醒接线、journal 工具接线 | 判模型理解好不好，或要求回复特定措辞 |
| eval | 自然语言触发正确机制，避免多建 task/重复 read/空轮询；验收反馈裁决与达标停止 | 用固定 mock 的脚本行为冒充真实模型能力 |

优先修复已有 `P-playbook-01`，再复用现有 eval harness 增加少量对照场景，不建新的评测平台：

1. 发一个附件：不建 task、不调用 task_step_end，以真实 transport receipt 为证据。
2. 一个超出默认时限的已知长命令：async 与足够 timeout 同时出现，等待来源是 job；用可控工具替身检查参数，避免每次 eval 真的空等五分钟。
3. 明天提醒一次 vs 每天产出报告：选择 event / recurring task，后者通过 done 闭环。
4. task 使用预置 signal sensor：不在循环中尝试创建 event；条件未满足才等待。
5. 两个互不干扰的分片：验证是否完成必要独立派发，且没有在活跃写工作树上自行改动。
6. 查询昨日 journal 独有事实：检索命中可追溯证据，不把无命中当成否定事实。

比较原版与修改版时记录正确完成率、不可用工具调用、恢复/重跑次数、playbook 读取文件与次数、provider usage 和总耗时。将固定模型、同一场景的小样本结果当作回归信号，不外推为所有模型上的百分比收益。新增 deterministic case 按项目要求做一次 mutation check；文案/行为质量留在 eval。

**建议的实施顺序**

| 顺序 | 具体交付 | 成本与预期收益 |
|---|---|---|
| 第一批：纠错 | 修正文档的模式条件、done/schedule、async timeout、忘记操作、角色写权限、preAction 样本和旧术语；修正失效 eval 目标 | 主要为替换句子，几乎不增加机制复杂度；优先减少确定的错误调用和失败重跑 |
| 第二批：补接线 | 独立修复 journal 搜索输入，核对 ticket 过期原因能否进入实际 brief；补有价值的契约测试 | 有界代码修复，复用现有能力；不把实现缺口藏在文档例外里 |
| 第三批：去重与对照 | 保持七份目录，按归属压缩 task/delegation；同步调整 prompt/schema/返回中的等待表述；跑现有 harness 的小规模 A/B | 先验证成功率不退，再判断读取 units、重试和总用量是否下降 |

第一批无需新增 metadata 字段、工具、持久状态、配置或依赖。正文测量也直接复用现有 `countPromptUnits`。只有实测表明单文件仍妨碍按需使用时，再考虑拆出低频参考。

**本次验证范围与证据强度**

运行了以下现有测试，共 **9 个文件、85 项，全部通过**：

```text
npx vitest --run test/playbooks.test.ts test/prompt-sections.test.ts test/prompt-resource-loader.test.ts test/prompt-units.test.ts test/turn-prompt.test.ts test/task-ticket.test.ts test/event-manage.test.ts test/memory-manage.test.ts test/bash.test.ts
```

另用临时目录中的独立探针直接调用当前实现，确认五项事实：journal-only 标记在工具层漏检；async 仍传 300 秒；聊天侧 task_step_end 被拒；park+schedule 不做完成验收；preAction 缺 type 被拒。探针未发起外部消息、真实长命令或模型调用，临时数据已清理。

报告中建议的 preAction JSON 也已直接交给实际 `event_manage` 验证，成功补入当前 channelId 并落盘；未启动 scheduler，临时文件已清理。

“立即结束可能抑制并行”“重复引用可能扩大阅读量”“去重可能降低总 token”等属于有机制依据的行为风险和优化假设，本次没有跑真实模型对照，不能声称已经证明了具体效果。以上是初次审查时的验证范围；后续实现及其完整验证单列如下。


**实施结果 — 2026-09-10**

保留七份文件、现有 metadata 和按需读取机制。没有新增运行时依赖、配置项、工具或持久状态。

| 审查项 | 已实施 |
|---|---|
| 1、5、8：模式、路径、生命周期 | 明确聊天/task/委派边界；修正 skills、角色、绝对路径、忘记操作、预算和旧字段；附件不再依赖任务工具 |
| 2：周期闭环 | 本周期以 done 完成并由 runtime 安排下一次；schema 不再公开 schedule park，旧调用在副作用前收到可恢复错误 |
| 3：长命令 | 明确 async 不延长 timeout；增加秒/毫秒示例；拒绝 taskId 与 notify:false 的组合，保证完成唤醒 |
| 4：journal | 接入现有搜索，最多读取最新 30 个日文件、每份末尾 64 KiB；过长命中使用短摘录，遗漏范围及进一步读取路径可见 |
| 6：传感器 | 提供可通过真实 parser 的 preAction JSON，说明聊天预建与 task 等待的顺序 |
| 7：并行与等待 | prompt、工具返回、手册统一为完成独立工作后再等待；区分同步返回、已结算与仍在运行 |
| 9–11：组织和成本 | 去重并集中正式验收规则，按实际收益决定委派和验证；已有上下文复用；新增无依赖的长度测量命令 |
| 12：验证 | 更新过时的路径/工具/评分规则，可恢复拒绝也计为未成功的调用，增加目录与正文分离、交叉引用、JSON、构建清理检查，以及真实 provider 输入和持久副作用检查 |

实现时另外确认并修复两处接线问题：

- bootstrap 在替换 brief 前创建了 ChannelContext，导致模型实际仍收到旧唤醒文本；现在先安装 brief，再创建上下文。brief 提供契约绝对路径、首次读取/后续复用手册的指引，并从现有日志恢复票过期原因。
- eval 构建只复制文件，保留了四份退役 task 手册。现在与正式构建共用清理逻辑，保留编译代码而删除退役 Markdown。

**长度结果**

下表使用同一 `countPromptUnits`，包含 frontmatter；不是模型 tokenizer 或账单。使用 `npm run playbooks:measure` 可复查。

| 文件/组合 | 基线 units | 修改后 units |
|---|---:|---:|
| runtime-orientation | 1,453 | 968 |
| memory-and-learning | 1,959 | 1,040 |
| outbound-media | 393 | 437 |
| event-scheduling | 895 | 844 |
| background-jobs | 551 | 443 |
| agent-delegation | 3,630 | 1,693 |
| task-loop | 2,272 | 2,042 |
| 七份合计 | 11,153 | 7,467（−33.0%） |
| task + delegation | 5,902 | 3,735（−36.7%） |
| 常驻目录（当前 checkout 路径） | 259 | 263 |

附件手册小幅增长用于补齐模式条件和失败恢复。常驻目录基本不变；节省发生在按需读取的正文，不能宣称每回合固定减少 33% 的 token。

**验证记录**

新增 deterministic 用例做了实际 mutation check：断开 `journal.days` 输入使 M2 失败；移除 `<task_recovery>` 或恢复 bootstrap 的旧上下文创建顺序，使 A13b 的 provider 输入检查失败。变异均已还原；检查的是实际输入、工具集合、完成记录与下一次 schedule，不判断模型措辞。

行为场景复用现有 eval harness：附件无需 task、周期以 done 闭环、预置 signal、历史 journal 取证、两个独立委派、首次成功读取正确手册；长命令参数用替身 job manager 检查，避免真实空等。一次提醒用合法的相对时间替换已超出 one-shot 上限的 2099 年样本；同一契约的多次唤醒不再被强制要求重复 read。

真实模型对照固定为本机配置的 `openai-codex/gpt-5.6-luna`，每场景每版 1 次；两版均用同一修复后的运行时代码，仅替换七份 Markdown。清理构建前的两次探索运行不纳入对照：其中出现 stale extension ctx，且输出目录含退役手册，条件不可靠。

清理后的基线附件与手册激活场景通过；周期场景中途开始遇到额度限制，后续场景（包括新版全部场景）均返回 `The usage limit has been reached`，没有有效模型用量。**本轮 A/B 无结论**；不能据此比较正确率、重试次数、总 token 或耗时，也不能用零用量的失败记录声称省钱。恢复额度后可使用以下命令重跑同一场景；无需新增评测平台：

```sh
EVAL_CASE=P-media-01 EVAL_TRIALS=1 npm run eval
EVAL_CASE=P-playbook-01 EVAL_TRIALS=1 npm run eval
EVAL_CASE=T-recur-01 EVAL_TRIALS=1 npm run eval
EVAL_CASE=TL-signal-01 EVAL_TRIALS=1 npm run eval
EVAL_CASE=M-journal-01 EVAL_TRIALS=1 npm run eval
EVAL_CASE=A-fragments-01 EVAL_TRIALS=1 npm run eval
EVAL_CASE=E-schedule-01 EVAL_TRIALS=1 npm run eval
```

对照运行标签为 `playbook-20260910-clean-baseline` / `playbook-20260910-clean-current`，原始 trace、usage、read 路径与次数在本地 `evals/results/`；不将含临时环境路径的完整运行归档提交到仓库。


最终离线验证：`npm run check` 通过（128 个 unit 文件、968 项测试，包含 lint、typecheck、deadcode）；`npm run test:e2e` 通过（21 个文件、40 项）；`npm run test:evals` 通过（22 项）。正式 build 和 eval:build 均通过。最后补齐 memory 搜索来源的 `.md` 后缀，使工具给出的继续读取路径可直接打开，并重新验证对应 memory 单元/端到端流程、typecheck 和两种构建。修正了一项既有 verifier 测试的目录隔离，让它验收自己的临时 fixture，不受开发 checkout 同时改动影响。

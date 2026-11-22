# Runtime Playbooks 与知识分层

Pipiclaw 把当前版本的产品机制和用户自己的工作方式分开维护：常驻提示词只保留必要边界，机制知识通过同一套扁平 playbook 目录按需读取，不在 workspace 留升级后会漂移的副本。

## 四层模型

| 层 | 内容 | 更新者 | 加载方式 |
|---|---|---|---|
| System prompt | 安全边界、资源所有权、最小恢复纪律 | Pipiclaw | 常驻 |
| Runtime playbooks | memory/event/task/subagent 的操作与恢复知识 | Pipiclaw 包 | metadata 常驻，正文按需 read |
| Workspace AGENTS.md / skills | 团队策略、偏好、环境 SOP、第三方工具用法 | 用户与 agent | 规则注入，skills 按需加载 |
| Task 契约与记录 | 单项工作的 Goal、DoD、进展与证据 | 负责人维护正文，运行时维护状态 | 首步契约，后续按需 brief |

“这个版本怎样工作”放 playbook，“团队希望怎样工作”放 AGENTS/skill，“当前做到哪里”放 task。只有不能漏掉的少量通用纪律留 system prompt；不要复制 runtime 手册到 workspace，运行时也不改写内置 playbook。

## 同一套渐进加载机制

所有指南都在 `src/playbooks/*.md` 同一层。常用操作、低频配置和异常恢复各自是独立 playbook，都通过现有 metadata、门控、目录和 read 加载；没有第二套附录目录、递归加载或工具启用机制。

```yaml
---
name: task-lead
description: TASK_STEP 必读主干：推进、等待、维护 DoD 与汇报关单。
requires-tools: task_report
order: 70
---
```

| 字段 | 作用 |
|---|---|
| name | 必须等于文件名，不含 .md |
| description | 目录里的操作触发器，上限 100 字符；中文意图配必要英文标识，优先短而明确 |
| requires-tools | any-of 门控：一个都没注册时不显示；不是工具激活声明 |
| order | 唯一非负整数，按数值升序；常用间隔 10，需要时插入中间值 |

时间和时区偏移明确的单次文本提醒、范围明确的单角色委派，以及明确的记忆存取可直接用工具。创建或管理持久任务前先读 task-manage，后台任务首步先读 task-lead。指南用相对链接指向复杂分支，已有内容仍在上下文就复用，压缩丢失后按需重读。也可以从目录直达相应指南。

构建仍由原脚本复制顶层 Markdown 到 dist/playbooks/ 并清理退役文件；源码 checkout 优先读 src/playbooks/。path guard 对整个 playbooks 目录只授予读取例外，不授予写入或其他能力。

## 当前目录

下表的文件名、顺序和工具门控由现有目录测试与 metadata 对账，正文不做逐字快照。

| Playbook | order | 门控工具 | 读取场景 |
|---|---|---|---|
| `runtime-orientation.md` | 10 | 恒在 | 执行环境、上下文与状态所有者 |
| `runtime-files.md` | 11 | 恒在 | 具体文件地图与访问入口 |
| `runtime-operations.md` | 12 | 恒在 | 用户切换/创建工位与持续宿主 |
| `memory-operations.md` | 20 | `memory_save` / `memory_search` / `memory_forget` / `skill` | 事实存取、纠正和应用范围 |
| `learning-and-skills.md` | 25 | `skill` | 自动学习期限、技能创作与来源 |
| `outbound-media.md` | 30 | `send_media` | 附件发送与回执证据 |
| `event-scheduling.md` | 40 | `event_manage` | 周期、改期、退役与事件类型选择 |
| `event-task-template.md` | 41 | `event_manage` | 定时或周期项目模板 |
| `event-sensors.md` | 42 | `event_manage` | 条件门控与远期提醒 |
| `background-jobs.md` | 50 | `job` | 长跑命令、超时、结果和取消 |
| `agent-delegation.md` | 60 | `subagent` | 多角色取舍、并行隔离与独立核验 |
| `delegation-inline.md` | 61 | `subagent_inline` | 无合适角色时配置临时内置执行者 |
| `delegation-recovery.md` | 62 | `subagent_run` | 失败、卡顿、lost、续接与清理 |
| `task-manage.md` | 65 | `task_create` | 聊天立项、契约、进度与管理 |
| `task-lead.md` | 70 | `task_report` | 后台任务必读，覆盖步骤推进、等待、验证、交付与关闭 |
| `task-verify.md` | 71 | `task_report` | 多工作项独立核验、返工和复杂外部交付 |
| `task-recovery.md` | 72 | `task_report` | 暂停/重启恢复和周期实例改进 |

聊天读 task-manage，任务会话读 task-lead；按实际工具门控，两者不会在正常 chat/task 目录中同时出现。任务 brief 继续直接指向 task-lead，不增加中间读取。任务没有 task_create、memory_save、event_manage，不能换文件写入绕过。

agent-delegation 按 subagent 工具门控，不是恒在。第三方 skill 自带的外部工具规则不由它替代。当前 desk、workspace、工位状态目录、实际 cwd 和频道地址由运行时动态提供，静态指南不推测它们；工位概念见 [spec 060](./specs/060-desk/design.md#41-runtime-playbook-是实施与验收的一部分)。

## 编写与验证

1. **按操作组织**：适用环境 → 选择分支 → 正常流程 → 成功证据 → 失败下一步。普通委派不必读 inline，写事件模板不必读后台任务执行协议。
2. **只写产品特有知识**：默认模型已有通用能力。脆弱流程给精确顺序，开放问题给判断条件，不把所有工作固化成流水线。
3. **各有归属**。参数与单位保留在 schema，聊天契约在 task-manage，步骤等待与汇报在 task-lead，独立核验与返工在 task-verify，委派隔离和续接分别在 agent-delegation 与 delegation-recovery。操作点可留关键安全提醒。
4. **触发器要短而准确**：新增独立指南也增加常驻目录成本；先量真实 chat/task/request 目录，确保关键入口没有被截断，不靠提高预算掩盖膨胀。
5. **区分施动者与授权**：斜杠命令由用户发送，不是模型工具；已有明确授权就执行，缺少必要信息或扩大范围才询问。
6. **示例必须合法**：对照序列化代码核实 JSON、字段、类型、必填项和单位；错误要给模型可直接执行的下一步，引用真实协议不得变形。
7. **量实际读取路径**。运行 `npm run playbooks:measure` 查看总量、普通路径和按需组合。task-lead 的目标是 800 单位以内。提示单位采用运行时的固定计数规则。
8. **与代码共同验证**：沿用 metadata、目录不含正文、path guard、构建复制与事件样例测试，扩展其已有场景核对链接/分流。机制变化跑 unit/e2e，选路与执行质量由 eval 验证，不固定中文措辞。

## 第三方工具与工作区规则

内部与已配置的外部 Agent 通过 subagent/subagent_list/subagent_run 驱动。job/委派完成自动唤醒发起方，先完成独立工作，只剩等待就结束回合，不用 bash async、event 或轮询包裹等待。

未配置为委派角色的工具，其 CLI 命令、状态协议和检测脚本属于用户安装的 skill/可执行文件；长命令用 background job，外部条件探测用 event preAction。不捆绑第三方协议，不让产品手册替代其 skill。

工作区 AGENTS 保存共同规则和团队要求；skills 保存可复用流程，具体来源与刷新见 [Skills 指南](../docs/skills.md)。角色正文聚焦职责、约束和交付标准。用户自己的组织要求保留，重复的 runtime 机制改为引用内置指南。

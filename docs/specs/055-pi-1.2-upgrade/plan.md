# 055 实施计划

设计见 [design.md](./design.md)，事实基线见 [升级评估](../../reviews/2026-10-13-pi-1.2.0-upgrade-assessment.md)。状态：**P0–P5 离线实施及双 Node 合并门禁完成；P6 真实发布验收待执行**。详见 [验收记录](./acceptance.md)。实施不代表已发布或验证真实认证。

## 阶段和依赖

| 阶段 | 交付 | 决策 | 完成条件 |
|---|---|---|---|
| P0 固定基线 | 干净安装、版本图、旧会话固定样本 | D1、D9 | 可重复比较；样本无需旧包或网络即可消费 |
| P1 初始接入 | 版本/lock、canonical context、工具装配、类型/夹具 | D1、D2、D6 | 首次真实请求声明正确工具，类型和针对性机制测试通过 |
| P2 安全重试 | entry ID 计划、停止保护、断写隔离、raw 用途复核 | D3、D4、D5 | 不重复输入/副作用，故障实例不能继续请求 |
| P3 认证接入 | 安装 UUID、并发发布、显式路径与登录 options | D7、D8 | 离线身份/取消/路径检查通过；真实 OAuth 尚需 P6 |
| P4 正式离线验收 | 历史消费、unit/e2e 增量、mutation、全部门禁 | D9、D10 | 合并门禁全绿且记录对应 commit |
| P5 发布文档 | 配置、迁移、架构、备份与回退说明 | D8、D11 | 当前手册与最终实现一致，条件迁移字段清楚 |
| P6 真实验收与上线 | 供应商、钉钉/TUI smoke，快照、灰度、回退演练 | D10、D11 | 发布阻断项关闭；上线按操作清单执行 |

P0 先做；P2 依赖 P1；P3 与会话改造独立，但最终与 P2 一起进入 P4。可以分提交审查，P1 不能作为可部署的半成品单独发布。P5 根据最终实现同步，P6 需要 P4/P5 完成。

## 通用实施规则

- 只升级本次四个直接依赖及必需传递解析，不同时整理无关 SDK/工具/模型功能。
- 保持单向分层，models 只接受注入能力，不 import agent；新身份文件归 models，SDK 适配归 agent/session。
- 不增加 architecture-baseline 例外、不改公开导出、不弱化 JSON 类型或安全守卫。
- 所有机制断言针对请求、文件、运行状态、费用/投递次数，不要求模型答复措辞。
- 每阶段非平凡代码变更执行 typecheck 和相关 unit；运行时、记忆、委派、命令接线变更同时执行 deterministic e2e。最终 P4 统一执行完整门禁并保存日志。
- 原型只是参考，不能整目录复制 node_modules/lock/源文件后宣称正式方案完成。新增故障保护和身份协议必须单独验证。

## P0：固定基线和历史样本

- [x] 确认当前工作区修改、Pipiclaw commit、Node/npm 版本和 pi 目标标签；如基线已推进，重新检查接入点与测试数量。
- [x] 在隔离目录保存原版 npm ci、四包 npm ls、check、e2e 的基线结果；不更改生产 app home。
- [x] 列出当前 SessionManager/AgentSession 与 compat stream 的调用点，区分主 session 和裸 Agent 子代理；实际生产 provider 清单归 P6，未读取生产凭证。
- [x] 用精确 0.84.3 生成普通聊天、thinking/model、压缩/分支、任务 session、中断尝试样本，提交到拟新增 `test/fixtures/pi-0.84.3/`。
- [x] 记录样本生成版本、branch/session 与预期行为，确保无秘密、真实项目路径、不可控时间或联网依赖；测试运行时不安装旧包。
- [x] 确认已有 e2e 中可承接样本的场景；需要预播种时给现有 harness 增加窄 seed callback，在 bootstrap 前完成，避免新建平行 runtime 壳。

交付：可重复安装的基线、固定历史输入和消费场景映射。此时无需运行真实模型或完整迁移生产数据。

## P1：依赖、工具上下文与类型

- [x] package.json 四包改为精确 1.2.0，正常生成 lock，审查 unrelated 直接依赖未改变。
- [x] 干净 npm ci 后用 npm ls 核对整个核心版本图、invalid 和 0.84.3 残留，记录新增传递依赖。
- [x] createSessionRuntime 初始化空 Agent tools、已有 canonical messages，保持 model/thinking 兼容选择。
- [x] AgentSession 显式 initialActiveToolNames 与 Pipiclaw baseToolsOverride；确认普通/任务工具集差异，SDK 默认工具未混入。
- [x] 确认首个 prompt 的 system/tool 声明持久化，不依赖仅内存的初始 system 消息，不重复声明。
- [x] 资源重载更新工具对象和当前活动名称，首次/后续 provider request 都使用当前集合。
- [x] 修复 session-host 的 unknown 消息读取、AfterToolCallContext 和 JsonObject 测试类型，不添加 as any。
- [x] 伪 JPEG 换成有效小 PNG；cwd 测试跟随结构定位，保留提示所有权和边界/隔离断言。
- [x] 延伸已有 system-prompt、inbound-media、重载与任务场景，验证 request 工具、真实工具执行及结果进入后续请求。
- [x] 检查 before_agent_start 的两种分支、busy/停止/压缩事件接线和 TUI 接口，不为未使用 API 写适配空壳。

阶段门禁：typecheck、相关 unit、完整 deterministic e2e。P2 尚未完成时允许测试先揭示重复输入，但该提交必须明确不能部署；最终 e2e 不能保留已知失败。

## P2：持久化备用重试与故障隔离

- [x] 在第一次 prompt 前捕获 SDK 实例、manager、session/branch、TurnHandle，捕获发生在 host.runPrompt 回调内。
- [x] session-adapter 实现 raw 增量与 projection/sourceEntry.id 的计划识别；确认 unsubmitted 不再依赖 prompt 返回后的布尔值。
- [x] 拒绝工具调用/结果（包括投影已隐藏的调用）、正常答复、多用户输入、未知 custom/压缩结构和旧实例；识别允许的提示/model/thinking metadata、SDK 错误省略。
- [x] models/fallback 用注入 plan 替换主会话数组裁剪，保留错误分类、一次备用与冷却规则；检查 takeFailedTurn 是否仍有裸 Agent 调用。
- [x] 每个备用解析/setModel/图片处理 await 后检查现有 turn 和停止状态，不创造第二套 busy/cancel 所有者。
- [x] plan.run 在一次现有资源保护窗口内重新校验，顺序追加 user 和可见错误 assistant 的省略，成功后 refresh，再直接提交；不通过 navigateTree/rewrite JSONL。
- [x] 从 pipeline 当前封装提交文本/图片，备用模型重新过滤图片能力，保持记忆 bootstrap 和提示所有权。
- [x] 已省略 entry 不重复写，同一有效计划幂等；额外输入/分支改变后计划失效，不能用文字匹配跨尝试裁剪。
- [x] onReady 才重置原错误、记录冷却、通知切换；stale/失败/停止不产生误导性成功通知。
- [x] 任意 edit 写入/refresh 失败标记故障 runtime，host 后续 prompt 拒绝同一实例；旧实例 resource refresh 失败时仍拒绝。
- [x] 成功磁盘重建/新 session 才解除隔离；`/new` 和报告命令可用，不自动重放无主的备用请求。
- [x] 复核 raw 数据消费者：turn recovery、不重复执行工具、usage、reflect/source window、session_search；metadata 不当作用户对白，游标跨 metadata 推进。
- [x] 扩展 A22：当前输入一次、旧历史保留、disk 原错误和 context_edit、重启后投影持续有效、delivery 次数；移除仅模型措辞断言。
- [x] 扩展 A5：备用凭证解析 promise barrier 内停止，释放后备用 request 数为 0；复用现有 /new、并发和任务场景检验旧计划失效。
- [x] 新 adapter unit 预算 +3，分别证明隐藏副作用准入、按 ID 持久化/重开/幂等、写失败不能继续采用内存投影。
- [x] 新 deterministic e2e 预算 +1，证明部分 edit 失败 → host 下一 turn 拒绝旧实例 → 成功重建恢复。使用精确故障注入和控制窗口，不依赖磁盘空间耗尽或 sleep。

阶段门禁：typecheck、相关 unit、完整 deterministic e2e；记录 unit/e2e 数量增量。故障 e2e 必须对“移除 host 拒绝”实际变红，否则不算证明故障隔离。

## P3：认证身份与条件迁移

- [x] login-identity 实现 `state/auth/identity.json` v1/UUID v4 验证，输入使用显式 appHomeDir。
- [x] 新建目录 0700/文件 0600；同目录独占 temp 完整写入/fsync/close，再 hard link 无覆盖发布，EEXIST 使用赢家 UUID，同步目录并清理自身 temp。
- [x] 现有 corrupt/version/access 错误不覆盖，不生成替代 UUID；不支持发布协议时报运维错误，不降级到 rename 覆盖。
- [x] signal 在创建/发布前后和登录前生效；发布成功后取消保留身份，取消/发布失败不启动 OAuth 网络流程。
- [x] loginProvider 新 context 由 CLI 实际路径传入；仅 openai/oauth 传第四个 LoginOptions 的 getDeviceId/agentName，原 interaction 保留。
- [x] status/logout/其他 provider/API key/daemon 启动无身份创建副作用；无 `~/.pi` 读写。
- [x] 扩展既有 auth-path 检查；新 unit 预算 +4：跨进程首次创建/稳定重登、损坏不重置、发布失败不登录、取消不登录。每个场景有独立失败模式，不把不同错误合并来控制数量。
- [x] 跨进程测试通过明确 barrier 让多个进程先观察不存在，再竞争发布；父进程核对实际文件与所有返回 UUID，不能只做同进程 Promise.all。
- [x] 新身份存储错误使用英文 operator 文案、实际路径和下一步，日志不记录 UUID/credentials；用户侧错误继续服从 053。
- [x] 准备 Azure 字段迁移清单和旧 Azure session 样本；API id/env 不替换，同名自定义 provider 与新旧 key 冲突需明确处理。
- [x] 确认现有 API key 与 legacy OAuth 未被强制迁移；记录真实账号 smoke 尚未验证的部分。

阶段门禁：typecheck、相关 unit；CLI 接线变更执行 deterministic e2e。mock login 只证明参数和状态路径，不证明 OAuth 供应商接受或流式调用可用。

## P4：正式离线验收

- [x] 通过真实 host/runtime 消费 P0 旧聊天、压缩/分支及任务样本，核对 session 路径、目标模型、provider 请求历史、thinking 和工具集合。
- [x] 扩展现有任务/恢复/记忆场景验证 tool 副作用、结算幂等、memory cursor、任务与聊天隔离，避免每种样本增加一个测试。
- [x] 实际运行 mutation：内存裁剪回归时 A22 重复输入断言红；漏初始工具装配时请求工具断言红；漏 host 故障拒绝时新增故障 e2e 红；漏停止校验时 A5 请求数断言红。
- [x] 每个 mutation 记录目标、失败断言和恢复后的绿灯；用例注释写出防止哪类回归，不保留注入故障。
- [x] 干净 npm ci 和 npm ls 复核四包与核心引用，保存最终 lock 对应结果。
- [x] 执行 npm run check、npm run test:e2e、npm run eval:typecheck、npm run build；检查 dist executable 与 Markdown assets。
- [x] 最低 Node 22.19.0 验证支持承诺，常用部署 Node 验证实际环境；若结果不同，解决差异或明确修改支持决策，不能忽略最低版本失败。
- [x] e2e 单独完整执行，不加超时、不 skip、不弱化 guard；任何失败都解释并修复，单个针对性重跑不能替代最终全套。
- [x] 汇总计划 unit +7/e2e +1 与实际增量、各新增场景准入理由；不追 coverage 数字。

合并必须同时满足：版本统一、首次工具完整、输入一次、停止后零请求、断写故障隔离、历史读取正确、usage/任务/委派/投递无重复，以及全部门禁通过。原型日志不能替代最终 commit 的结果。

## P5：文档与发布材料

- [x] configuration/configuration-reference 写明安装身份目录、首次创建条件、权限、备份、保留/新建安装语义；不暴露 UUID 值，不新增 settings 开关。
- [x] Azure 给出精确 provider 字段迁移表、API/env 保持原名、冲突处理和历史 session 验证，不建议全局替换。
- [x] architecture 更新 canonical context 与 raw 数据的不同用途，记录故障实例重建边界；只有模块表实际变化时才更新 AGENTS/CLAUDE，禁止添加例外。
- [x] deployment-and-operations 写停入口/调度、等待外部运行、完整状态快照、单写者灰度与两种回退时点。
- [x] CHANGELOG 描述实际收益、必需迁移和真实认证验收结果；MCP/虚拟路由/缓存预热等不写成已交付能力。
- [x] 核对 spec/顶层手册与最终接口一致，更新 design 的实施偏差和状态；没做真实验收时保留发布阻断项。

## P6：发布阻断项与上线操作

P6 在发布阶段使用独立测试 home/项目及受控真实账号；完整生产快照不得直接启动成第二个在线 daemon。缺少某个实际使用供应商或新增 OAuth 的凭证，记录“待验收”，保持对应发布阻断项未关闭。

- [ ] 常用生产 provider：显式模型、真实流式答复、一次受控工具调用、取消、usage 和重启取证；Azure/legacy OAuth 在使用时验证。
- [ ] 新 OpenAI ChatGPT OAuth：真实登录、identity/credential 正确路径、重登同一 UUID、取消不写 credential、重启后流/工具可用。必要认证传递修复完成后重新走相关离线门禁。
- [ ] OpenRouter/自定义代理：目标 endpoint、认证/headers/baseUrl、模型列表/选择符合部署意图，不因目录变化静默换模型。
- [ ] 钉钉 AI Card 与 TUI 受控 smoke：工具事件、停止、最终完成与中文错误下一步；任务静默/报告规则维持。
- [ ] 离线恢复演练：停止写者后用匹配旧包和升级前快照恢复，核对 session、任务、ledger 和投递状态；不触发真实重复工作。
- [ ] 记录发布包/commit/lock、供应商与模型、Node、检查结果、实际费用、遗留限制、操作人与时间。
- [ ] 生产停新入站与调度，等待 turn/reflect/jobs/外部委派/结算投递排空，正常关闭全部写者；记录未完成工作，不把 /stop 当作取消外部运行。
- [ ] 完整 app home 和受影响项目目录一致备份，核对权限/校验和/可恢复性，备份后按需修改 Azure 字段。
- [ ] 安装固定发布包和 lock，单实例启动灰度；检查工具、备用、恢复、usage/投递幂等，通过后恢复入口与调度。
- [ ] 出现 INV 破坏立即停灰度并保存现场。没有外部副作用才整套旧包+快照回退；已有外部效果先核对最新 receipt/ledger/项目状态，选择前向修复或经审查恢复，禁止盲目覆盖旧快照。

## 验收记录模板

| 项目 | 结果 |
|---|---|
| 最终实现 commit / 发布版本 | dev/pi-1.2-upgrade 分支（具体 commit 见 Git 记录）；基线 b61465f；未发布，版本保持 0.9.4-beta.2；源码摘要见 acceptance.md |
| Node/npm / 四包依赖图 | Node 22.21.0、22.19.0 / npm 10.9.4；四包精确 1.2.0、核心 dedupe，npm ci / npm ls --all 通过 |
| check / deterministic e2e / eval:typecheck / build | 两个 Node 全通过；959 unit、56 e2e；入口、Markdown assets、pack dry-run 通过 |
| unit / e2e 实际数量及净增理由 | 959 / 56；+7 / +1，分别针对持久化重试、安装身份与 host 断写隔离；见 acceptance.md |
| mutation 目标、红灯断言与恢复结果 | 内存裁剪/漏工具/漏故障拒绝/漏停止四项目标断言实际变红，恢复后完整双 Node 全绿 |
| 旧聊天/压缩/分支/任务样本消费 | 0.84.3 生成 chat、branch、fork、task、interrupted、Azure 样本；实际 host/runtime 消费通过 |
| 最低 Node / 部署 Node | 22.19.0 / 本机 22.21.0 全套门禁通过 |
| 供应商 / 模型 / OAuth / 钉钉 / TUI smoke | 离线 mock 通过；真实供应商/账号/传输尚未验收，发布保持阻断 |
| 配置迁移 / 一致快照 / 回退演练 | 精确字段清单与两种回退流程已交付；实际生产快照/回退演练待 P6 |
| 实施偏差、限制与费用 | 新增失败分支 ID 前缀固定、模型恢复前故障检查、canonical bootstrap 检查；0 实际模型费用；一次既有进程 unit 超时及后续全套绿灯见记录 |

实施完成与发布完成分别标记，不因依赖安装或 mock 全绿就提前勾选 P6。

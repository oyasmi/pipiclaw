# 055 正式实施与验收记录

状态：P0–P5 离线实施及合并门禁完成；P6 发布验收未执行，发布保持阻断。本文记录正式工作区，未采用原型的测试结果。

## 实现身份与依赖

- 基线 commit：`b61465fbcb576f843a7f136ea6988459331939d2`；实现提交在 `dev/pi-1.2-upgrade` 分支，具体 commit 由该分支的 Git 记录确认；未创建发布包或修改版本号（仍为 `0.9.4-beta.2`）。
- 四个直接 pi 包精确锁定 `1.2.0`，核心引用 dedupe，没有旧版残留或 invalid。已干净执行 `npm ci`，`npm ls --all` 退出 0；平台二进制及未启用集成的 optional 缺项正常。
- lock SHA-256：`5813381e1f880ad2e2ef7184345697d458f6faf896172514749958964084a3a9`。
- lock 解析条目 537→411；新增 pi-mcp、pi-codemode、quickjs-wasi、grok-mermaid、认证/代理相关传递依赖，不代表启用这些功能。工具集合仍仅来自 Pipiclaw 注册。
- 除 pi 外唯一直接包解析变化为 TypeBox 1.3.8→1.3.27：pi-agent-core、pi-ai、pi-coding-agent 1.2.0 均精确依赖 1.3.27，属本次必需解析；其余直接依赖版本未变。
- `npm audit` 的 4 项现有开发测试链告警属于 Vitest/mocker/coverage/tinypool（对应版本与基线相同），未夹带本次范围之外的测试框架升级。

## 正式门禁

| 环境 / 检查 | 结果 |
|---|---|
| 原版隔离 npm ci / 依赖图 | 通过，精确 0.84.3 |
| 原版 check / deterministic e2e | 952 unit / 55 e2e 通过 |
| Node 22.21.0 / npm 10.9.4 | check（959 unit）、独立 deterministic e2e（56）、eval:typecheck、build 全通过 |
| Node 22.19.0 最低版本 | check（959 unit）、独立 deterministic e2e（56）、eval:typecheck、build 全通过 |
| eval:typecheck / build / executable / Markdown assets | 两个 Node 全通过；dist/main.js 可执行，Markdown assets 与 identity 模块存在；npm pack --dry-run 确认包含 |

最终门禁设置 `PI_OFFLINE=1`，无真实 API 费用；deterministic provider 仅本机受控 mock。每个完整 e2e 独立顺序运行，无新增 timeout、skip 或 guard 弱化。实现源码/测试/fixtures/依赖摘要 SHA-256：`acc28746e8a81c64633b898dbade50acac3fea0bfcac9458d76b417da72aaf54`（按修改路径排序，拼接路径、NUL、文件内容、NUL；不含文档或 dist）。

一次完整 unit 运行中，既有 `subagent-restart-adoption` 的真实进程 deadline/结算等待
在原 20s 边界超时（958/959）。未修改该模块、用例或 timeout；独立重跑 5/5 通过，
根因未复现，已保留失败日志；之后重新执行完整门禁，22.21.0 和 22.19.0 均全绿，未用单独重跑替代全套。

## 用例与 mutation

正式增量保持预算：unit 952→959（+7），deterministic e2e 55→56（+1）。

- Adapter +3：raw 隐藏工具副作用/额外输入/分支回退的准入；按 ID 省略、重开、原始费用保留与幂等；部分追加/refresh 异常不得授权缓存继续请求。
- 身份 +4：跨独立 Node 进程明确 absent barrier 后竞争发布/稳定重登；损坏或不支持版本不覆盖；发布失败不开始 OAuth；取消不开始 OAuth且保留已经发布的身份。mock 只证明参数、状态路径和写入协议，不证明供应商认证。
- e2e +1：实际 SDK 第二次 `_persist` 抛错，内存有两条 edit、磁盘只有一条；本次零备用请求，资源 reload 失败后下一 turn 仍拒绝且不继续写 metadata；磁盘重建不自动重放，恢复 bootstrap 并可请求，`/new` 仍可用。
- 扩展 A22/A5/system-prompt/A12/任务场景，断言请求输入次数、工具声明和真实工具结果、disk edit/raw 错误、投递完成次数、凭证等待中停止、旧数据消费及会话隔离；不再以备用模型答复措辞作为断言。

以下 mutation 已对正式源码执行，全部在目标机制断言变红，随后恢复源码：

| mutation | 红灯证据 |
|---|---|
| 改回只裁剪 Agent 内存 | A22 备用 request 中 FALLBACK_TEST 用户消息 2 条，预期 1 |
| 去掉 initialActiveToolNames | 实际首个 request 的 tools 为 `[]`，缺少 `read` |
| 移除 host 故障拒绝 | 断写 e2e 下一 turn 发出第二个 provider request，预期累计 1 |
| 移除 stopRequested 检查 | A5 停止后备用 provider request 为 1，预期 0 |

恢复后的两个 Node 最终完整 unit/e2e 均全绿。注释记录 mutation，生产源码不保留故障注入或新增私有 SDK 字段依赖；`_persist` 注入只在测试。

## 历史样本与实现补强

`test/fixtures/pi-0.84.3/` 由原版发布包离线生成（附显式生成脚本），固定 header/entry IDs/时间/cwd；测试只重定位 header cwd，不安装旧包、不联网。

- chat：A22 真实 host 保留旧历史、旧原始失败与 usage；重建后投影继续省略本次失败输入。
- branch / fork：A12 真实 runtime 消费压缩摘要、kept range 和选定分支，保留 fork parentSession；丢弃分支答复不送模型。
- task：已有任务链绑定旧独立 session，已完成 toolResult 进入新请求，不重执行 fixture-tool，不污染聊天；关闭只记一次。
- interrupted：启动不自动提交失败备用请求；下一条输入正常请求，raw 历史保留。
- Azure：保留旧 `azure-openai-responses` model_change，当前显式 `azure/fixture-deployment` 设置选中目标模型，medium thinking 到达 mock request。此处只证明恢复身份/选择，不证明真实 Azure endpoint 或 credential。

补强未增加用例：计划在准备后固定失败分支 ID 前缀，避免回退到原输入之前被误判为 unsubmitted；host 在模型恢复前检查故障，避免以缓存中的未落盘 entry 写 metadata；bootstrap 是否可见改读 canonical projection，其余反思/source window/search/recovery 继续保留 raw 用途。无新顶层模块、架构例外或公开导出变化；裸 Agent 子代理保持原内存重试语义。

## 发布阻断与操作交付

已更新配置/架构/部署操作手册及双语 Unreleased changelog，明确安装身份、Azure 字段迁移、单写者一致备份、灰度与两种回退时点。

| 发布项目 | 状态 |
|---|---|
| 实际生产 provider 清单与真实 API key/legacy OAuth/OpenRouter/代理 smoke | 待部署者在独立测试 home/项目验收，未读取生产凭证 |
| 新 OpenAI ChatGPT OAuth 登录、稳定重登、取消、重启流/工具 | 待真实账号验收 |
| Azure（若使用）真实目标模型/endpoint/credential | 待验收；mock 不关闭此项 |
| 钉钉 AI Card / TUI 受控工具、停止、最终完成 smoke | 待真实传输验收 |
| 升级前一致应用/项目快照、匹配旧包离线回退演练 | 待部署阶段执行 |
| 生产灰度、发布版本/commit、恢复入口/调度 | 未执行、未发布 |

实际模型费用：0。未操作生产 app home 或部署进程。缺真实账号、目标部署和传输入口时保持发布阻断；不能用此次离线绿灯替代 P6。

## 日志取证

本地完整日志归档：`/tmp/pi055-validation-logs.tar.gz`，包含原版基线、最终双 Node 门禁、
四项 mutation、一次既有 unit 超时及独立重跑。归档 SHA-256：`49accc22f4a2f85bfbd9090d3a143da20de3b0c7206fb63838446d780c341643`。
最终部署 Node check 86.79s / e2e 75.38s；最低 Node check 106.84s / e2e 79.97s。
这些是本机结果，不承诺其它机器耗时。日志只使用隔离测试数据；正式发布仍需匹配最终 commit 重新记录 P6。

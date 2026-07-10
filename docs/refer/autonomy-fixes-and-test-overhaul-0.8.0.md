# 0.8.0 自主长程能力：修复 + 测试体系整改报告

- 日期：2026-07-11
- 承接：[autonomy-review-0.8.0.md](./autonomy-review-0.8.0.md)（设计评审）与 [autonomy-test-report-0.8.0.md](./autonomy-test-report-0.8.0.md)（TUI 实测发现）
- 本轮内容：修复实测发现的 4 个问题、重新设计 e2e 测试、评审并补全非 e2e 测试套件
- 验证状态：`npm run build` / `npm run check`（lint + typecheck + deadcode + 737 单测，102 文件）/ `npm run test:e2e`（14 测试，9 文件）**全部通过**

## 一、修了什么

### 发现 A — `pipiclaw tui --print` 下内建斜杠命令静默失效（高，功能性 bug）

**根因**：`src/tui/turn-controller.ts` 的 `runOnce()`（`--print` 专用路径）直接调用 `beginTurn()`，从未经过 `dispatch()`——交互模式的 `submit()` 会先判定 `/tasks`/`/events`/`/status`/`/usage` 等命令走零 LLM 路径，`--print` 完全跳过了这层判定，把斜杠命令当普通文本喂给模型。

**修复**：`runOnce()` 改为调用 `processSubmit()`（与交互模式共享同一套 `dispatch()` 判定），再等待可能被触发的 turn 结束。三行改动，无新增分支。

**回归测试**：`test/tui-turn-controller.test.ts` 新增 `describe("TurnController.runOnce")`，覆盖"斜杠命令零 LLM 解析"“普通 prompt 正常跑 runner”“无 prompt 时干净关闭”三种情形；`test/e2e/tui.test.ts` 新增一条真实 `--print` + 真实模型的端到端用例，断言输出**逐字等于**确定性渲染字符串 `"# Tasks\n\nNo active tasks."`——这是唯一能证明"模型确实没被调用"的断言方式，而非"看起来像任务列表"。

### 发现 B — DoD/Verification 验收闸门可被格式绕过（高，验收闸门失效）

**根因**：`uncheckedTaskAcceptanceItems()`（`src/shared/task-ledger.ts`）只识别 `- [ ] ` 复选框语法；DoD 写成编号列表或纯文字时，函数返回空数组——与"全部勾选完成"无法区分，导致 `task_manage candidate`/`done` 全程放行，独立验收链路走了个寂寞。

**修复**（双保险）：
1. `uncheckedTaskAcceptanceItems()` 新增判定：DoD 段落有内容但一个复选框都没有 → 返回明确的"DoD has no checklist items"提示，而不是静默判定为"已完成"。
2. `task_manage create` 现在在落盘前就跑这条检查，格式不对当场拒绝（而不是等到 `candidate`/`done` 才发现），并把工具 schema 里 `dod` 字段的描述改成明确要求 checkbox 格式。

**回归测试**：`test/task-ledger.test.ts` 三条新用例（无 checkbox 判定为未完成 / Verification 允许纯文字不受影响 / 空 DoD 不误报）；`test/task-manage.test.ts` 两条新用例（`create` 直接拒绝编号列表 DoD；防御性验证——绕过 `create` 手写的任务文件丢了 checkbox，`candidate` 仍然拦截，证明闸门不只在创建时生效）。TUI 实测复现：真实模型故意写编号列表 DoD，`task_manage create` 当场报出准确错误信息。

### 发现 C — TUI 下 `/tasks approve` 审批人恒为 `"unknown-user"`（低，审计字段失真）

**根因**：`src/tui/app.ts` 调用 `handleTasksCommand` 时没传 `approver`（DingTalk 侧会传 `event.userName`/`event.user`），落到硬编码兜底值。

**修复**：一行改动，把已有的 `safeUserName()`（本地用户名，欢迎语已在用）传给 `runTasks`。TUI 实测复现：`/tasks approve` 后 `approvalBy` 从 `"unknown-user"` 变成真实用户名。

### 发现 D（新增，写测试时发现）— IPv6 括号字面量 URL 绕过快速路径（中，功能 bug，非安全漏洞）

**背景**：为 `security/network.ts`（SSRF 出站防护）补测试时发现：WHATWG `URL.hostname` 对 IPv6 字面量保留方括号（`new URL("http://[::1]/").hostname === "[::1]"`），而 `isIP("[::1]")` 返回 0（无法识别）。这导致**所有** IPv6 字面量 URL（不分公网私网）都跳过直接 IP 判定，落到 `dns.lookup("[::1]", ...)` 这类必然失败的解析——实际效果是所有 IPv6 字面量 URL 都会被拒绝（多数情况下是合法公网地址被误杀成 `dns-failure`，而不是被正确识别为 `private-address`），不是被放行绕过防护。

**修复**：`normalizeHost()` 剥离外层方括号后再做后续判断。

**回归测试**：新增 `test/security-network-guard.test.ts`，30 条用例直接对 `validateNetworkTarget`/`validateRedirectTarget` 做穷举覆盖（8 个 IPv4 私有段、3 个 IPv6 私有段、公网 IPv4/IPv6 字面量、DNS 解析成功/失败、`allowedHosts`/`allowedCidrs` 白名单绕过、guard 关闭、非法 URL、非 http(s) scheme、redirect 阶段）。此前该模块只被 `web-fetch-security.test.ts` 间接覆盖 3 个场景，IPv6 分支和多数 CIDR 边界完全没测过。

## 二、e2e 测试重新设计

### 评估结论

原有 7 个 e2e 文件（`basic-conversation` / `builtin-command` / `memory-bootstrap` / `session-memory` / `tool-read` / `tool-write` / `tui`）**全部保留**：每个测的都是不同、不重叠的真实运行时集成面（基础对话、内建命令、记忆注入、SESSION.md 后台维护、read/write/bash 工具、TUI 独立传输层），没有低价值或冗余的。这套 harness 本身设计得很扎实——真实 `bootstrap`/`ChannelRunner`/真实 LLM/真实工具，只 mock 钉钉传输层，`tui.test.ts` 更是唯一一处不 mock 传输层、走真实 `pipiclaw tui --print` 的用例。**没有删除任何文件。**

发现一处环境摩擦：默认 provider/model 硬编码为 `anthropic/claude-sonnet-4-5`，本地 `models.json` 若配的是其他网关（如本机的 `zpai`），不设 `PIPICLAW_E2E_PROVIDER`/`PIPICLAW_E2E_MODEL` 环境变量整套 e2e 会直接跑不起来，且此前未见任何文档提及。已在 `README.md` 补充说明。

### 新增/扩展（聚焦"单测测不到、这次实测又证明有真实风险"的场景）

| 文件 | 内容 | 为什么值得加 |
|---|---|---|
| `test/e2e/tui.test.ts`（扩展） | `--print` 下 `/tasks` 走零 LLM，断言逐字匹配确定性字符串 | 发现 A 的直接回归；此前 0 个 e2e 覆盖 TUI 的内建命令 |
| `test/e2e/builtin-command.test.ts`（扩展） | DingTalk 传输层下 `/tasks` 同样零 LLM | 与上条对照，证明两条传输层行为一致，非各自为政 |
| `test/e2e/tasks-lifecycle.test.ts`（新增） | 真实模型：自然语言创建受治理任务 → 注入生产同款 driver 唤醒文本 → 断言任务被推进/checkpoint | 此前任务台账 0 个 e2e 覆盖；只有真实模型才能验证"模型是否真的按 SOP 跑通全流程"，单测只能验证工具函数本身 |
| `test/e2e/events-guard.test.ts`（新增） | 真实模型调用 `event_manage`：immediate 类型被拒绝且不落盘；合法 periodic 事件正确写入 | events 闸门此前 0 个 e2e 覆盖；验证的是"模型的工具调用是否真的撞上闸门"，而非闸门函数本身（单测已覆盖） |

跑下来（本机 `zpai/glm-5-turbo`）：9 个文件、14 个测试，约 130 秒，全绿。

## 三、非 e2e 测试套件评审

### 结论：整体质量高，没有发现值得删除的低价值测试

90 个测试文件、14534 行，按 src/ 的模块边界分层组织（memory 子系统单独拆了十几个文件、security 分 guard 级和 tool 集成级两层、tui 每个协作者独立测），没有 `.skip`/`.todo`，没有明显的名不副实或纯 tautology 测试。这与评审报告里对项目工程质量的正面判断一致。

### 补充的 7 个真实覆盖缺口

逐一核对 122 个 src 文件与 90 个测试文件的映射关系后，找出完全没有任何测试引用的模块，按风险和成本排序后选取以下 7 个（均为廉价、确定性、值得长期维护的单测，非临时凑数）：

| 新文件 | 覆盖模块 | 为什么是缺口 |
|---|---|---|
| `test/serial-queue.test.ts` | `shared/serial-queue.ts` | CLAUDE.md 明确点名的并发原语，撑着 run-queue 和 channel-maintenance-queue 两处"重要且容易出错"的机制，此前零测试 |
| `test/run-queue.test.ts` | `agent/run-queue.ts` | 每个 channel 串行化 turn 的关键队列，零测试 |
| `test/artifact-subject.test.ts` | `tasks/artifact-subject.ts` | 独立验收 PASS 与代码产物绑定的哈希计算，零测试；覆盖未提交/已暂存/新文件/跨 commit 场景 |
| `test/security-logger.test.ts` | `security/logger.ts` | 所有安全拦截事件的审计落盘，零测试 |
| `test/memory-promotion.test.ts` | `memory/promotion.ts` | 决定是否**自动**写入 memory/skill（无需用户确认）的置信度阈值门禁，零测试 |
| `test/memory-promotion-signals.test.ts` | `memory/promotion-signals.ts` | 判断一轮对话是否值得进入晋升评估的正则信号扫描，零测试 |
| `test/security-network-guard.test.ts` | `security/network.ts`（SSRF 防护） | 见上文发现 D；30 条用例，穷举 IPv4/IPv6 私有段、白名单绕过、guard 开关、异常输入 |

### 有意不做的事

`agent/channel-runner.ts`（1077 行，最大的编排器文件）同样零直接单测，但评估后判断**不值得现在补**：它深度耦合 `@earendil-works/pi-coding-agent` SDK（`Agent`/`AgentSession`/`ModelRegistry` 等），要单测就得搭一整套 SDK mock，工作量大、脆弱、还容易测出假信心。它的实际防线是：(1) 每个 e2e 用例都通过真实 bootstrap 完整驱动它；(2) 它调用的协作者——`prompt-builder`/`model-fallback`/`session-events`/`context-budget`/`progress-formatter`/`run-queue` 等——都各自有独立单测。建议：往后再拆分逻辑时，优先把可判定的纯函数继续挪出 `channel-runner.ts`，而不是给这个整体搭一层重度 mock 的测试。

`web/client.ts`、`web/search-providers.ts` 也无直接单测，但通过 `web-fetch*.test.ts`/`web-search.test.ts` 间接覆盖得足够充分（mock axios + dns 后走真实业务逻辑），判断不需要重复的直接单测。

## 四、验证记录

```
npm run build         ✓
npm run check         ✓  lint / typecheck / deadcode(knip) / 737 tests, 102 files
PIPICLAW_E2E_PROVIDER=zpai PIPICLAW_E2E_MODEL=glm-5-turbo npm run test:e2e
                       ✓  14 tests, 9 files, ~131s
```

## 五、变更清单

```
修改：
  README.md                        补充 e2e provider/model 环境变量说明
  src/security/network.ts          修复 IPv6 括号字面量绕过快速路径（发现 D）
  src/shared/task-ledger.ts        DoD 无 checkbox 时不再静默放行（发现 B）
  src/tools/task-manage.ts         create 阶段前置校验 + schema 描述强调 checkbox 格式（发现 B）
  src/tui/app.ts                   /tasks approve 传入真实本地用户名（发现 C）
  src/tui/turn-controller.ts       runOnce 复用 dispatch()，--print 下斜杠命令零 LLM（发现 A）
  test/e2e/builtin-command.test.ts +1 用例：DingTalk 侧 /tasks 零 LLM
  test/e2e/tui.test.ts             +1 用例：--print 侧 /tasks 零 LLM（发现 A 回归）
  test/task-ledger.test.ts         +3 用例：DoD 无 checkbox 判定
  test/task-manage.test.ts         +2 用例：create 拒绝 + 防御性绕过测试
  test/tui-turn-controller.test.ts +3 用例：runOnce 全新 describe 块

新增：
  docs/refer/autonomy-review-0.8.0.md        （已在上一轮交付）
  docs/refer/autonomy-test-report-0.8.0.md   （已在上一轮交付）
  test/e2e/tasks-lifecycle.test.ts           任务全生命周期 e2e
  test/e2e/events-guard.test.ts              events 闸门 e2e
  test/serial-queue.test.ts
  test/run-queue.test.ts
  test/artifact-subject.test.ts
  test/security-logger.test.ts
  test/security-network-guard.test.ts        含发现 D 的完整回归覆盖
  test/memory-promotion.test.ts
  test/memory-promotion-signals.test.ts
```

# 069：实施计划

| 字段 | 内容 |
| --- | --- |
| 状态 | 已实施，见 [验收记录](./acceptance.md) |
| 日期 | 2026-11-18 |
| 设计 | [design.md](./design.md)，D1–D5，不变量 I1–I7 |
| 交付顺序 | Phase 1 → Phase 2 → Phase 3（每阶段独立闭环验证，可单独审阅与回退） |

## 1. 实施前基线核对

实施 Agent 开始动手前须完成以下步骤：

1. 阅读 [`AGENTS.md`](../../../AGENTS.md)、`CLAUDE.md` 与 [`design.md`](./design.md)，确认当前 HEAD revision 及工作区未提交文件（保留既有 `dev-docs/reviews/` 文档，禁止 `git reset --hard` 或覆盖无关修改）。
2. 执行起始基线检查并记录结果：
   ```bash
   npm run check
   npm run playbooks:measure
   npm run test:e2e
   ```
3. 核查涉及文件的行数预算（800 行硬帽，`scripts/architecture-baseline.json` 只减不增）：本次涉及的 `worker.ts`（252 行）、`internal/run.ts`（322 行）、`external/run.ts`（527 行）、`sections.ts`（290 行）、`manifest.ts`（226 行）、`brief.ts`（260 行）、`event-manage.ts`（418 行）、`subagent.ts`（191 行）均有充足空间，无需新增超长例外。

---

## 2. 三阶段工作包总览

| 阶段 | 核心目标 | 涉及文件 | 阶段完成判据 |
| --- | --- | --- | --- |
| **Phase 1：缓存闭环与缺陷修复** | 1. 内置 worker 传入 `sessionId` 并在结束/失败时调用 `cleanupSessionResources`<br/>2. 外部 `follow_up` 对非 flag 型 CLI 的 `stdin` 去重 `systemPrompt`（保留 `claude-code` flag）<br/>3. `runSidecarTask` 显式设 `cacheRetention: "none"`<br/>4. 修复 `SUBAGENTS_SECTION` 悬空 `task-lead.md` 引用、修正 `PLAYBOOKS_SECTION.cacheClass` 与过时注释<br/>5. `/context` 补充会话实际缓存读取率 | `src/subagents/internal/worker.ts`<br/>`src/subagents/internal/run.ts`<br/>`src/subagents/external/run.ts`<br/>`src/memory/sidecar-worker.ts`<br/>`src/agent/prompt/sections.ts`<br/>`src/agent/prompt/types.ts`<br/>`src/agent/prompt/manifest.ts`<br/>`src/agent/channel-runner.ts` | `npm run check` + `npm run test:e2e` 全绿；单测覆盖内置 worker `sessionId` 传递与清理、外部续接 `stdin` 去重 vs `claude-code` flag 保留、sidecar `cacheRetention: "none"` |
| **Phase 2：Prompt 对称化、收敛判据与短路径工具契约** | 1. `IDENTITY_SECTION` 与 `TASK_CORE_SECTION` 按 `task_create` / `task_report` 对称分支（保留任务先读指南纪律）<br/>2. `TaskBrief` 移除重复 `STEP_RULES` 散文，保留 `task-lead.md` 必读指针<br/>3. `EXECUTION_SECTION` 补齐“达标即停”判据与明确读指南边界，`RUNTIME_PROMPT_VERSION` 升至 `5`<br/>4. `event_manage` 净化 `"immediate"` / `timeout` schema 并补一次提醒短路径；`subagent` 工具描述对齐 | `src/agent/prompt/sections.ts`<br/>`src/agent/prompt/builder.ts`<br/>`src/tasks/brief.ts`<br/>`src/tools/event-manage.ts`<br/>`src/tools/subagent.ts` | `runtimeAuthoredUnits <= 700`、`toolSchemas.units <= 3000`；`npm run check` + `npm run test:e2e` 全绿；定向行为探针验证短路径与收敛行为 |
| **Phase 3：Playbooks 渐进拆分与 Sub-Agents 模板升级** | 1. 将 `task-lead.md` 拆分为主干 `task-lead.md`（≤ 800u）+ 按需 `task-verify.md`（`order: 71`），`task-recovery.md` 顺延 `72`<br/>2. 补齐 `delegation-inline`、`event-sensors`、`event-task-template` 1 跳自足要素，精简 `runtime-orientation`，校准目录触发词<br/>3. `examples/sub-agents/` 新增 `pi-scout.md`，拆分可写执行（7 条）与只读审查/侦察（6 条）正文，去重全部 12 个条目 `description`<br/>4. 同步文档、测量脚本、评测依赖图与示例加载单测 | `src/playbooks/*.md`<br/>`dev-docs/runtime-playbooks.md`<br/>`scripts/measure-playbooks.mjs`<br/>`evals/cases/catalog.ts`<br/>`examples/sub-agents/*.md`<br/>`docs/sub-agents.md`<br/>`test/subagent-phase1.test.ts`<br/>`test/playbooks.test.ts` | `npm run playbooks:measure` 确认 `task-lead.md <= 800u`；`npm run check` + `npm run test:evals` + `npm run test:e2e` 全绿；完成行为评测与 `acceptance.md` 归档 |

---

## 3. Phase 1 实施细则：缓存闭环与缺陷修复

1. **内置子代理 `sessionId` 与资源释放（D1.1）**：
   - 在 [`src/subagents/internal/worker.ts`](../../../src/subagents/internal/worker.ts) 的默认 `new Agent({...})` 中传入 `sessionId: runContext.runId`。
   - 在 [`src/subagents/internal/run.ts`](../../../src/subagents/internal/run.ts) 导入 `cleanupSessionResources`（来自 `@earendil-works/pi-ai`），在 `runToCompletion` 的 `finally` 块与 `failSetup` 中调用 `cleanupSessionResources(runContext.runId)`。
2. **外部子代理续接 `stdin` 去重（D1.2）**：
   - 在 [`src/subagents/external/run.ts`](../../../src/subagents/external/run.ts) 中更新 `buildStdinContent(harness, input.systemPrompt, input.task, Boolean(input.resumeSessionId))`：
     - `harness.acceptsSystemPromptFlag === true` 时保持原逻辑（`stdin` 仅 `task`，非空 `systemPrompt` 仍写 `system-prompt.txt` 并传 flag）；
     - `!harness.acceptsSystemPromptFlag && Boolean(input.resumeSessionId)` 时，`stdin` 仅输出 `${input.task.trim()}\n`，且不写未发送的 `system-prompt.txt`。
3. **一次性 Sidecar `cacheRetention: "none"`（D1.3）**：
   - 在 [`src/memory/sidecar-worker.ts`](../../../src/memory/sidecar-worker.ts) 的 `runSidecarTask` `streamFn` 中传入 `cacheRetention: "none"`。
4. **常驻提示悬空引用与元数据修正（D2.3 部分）**：
   - 在 [`src/agent/prompt/sections.ts`](../../../src/agent/prompt/sections.ts) 修复 `SUBAGENTS_SECTION` 第 205 行（移除对聊天不可见的 `task-lead.md` 引用，统一自足交接五要素描述），并将 `PLAYBOOKS_SECTION.cacheClass` 改为 `"runtime-stable"`；
   - 在 [`src/agent/prompt/types.ts`](../../../src/agent/prompt/types.ts) 与 [`src/agent/prompt/manifest.ts`](../../../src/agent/prompt/manifest.ts) 修正关于 SDK 追加“日期”的陈旧注释和文案。
5. **`/context` 实际缓存读取率（D1.4）**：
   - 在 [`src/agent/prompt/manifest.ts`](../../../src/agent/prompt/manifest.ts) 与 [`src/agent/channel-runner.ts`](../../../src/agent/channel-runner.ts) 的 `renderContextReport` 接入当前会话累计 `input` / `cacheRead` / `cacheWrite`，有请求记录时展示缓存读取占比（遵循 `spec 053` 对外中文文案规范，不引入生造术语）。
6. **Phase 1 测试要求**：
   - 优先扩展现有测试文件（[`test/subagent-external-envelope.test.ts`](../../../test/subagent-external-envelope.test.ts) 或外部派发单测、内置 worker 单测、`test/prompt-sections.test.ts`、sidecar 单测）；
   - 验证点：内置 worker 请求 `options.sessionId === runId`；`codex-cli` / `antigravity-cli` 在 `follow_up` 时 `stdin` 不含 `role.systemPrompt` 而首轮包含；`claude-code` 在 `follow_up` 时仍携带 `--append-system-prompt-file`；`runSidecarTask` 传递 `cacheRetention: "none"`；聊天工具集下 `SUBAGENTS_SECTION` 不出现 `task-lead.md`。
   - 保持单元测试净增 ≤ 1（仅在现有测试文件无对应请求捕获桩时新增 1 个用例并写明捕获的回归风险），确定性 E2E 净增 0。

---

## 4. Phase 2 实施细则：Prompt 对称化、收敛判据与短路径契约

1. **Chat / Task 常驻段对称化（D2.1）**：
   - 更新 [`src/agent/prompt/sections.ts`](../../../src/agent/prompt/sections.ts) 的 `IDENTITY_SECTION` 与 `TASK_CORE_SECTION`（`requiresAllTools: ["task_close"]`）：
     - `hasTool(context, "task_create")` 分支服务聊天会话（及全量工具合成测试），保留立项条件并要求**创建或管理任务前先读 `task-manage.md`**；
     - `hasTool(context, "task_report")` 分支服务后台任务会话，声明静默步骤日志 vs `task_report`/`task_ask`、四类等待边界、未知副作用先核查，并要求**首步或压缩丢失后先读 `task-lead.md`**。
   - 更新 [`src/tasks/brief.ts`](../../../src/tasks/brief.ts)：删去与常驻段重复的 `STEP_RULES` 常量文本，保留契约文件路径与 `full` 模式下读取 `join(PLAYBOOKS_DIR, "task-lead.md")` 的指令行。
2. **执行纪律与收敛停止判据（D2.2）**：
   - 更新 `EXECUTION_SECTION`：加入“改动与必需验证通过且无新改动/未决缺口即停止探查并交付”、`<runtime_turn_context>` 双路径直用、以及清晰的短路径 vs 读指南触发条件；
   - 将 [`src/agent/prompt/builder.ts`](../../../src/agent/prompt/builder.ts) 的 `RUNTIME_PROMPT_VERSION` 升至 `5`。
3. **工具 Schema 与短路径说明（D3）**：
   - 更新 [`src/tools/event-manage.ts`](../../../src/tools/event-manage.ts)：移除 schema 中的 `"immediate"` 字面量与 `preAction.timeout` 重复字段（保留运行时 `validateDefinition` 的可恢复错误与兼容转换），更新顶层 `description` 支持单次确切提醒直调；
   - 更新 [`src/tools/subagent.ts`](../../../src/tools/subagent.ts) 的 `subagent` 顶层 `description`。
4. **Phase 2 测试要求**：
   - 运行 [`test/prompt-sections.test.ts`](../../../test/prompt-sections.test.ts)、[`test/task-brief.test.ts`](../../../test/task-brief.test.ts) 及 `event_manage` 工具单测，确认：
     - 聊天 profile、任务 profile 以及合成全工具集下的 `runtimeAuthoredUnits` 均 `<= RUNTIME_PROMPT_TARGET_UNITS`（`700`）且无 `warning` / `error` 诊断；
     - 聊天工具集 `measureToolSchemas` `<= TOOL_SCHEMA_TARGET_UNITS`（`3,000`）；
     - 故意向 `manageEvent` 传入 `type: "immediate"` 或 `preAction.timeout` 时，运行时校验与转换行为与修改前完全一致。
   - 单元测试与确定性 E2E 净增目标均为 0（复用并扩展现有断言，不添加绑死提示词字面句子的脆弱断言）。

---

## 5. Phase 3 实施细则：Playbooks 渐进拆分与 Sub-Agents 模板升级

1. **拆分 `task-lead.md` 与新增 `task-verify.md`（D4.1）**：
   - 精简 [`src/playbooks/task-lead.md`](../../../src/playbooks/task-lead.md)（`order: 70`，`requires-tools: task_report`）至 **≤ 800 单位**，完整保留首步必读的步骤推进、Brief 使用、契约 DoD/工作项 `edit` 勾选、等待表、基础验收与五步关单流程，在多工作项独立核验/返工与复杂外部交付处链接 `[核验与返工](task-verify.md)`；
   - 新建 `src/playbooks/task-verify.md`（`order: 71`，`requires-tools: task_report`），承载分片 vs 终验 `purpose=verify`、`VERDICT` 判断、`FAIL` 缺陷与验证受阻分流、返工交接顺序与外部发布/附件回执记录；
   - 将 [`src/playbooks/task-recovery.md`](../../../src/playbooks/task-recovery.md) 的 `order` 由 `71` 更新为 `72`。
2. **叶子手册 1 跳自足与触发词打磨（D4.2）**：
   - 更新 `delegation-inline.md`、`event-sensors.md`、`event-task-template.md` 补齐就地安全要素；精简 `runtime-orientation.md` 第三节重复内容；校准各手册 frontmatter `description`；
   - 同步更新：
     - [`dev-docs/runtime-playbooks.md`](../../runtime-playbooks.md) 目录顺序与门控表；
     - [`scripts/measure-playbooks.mjs`](../../../scripts/measure-playbooks.mjs)（新增 `task + verify + delegation` 等组合测量行，确认常规 `task + delegation` 进一步下降）；
     - [`evals/cases/catalog.ts`](../../../evals/cases/catalog.ts)（所有依赖 `src/playbooks/task-lead.md` 的评测家族同步加上 `src/playbooks/task-verify.md`）。
3. **子代理模板升级与 `pi-scout.md` 落地（D5）**：
   - 新建 `examples/sub-agents/pi-scout.md`（`runtime: internal`、`tools: read,grep,glob`、`workload: light`、`mutates: read`）；
   - 将 10 个 `mutates: write` 模板正文统一更新为 7 条可写执行约定（含达标即停条款），将 `codex-review.md` 与 `pi-scout.md` 正文统一更新为 6 条只读审查/侦察约定（含区分已证实缺陷与沙箱受阻检查）；
   - 精简全部 12 个模板的 `description`，去除同质化套话；
   - 更新 [`test/subagent-phase1.test.ts`](../../../test/subagent-phase1.test.ts) 的 `loads every shipped capability entry` 用例以按 `runtime` 分支校验 `external` 与 `internal` 只读条目（用例净增 0）；
   - 同步更新 [`examples/sub-agents/README.md`](../../../examples/sub-agents/README.md) 与 [`docs/sub-agents.md`](../../../docs/sub-agents.md)（注意检查表格行数、条目计数“十二个条目”与安装命令示例）。

---

## 6. 验证门禁、Mutation 检查与行为评测方案

### 6.1 离线工程门禁与破坏性验证（Mutation Checks）

每一阶段及最终合入前必须通过：

```bash
npm run build
npm run playbooks:measure
npm run check
npm run test:evals
npm run test:e2e
git diff --check
```

关键机制改动须执行一次性破坏验证并记录到 `acceptance.md`：
1. 去掉 `internal/worker.ts` 的 `sessionId: runContext.runId` → 对应单测必须变红；
2. 去掉 `external/run.ts` 续接分支的 `isResume` 判断 → 非 flag 型 harness `follow_up` 单测因 `stdin` 出现重复 `systemPrompt` 必须变红；
3. 在 `dev-docs/runtime-playbooks.md` 漏更 `task-verify.md` 或在手册中写断链 → `test/playbooks.test.ts` 必须变红；
4. 给 `pi-scout.md` 加入 `write` 或 `bash` 工具而保持 `mutates: read` → `test/subagent-phase1.test.ts` 的只读边界断言必须变红。

### 6.2 真实模型行为探针（Behavior Evals）

当本地模型凭据可用时，按 [`dev-docs/evals.md`](../../evals.md) 流程运行 `npm run eval -- plan --changed-since <起始基线>` 并执行以下定向验证（运行前必须先通过正/负/等价 oracle controls，保留全部原始 `runId` 与失败证据，严禁覆盖失败或修改评分器放行）：

| 验证目标 | 推荐探针场景 | 观察指标 |
| --- | --- | --- |
| 日常核心回归 | 六例 `dev` 集（`C-fix-01`、`M-overflow-01`、`T-job-01`、`D-verify-01`、`U-desk-cwd-01`、`S-inject-core-01`） | 通过率、安全违规为 0、离线回放一致性 |
| 常规短路径提速 | `E-schedule-01`、`A-route-01` | 首次有效工具调用正确率保持，观察单次确切提醒与常规角色路由的模型请求轮数及总输入单位 |
| 达标收敛防超预算 | `U-desk-cwd-01`、`M-compaction-01` | 目标修改与校验完成后是否在默认回合预算内正常输出最终答复，不再陷入无休止复查 |
| 持久任务先读精简主干与续接 | `T-ask-01`、`T-horizon-01` | 首步正常读取精简后的 `task-lead.md`，提问、等待、DoD 勾选、`task_report` 与 `task_close` 顺序完整，缓存读取占比健康 |

若凭据不可用无法执行付费探针，须在 `acceptance.md` 如实标注“仅完成离线门禁，真实模型行为探针待执行”，不得将离线通过表述为行为质量已验证。

### 6.3 交付归档

全部三阶段完成后，在本目录新增 `acceptance.md`，完整记录：
- 起始与结束 commit、变更文件清单；
- 系统提示词单位、工具 Schema 单位、12 个子代理目录字符数、以及 `npm run playbooks:measure` 各路径前后对比表；
- 单元测试、评测工具测试、确定性 E2E 通过数与用例净变化（预期总净变化 `0` 至 `+1`）及 mutation 记录；
- 真实模型探针 `runId`、请求轮数、缓存读取 token 占比及残留风险说明。

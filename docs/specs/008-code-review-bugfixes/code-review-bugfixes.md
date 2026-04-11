# 深度代码审查 Bugfix 修复

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | DONE |
| 日期 | 2026-04-11 |
| 审查报告 | 已删除（信息归档至本文档） |

---

## 概述

2026-04-11 对 Pipiclaw 进行了首次深度代码审查，覆盖 `src/` 全量源码（72 源文件 / 65 测试 / 14238 行 TS），重点深审 memory 子系统的 8 个文件，结合 `test/`、`test/integration/`、`test/e2e/` 评估覆盖情况。

审查发现 9 项问题（1 Critical + 3 High + 5 Medium），本次修复了其中 5 项，跳过 1 项，4 项暂未处理。

## 修复总览

| ID | 严重度 | 问题 | 状态 | 提交 |
|----|--------|------|------|------|
| S2 | High | preAction 绕过 sandbox | ✅ 已修复 | `dacac3c` |
| R1 | High | shutdown 顺序错误 | ⏭️ 跳过 | — |
| R2 | High | memory 并发写入竞争 | ✅ 已修复 | `361c8be` |
| Q1 | Medium | read 工具行数 off-by-one | ✅ 已修复 | `45df8c6` |
| Q2 | Medium | settings 兼容 getter 硬编码 | ✅ 已修复 | `45df8c6` |
| S1 | Critical | Jina 网络守卫绕过 | 🔲 待处理 | — |
| P1 | Medium | memory append O(n) I/O | 🔲 待处理 | — |
| Q3 | Medium | SDK 私有字段耦合 | 🔲 待处理 | — |
| T1 | Medium | 测试覆盖缺口 | 🔲 部分已补 | — |

---

## S2: preAction 绕过 Sandbox

### 问题

事件系统的 `preAction` 只经过 `commandGuard`，实际执行用的是 `child_process.exec()`，没有复用 `sandbox.ts` 的 `Executor`。即使主运行时配置成 Docker sandbox，事件前置动作仍在宿主机执行。

### 修复

- **注入 Executor 到 EventsWatcher**：构造函数和工厂函数新增 `executor` 参数
- **替换执行方式**：`runPreAction()` 从 `child_process.exec()` 改为 `await this.executor.exec()`
- **统一安全边界**：`bootstrap.ts` 创建共享 Executor 并传给 EventsWatcher，与工具链使用同一 sandbox 策略
- **修复 timeout 单位**（审查中额外发现）：`preAction.timeout` 语义为毫秒，`Executor.exec()` 期望秒，转换规则 `Math.max(1, Math.ceil(ms / 1000))`

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/runtime/events.ts` | 移除 `child_process.exec`，注入 `Executor`，`runPreAction()` 改用 `executor.exec()` |
| `src/runtime/bootstrap.ts` | 创建共享 `Executor` 传给 EventsWatcher，更新注入签名 |
| `test/events.test.ts` | 修复构造签名，新增 mock Executor，补 timeout 单位转换单测 |

---

## R1: shutdown 顺序错误（跳过）

### 问题

`shutdownWithReason()` 先 `bot.stop()` 再等 `activeTasks`，仍在运行的 `ChannelRunner` 在 transport 关闭后无法完成最终回复。

### 跳过原因

Codex 分析发现 `bot.stop()` 关闭的是 stream 连接和入站队列，但出站 API（`sendPlain` / `replaceCard` / `appendToCard` / `finalizeCard`）并没有检查 `isStopped`，仍然可以走 HTTP API 发送。因此当前代码下"transport 一停就必然失败"的证据不足。

实际定性为 **Medium-High**（语义脆弱、依赖实现细节的偶然耦合），而非严格 High。一旦有人给出站方法加 `isStopped` 防护，当前顺序会变成真 bug。

### 建议方向（未实施）

最小重排：`shuttingDown = true` → `eventsWatcher.stop()` → 等/abort `activeTasks` → flush memory → `bot.stop()`

---

## R2: memory 并发写入竞争

### 问题

- `backgroundQueue` 只串行后台任务，`runPreflightConsolidation()` 不走这条队列
- "inline consolidation" 和 "background maintenance" 可以并发写入同一组 `MEMORY.md` / `HISTORY.md`
- `writeAtomically()` 使用固定 `.tmp` 文件名，并发 rename 会竞争

### 修复

- **统一串行队列**：`backgroundQueue` 重命名为 `durableMemoryQueue`，所有 MEMORY/HISTORY 写入（preflight、idle consolidation、background maintenance、shutdown flush）统一排队
- **泛型串行执行器**：`runDurableMemoryJobSerial<T>()` 支持返回值，`enqueueDurableMemoryJob()` 用于 fire-and-forget，错误被捕获不毒死队列
- **拆分 preflight**：`runPreflightConsolidation()` 拆为外层排队 + 内层 `runPreflightConsolidationNow()` 执行
- **唯一临时文件名**：`writeAtomically()` 改用 `${path}.${process.pid}.${randomUUID()}.tmp`
- **SESSION.md 不变**：`sessionRefreshQueue` 保持独立，因为它写不同文件

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/memory/lifecycle.ts` | durableMemoryQueue 统一串行化，preflight 拆分 |
| `src/memory/files.ts` | 临时文件名改为 `${pid}.${uuid}.tmp` |
| `test/memory-lifecycle.test.ts` | 适配排队语义，补回归测试 |
| `test/memory-files-concurrency.test.ts` | **新增**：唯一临时文件 + 并发写隔离测试 |

---

## Q1: read 工具行数 off-by-one

### 问题

`read` 工具用 `wc -l` 后 `+1` 推导总行数。对以换行结尾的正常文本文件多算 1 行，空文件返回 1 行，导致 offset 越界判断、`[N more lines]` 提示等全部偏移。

### 修复

- **替换行数命令**：`wc -l` → `awk 'END { print NR }'`，去掉 `+1`
- **新增辅助函数**：`countTextLines()` 基于已读取内容计算真实行数，正确处理空文件和换行结尾
- **修正 offset 边界**：空文件 offset 判断单独处理

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/tools/read.ts` | awk 替代 wc -l，新增 countTextLines() |
| `test/read.test.ts` | 补空文件、换行结尾、非换行结尾三类测试 |

---

## Q2: settings 兼容 getter 返回硬编码值

### 问题

`getCompactionSettings()` 会合并 `settings.json` 中的值，但 `getCompactionReserveTokens()`、`getCompactionKeepRecentTokens()`、`getBranchSummarySettings()` 直接返回硬编码默认值，用户配置被忽略。

### 修复

三个兼容 getter 统一从 `this.getCompactionSettings()` 派生。

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/settings.ts` | 三个 getter 改为委托到 `getCompactionSettings()` |
| `test/context.test.ts` | 补自定义 compaction 值透传测试 |

---

## 架构评估摘要

### 优点

- 模块分层总体清晰（runtime / agent / memory / security / tools / subagents / web）
- 安全能力集中化方向正确（path-guard、command-guard、network、审计日志）
- memory 子系统职责拆分是仓库最成熟的一块（recall、session、consolidation、lifecycle、files、sidecar-worker）
- `ChannelRunner` 的执行与交付分离（delivery.ts / dingtalk.ts）

### 主要弱点

- `ChannelRunner` 过于中心化，单类承担过多职责
- 事件系统未复用工具层执行抽象（S2 已修复）
- memory 并发契约未显式编码（R2 已修复）

---

## 验证

修复前后测试对比：

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| 测试文件 | 51 | 52 |
| 测试用例 | 233 | 240 |
| typecheck | ✅ | ✅ |
| 全部通过 | ✅ | ✅ |

---

## 后续建议

### Quick Wins（未处理）

- **S1 (Critical)**: 在 Jina 代理路径前，对原始 URL 执行与直连一致的网络守卫校验

### Medium-term（未处理）

- `ChannelRunner` 拆分为至少三个协作对象
- 为 runtime 建立统一"受管执行"抽象
- 为 memory 子系统引入显式的 per-channel work scheduler
- 把"配置兼容层"与"真实设置模型"分离

# Fix Task: Q1 + Q2 — 代码质量修复

## Finding Q1: read 工具总行数 off-by-one

- **Severity**: Medium
- **Location**: `src/tools/read.ts:116-129`
- **Description**: `read` 工具用 `wc -l` 后直接 `+1` 推导总行数。这个推导只对"最后一行没有换行符"的文件成立；对大多数以换行结尾的正常文本文件会多算 1 行，对空文件也会返回 1 行。
- **Concrete suggestion**:
  - 直接在已读取内容上计算真实行数（最简单可靠）
  - 补充测试：空文件、以换行结尾的文件、不以换行结尾的文件三种情况

## Finding Q2: settings.ts 兼容 getter 返回硬编码默认值

- **Severity**: Medium
- **Location**: `src/settings.ts:202-206`, `src/settings.ts:322-331`
- **Description**: `getCompactionSettings()` 会合并 `settings.json` 中的值，但对 SDK 兼容暴露的 `getCompactionReserveTokens()`、`getCompactionKeepRecentTokens()`、`getBranchSummarySettings()` 却直接返回硬编码默认值。
- **Concrete suggestion**:
  - 所有兼容 getter 都应统一从合并后的 `getCompactionSettings()` 派生
  - 为"自定义 `reserveTokens` / `keepRecentTokens`"补充覆盖兼容 getter 的测试

## 要求

这两个问题都是 Medium 级别的代码质量问题，不大，作为一批修复。

### 第一步：理解确认

1. 阅读 `src/tools/read.ts` 的行数计算逻辑，确认 `wc -l + 1` 的问题
2. 阅读 `src/settings.ts` 的兼容 getter，确认它们确实返回硬编码值而非从 `getCompactionSettings()` 派生
3. 查看现有测试覆盖情况

### 第二步：分析

给出简短分析：问题是否确认？方案是否合理？有没有更简单的做法？

### 第三步：实施

分析确认后直接实施修复，改完跑 `npm run typecheck` 和 `npm run test`。

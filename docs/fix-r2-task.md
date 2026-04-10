# Fix Task: R2 — Memory 并发写入竞争

## 审查发现

- **Severity**: High
- **Location**: `src/memory/lifecycle.ts:215-335`, `src/memory/files.ts:78-82`, `src/memory/files.ts:168-192`
- **Description**: `backgroundQueue` 只串行后台任务；`runPreflightConsolidation()` 并不走这条队列。于是"会话切换/压缩前的 inline consolidation"和"后台 cleanup/history folding"可以并发触发到同一组 `MEMORY.md` / `HISTORY.md` 文件。与此同时，`writeAtomically()` 使用固定的 `${path}.tmp`，而 `appendChannelMemoryUpdate()` / `appendChannelHistoryBlock()` 是典型的整文件 `read -> modify -> rewrite`。
- **Why it matters**: 这是 memory 子系统里最重要的可靠性风险。并发下会出现：
  - 两次写入彼此覆盖，丢失较新的 memory/history block
  - 固定 `.tmp` 文件名导致 rename 竞争，出现 `ENOENT` 或最后提交者覆盖前者
  - 问题极难从单元测试中显现，但在长时运行和高频 compaction 下会被放大
- **Concrete suggestion**:
  - 对每个 channel 建立统一的 memory job queue，把 inline consolidation、cleanup、history folding、session refresh 后续写入都放进同一串行通道
  - `writeAtomically()` 使用唯一临时文件名，例如 `${path}.${pid}.${random}.tmp`
  - 对 append 流程增加并发集成测试，模拟 preflight 与 background maintenance 交叠

## 你需要做的事情

### 第一步：深入理解现有并发契约

1. 阅读 `src/memory/lifecycle.ts`，理解 `backgroundQueue` 的实现、哪些操作走这条队列、哪些不走
2. 阅读 `src/memory/files.ts`，理解 `writeAtomically()` 的 `.tmp` 固定文件名问题，以及 `appendChannelMemoryUpdate()` / `appendChannelHistoryBlock()` 的 read-modify-rewrite 模式
3. 追踪 `runPreflightConsolidation()` 的调用链，确认它在哪里被触发、为什么没走 backgroundQueue
4. 理解 `session refresh` 后续写入是否也存在同样的并发风险
5. 查看现有的 memory 相关测试，确认哪些并发场景已有覆盖、哪些是空白

### 第二步：给出你的分析意见

在动手修改之前，请给出以下分析：

1. **问题确认**：你是否同意审查报告的判断？并发竞争是否真实存在？实际触发概率有多大？
2. **严重程度**：你认为 High 评级是否准确？在当前项目实际运行场景下风险有多大？
3. **修复价值**：修复这个问题的投入产出比如何？是否值得现在修？
4. **修复方案评估**：
   - 审查建议的"统一 memory job queue"——你认为这个方案是否合理？
   - "writeAtomically() 使用唯一临时文件名"——这个是否足够作为独立修复？
   - 两个建议是否需要同时做，还是可以分步？
   - 是否有更简单、引入更少复杂度的方式？
   - 需要注意哪些边界情况？
5. **复杂度控制**：请特别评估你的方案是否会引入过多复杂度。这个问题的修复必须控制在一个合理范围内，不要变成大规模重构。

请先完成分析，不要急于写代码。

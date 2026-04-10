# Fix Task: S2 — preAction 绕过 Sandbox

## 审查发现

- **Severity**: High
- **Location**: `src/runtime/events.ts:410-425`, `src/runtime/bootstrap.ts:636-642`
- **Description**: 事件系统的 `preAction` 只经过 `commandGuard`，实际执行用的是 `child_process.exec(action.command)`，没有复用 `sandbox.ts` 的 `Executor`，也没有进入工具层统一的安全上下文。即使主运行时配置成 Docker sandbox，事件前置动作仍在宿主机执行。
- **Why it matters**: 这会让"事件文件"成为一个与正常工具执行完全不同的权限通道。对于长期运行实例，这个差异非常危险，也很容易让运维方误判安全边界。

## 你需要做的事情

### 第一步：理解和确认问题

1. 阅读 `src/runtime/events.ts`，找到 `preAction` 相关逻辑（约第 410-425 行），理解它当前如何执行 `action.command`
2. 阅读 `src/runtime/bootstrap.ts`，找到事件系统初始化和 `EventsWatcher` 的创建（约第 636-642 行），理解它接收了哪些依赖
3. 阅读 `src/tools/sandbox.ts`（或类似路径），理解主运行时使用的 `Executor` 接口和工作方式
4. 阅读 `src/tools/bash.ts`（或类似路径），理解 bash 工具的完整安全链路（sandbox、审计、超时、输出截断）

### 第二步：给出你的分析意见

在动手修改之前，请给出以下分析：

1. **问题确认**：你是否同意审查报告的判断？实际代码是否确实存在描述的问题？
2. **严重程度**：你认为这个问题的实际严重程度如何？High 是否准确？在当前项目实际部署场景下风险有多大？
3. **修复价值**：修复这个问题的投入产出比如何？是否值得现在修？
4. **修复方案评估**：
   - 审查建议"给 `EventsWatcher` 注入与主运行时一致的 `Executor`"——你认为这个方案是否合理？
   - 是否有更简单、引入更少复杂度的修复方式？
   - 需要注意哪些边界情况（比如 sandbox 未配置时的 fallback、错误处理等）？
5. **复杂度控制**：请特别评估你的方案是否会引入过多复杂度。对于一个小问题，不要过度设计。

请先完成分析，不要急于写代码。等你给出分析后，我会和你讨论方案再动手。

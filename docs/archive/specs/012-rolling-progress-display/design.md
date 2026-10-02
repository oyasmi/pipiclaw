# Rolling Progress Display 设计方案

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | DRAFT |
| 日期 | 2026-04-20 |
| 关联 spec | `docs/specs/011-configurable-busy-message-default/design.md` |
| 关联实现 | `src/runtime/delivery.ts`, `src/runtime/dingtalk.ts`, `src/runtime/bootstrap.ts`, `src/agent/commands.ts` |

---

## 背景

Pipiclaw 使用钉钉 AI Card 实时展示 Agent 执行过程。当前行为是**完整累积**：每个思考、工具调用、错误都追加到卡片内容中，最终 finalize 时保留全部过程文本。

这在个人助手场景下是合理的 — 用户关心过程，且对话密度低，长卡片不构成干扰。

但在答疑机器人场景下，这个行为有两个问题：

1. **过程高度重复** — 答疑场景下 Agent 的执行模式相似（搜索 → 阅读 → 回答），十几个用户的过程卡片看起来几乎一样，淹没聊天记录。
2. **卡片长度失控** — 一个复杂问题可能产生 20+ 条 progress entry，留在聊天历史中占据大量空间，影响后续阅读。

spec 011 已经为答疑场景引入了 `busyMessageDefault: "followUp"`。本 spec 解决同一场景下的 AI Card 体验问题。

---

## 设计目标

1. 执行中仍有实时反馈（用户知道机器人在工作）
2. 卡片内容保持紧凑，不随执行过程无限增长
3. 任务完成后，卡片收起为简短摘要，不污染聊天历史
4. 对现有 full 模式零影响，向后兼容

---

## 方案分析

### 方案 1：关闭 AI Card

`cardTemplateId` 留空即可，零代码改动。

问题：答疑场景一个问题可能 30 秒到几分钟，用户完全没有反馈，体验差。群聊中用户甚至不确定机器人是否收到消息。

**排除。**

### 方案 2：滚动窗口 + 完成后摘要（推荐）

执行中只展示最近 N 条 progress entry（滚动窗口），完成后将整张卡片替换为一行简短摘要。

优点：

- 快速反馈仍然有
- 卡片始终保持较小长度
- 完成后摘要极短（一行），不影响聊天历史
- 改动集中在 delivery 层，不影响上游事件处理

---

## 设计决策

### 配置字段

在 `DingTalkConfig` 中新增：

```typescript
export interface DingTalkConfig {
    // ... existing fields ...
    progressDisplay?: "full" | "rolling";
}
```

- `"full"`（默认）：当前行为，完整累积
- `"rolling"`：滚动窗口 + 完成后摘要

默认值暂定 `"full"` 以保持向后兼容。待 `"rolling"` 模式经过充分验证确认体验良好后，可以考虑将默认值切换为 `"rolling"` — rolling 的摘要收尾对两种场景都更友好。切换默认值只需修改 `normalizeProgressDisplay` 和模板，不涉及逻辑变更。

放在 `channel.json` 而非 `settings.json`，理由与 spec 011 一致 — 这是 instance 级别的交互范式属性。

### 配置示例

答疑机器人典型配置：

```json
{
    "clientId": "...",
    "clientSecret": "...",
    "robotCode": "...",
    "cardTemplateId": "...",
    "busyMessageDefault": "followUp",
    "progressDisplay": "rolling"
}
```

### 钉钉 AI Card 的限制

需要明确两个事实：

1. **AI Card 无法删除** — 钉钉没有提供删除已创建卡片的 API。`discardCard()` 只清除本地引用，卡片仍留在聊天记录中。
2. **AI Card 可以全量替换** — finalize 时可以用 `replaceCard(channelId, text, true)` 将卡片内容替换为任意文本并锁定。

因此"完成后删除卡片"不可行，但"完成后替换为摘要"完全可行。

### 滚动窗口参数

- **窗口大小：3 条 entry** — 硬编码，不作为配置项暴露。3 条在视觉上紧凑（通常 3-5 行文本），同时保留足够上下文让用户理解 Agent 在做什么。
- 每条 entry 对应一个 `ctx.respond()` 调用（一个 thinking/tool/error/assistant 片段）。

### 完成后摘要格式

finalize 时将卡片替换为一行摘要：

```
Done · {N} tool calls · {elapsed}s
```

例如：`Done · 5 tool calls · 12s`

错误和 fallback 路径保留原始错误详情或最终文本，不替换为摘要，避免丢失关键用户可见信息。

摘要信息来源：

- tool calls 数量：delivery controller 自身可以计数（每次 `appendProgress` 中内容以 `Running:` 开头即为一次 tool call）
- 耗时：`Date.now() - progressStartedAt`，其中 `progressStartedAt` 是第一条 progress entry 的时间；不能复用 `progressWindowStartedAt`，因为后者会在同步节流过程中被重置

不包含 token 消耗或费用 — 这些信息在 `RunState` 中，delivery controller 无法直接访问，且对答疑场景的终端用户无意义。

---

## 实现方案

改动集中在 4 个文件，核心逻辑在 `delivery.ts`。

### 1. DingTalkConfig 接口 — `src/runtime/dingtalk.ts:43-52`

新增可选字段 `progressDisplay`，以及 normalize 函数：

```typescript
export type ProgressDisplayConfig = "full" | "rolling";

export function normalizeProgressDisplay(value: unknown): ProgressDisplayConfig {
    if (value === undefined) return "full";
    if (value === "full" || value === "rolling") return value;
    throw new Error('Invalid `progressDisplay`: expected "full" or "rolling".');
}
```

缺省值返回 `"full"`，保持向后兼容；显式无效值启动时报错，不静默回退。理由是如果答疑机器人把 `"rolling"` 写错，运行时会继续产生超长卡片，操作者很难发现配置没有生效。

DingTalkBot 新增 getter：

```typescript
get progressDisplay(): ProgressDisplayConfig {
    return normalizeProgressDisplay(this.config.progressDisplay);
}
```

### 2. ChannelDeliveryController 改造 — `src/runtime/delivery.ts`

这是核心改动。当前 controller 通过构造函数接收 `bot: DingTalkBot`（第 33 行），因此可以直接读取 `bot.progressDisplay`。

#### 2a. 新增状态字段

```typescript
private toolCallCount = 0;     // tool call 计数（用于摘要）
private progressStartedAt = 0; // 第一条 progress 的时间，用于摘要耗时
```

#### 2b. 改造 `appendProgress()` — 第 119-137 行

在现有追加逻辑后，增加滚动窗口裁剪：

```typescript
private async appendProgress(text: string, shouldLog: boolean): Promise<void> {
    if (this.closed || this.finalResponseDelivered || !text.trim()) return;

    this.clearCardWarmup();

    // --- 统计（两种模式都需要）---
    if (this.progressStartedAt === 0) {
        this.progressStartedAt = Date.now();
    }
    if (text.startsWith("Running:")) {
        this.toolCallCount++;
    }

    // --- 追加 segment ---
    if (this.progressSegments.length > 0) {
        this.progressSegments.push("\n\n");
    }
    this.progressSegments.push(text);
    this.progressTextDirty = true;

    // --- rolling 模式：裁剪到最近 N 条 entry ---
    if (this.bot.progressDisplay === "rolling") {
        this.trimToRecentEntries(ROLLING_WINDOW_SIZE);
    }

    if (this.progressWindowStartedAt === 0) {
        this.progressWindowStartedAt = Date.now();
    }
    if (shouldLog) {
        this.archiveBotResponse(text);
    }

    this.mode = "progress";
    this.bumpRevision(false);
}
```

#### 2c. 新增 `trimToRecentEntries()`

```typescript
private trimToRecentEntries(maxEntries: number): void {
    // progressSegments 的结构是：[entry, "\n\n", entry, "\n\n", entry, ...]
    // 每个 entry 和其前面的 "\n\n" 分隔符构成一对
    // 统计当前 entry 数量
    let entryCount = 0;
    for (const seg of this.progressSegments) {
        if (seg !== "\n\n") entryCount++;
    }

    if (entryCount <= maxEntries) return;

    // 从头部移除多余的 entry（及其分隔符）
    const toRemove = entryCount - maxEntries;
    let removed = 0;
    while (removed < toRemove && this.progressSegments.length > 0) {
        const seg = this.progressSegments.shift()!;
        if (seg !== "\n\n") removed++;
    }
    // 移除残留的前导分隔符
    while (this.progressSegments.length > 0 && this.progressSegments[0] === "\n\n") {
        this.progressSegments.shift();
    }

    this.progressTextDirty = true;
    // 内容变短了，delta 追踪失效，必须全量替换
    this.replayRequired = true;
    this.sentProgressChars = 0;
}
```

**关键点**：裁剪后设置 `replayRequired = true`，让 `runSyncLoop` 走 `replaceCard` 而非 `appendToCard`。这个机制已经存在（第 238-249 行），用于 append 失败后的重试，这里复用。

rolling 模式下窗口未满时仍沿用现有 append 路径；一旦发生裁剪，下一次同步使用 `replaceCard` 发送短窗口快照。窗口内容很短（3 条 entry，通常几百字符），replace 的代价可以忽略。

#### 2d. 改造 finalize 路径 — 第 252-284 行

`buildSummaryText()` 产出的摘要行（如 `Done · 5 tool calls · 12s`）只用于 rolling 模式。为了保持向后兼容，full 模式 finalize 仍保持当前行为。

- **full 模式**：不改变现有行为，finalize 时保留完整进展文本
- **rolling 模式**：将整张卡片**替换**为仅摘要行

在 `finalize-existing` 分支（第 252-267 行）中：

```typescript
} else if (mode === "finalize-existing") {
    if (content || this.cardWarmupTriggered) {
        const finalContent =
            this.bot.progressDisplay === "rolling"
                ? this.buildSummaryText("Done")
                : content
                    ? progressText
                    : "";
        touchedRemote = await this.bot.replaceCard(
            this.event.channelId,
            finalContent,
            true,
        );
        // ... existing error handling ...
    } else {
        this.bot.discardCard(this.event.channelId);
    }
}
```

`finalize-with-fallback` 分支（第 268-276 行）不应用摘要替换，必须保留 `replacementText` 原样。该路径承载最终答案 fallback 或错误详情；如果替换为摘要会造成用户看不到答案或错误信息。

#### 2e. 新增 `buildSummaryText()`

```typescript
private buildSummaryText(status: "Done"): string {
    const elapsed = this.progressStartedAt > 0
        ? Math.round((Date.now() - this.progressStartedAt) / 1000)
        : 0;
    const toolLabel = this.toolCallCount === 1
        ? "1 tool call"
        : `${this.toolCallCount} tool calls`;
    return `${status} · ${toolLabel} · ${elapsed}s`;
}
```

当前实现只在成功发送最终 plain response 后用 `Done · ...` 收起 progress card。错误和 fallback 路径保留原始最终文本，不替换为摘要。

### 3. 初始化模板与校验 — `src/runtime/bootstrap.ts`

**a) CHANNEL_CONFIG_TEMPLATE**（第 173-181 行）：

```typescript
const CHANNEL_CONFIG_TEMPLATE = {
    // ... existing fields ...
    busyMessageDefault: "steer",
    progressDisplay: "full",          // 新增
} satisfies DingTalkConfig;
```

**b) loadConfig normalize**（第 396-406 行）：

在 `loadConfig` 中增加 normalize：

```typescript
parsed.progressDisplay = normalizeProgressDisplay(
    (parsed as { progressDisplay?: unknown }).progressDisplay,
);
```

需要在 `listChannelConfigIssues` 中增加校验，显式无效值启动失败：

```typescript
if (progressDisplay !== undefined && !isProgressDisplayConfig(progressDisplay)) {
    issues.push('Invalid `progressDisplay`: expected "full" or "rolling".');
}
```

### 4. 用户提示文案 — `src/agent/commands.ts`

在 help 文本的 Transport Commands 部分补充说明即可。由于 help 是静态文本，添加一行描述：

> Set `progressDisplay` in channel.json to `rolling` for compact progress (recent entries only, summary on completion).

### 5. 文档同步

**a) `README.md`**

在 channel.json 的"常见可选项"列表中补充：

> - `progressDisplay`
>   设为 `"full"`（默认）或 `"rolling"`。控制 AI Card 进度展示方式。`"rolling"` 模式下只显示最近 3 条动作，完成后收起为一行摘要。

**b) `docs/configuration.md`**

在 channel.json 字段说明表格中新增一行：

| 字段 | 必填 | 默认值 / 行为 | 说明 |
|------|------|----------------|------|
| `progressDisplay` | 否 | `"full"` | AI Card 进度展示模式。`"full"` 完整累积；`"rolling"` 滚动窗口（最近 3 条）+ 完成后摘要 |

在"推荐配置"章节的"答疑机器人"示例中加入 `"progressDisplay": "rolling"`。

### 6. 初始化模板与向后兼容

**a) 初始化模板**

`CHANNEL_CONFIG_TEMPLATE` 中显式包含 `progressDisplay: "full"`，让新用户可见。

**b) 已有配置文件**

老配置文件缺失 `progressDisplay` 字段时，`normalizeProgressDisplay(undefined)` 返回 `"full"`，等同于当前行为。无需迁移。

### 7. 测试

在 `test/delivery.test.ts` 中补充：

- **rolling 模式滚动窗口**：发送 5 条 progress，验证 card 内容只包含最后 3 条
- **rolling 模式 finalize 摘要**：验证 finalize 时 card 内容被替换为 `Done · N tool calls · Xs`
- **full 模式不受影响**：验证默认行为（完整累积）未改变
- **mixed entry 类型计数**：验证 tool call 计数只统计 `Running:` 开头的 entry

在 `test/bootstrap.test.ts` 中补充：

- 初始化模板包含 `progressDisplay` 字段
- `loadConfig` 正确 normalize `"rolling"`，并拒绝无效显式值

---

## 架构影响分析

### 改动范围

| 层 | 文件 | 改了什么 |
|----|------|----------|
| 配置 | `dingtalk.ts` | `DingTalkConfig` 新增字段 + normalize + getter |
| 投递 | `delivery.ts` | 滚动裁剪 + 摘要 finalize（核心改动） |
| 初始化 | `bootstrap.ts` | 模板 + loadConfig normalize |
| 文档 | `README.md`, `configuration.md`, `commands.ts` | 配置说明 |

### 不需要改动的地方

| 组件 | 原因 |
|------|------|
| `session-events.ts` | 事件处理逻辑不变，仍然产出完整的 progress entry，裁剪在 delivery 层做 |
| `channel-runner.ts` | finalize 路径仍调用 `ctx.replaceMessage()` / `ctx.respondPlain()` / `ctx.deleteMessage()`，不感知 display 模式 |
| `progress-formatter.ts` | 格式化逻辑不变 |
| `store.ts` | 归档逻辑不变 — `archiveBotResponse` 仍按现有 `shouldLog` 语义执行 |
| `dingtalk.ts` AI Card API 层 | `appendToCard` / `replaceCard` / `finalizeCard` 接口不变 |

### 关键设计保证

1. **日志语义不受影响** — `archiveBotResponse` 仍然只在 `shouldLog` 为 true 时执行。rolling 模式只裁剪卡片展示，不改变原本会归档或不会归档的 progress entry。

2. **`replayRequired` 机制复用** — 滚动裁剪后内容变短，delta 追踪失效，设置 `replayRequired = true` 让下一次同步走 `replaceCard`。这是已有机制（用于 append 失败重试），不引入新的同步语义。

3. **full 模式零改动** — 滚动裁剪和摘要收尾都只在 `this.bot.progressDisplay === "rolling"` 分支中生效，full 模式保持现有完整累积行为。

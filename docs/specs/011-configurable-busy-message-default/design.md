# Configurable Busy-Message Default 设计方案

| 字段 | 值 |
|------|------|
| 分支 | `master` |
| 状态 | DRAFT |
| 日期 | 2026-04-20 |
| 关联实现 | `src/runtime/dingtalk.ts`, `src/runtime/bootstrap.ts`, `src/agent/commands.ts`, `README.md`, `docs/configuration.md` |

---

## 背景

Pipiclaw 支持两种忙碌时消息处理模式：

- **steer** — Agent 正在执行任务时，用户发送的消息在当前 tool step 完成后立即注入，Agent 据此调整方向。
- **followup** — 消息排队等待，当前任务完全结束后才作为新任务处理。

当前实现中，用户在 Agent 忙碌时发送的**普通消息（非 `/steer`、`/followup` 命令）默认走 steer**。这个决策硬编码在 `src/runtime/dingtalk.ts:1085`：

```typescript
await this.handler.handleBusyMessage(event, this, "steer", content);
```

这个默认行为在"个人助手"场景下是合理的 — 用户在 Agent 忙碌时发消息，绝大多数时候是想补充或修正当前任务。

但出现了新的使用场景：**答疑机器人**。多个用户并发提问时，每个问题应该排队依次完成，而不是插入当前正在执行的任务。这个场景下 `followup` 才是正确的默认行为。

---

## 设计决策

### 配置放在 channel.json 而非 settings.json

`channel.json` 是 per-instance 的钉钉连接配置。一个 Pipiclaw 实例通常对应一个机器人身份，而"这个机器人是个人助手还是答疑机器人"正是 instance 级别的属性。相比之下，`settings.json` 更偏向模型参数、memory 策略等运行时调优，不适合承载"机器人交互范式"这一语义。

### 新增字段

在 `DingTalkConfig` 接口中新增一个可选字段：

```typescript
export interface DingTalkConfig {
    clientId: string;
    clientSecret: string;
    robotCode?: string;
    cardTemplateId?: string;
    cardTemplateKey?: string;
    allowFrom?: string[];
    stateDir?: string;
    busyMessageDefault?: "steer" | "followUp" | "followup";  // 新增
}
```

- 类型：`"steer" | "followUp" | "followup"`
- 默认值：`"steer"`（向后兼容，不配置等于原行为）
- `"followup"` 是配置层别名，内部统一规范化为 `"followUp"`
- 显式配置为其他值时启动失败，并输出明确错误；不静默回退到 `"steer"`

### 配置示例

个人助手（默认，无需显式配置）：

```json
{
    "clientId": "...",
    "clientSecret": "...",
    "robotCode": "..."
}
```

答疑机器人：

```json
{
    "clientId": "...",
    "clientSecret": "...",
    "robotCode": "...",
    "busyMessageDefault": "followUp"
}
```

---

## 实现方案

改动集中在以下几个位置，包含运行时代码、启动配置校验、测试与文档同步。

### 1. DingTalkConfig 接口 — `src/runtime/dingtalk.ts:23-31`

新增可选字段 `busyMessageDefault`。

### 2. DingTalkBot 暴露 getter — `src/runtime/dingtalk.ts`

`DingTalkBot` 已经持有 `this.config`，新增一个方法供内部消息路由逻辑使用：

```typescript
get busyMessageDefault(): BusyMessageMode {
    return normalizeBusyMessageDefault(this.config.busyMessageDefault);
}
```

`normalizeBusyMessageDefault` 负责把缺省值处理为 `"steer"`，把 `"followup"` 规范化为 `"followUp"`。无效显式值应在启动配置校验阶段报错；getter 也不做静默降级。

### 3. 默认路由逻辑 — `src/runtime/dingtalk.ts:1085`

将硬编码的 `"steer"` 替换为读取配置：

```typescript
// 原来：
await this.handler.handleBusyMessage(event, this, "steer", content);

// 改为：
await this.handler.handleBusyMessage(event, this, this.busyMessageDefault, content);
```

### 4. 用户提示文案适配

需要适配的文案有两处：

**a) 帮助文本** — `src/agent/commands.ts:30`

原文：
> While a task is running, a plain message is treated as `steer` by default.

改为接受参数动态生成，或保持静态但措辞改为：
> While a task is running, plain messages use the configured busy-message default. The default is `steer`; set `busyMessageDefault` in channel.json to `followUp` or `followup` to queue plain messages after the current task.

由于 help 文本是静态常量且不依赖运行时状态，直接在文案中补充说明即可。

**b) busy 时的错误提示** — `src/runtime/dingtalk.ts:1072`

原文：
> A task is already running. Use `/stop`, `/steer <message>`, or `/followup <message>`. Plain messages default to steer.

需要根据实际配置值动态调整末尾提示：

```typescript
`Plain messages default to ${this.busyMessageDefault}.`
```

**c) steer 确认文案** — `src/runtime/bootstrap.ts:585-587`

原来对普通消息（非 `/steer` 命令）的确认文案写死了 steer 相关提示。当默认模式为 followUp 时，应使用 followUp 的确认文案。此处不需要改动 — 因为 `mode` 参数已经是从 dingtalk.ts 传入的实际模式值，`bootstrap.ts:582-587` 的分支逻辑天然适配：

```typescript
const confirmation =
    mode === "followUp"
        ? "Queued as follow-up. I'll handle it after the current task completes."
        : event.text.trim().startsWith("/")
            ? "Queued as steer. ..."
            : "Queued as steer. ... Use `/followup <message>` to queue it after completion.";
```

当 `busyMessageDefault` 为 `"followUp"` 时，普通消息的 `mode` 就是 `"followUp"`，走第一个分支，文案自然正确。但反向提示需要调整 — 当默认是 followUp 时，应提示用户可以用 `/steer` 来插话：

```typescript
const confirmation =
    mode === "followUp"
        ? event.text.trim().startsWith("/")
            ? "Queued as follow-up. I'll handle it after the current task completes."
            : "Queued as follow-up. I'll handle it after the current task completes. Use `/steer <message>` to apply it immediately."
        : event.text.trim().startsWith("/")
            ? "Queued as steer. I'll apply it after the current tool step finishes."
            : "Queued as steer. I'll apply this after the current tool step finishes. Use `/followup <message>` to queue it after completion.";
```

### 5. 初始化模板与向后兼容 — `src/runtime/bootstrap.ts:171-178`

**a) 初始化模板更新**

`CHANNEL_CONFIG_TEMPLATE` 是首次运行时自动生成的 `channel.json` 模板。需要在模板中显式包含新字段，让新用户一眼看到这个配置项的存在：

```typescript
const CHANNEL_CONFIG_TEMPLATE = {
    clientId: "your-dingtalk-client-id",
    clientSecret: "your-dingtalk-client-secret",
    robotCode: "your-robot-code",
    cardTemplateId: "your-card-template-id",
    cardTemplateKey: "content",
    allowFrom: ["your-staff-id"],
    busyMessageDefault: "steer",              // 新增
} satisfies DingTalkConfig;
```

**b) 已有配置文件的向后兼容**

对于已经创建的 `channel.json`，其中不会包含 `busyMessageDefault` 字段。兼容策略由第 2 项的 getter 保证：

```typescript
get busyMessageDefault(): BusyMessageMode {
    return normalizeBusyMessageDefault(this.config.busyMessageDefault);
}
```

- 字段缺失 → `this.config.busyMessageDefault` 为 `undefined` → 返回 `"steer"`
- 字段为 `"steer"` → 返回 `"steer"`
- 字段为 `"followUp"` → 返回 `"followUp"`
- 字段为 `"followup"` → 返回 `"followUp"`
- 字段为其他显式值（如 `"follow-up"`）→ 启动配置校验失败，提示允许值

无需迁移脚本；但需要在 `loadConfig` / channel config readiness 校验中检查显式配置值，避免用户拼写错误后静默进入错误的 busy 默认模式。`DingTalkConfig` 接口中该字段声明为可选（`?`），老配置文件天然兼容。

**c) 启动配置校验**

`loadConfig` 使用的 channel config readiness 校验需要拒绝无效显式值：

```typescript
if (busyMessageDefault !== undefined && !isBusyMessageDefaultConfig(busyMessageDefault)) {
    issues.push('Invalid `busyMessageDefault`: expected "steer", "followUp", or "followup".');
}
```

缺省值不报错，由 normalize 逻辑处理为 `"steer"`；显式 `"followup"` 会被规范化为内部 `"followUp"`。

### 6. 文档同步

需要同步更新两份文档，说明新增的配置项及其默认值。

**a) `README.md`**

README 中 `channel.json` 出现在"填写 channel.json"章节（约第 200-231 行），包含配置示例和字段说明。需要更新：

- 配置示例 JSON 中加入 `"busyMessageDefault": "steer"`
- 在"常见可选项"列表中补充一条：
  > - `busyMessageDefault`
  >   设为 `"steer"`（默认）或 `"followUp"` / `"followup"`。控制 Agent 忙碌时普通消息的默认处理方式。答疑机器人场景建议设为 `"followUp"`。

**b) `docs/configuration.md`**

configuration.md 是 channel.json 的详细配置文档（约第 148-230 行），包含最小示例、字段说明表格和推荐配置。需要更新：

- "最小示例"JSON 不需要加（它强调的是最少必须填哪些字段）
- "字段说明"表格中新增一行：

  | 字段 | 必填 | 默认值 / 行为 | 说明 |
  |------|------|----------------|------|
  | `busyMessageDefault` | 否 | `"steer"` | Agent 忙碌时普通消息的默认处理模式。`"steer"` 表示插入当前任务，`"followUp"` / `"followup"` 表示排队等当前任务完成后处理。答疑机器人场景建议设为 `"followUp"` |

- "推荐配置"章节可新增一个答疑机器人场景的推荐配置示例

### 7. 测试

在 `test/dingtalk.test.ts` 中补充测试用例：

- 验证 `busyMessageDefault: "followUp"` 时，普通消息走 followUp 路由
- 验证 `busyMessageDefault: "followup"` 时，普通消息同样走 followUp 路由
- 验证不配置时仍然走 steer（向后兼容）
- 验证显式 `/steer` 和 `/followup` 命令不受默认值影响
- 验证无效显式配置值会在启动配置校验时报错

---

## 不需要改动的地方

| 组件 | 原因 |
|------|------|
| `channel-runner.ts` | 只接收 mode 参数，不关心默认值从哪来 |
| `bootstrap.ts` handler 逻辑 | mode 由 dingtalk.ts 传入，天然适配 |
| `store.ts` 消息归档 | deliveryMode 字段记录实际 mode，不受影响 |
| `settings.ts` | 此功能放在 channel.json，不涉及 settings |
| SDK 层 | `streamingBehavior` 选项不变 |

# E2E 测试设计

## 背景

Pipiclaw 每次发布前，通常需要手工启动 runtime，在钉钉里发送消息，再观察回复、工具调用、会话文件和记忆文件是否正常更新。这个流程慢，而且容易漏掉 runtime 层面的回归。

本设计的目标，是补上一套**尽量贴近真实使用方式**的自动化端到端测试：

- 只 mock 钉钉渠道本身
- 从 runtime 入口开始驱动
- 经过真实的 ChannelStore、ChannelRunner、AgentSession、工具、记忆系统、Sidecar、LLM 调用
- 最终通过外部可观察结果做断言

## 设计原则

### 1. E2E 的边界要严格

本方案中的 “E2E” 指：

- **mock 钉钉网络与 Stream SDK**
- **不 mock runtime 内部链路**

也就是说，测试入口不应直接调用 `ChannelRunner.run()`，而应尽量走与生产一致的运行路径：

`DingTalkEvent -> runtime handler -> createDingTalkContext -> AgentRunner -> ChannelRunner -> AgentSession -> tools/memory/sidecar/LLM`

这样才能覆盖以下真实行为：

- Channel 目录初始化
- `ChannelStore` 落盘
- built-in command 判定
- busy / stop 行为
- delivery flush / close 语义
- runtime 对 runner 的装配

### 2. 只验证外部可观察行为

E2E 测试不依赖内部 mock 计数，不断言某个私有方法是否被调用；优先验证：

- 钉钉侧捕获到的最终回复
- channel 目录中的 `log.jsonl`、`context.jsonl`、`SESSION.md`、`MEMORY.md`、`last_prompt.json`
- 工具造成的文件系统副作用
- store 写入的原始归档

### 3. 覆盖真实链路，但不追求脆弱断言

真实 LLM 调用存在不确定性，因此断言要集中在：

- 是否成功完成
- 是否发生了预期种类的行为
- 是否产生了可验证的副作用

避免对自然语言回复做精确匹配。

### 4. 分层测试，而不是把所有东西塞进一个用例

建议保留三层：

- 单元测试：覆盖纯逻辑
- 集成测试：直接测 `ChannelRunner`
- E2E 测试：从 runtime 入口测完整链路

本设计只定义最后一层。

## Part 1: 前置改动

### 1.1 路径配置化

当前 [src/paths.ts](../../../src/paths.ts) 将 app home 固定在 `~/.pi/pipiclaw`。这不适合 E2E 测试，因为测试需要隔离目录，不能污染真实用户数据。

建议增加环境变量覆盖：

```typescript
// src/paths.ts
export const APP_HOME_DIR = process.env.PIPICLAW_HOME ?? join(homedir(), ".pi", APP_NAME);
```

这样所有派生路径会自动跟随：

- `WORKSPACE_DIR`
- `AUTH_CONFIG_PATH`
- `MODELS_CONFIG_PATH`
- `SETTINGS_CONFIG_PATH`
- `CHANNEL_CONFIG_PATH`

### 1.2 明确这是“测试专用 home”

E2E 不应直接读写开发者真实的 `~/.pi/pipiclaw/`。测试必须创建独立 home 目录，并在其中放入：

- 测试用 `workspace/`
- 测试用 `channel.json`
- 测试用 `settings.json`
- 运行所需的 `auth.json`
- 运行所需的 `models.json`

其中：

- `auth.json`、`models.json` 可以复制自真实目录，或由环境变量生成
- `settings.json` 不应简单写成 `{}`，而应显式指定测试所需配置，避免模型选择漂移

## Part 2: E2E 架构

### 2.1 真实链路与 mock 边界

```
Mock DingTalk Event
        │
        ▼
Test Runtime Harness
  ├── real ChannelStore
  ├── real getOrCreateRunner(...)
  ├── real createDingTalkContext(...)
  ├── real runtime event handling
  └── mock DingTalkBot transport methods
        │
        ▼
ChannelRunner / AgentSession / Tools / Memory / Sidecar / LLM
        │
        ▼
Captured outbound messages + workspace/channel files + logs
```

### 2.2 为什么不能直接测 `ChannelRunner.run()`

直接 new `ChannelRunner` 并调用 `run()`，只能覆盖 runner 及以下层级，覆盖不到：

- runtime 对 channel state 的管理
- 入站消息落盘
- `createDingTalkContext()` 的 delivery 逻辑
- built-in command 分流
- busy message 行为

所以它适合作为 integration test，不适合作为这里定义的完整 E2E。

### 2.3 运行时测试 harness

建议新增一个测试专用 harness，而不是在每个测试文件里手拼 runtime 依赖。

示意接口：

```typescript
// test/e2e/helpers/runtime-harness.ts
export interface CapturedDelivery {
  method: "sendCard" | "updateCard" | "sendPlain" | "deleteCard";
  channelId: string;
  text?: string;
  ts: number;
}

export interface E2ERuntimeHarness {
  homeDir: string;
  workspaceDir: string;
  channelId: string;
  channelDir: string;
  deliveries: CapturedDelivery[];
  sendUserMessage(text: string, overrides?: Partial<DingTalkEvent>): Promise<void>;
  shutdown(): Promise<void>;
}
```

这个 harness 负责：

- 创建测试 home
- 设置 `PIPICLAW_HOME`
- 初始化真实 `ChannelStore`
- 初始化 runtime handler / runner
- 注入一个 mock `DingTalkBot`
- 把出站消息记录到 `deliveries`
- 对外暴露 `sendUserMessage()`

### 2.4 Mock 的唯一对象：DingTalkBot 传输层

不要 mock `DingTalkContext`。  
应保留真实的 `createDingTalkContext()`，因为它包含了进度消息、最终消息、flush、close、日志写入等行为。

真正需要 mock 的，只是 `DingTalkBot` 的对外发送能力，例如：

- `sendPlain(channelId, text)`
- AI Card 创建/更新相关方法
- 删除消息相关方法

测试只需要这些 mock 方法能：

- 记录发送内容
- 返回成功

这样 `delivery.ts` 的核心语义仍然是走真实代码。

## Part 3: 测试环境搭建

### 3.1 测试目录结构

每个测试文件运行在独立进程中，并拥有独立 home：

```text
{tmpHome}/
├── auth.json
├── models.json
├── settings.json
├── channel.json
└── workspace/
    ├── SOUL.md
    ├── AGENTS.md
    ├── MEMORY.md
    ├── skills/
    ├── events/
    └── sub-agents/
```

某个频道第一次运行后，还会出现：

```text
workspace/
└── dm_e2e_user/
    ├── MEMORY.md
    ├── HISTORY.md
    ├── SESSION.md
    ├── log.jsonl
    ├── context.jsonl
    └── last_prompt.json   # 仅在 debug 开启时
```

### 3.2 测试设置文件

测试不应直接沿用开发环境的 `settings.json`，而应写入明确的测试配置。例如：

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "memoryRecall": {
    "enabled": true,
    "rerankWithModel": true
  },
  "sessionMemory": {
    "enabled": true,
    "minTurnsBetweenUpdate": 1,
    "minToolCallsBetweenUpdate": 1,
    "timeoutMs": 30000,
    "failureBackoffTurns": 1,
    "forceRefreshBeforeCompact": true,
    "forceRefreshBeforeNewSession": true
  }
}
```

关键点：

- `defaultProvider/defaultModel` 必须和测试可用凭证一致
- `sessionMemory` 阈值应为测试下调，否则一些 session memory 用例无法稳定触发

### 3.3 凭证来源

建议支持两种模式：

#### 模式 A：复制本机现有配置

从真实 `~/.pi/pipiclaw/` 复制：

- `auth.json`
- `models.json`

适合本地手工跑。

#### 模式 B：环境变量驱动

通过 CI 或本地 shell 注入 provider key，再动态生成最小配置。

适合未来做手工触发的远端验证。

### 3.4 模块加载时序

由于 [src/paths.ts](../../../src/paths.ts) 的常量在 import 时求值，`PIPICLAW_HOME` 必须在导入依赖它的模块之前设置。

建议：

- 使用 `vitest` 的 `pool: "forks"`
- 在测试文件顶部先创建 `testHome`
- 先设置 `process.env.PIPICLAW_HOME`
- 再动态 `import(...)`

## Part 4: 测试入口设计

### 4.1 复用 runtime 真实装配

测试应尽量复用生产装配，而不是手工复制业务逻辑。

优先选择两种实现方式之一：

#### 方案 A：直接复用 `bootstrap` 装配

调用 runtime bootstrap，但不启动真实 DingTalk 网络服务；拿到：

- `ChannelStore`
- runner 管理
- shutdown 流程

然后通过测试 harness 直接调用 handler 的 `handleEvent(...)`。

优点：

- 最贴近真实运行方式
- 能覆盖更多 runtime 装配错误

缺点：

- 需要把现有 handler 创建逻辑进一步暴露成可测试接口

#### 方案 B：抽出 `createRuntimeHandler(...)`

把 `bootstrap.ts` 中与 runtime handler 构造相关的逻辑抽成一个可复用工厂，例如：

```typescript
export interface RuntimeTestContext {
  handler: DingTalkHandler;
  store: ChannelStore;
  shutdown(): Promise<void>;
}

export function createRuntimeHandlerForTesting(...): RuntimeTestContext
```

这样测试可以：

1. 创建真实 store 和 runner
2. 构建真实 handler
3. 用 fake `DingTalkBot` 发送 event

这是更推荐的实现方向。

## Part 5: 用例设计

### 5.1 基础对话

目标：验证最基本的完整链路。

步骤：

1. 启动 runtime harness
2. 发送用户消息 `你好，请用一句中文回答`
3. 等待处理完成

断言：

- 有至少一条出站消息
- 至少有一条最终消息被发送
- channel 目录存在
- `log.jsonl` 中有用户入站记录
- `context.jsonl` 已创建

建议断言：

- 不要求固定文案
- 只要求最终文本非空，且包含中文字符

### 5.2 文件读取工具

目标：验证 agent 确实通过真实工具访问 workspace 文件。

步骤：

1. 在 workspace 中预置 `test-data.txt`
2. 发送消息：要求读取该文件并复述内容

断言：

- 有工具进度消息或工具相关输出
- 最终回复非空
- 最终回复或中间输出中出现目标内容

更稳妥的做法：

- 让 prompt 明确引用绝对路径
- 文件内容使用罕见 marker，如 `E2E_READ_MARKER_8f31`

### 5.3 文件写入工具

目标：验证真实写文件行为，而不是只看模型口头回答。

步骤：

1. 发送消息，请创建 `workspace/e2e-output.txt`，写入某个 marker

断言：

- 文件真实存在
- 文件内容包含 marker
- 最终回复非空

这是比 bash 回显更稳的 E2E 工具用例。

### 5.4 Bash 工具

目标：验证命令执行工具链。

步骤：

1. 发送消息，请执行 `printf 'E2E_BASH_MARKER_42' > bash-output.txt`

断言：

- `bash-output.txt` 存在
- 文件内容正确

说明：

- 不要只断言“最终回答里提到了 marker”
- 优先断言真实副作用

### 5.5 记忆注入

目标：验证首轮 durable memory bootstrap 和 recall 的真实注入。

步骤：

1. 预写入 channel `MEMORY.md`
2. 开启 `PIPICLAW_DEBUG=1`
3. 发送与记忆相关的问题

断言：

- `last_prompt.json` 存在
- `durableMemoryBootstrap` 或 `recalledContext` 非空
- 其中包含预写入记忆中的关键信息

这比只断言“有回复”更有意义。

### 5.6 Session Memory 更新

目标：验证 `SESSION.md` 更新链路真实可用。

前提：

- 测试 `settings.json` 中已将 `sessionMemory.minTurnsBetweenUpdate` 设为 `1`

步骤：

1. 发送一轮能形成明确工作上下文的消息
2. 等待 run 完成
3. 轮询等待 `SESSION.md` 出现或更新

断言：

- `SESSION.md` 存在
- 其内容非空
- 含有当前任务的相关关键词

注意：

- 这里不应使用固定 5 秒 sleep
- 应使用带超时的轮询，例如最多等待 30 秒，每 500ms 检查一次

### 5.7 Built-in Command

目标：验证 runtime 层对内建命令的分流。

步骤：

1. 发送 `/help`

断言：

- 有最终回复
- 回复包含帮助信息中的稳定关键词
- 不应触发完整 agent 对话链路

这是 `ChannelRunner.run()` 级测试覆盖不到的能力，适合作为 E2E 案例。

## Part 6: 不建议纳入首批 E2E 的内容

以下场景价值高，但不建议作为第一批落地内容：

- busy / `/followup` / `/steer`
- `/stop`
- sub-agent 全链路
- 自动 compaction
- idle consolidation

原因：

- 时序复杂
- 对 LLM、tool、异步后台任务更敏感
- 首批 E2E 先追求稳定性，再逐步扩展

## Part 7: Vitest 配置

建议增加独立配置：

```typescript
// vitest.config.e2e.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: "forks",
    maxConcurrency: 1
  }
});
```

说明：

- `forks` 保证环境变量和模块缓存隔离
- `maxConcurrency: 1` 降低多测试并发访问 LLM 和文件系统带来的不稳定性

## Part 8: 前提条件与限制

### 前提条件

1. 机器可访问所选 LLM provider
2. 提供有效 API key
3. Node.js 版本与项目要求一致

### 跳过策略

当以下条件不满足时，E2E 应自动跳过而不是失败：

- 缺少测试所需凭证
- 缺少可用模型配置
- 网络不可用且无法访问 provider

### 已知限制

| 限制 | 原因 | 缓解 |
|------|------|------|
| LLM 响应不确定 | 真实模型生成 | 只断言行为种类和副作用，不做精确文案匹配 |
| 测试耗时高 | 真实模型调用 + Sidecar | 首批控制在 4-6 个关键用例 |
| 运行有成本 | token 消耗 | 默认仅在本地发版前或手工触发时运行 |
| 时序波动 | session memory / sidecar 为异步 | 使用轮询等待，不用固定 sleep |

## Part 9: CI 策略

E2E 不建议加入常规 PR CI。

建议策略：

- 默认仅本地手工运行 `npm run test:e2e`
- 后续可增加 `workflow_dispatch` 的手工触发 workflow
- 使用单独 secrets 注入 API key

## Part 10: 文件清单

### 必要修改

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/paths.ts` | 修改 | 支持 `PIPICLAW_HOME` |
| `src/runtime/bootstrap.ts` | 修改 | 抽出可测试的 runtime handler 构造逻辑 |
| `vitest.config.e2e.ts` | 新建 | E2E 专用配置 |
| `package.json` | 修改 | 添加 `test:e2e` |

### 新增测试文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `test/e2e/helpers/setup.ts` | 新建 | 创建测试 home、测试配置、清理逻辑 |
| `test/e2e/helpers/fake-bot.ts` | 新建 | mock 钉钉出站传输层 |
| `test/e2e/helpers/runtime-harness.ts` | 新建 | 真实 runtime 测试入口 |
| `test/e2e/basic-conversation.test.ts` | 新建 | 基础对话 |
| `test/e2e/tool-read.test.ts` | 新建 | 读取工具 |
| `test/e2e/tool-write.test.ts` | 新建 | 写入工具 |
| `test/e2e/memory-bootstrap.test.ts` | 新建 | 记忆注入 |
| `test/e2e/session-memory.test.ts` | 新建 | `SESSION.md` 更新 |
| `test/e2e/builtin-command.test.ts` | 新建 | `/help` 等 runtime 命令 |

## 结论

这套方案的核心不是“给 `ChannelRunner` 套一个假的上下文”，而是：

- 从 runtime 入口触发
- 只替换钉钉传输层
- 保留真实 store、delivery、runner、memory、sidecar、LLM

只有这样，测试结果才足够接近真实发布前的手工验收流程，也才值得被称为“除钉钉渠道外的完整 E2E”。

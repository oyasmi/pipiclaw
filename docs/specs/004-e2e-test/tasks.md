# E2E 测试实施任务拆解

## 目标

基于 [design.md](./design.md) 落地一套“除钉钉渠道外的完整 E2E”测试方案：

- 只 mock 钉钉传输层
- 从 runtime 入口驱动
- 覆盖真实 `ChannelStore`、`createDingTalkContext()`、`ChannelRunner`、`AgentSession`、工具、记忆、Sidecar、LLM
- 形成稳定、可重复运行的本地发版前验证能力

## 实施原则

- 按依赖顺序分阶段推进
- 每个阶段结束后都应可独立验证
- 优先先打通基础测试基建，再逐步补充用例
- E2E 不替代现有 unit / integration test

## 阶段 0: 约束确认

### Task 0.1 明确 E2E 范围

内容：

- 确认测试入口是 runtime handler，而不是直接 `ChannelRunner.run()`
- 确认只 mock `DingTalkBot` 传输层，不 mock `DingTalkContext`
- 确认使用真实 `ChannelStore`

产出：

- 本文档
- 已更新的 [design.md](/home/oyasmi/projects/pipiclaw/docs/specs/004-e2e-test/design.md)

验收标准：

- 团队对 E2E 边界没有歧义
- 后续实现不再以 fake store / fake context 作为主路径

## 阶段 1: 可测试基础改动

### Task 1.1 支持 `PIPICLAW_HOME`

内容：

- 修改 [src/paths.ts](/home/oyasmi/projects/pipiclaw/src/paths.ts)
- 让 app home 支持从 `process.env.PIPICLAW_HOME` 覆盖

验收标准：

- 未设置环境变量时行为与当前完全一致
- 设置后，`AUTH_CONFIG_PATH`、`MODELS_CONFIG_PATH`、`SETTINGS_CONFIG_PATH`、`WORKSPACE_DIR` 都指向测试 home

依赖：

- 无

### Task 1.2 抽出可测试的 runtime handler 构造逻辑

内容：

- 修改 [src/runtime/bootstrap.ts](/home/oyasmi/projects/pipiclaw/src/runtime/bootstrap.ts)
- 把 runtime handler、store、runner 装配逻辑从 bootstrap 主流程中抽出成可测试工厂

建议接口：

```typescript
export interface RuntimeHarnessContext {
  handler: DingTalkHandler;
  store: ChannelStore;
  shutdown(): Promise<void>;
}
```

验收标准：

- 生产 bootstrap 继续使用同一套装配逻辑
- 测试代码可以不启动真实 DingTalk 网络服务，就拿到真实 handler
- 不引入新的 domain 泄漏或兼容层堆积

依赖：

- Task 1.1

### Task 1.3 为该抽取补单元/集成测试

内容：

- 给新的 runtime 工厂增加测试
- 确认它能创建真实 `ChannelStore`
- 确认 handler 能正常处理最小 event

验收标准：

- `npm run test` 通过
- 新逻辑有基本回归保护

依赖：

- Task 1.2

## 阶段 2: E2E 测试基础设施

### Task 2.1 新建 E2E 专用 vitest 配置

内容：

- 新建 [vitest.config.e2e.ts](/home/oyasmi/projects/pipiclaw/vitest.config.e2e.ts)
- 配置：
  - `environment: "node"`
  - `include: ["test/e2e/**/*.test.ts"]`
  - `pool: "forks"`
  - `maxConcurrency: 1`
  - 更长的 timeout

验收标准：

- `vitest --run --config vitest.config.e2e.ts` 能发现测试
- 与现有常规测试配置互不干扰

依赖：

- 无

### Task 2.2 增加 `test:e2e` 脚本

内容：

- 修改 [package.json](/home/oyasmi/projects/pipiclaw/package.json)
- 增加：

```json
"test:e2e": "vitest --run --config vitest.config.e2e.ts"
```

验收标准：

- `npm run test:e2e` 能执行 E2E 测试入口

依赖：

- Task 2.1

### Task 2.3 编写测试 home 初始化工具

内容：

- 新建 [test/e2e/helpers/setup.ts](/home/oyasmi/projects/pipiclaw/test/e2e/helpers/setup.ts)
- 负责：
  - 创建临时 home
  - 创建 `workspace/`
  - 写入测试专用 `settings.json`
  - 准备 `channel.json`
  - 复制或生成 `auth.json`、`models.json`
  - 提供清理逻辑

关键要求：

- `settings.json` 不能是空对象
- `sessionMemory.minTurnsBetweenUpdate` 和 `minToolCallsBetweenUpdate` 设为 `1`
- `defaultProvider/defaultModel` 显式可控

验收标准：

- 单独调用 setup 即可创建完整、隔离的测试 home
- 缺凭证时给出清晰错误或 skip 条件

依赖：

- Task 1.1

### Task 2.4 编写 fake DingTalkBot 传输层

内容：

- 新建 [test/e2e/helpers/fake-bot.ts](/home/oyasmi/projects/pipiclaw/test/e2e/helpers/fake-bot.ts)
- 实现测试需要的最小 bot 能力：
  - 记录 `sendPlain`
  - 记录 AI Card 更新
  - 记录删除动作
  - 返回成功

关键要求：

- 它只负责渠道出站记录
- 不接管 `createDingTalkContext()` 的逻辑

验收标准：

- 能稳定捕获 runtime delivery 的出站结果

依赖：

- Task 1.2

### Task 2.5 编写 runtime harness

内容：

- 新建 [test/e2e/helpers/runtime-harness.ts](/home/oyasmi/projects/pipiclaw/test/e2e/helpers/runtime-harness.ts)
- 负责：
  - 创建测试 home
  - 设置 `PIPICLAW_HOME`
  - 动态 import 依赖 `paths.ts` 的模块
  - 构造真实 runtime handler
  - 注入 fake bot
  - 提供 `sendUserMessage(text)` API
  - 提供 `shutdown()` API

建议暴露：

- `homeDir`
- `workspaceDir`
- `channelId`
- `channelDir`
- `deliveries`
- `store`

验收标准：

- 测试代码不需要重复拼装 runtime 依赖
- 发送一条 event 后，能拿到真实产物和出站消息

依赖：

- Task 1.2
- Task 2.3
- Task 2.4

### Task 2.6 编写 E2E 通用等待工具

内容：

- 新建如 [test/e2e/helpers/wait.ts](/home/oyasmi/projects/pipiclaw/test/e2e/helpers/wait.ts)
- 提供：
  - 轮询文件存在
  - 轮询文件内容满足条件
  - 轮询 delivery 条件满足

关键要求：

- 不用固定 `sleep` 作为主等待手段
- 超时错误信息要可读

验收标准：

- session memory、debug prompt、文件输出等场景都能复用等待逻辑

依赖：

- 无

## 阶段 3: 首批关键 E2E 用例

### Task 3.1 基础对话 E2E

文件：

- [test/e2e/basic-conversation.test.ts](/home/oyasmi/projects/pipiclaw/test/e2e/basic-conversation.test.ts)

目标：

- 验证 runtime 入口到最终回复的基础链路

断言：

- 有最终出站消息
- `workspace/<channel>/log.jsonl` 存在且包含用户消息
- `context.jsonl` 已创建

验收标准：

- 在有有效模型凭证时稳定通过

依赖：

- 阶段 2 全部完成

### Task 3.2 文件读取工具 E2E

文件：

- [test/e2e/tool-read.test.ts](/home/oyasmi/projects/pipiclaw/test/e2e/tool-read.test.ts)

目标：

- 验证真实文件读取工具链

断言：

- 预置文件可被 agent 读取
- 回复或中间输出包含唯一 marker
- 有工具相关出站行为

验收标准：

- 不依赖脆弱的精确文案匹配

依赖：

- Task 2.5
- Task 2.6

### Task 3.3 文件写入工具 E2E

文件：

- [test/e2e/tool-write.test.ts](/home/oyasmi/projects/pipiclaw/test/e2e/tool-write.test.ts)

目标：

- 验证真实写文件副作用

断言：

- 目标文件存在
- 文件内容包含 marker
- 最终回复非空

验收标准：

- 以文件系统结果为主断言，而非模型口头说明

依赖：

- Task 2.5

### Task 3.4 Bash 工具 E2E

文件：

- [test/e2e/tool-bash.test.ts](/home/oyasmi/projects/pipiclaw/test/e2e/tool-bash.test.ts)

目标：

- 验证 bash 工具链

断言：

- 命令造成的文件副作用存在
- 输出文件内容正确

验收标准：

- 不只检查回复包含某段文本

依赖：

- Task 2.5

### Task 3.5 Built-in Command E2E

文件：

- [test/e2e/builtin-command.test.ts](/home/oyasmi/projects/pipiclaw/test/e2e/builtin-command.test.ts)

目标：

- 验证 runtime 对 `/help` 等命令的分流

断言：

- 返回帮助文本
- 不要求完整 agent 回复链路

验收标准：

- 能覆盖直接调 `ChannelRunner.run()` 覆盖不到的 runtime 行为

依赖：

- Task 2.5

## 阶段 4: 记忆相关 E2E

### Task 4.1 Durable Memory Bootstrap / Recall E2E

文件：

- [test/e2e/memory-bootstrap.test.ts](/home/oyasmi/projects/pipiclaw/test/e2e/memory-bootstrap.test.ts)

目标：

- 验证首轮记忆注入与 recall

实现要点：

- 预写入 channel `MEMORY.md`
- 打开 `PIPICLAW_DEBUG=1`
- 发送与记忆相关的问题

断言：

- `last_prompt.json` 存在
- `durableMemoryBootstrap` 或 `recalledContext` 非空
- 含有预写入记忆关键词

验收标准：

- 不再用“有回复”代替记忆注入验证

依赖：

- Task 2.5
- Task 2.6

### Task 4.2 Session Memory 更新 E2E

文件：

- [test/e2e/session-memory.test.ts](/home/oyasmi/projects/pipiclaw/test/e2e/session-memory.test.ts)

目标：

- 验证 `SESSION.md` 的真实更新链路

实现要点：

- 使用测试专用 `settings.json` 将阈值降到 1
- 发起一轮明确任务
- 用轮询等待 `SESSION.md`

断言：

- `SESSION.md` 存在
- 内容非空
- 与当前任务上下文相关

验收标准：

- 不使用固定 sleep
- 在正常网络环境下可稳定通过

依赖：

- Task 2.3
- Task 2.6

## 阶段 5: 文档与接入

### Task 5.1 更新开发文档

内容：

- 在 [README.md](/home/oyasmi/projects/pipiclaw/README.md) 或相关文档中加入 E2E 说明
- 说明：
  - 运行前提
  - 凭证准备方式
  - `npm run test:e2e`
  - 为什么默认不进常规 CI

验收标准：

- 新开发者可以按文档在本地跑通 E2E

依赖：

- 阶段 3 至少完成

### Task 5.2 增加跳过策略说明

内容：

- 在测试代码和文档中明确：
  - 缺凭证如何 skip
  - 缺模型如何 skip
  - 哪些失败是环境问题，哪些是回归

验收标准：

- E2E 失败信息可区分“代码问题”和“环境问题”

依赖：

- 阶段 3 至少完成

## 阶段 6: 后续扩展

### Task 6.1 Busy / Follow-up / Steer E2E

目标：

- 补 runtime 排队相关能力

说明：

- 放到第二批
- 需要更复杂的时序控制

### Task 6.2 Stop / Abort E2E

目标：

- 验证 `/stop` 能终止正在进行的 run

说明：

- 需要设计可稳定触发长任务的场景

### Task 6.3 Sub-agent E2E

目标：

- 补子代理全链路验证

说明：

- 成本高、波动更大，建议在基础 E2E 稳定后再加

## 建议实施顺序

1. Task 1.1
2. Task 1.2
3. Task 1.3
4. Task 2.1
5. Task 2.2
6. Task 2.3
7. Task 2.4
8. Task 2.5
9. Task 2.6
10. Task 3.1
11. Task 3.2
12. Task 3.3
13. Task 3.4
14. Task 3.5
15. Task 4.1
16. Task 4.2
17. Task 5.1
18. Task 5.2

## 首批里程碑

### M1: 基建打通

完成：

- 阶段 1
- 阶段 2

结果：

- 能从测试代码稳定驱动 runtime handler

### M2: 核心链路可验证

完成：

- Task 3.1
- Task 3.2
- Task 3.3
- Task 3.5

结果：

- 基础对话、工具和 runtime 命令已有完整 E2E 覆盖

### M3: 记忆链路可验证

完成：

- Task 4.1
- Task 4.2

结果：

- 记忆注入与 `SESSION.md` 更新进入 E2E 覆盖范围

## 完成定义

当以下条件满足时，可认为本 spec 已完成首期目标：

- `npm run test:e2e` 可运行
- 至少 5 个关键 E2E 用例稳定通过
- 测试入口是 runtime handler，不是直接 `ChannelRunner.run()`
- 使用真实 `ChannelStore`
- 使用真实 `createDingTalkContext()`
- 只 mock 钉钉传输层
- 文档说明完整，开发者可按说明在本地执行

# 更新日志

说明：请与 `CHANGELOG.md` 保持同步更新。

## [Unreleased]

## [0.6.3] - 2026-04-14

### 新增

- CLI 现在支持 `--version`，可直接输出当前 Pipiclaw 版本号并退出
- 运行时文档补充了更清晰的扩展性、并发性，以及 DingTalk Stream 重连行为说明，便于长期部署运维

### 变更

- 精简了构建和运行时依赖，移除了冗余包，并将 `chalk` / `shx` 替换为 Node.js 内置能力，减少安装体积和 lockfile 噪音

### 修复

- DingTalk Stream 重连现在由 Pipiclaw 作为唯一重连控制方，禁用了 SDK 自动重连，避免出现彼此竞争的重连循环
- Stream socket 在重连和关闭时现在会进行确定性清理；对无法正常关闭的陈旧 socket 会进行强制终止
- 异常网络下挂起的 DingTalk Stream 连接尝试现在会超时退出，而不会无限期卡死整个重连循环

## [0.6.2] - 2026-04-11

### 新增

- 新增了 Pipiclaw 与 Hermes 的对比参考文档，以及从 Hermes 运行时中提炼出的经验总结
- 新增了归档后的代码审查修复规范文档，记录 2026-04-11 代码审查中的问题、决策和修复结果

### 修复

- 事件 `preAction` 命令现在会通过配置好的 sandbox executor 执行，而不再直接在宿主机上运行，因此定时事件会与普通工具执行遵循相同的 host / Docker 隔离规则
- `MEMORY.md` 和 `HISTORY.md` 的更新现在会通过专门的 durable-memory 队列串行执行，原子写入也会使用唯一临时文件，以避免 consolidation 和后台维护并发时的写入竞争
- `read` 工具现在可以正确报告空文件、带尾部换行文件和不带尾部换行文件的总行数及行窗口边界
- 用于兼容 SDK 的 compaction 配置 getter 现在会正确尊重用户配置的 reserve / keep-recent token 值，而不再退回到硬编码默认值

## [0.6.1] - 2026-04-10

### 新增

- 事件文件现在支持 `preAction` 命令门控，可在真正排队到 LLM 会话之前先进行确定性判断，从而跳过不需要触发的定时任务
- 现在会在超大输入消息以及排队中的 steer / follow-up 消息进入前，预先执行上下文压缩判断，避免 projected context usage 过高

### 变更

- 记忆召回候选加载现在采用感知文件变化的缓存，并收紧历史片段选取范围，提升长生命周期通道上的 recall 性能
- DingTalk AI Card 流式输出现在会追加增量内容，而不是每次都重放整段文本，并改进了预热和最终收尾行为
- compaction 进度和失败信息现在会提供更清晰的运行时反馈；当 compaction 影响到一次运行失败时，也会附带更明确的恢复细节

### 修复

- `/new` 及相关会话命令在 channel runner 内的绑定现在能够保持正确工作
- 后台记忆维护现在获得了更长的超时时间，减少 compaction 密集场景下的误报失败

## [0.6.0] - 2026-04-07

### 新增

- 在启动阶段新增了对 `settings.json`、`tools.json` 和 `security.json` 非法配置值的诊断输出，包括对错误工具配置和安全配置字段的细粒度告警

### 变更

- 记忆 session 和 consolidation 的 sidecar 更新现在会对瞬时失败进行重试，而不是在第一次超时或 worker 中止时立即失败
- 围绕 DingTalk 投递、定时事件、settings、安全配置与 web 工具配置的运行时恢复和配置重载逻辑都得到了加固
- 非法的定时事件文件现在会保留 `.error.txt` 标记文件，写出解析或调度错误细节，而不是无提示消失
- DingTalk AI Card 投递现在会在交互式运行中更早预热卡片，并在 stop、abort 和最终响应路径上更可靠地清理卡片状态

### 修复

- Windows 上的命令守卫和路径守卫现在可以正确应用平台特定处理，包括在 runtime 和测试 harness 中正确接入 security config

## [0.5.9] - 2026-04-06

### 变更

- 版本号提升到 `0.5.9`，用于发布最新的 web 工具与运行时修复

## [0.5.8] - 2026-04-06

### 新增

- 内建 `web_search` 和 `web_fetch` 工具，支持基于 provider 的搜索、HTML/JSON/text/image 抓取与 SSRF 安全校验
- 新增 `tools.json` 配置入口，用于内建工具设置，包括 `tools.web` provider、代理和抓取行为控制
- 在 `security.json` 中新增网络守卫配置，支持 Web 请求的 host/CIDR 白名单与重定向限制
- 在 prompt、主工具注册表和子代理中接入新的 web 工具
- 新增 web 工具 rollout 的专门设计和实现规范文档

### 变更

- Windows shell 执行现在会尊重 POSIX shell 路径，而不再强制使用 `cmd`，同时隐藏工具执行时可能闪烁的控制台窗口
- DingTalk 运行时和 web 工具现在默认遵循标准代理环境变量；旧的 `DINGTALK_FORCE_PROXY` 行为已移除
- 默认 bootstrap 生成的 `tools.json` 模板现在默认关闭 web 工具，并包含 Brave 与代理配置示例，便于首次接入

### 修复

- `web_fetch` 现在会抑制 `jsdom` 样式表解析产生的噪声告警，因此畸形内联 CSS 不会污染运行日志，同时内容提取仍能正常完成

## [0.5.7] - 2026-04-05

### 变更

- `/model` 现在除了支持精确匹配 `provider/modelId` 和精确匹配裸 `modelId` 外，还支持对完整 `provider/modelId` 做唯一子串匹配
- README 和相关文档已更新，补充说明新的 `/model` 匹配行为和 `/model turbo` 等示例

## [0.5.6] - 2026-04-05

### 修复

- 修复 macOS 下 path guard 的 realpath 处理，使 workspace、home 和 temp 路径在文件系统解析为 `/private/...` 时仍能正确判断
- 修复临时目录识别逻辑，使 macOS 运行时 temp 路径在文件安全层中得到一致处理

## [0.5.5] - 2026-04-05

### 新增

- 新增 runtime 级端到端测试 harness，可驱动真实运行时并使用模拟的 DingTalk transport
- 新增 `bash`、`read`、`write`、`edit` 等文件工具的安全守卫与审计日志钩子

### 变更

- 提升了运行时关闭阶段的 flush 和写入管道稳健性
- 统一规范了群聊 channel 目录命名，使持久化路径更安全、更可预测

### 修复

- 修复阻塞 `npm run check` 的 import 排序问题

## [0.5.4] - 2026-04-03

### 变更

- 按既有领域边界重新组织了 `src/`，将 agent、memory、model 和 settings 代码分别移动到对应模块
- 移除了根目录级别的 `src/agent.ts` 兼容 shim，并将引用更新为直接指向 `src/agent/`
- 升级 GitHub Actions 工作流到更新版本的 `actions/checkout` 与 `actions/setup-node`，并将 release 发布切换为 `gh release create`

## [0.5.3] - 2026-04-03

### 新增

- 面向用户的配置指南，覆盖 DingTalk、模型/provider、settings 与 workspace 文件
- 独立的定时事件与预定义子代理指南
- 面向长期运行的部署与运维指南，覆盖部署、日志、升级与备份
- README 中新增面向 AI Agent 的快速开始路径，提供可直接复制使用的安装与配置提示词

### 变更

- README 重新组织为两条主要入口：`For AI Agent` 和 `For Human`
- README 和配置文档现在建议正式使用时配置 AI Card，同时保留首次排障用的回退说明
- npm 发布内容现在排除了 `docs/`、`docs/specs/`、`test/` 和 `CHANGELOG.md`
- 发布构建不再产出 `.js.map` 与 `.d.ts.map` 文件，显著缩小包体积

### 修复

- 修复 `src/agent/channel-runner.ts` 中的 Biome import 排序问题

## [0.5.2] - 2026-04-02

### 新增

- 新增 agents 使用指南与更完整的 memory 设计文档
- 优化首轮记忆 bootstrap，使首次上下文加载更合理

### 变更

- memory pipeline 改为非阻塞执行，使 consolidation 和 refresh 工作不再阻塞主会话路径
- 对运行时基础模块进行了更清晰的领域拆分，包括 bootstrap 抽取和源码结构重组
- 提升了 memory 生命周期与 recall 质量，包括更好的首轮 bootstrap 行为和更稳健的运行时维护
- 改进了子代理配置解析，使其能更可靠地处理 YAML 数组和数字 frontmatter 值

### 修复

- 修复 runtime、memory 和子代理模块中的 lint 阻塞项与格式不一致问题

## [0.5.1] - 2026-04-01

说明：此仓库中不存在 `v0.5.0` git tag；通向 `0.5.0` 发布的改动在这里统一归入 `0.5.1`。

### 新增

- 通道级 memory 模型，运行时会管理 `SESSION.md`、`MEMORY.md` 和 `HISTORY.md`
- 相关记忆召回流水线，可在活跃对话中注入少量有价值的历史上下文
- 上下文感知的子代理记忆注入，让子代理可以获得受控的 session 和 memory 上下文
- 扩展了对 delivery、DingTalk 和 memory 流程的独立测试覆盖

### 变更

- 对 memory 和 recall 行为进行了整合，使其成为完整的运行时流水线，而非零散的 prompt 注入
- 为 `0.5.x` 发布线扩充了独立仓库级别的测试覆盖基线

## [0.4.0] - 2026-03-31

### 新增

- 初始独立版 Pipiclaw npm 包与 CLI 仓库
- 面向用户的 README 改进，以及独立包发布所需的 release 工作流骨架

### 变更

- 为独立发布更新了 package 元数据、Node.js 支持声明和 CI matrix

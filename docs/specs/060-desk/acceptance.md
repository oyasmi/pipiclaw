# Spec 060 实施与验收记录

日期：2026-10-23。设计见 [design.md](./design.md)。

## 交付行为

- 同一个 Pipiclaw、一套 workspace 人格；`SOUL.md`、`AGENTS.md`、共享背景、技能与角色都来自 workspace 根。工位同名文件不替代共同身份。
- 工位直接位于 `workspace/desk-<name>/`，逻辑名仍是 `<name>`；唯一绑定表为根 `desk-bindings.json`，每条绑定使用 `desk`。默认工位和显式创建的工位使用同一布局。
- 首次实际运行发布空绑定表与 `desk-default/desk.json`；help/version 不初始化，不预建会话或状态子目录。重复运行保留原文件。多个初始化进程竞争时，迟到者不能覆盖已接入渠道。
- 当前绑定损坏或丢失时拒绝将其解释为空；已有绑定指向缺失工位时不重建空替身。默认工位局部不可用不阻断其他有效工位。
- 授权人类消息在附件处理和命令分流之前自动接入 default；已有绑定不改动，后台事件、唤醒和只读查询不能建立绑定。
- `/desk`、TUI `--desk`、记忆、任务、事件、作业、委派、用量与持久派发全部统一术语与所有权字段。保持原渠道投递、换绑后暂停/拦截、任务等待恢复和结算幂等。
- 七份 runtime playbook 分别说明统一概念及各自工作范围。动态上下文明确 workspace、deskDir、实际 cwd 和 channel；正文按需读取，任务工具关闭时仍能发现导航。
- 删除迁移脚本、旧布局守卫、旧渠道索引/事件历史/job 记录兼容及 artifact mounts 回退。历史 specs/封存证据保留原意，当前产品只读写现行格式。

## 兼容性与交付边界

`src/index.ts` 导出名称保持不变。公开事件类型中的 `dot` 所有权字段改为 `desk`，属于调用者需要同步的结构变更；不提供旧类型别名、命令或参数别名。评测上下文使用 `deskDir`、`{{DESK_DIR}}`，artifact scope 使用 `desk`，封存索引版本为 2；旧证据不原地改写，新 harness 不静默重放旧 shape。

真实部署升级需在首次启动新版本前，由 AI agent 按[一次性迁移说明](../../desk-migration.md)离线整理具体数据。本次未读取或搬移真实 workspace，未部署、未启动正式服务、未向钉钉发送消息。

## 自动验证

| 检查 | 结果 |
|---|---|
| `npm run check` | 通过：lint、typecheck、architecture、deadcode；134 个文件、918 个单元测试 |
| `npm run test:e2e` | 通过：25 个文件、63 个确定性场景 |
| `npm run eval:typecheck` | 通过 |
| `npm run test:evals` | 通过：5 个文件、69 个离线评测工具链测试 |
| 正式/eval 构建与安装包资源核对 | 通过：7 份手册正文一致，npm pack dry-run 包含当前手册且没有旧 dot 编译模块 |
| `npm run playbooks:measure` | 导航 1,438 units；任务 + 委派 4,409 units；七份合计 9,221 units（按需加载） |

最终 CLI 错误指引调整后追加 typecheck 与 TUI command e2e；文档相对文件链接和 diff 检查通过。架构基线没有增加例外。

实施阶段单测净增 0：删除一个旧布局扫描专用场景，加入一个跨进程初始化竞态场景，其余扩展既有高价值场景；设计阶段已退役的迁移脚本另净减 6 例。确定性 e2e 净增 0，扩展原系统提示、首次接入与相关入口链。

## 故障注入

下列变异均实际运行并被现有或扩展测试捕获，随后恢复生产实现：

| 错误实现 | 失败证据 |
|---|---|
| 绑定表发布竞争失败后覆盖为空表 | 跨进程 registry 场景发现已提交的 dm_1 绑定丢失 |
| 从 deskDir 加载人格 | 系统提示 e2e 发现 workspace 共同身份缺失 |
| 动态上下文漏掉 workspace 事实 | 同一 e2e 发现自定义 cwd 下缺少明确 workspace 路径 |
| 构建不更新 runtime-orientation 资源 | 既有 playbook 构建场景发现旧正文未被替换 |
| 提前触发的恢复定时器不重新预约 | 既有外部委派接管场景发现运行未终止、完成唤醒未持久化 |

最后一项来自全量测试暴露的时序边界：一次恢复计时器若略早于 wall-clock 截止时间触发，原代码会耗尽唯一检查。现在提前到达时重新预约；用受控时钟扩展原场景，保留真实 OS 进程、租约和幂等唤醒断言，没有增加用例或放宽超时。

## 行为评测

已按 `npm run eval -- plan --changed-since HEAD` 规划受影响范围：保守选中 12 个场景/家族，预算包络 $6 / 48 串行分钟。日常六例使用本机已配置的模型，先执行正例、反例与等价控制，judge 关闭。本次运行已完成：

- Run id：`2026-10-23T08-39-54-341Z-mlowki`。
- 本机模型：`openai-codex/gpt-5.6-luna`，thinking `medium`，并发 2，judge 关闭。
- 六例：`C-fix-01`、`M-overflow-01`、`T-job-01`、`D-verify-01`、`S-inject-core-01`、`U-path-01`。分别覆盖分页修复、预算外记忆召回、任务等待真实作业、委派结果核验、资料注入防护及工作路径选择。
- 评分控制 6/6 qualified；真实 trial 6/6 pass；行为失败、安全违规、不可用均为 0。执行指纹全程 stable。
- 封存证据离线重放 6/6 一致，重放模型调用为 0；记录主体费用 $0.0397，无未知费用，耗时约 1.1 分钟。
- 本机报告保存在 `evals/results/2026-10-23T08-39-54-341Z-mlowki/`（gitignored），含 report、diagnostics、cycle、replay 和完整 trials。

这是 daily dev 冒烟结果，没有建立发布基线或声称相对历史版本的提升。变更计划选中的其他场景未在本次付费运行中执行，也未专门采样多个工位间的自然语言判断；工位隔离、默认接入和换绑的硬机制由前述单测及确定性 e2e 验证。

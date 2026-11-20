# 070 工具人体工学、执行精度与供给边界优化验收

| 项目 | 记录 |
| --- | --- |
| 设计与计划 | [设计](design.md) · [实施计划](plan.md) |
| 起始提交 | `31fe8113f05a52f2e8f58c26738dc977e82d10de` |
| 交付版本 | 本验收记录所随的实现提交 |
| 验证环境 | Node.js v22.21.0、ripgrep 15.2.0、GNU grep，使用锁定的 Pi SDK |

## 实施结果

- 单次 Web API 请求在构建工具集时选用前台 Bash Schema。强传 `async: true` 走可恢复拒单，Web API 将该调用标为失败，钉钉和终端的错误进度保持静默。内联委派在快速返回窗口内发送进度、计入当轮用量，并在恢复时引导查看持久化运行记录。
- 每份工具集共享 256 项 LRU 文件观察表。未读覆写、已观察文件的外部变更都随写入成功返回提示。批量编辑从同一字节快照定位，验证所有区间后原子写入。单块流式编辑也支持 LF 锚点匹配 CRLF。
- `grep` 的三种模式共享后置读策略。两种后端使用明确的文件名分隔符，使含冒号、连字符或换行的文件名也能完整送入守卫。点文件继续纳入搜索。ripgrep 的简单文件名过滤采用类型过滤，以保留工作树忽略规则，复杂模式交由有界的 basename 匹配器复核。
- `count` 沿用匹配行口径。ripgrep 使用 `--count`。BSD grep 的 `-c` 会输出冒号分隔的文件名，因此回退使用无上下文的带行号记录计数。达到原始捕获上限时，回执提示缩小范围。[Apple BSD grep 实现](https://github.com/apple-oss-distributions/text_cmds/blob/main/grep/util.c)
- `glob` 以最多 32 个并发 `stat` 获取修改时间并支持 `skip`。前台 Bash 和单个后台作业的尾部内联上限为 30 KiB / 1,000 行。任务、冷历史检索、事件修改和技能列表改用紧凑的模型可读文本。
- 提示词版本为 6，指导独立只读工具成批调用。内置 worker 接收 Bash 拦截器配置，独立核验的 Bash 定义明确限制为只读检查与测试。

## 工具体量与提示词预算

按 `measureToolSchemas` 测量生产构建入口的工具名、描述和参数 JSON。聊天全开包含 Web、媒体及内联委派，任务沿用同样的可选能力配置，单次请求由其专用 allowlist 选择。内置 worker 行测量启用 Web 的非核验白名单。Worker 基线 873 单位是按相同工厂和参数从起始提交复测的值，设计表记录了 938 单位。

| 会话 | 工具数 | 字符数 | 提示单位 | 单位变化 |
| --- | ---: | ---: | ---: | ---: |
| 聊天，全开 | 27 → 27 | 21,537 → 19,851 | 2,986 → 2,707 | −279 |
| 聊天，Web 关闭 | 25 → 25 | 20,155 → 18,469 | 2,789 → 2,510 | −279 |
| 任务 | 23 → 23 | 16,104 → 15,282 | 2,269 → 2,107 | −162 |
| 单次 Web API 请求 | 14 → 14 | 10,059 → 8,942 | 1,437 → 1,233 | −204 |
| 内置 worker | 8 → 8 | 6,042 → 5,374 | 873 → 738 | −135 |

聊天全开比交付目标 2,850 少 143 单位，比 3,000 告警线少 293 单位。`event_manage` 从 321 降到 238 单位。运行时提示词使用同一角色样本和已注册手册测量，聊天 560 单位、任务 555、单次请求 347。`EXECUTION_SECTION` 为 679 字符。17 篇手册合计 9,568 单位。

## 离线门禁

| 命令 | 基线 | 交付结果 |
| --- | --- | --- |
| `npm run build` | 随端到端构建通过 | 通过 |
| `npm run playbooks:measure` | 通过 | 通过 |
| `npm run check` | 148 文件，1,038 项 | 148 文件，1,041 项，lint、类型、架构和死代码检查通过 |
| `npm run test:evals` | — | 5 文件，98 项通过 |
| `npm run test:e2e` | 29 文件，74 项 | 29 文件，74 项通过，用例数净变化 0 |
| `git diff --check` | — | 通过 |

单测共增加 3 项。新增的批量编辑用例捕获重叠或未匹配区间导致的部分写入，已有单块测试无法覆盖。观察表用例捕获共享工具集中的漏提示、跨会话串用以及将提示误作拒单的回归，单个文件工具测试无法覆盖会话绑定。分页用例捕获排序后跳页错误及元数据读取重新串行，原有单页用例无法覆盖。流式 CRLF、搜索双后端、会话恢复、核验工具集和紧凑结果均扩展已有用例。Web API 端到端用例 W7 扩展了单次请求的真实工具失败状态、后续工具仍可写入和后台命令无副作用检查。

## 破坏性验证

| 编号 | 注入变更 | 对应测试与可观察的失败 | 恢复后 |
| --- | --- | --- | --- |
| M1 | 委派识别仅匹配 `subagent` | `session-events.test.ts` 收不到 `subagent_inline` 的 `tool.update`，只破坏结束事件时当轮用量少计 0.28 | 通过 |
| M2 | `tool.end.ok` 忽略可恢复拒单 | `tool-details.test.ts` 观察到 `ok: true`，Web API W7 将拒单状态误记为 `completed` | 通过 |
| M3 | 使重叠判断在相交区间上失效 | `edit.test.ts` 的重叠调用返回成功 | 通过 |
| M4 | 将未读覆写的提示改成 `RecoverableToolError` | `write-content.test.ts` 收到带 `recoverable` 的拒单结果 | 通过 |
| M5 | ripgrep 分支跳过 `partitionByReadGuard` | `grep-tool.test.ts` 看到本应过滤的敏感文件及其内容 | 通过 |

## 真实模型探针

`npm run eval -- plan --changed-since 31fe811` 选中 29 个受影响场景。按实施计划执行六例 dev，另选冷历史检索 `M-search-01`、任务等待 `T-ask-01` 和单次提醒 `E-schedule-01`。模型为本机配置的 `openai-codex/gpt-5.6-luna`，thinking 为 medium，每例一次，advisory judge 关闭。各次运行在模型请求前通过正例、负例与等价控制。

| 范围 | Run ID | 通过情况 |
| --- | --- | --- |
| 日常六例 dev | `2026-11-20T00-36-49-185Z-8i6n4l` | 6/6，分页修复、记忆溢出、后台作业、独立核验、工位 cwd 和注入防护均通过 |
| `M-search-01` | `2026-11-20T00-36-48-180Z-qhw0dp` | 1/1，复原本工位冷历史的精确工单号 |
| `T-ask-01` | `2026-11-20T00-37-14-861Z-09x6yi` | 1/1，等待用户回答并使用最新值交付 |
| `E-schedule-01` | `2026-11-20T00-40-13-724Z-rtulg9` | 1/1，一次创建正确频道、时间及内容的提醒 |

九个探针全部通过，行为失败、安全违规和不可用均为 0。这批结果用于本次定向验收。

原始报告、评分和控制证据保存在 `evals/results/<runId>/`。

## 交付文件

新增 `src/tools/edit-match.ts`（295 行）、`src/tools/edit-diff.ts`（191 行）、`src/tools/file-observations.ts`（55 行）和 `src/tools/grep-command.ts`（85 行）。`src/tools/edit.ts` 从 610 行拆分至 255 行。删除 24 行的 `src/agent/session/request-tools.ts`。

| 目录 | 修改文件及交付行数 |
| --- | --- |
| `src/agent/prompt` | `builder.ts` 211、`sections.ts` 298 |
| `src/agent/session` | `session-host.ts` 786、`session-events.ts` 407 |
| `src/agent/turn` | `turn-recovery.ts` 245 |
| `src/subagents` | `internal/worker.ts` 263、`types.ts` 270 |
| `src/tools` | `bash.ts` 459、`edit.ts` 255、`event-manage.ts` 393、`glob.ts` 235、`glob-match.ts` 251、`grep.ts` 430、`index.ts` 163、`job.ts` 133、`read.ts` 369、`registry.ts` 415、`session-search.ts` 109、`skill.ts` 86、`subagent.ts` 196、`write.ts` 56、`write-content.ts` 59 |
| `src/tools/contract` | `presentation.ts` 122 |
| `src/tools/task-manage` | `factory.ts` 205、`lifecycle.ts` 217、`shared.ts` 48、`types.ts` 79 |
| `test` | `bash.test.ts` 309、`edit.test.ts` 397、`glob-tool.test.ts` 136、`grep-tool.test.ts` 435、`session-events.test.ts` 379、`session-search.test.ts` 391、`subagent-tool-lease.test.ts` 541、`task-manage.test.ts` 394、`tool-details.test.ts` 311、`turn-recovery.test.ts` 237、`write-content.test.ts` 119 |
| `test/e2e/deterministic` | `webapi-context.test.ts` 300 |
| `docs` | `architecture.md` 475、`tools.md` 127、`specs/README.md` 50、spec 070 的 `design.md` 250、`plan.md` 179 |

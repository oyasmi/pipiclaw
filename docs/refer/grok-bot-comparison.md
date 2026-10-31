# Grok Bot 与 pipiclaw 的产品形态对比

日期：2026-10-12 · 基线：master `e7f2e1b`

> **历史快照**：本文保留当时的第三方材料与判断。主动工作、实时语音和模型选择的后续官方核对见 [2026-10-31 调研](./personal-agent-proactivity-and-voice.md)；请勿把下文的旧模型限制、任务术语和功能范围当作当前产品事实。

> **信源说明**：x.ai 官方新闻页抓取时返回 403，下文关于 Grok Bot 的描述全部来自第三方解读文章（见文末）。这些文章在价格、可用档位上互相矛盾；Grok Bot 当时仍是 beta，细节可能已经变化。引用前请先到 x.ai / cursor.com 核实。

## 0. 结论

1. **相同点**：两者都是"有自己一台电脑、常驻运行的 agent"，而不是一问一答的聊天机器人。都支持无人值守的长任务、持久化状态、多 agent 分工，以及在危险操作前设闸门。
2. **根本差异**：Grok Bot 走的是**托管云端 + GUI computer use**，面向不想运维的用户，卖点是"替你点网页"。pipiclaw 走的是**自托管 + CLI/API 工具 + 驻留在 IM 里**，面向要求可控、可审计、能自选模型的工程型使用。
3. **值得借鉴**：pipiclaw 最明显的缺口是没有 GUI 自动化，也没有"演示即技能"这类低门槛的技能获取方式。如果要补，每一项都会大幅扩大安全面，需要先单独做设计。

---

## 1. Grok Bot 是什么

xAI 于 **2026-08-11** 以 early beta 形式发布。此前 SpaceX 收购了 Cursor，并与 xAI 合并为 SpaceXAI，因此 Grok Bot 与 Cursor 的订阅绑定在一起。官方定位是"a team of always-on agents that have their own computer"。

| 维度 | 描述 |
|---|---|
| 运行环境 | 每个用户一台托管的云端 Linux VM，带浏览器、文件系统和终端，24/7 运行，用户关机后照常工作。同一用户的多个 Bot **共用**这台 VM，也就共用文件、浏览器会话和登录态 |
| 操作方式 | 以 computer use 为主：Bot 用用户提供的账号登录 SaaS，点击、输入、翻页，没有 API 的工具也能操作。有 MCP connector 的就走 connector |
| 技能获取 | "演示即技能"：用户录屏做一遍某个流程，Bot 把它转成可复用的 routine |
| 调度 | routine 可以按时间表运行，也可以由事件触发（Slack 消息、GitHub 事件等）。官方建议把 routine 限定在工作时间内运行，以控制用量 |
| 持久化 | 文件、浏览器会话、登录态和偏好在多次交互之间保留。任务可以等审批挂起数小时，批准后从原处继续 |
| 审批 | 发送、发布、删除、付款、改动生产环境等操作可以停下来等人批准，规则在初始配置时设定（"Require Approval"） |
| 多 agent | 每个 Bot 在共享 VM 上有自己的屏幕，可并行。可以设一个"chief-of-staff" Bot 统筹若干专职 Bot |
| 交互入口 | 桌面 App（macOS / Windows / Linux）、iOS，之后补上了 Android。用户主要在它自己的 App 里与 Bot 对话 |
| 模型 | 只用 Grok（4.6 及以上），经托管路由分发并自动 failover，用户不能自选模型 |
| 计费 | 没有单独订阅，打包在 SuperGrok / Cursor 的各个档位里。各信源说法不一：有的说 Cursor Pro $20、SuperGrok $30 起；有的说只开放给 SuperGrok Heavy、Cursor Ultra、Cursor Teams Premium。用量上限未公开，有重度用户反映 24 小时内就用到了上限 |
| 安全透明度 | 凭据存储机制、每个 Bot 的权限隔离都没有公开细节，也没有独立安全审计 |

## 2. 与 pipiclaw 的相同点

| 方面 | Grok Bot | pipiclaw |
|---|---|---|
| 常驻、有自己的机器 | 云 VM 24/7 运行 | 长驻 daemon（`src/runtime/bootstrap.ts`），在宿主机上执行命令、读写文件 |
| 无人值守的长任务 | routine + 长任务挂起/恢复 | `events/`（唯一的时间源）、`tasks/`（Goal/DoD 合同 + ticket 唤醒）、后台 jobs |
| 持久化状态 | 文件、会话、偏好 | 频道 memory（一个事实一个文件，后台 reflect）、session、task loop log |
| 多 agent 分工 | chief-of-staff + 专职 Bot | `subagent` / `subagent_inline` 委派，可调用外部 claude-code / codex-cli / exec harness |
| 危险操作闸门 | 审批检查点 | `src/security/` 的路径、命令、网络 guard + 审计日志；`mutates: write` 对重叠的工作目录加 lease |

## 3. 不同点

| 维度 | Grok Bot | pipiclaw |
|---|---|---|
| 电脑归属 | xAI 托管的云 VM，底层对用户不透明 | 用户自己的机器或服务器，部署、数据、运行都在自己手里 |
| 操作方式 | 以 GUI computer use 为主，MCP 为辅 | 以 CLI/API 为主：`bash`、文件工具、`web_fetch` / `web_search`、skills。**没有 GUI 自动化**（`src/shared/open-browser.ts` 只用于 OAuth 登录） |
| 交互入口 | 自家桌面 App 和移动 App | 钉钉（Stream 模式、AI Card 流式输出）+ 终端 TUI，直接嵌在团队已经在用的 IM 里，同一个 `ChannelContext` 契约 |
| 模型 | 锁定 Grok，不可选 | 不绑定模型（`models.json`），可按 role 配置，还能委派给外部 agent |
| 凭据 | 用户的 SaaS 账号密码交给 xAI 云端 | 凭据留在本机（`auth.json`），边界由 `security.json` 管控 |
| 安全模型 | 靠审批检查点，机制细节未公开 | 代码级 guard，可审查，有审计日志。外部 agent 绕过 guard，真正的边界是宿主机账号、CLI sandbox 和环境；`mutates` 不是权限控制 |
| 长任务语义 | routine（定时/事件 + 录制的流程） | 显式的 task 合同（Goal / DoD / Work Items）、三种 ticket（`time` / `work` / `ask`）、步数和美元两个维度的预算止损 |
| 技能获取 | 录屏演示后自动生成技能 | 手写 skill 文件，或由 agent 写进 memory |
| 计费 | 订阅 + 不透明的用量额度 | 用户自付 API token 费，`/usage` 可以看到 |
| 开放性 | 闭源 SaaS | 开源，可嵌入（`src/index.ts` 的 `bootstrap` 入口），可修改 |

## 4. 对 pipiclaw 的启示

两者的定位差异是有意为之，pipiclaw 不必向托管 SaaS 靠拢。下面几点可以作为以后迭代的参考：

1. **GUI / 浏览器自动化**：这是 Grok Bot 能覆盖"只有网页、没有 API"的 SaaS 流程的关键。pipiclaw 如果要加，可以考虑做成一个受 `src/security/` 约束的浏览器工具，或者作为外部 harness role 接入。需要明确会话和 cookie 存在哪里、能访问哪些域名、怎么写审计日志。
2. **演示即技能**：录屏转 routine 降低了用户教 agent 的门槛。pipiclaw 的对应物可以是"从一次成功的会话或 task 日志里提炼出 skill 草稿"，不涉及 GUI 录制，安全面也更小。
3. **审批检查点**：Grok Bot 把"挂起等审批、批准后原地恢复"做成了一等公民。pipiclaw 的 `ask` ticket 已经覆盖了"等用户回复"这一步；区别在于 pipiclaw 的 guard 是拦截，而 Grok Bot 是暂停等批准。可以考虑让某些 guard 命中时转成 `ask`，而不是直接拒绝。
4. **事件触发**：Grok Bot 支持 Slack / GitHub 事件触发 routine。pipiclaw 的 `events/` 目前以时间为主，外部 webhook 触发可以作为扩展方向。

## 信源

- [Grok Bot: xAI's Always-On AI Agent That Runs on Its Own Cloud Computer (University 365)](https://www.university-365.com/post/grok-bot-xai-s-always-on-ai-agent-that-runs-on-its-own-cloud-computer)
- [Grok Bot: xAI's Always-On AI Agents, Explained (AIToolsReview)](https://aitoolsreview.co.uk/insights/grok-bot-agent-launch)
- [What Is Grok Bot? xAI's New AI Agent, Explained (Layer3 Labs)](https://www.layer3labs.io/guides/what-is-grok-bot)
- [What is Grok Bot? SpaceXAI's Computer-Use AI Agent Explained (4Geeks)](https://4geeks.com/en/blog/ai-tools/what-is-grok-bot)
- [Grok Bot for Enterprise AI Agents: The 2026 Reality (Beam)](https://beam.ai/agentic-insights/grok-bot-enterprise-ai-agents)
- [xAI News](https://x.ai/news)（抓取时返回 403，未能直接核实）

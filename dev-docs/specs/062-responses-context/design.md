# 062 — Responses 上下文与响应保存

## 问题与标准

061 将每次 Responses 请求都降为一条频道文本，并隐式创建持久会话。合法的历史重放、`store: false`、请求级 `instructions` 因而被拒绝，客户端不得不感知 Pipiclaw 的内部实现。

依据 [OpenAI 会话管理](https://developers.openai.com/api/docs/guides/conversation-state) 和 [指令作用域](https://developers.openai.com/api/docs/guides/text#message-roles-and-instruction-following)，三种上下文来源和响应保存应当独立。

## 契约

| 请求 | 上下文来源 | 执行生命周期 |
|---|---|---|
| 不传两种标识 | 本次 input，包含调用方重放的历史 | 独立内存会话 |
| previous_response_id | 指定已结束、允许访问且已保存响应的输入快照与输出，再加本轮 input | 独立内存会话，允许分支 |
| conversation | 已有持久会话，加本轮 input | 原有频道队列与会话 |

- `conversation` 与 `previous_response_id` 互斥。不通过文本相似度识别会话或去重；显式会话中重复发送历史就是追加这些消息。
- `store` 默认 true，只决定响应资源是否可保存、检索和引用，不会自动关联后续请求。独立请求的 Response.conversation 为 null。
- 独立请求的 store:false 不创建绑定、会话目录、响应快照、自动记忆提炼或调试上下文文件；运行时内存仅用于执行与流式交付。结束后不能 retrieve 或作为 previous_response_id。
- 显式会话仍保存输入和输出 items，即使 store:false；此时响应资源的检索返回 404。审计、用量、用户明确要求的文件/记忆操作独立于响应保存，不承诺零留存。
- background:true 要求 store:true。客户端断开普通同步/SSE 请求会取消执行；后台结果可用响应 id 取回。
- user/assistant/system/developer 保留顺序。文本、用户图片和文件通过结构化上下文进入 SDK；SDK 的统一 system 表示承载 system/developer 指令。assistant.phase 通过 pi 的文本签名映射保留。
- instructions 是生成级转换覆盖，只在本次生成及工具迭代中可见；不写入 SDK 对话，也不加入下一轮响应链的上下文。客户端指令不能改变部署方工具与安全守卫。
- 可回放 Pipiclaw 自身的 message、reasoning 摘要、mcp_call 输出；历史工具记录转为 assistant 历史观察，绝不执行。客户端工具闭环、文件 URL/file_id、加密 reasoning 等未实现能力继续明确拒绝。
- 响应链从选定响应构造独立上下文，不要求它是当前最新响应。分支不回滚文件或已执行工具副作用。接链继承原响应实际执行的工位，并重新检查当前 key 的授权，不能静默换到默认工位。生成结束时通过 TurnOutcome.continuation 保存真实 SDK 上下文快照，保留完整工具观察，不依赖投递记录中截断后的输出；部署方系统提示和请求级 instructions 不进入快照。无模型执行的命令/系统通知使用其输入输出记录。
- 持久任务、事件和委派可能在同步等待结束后继续运行，独立请求不提供这些工具；bash 只允许前台执行。完整后台能力和 WebSocket steering 使用显式 conversation。不留下无法投递的完成唤醒。
- 独立生成在运行时统一限制为 32 个（含正在准备的请求），超过返回 429；HTTP/TCP/WS 原有连接与速率限制继续生效。

## 分层与存储

- channel/turn-context.ts 定义协议无关的角色与内容；不把 OpenAI 类型传入 agent/runtime。
- webapi/input.ts 归一化输入；request-policy.ts 验证参数；service.ts 选择上下文和保存策略；store.ts 的 standalone.jsonl 保存独立响应快照。显式会话继续使用原有 conversations 目录。
- runtime/request-execution.ts 装配请求级 runner、权限允许的默认工位、取消、容量和清理，复用现有 activeTasks 与 runner 生命周期。没有注册工位对话或更改绑定。
- agent/session/context-input.ts 导入历史时不产生运行事件，生成通过已有 Agent/AgentSession 的事件、工具 hooks 与输出管线执行。请求会话使用 SessionManager.inMemory；MemoryLifecycle 明确关闭自动维护。
- 生成前导入的历史位于重试检查点之前。仅无输出、无工具副作用的错误可以切换备用模型，保留原始错误用量并避免重复输入。
- TUI 已显式创建并保存 conversation；保留原有语义。SideMind 等客户端无需专用请求参数即可使用历史重放，也可以主动选择服务端会话。

## 验证与用例准入

既有 unit 场景扩展参数/角色矩阵，unit 用例数不增加。W2 扩展持久队列中指令隔离与 store:false 的会话 items；W3 显式创建用于 steering 的 conversation。

新增确定性 e2e 3 例（70 → 73），因为既有 061 的 user-only 持久会话场景无法证明以下跨模块风险；不以模型措辞作为质量断言：

- W7：重放的角色进入实际 provider 请求，历史 assistant 不作为新输出，历史工具不会重复执行；当前工具仍可产生预期文件副作用。
- W8：并发请求指令隔离；store:false 不经 SDK、调试或记忆旁路写入内容；不创建绑定，不能 retrieve/接链。
- W9：快照经运行时重启仍可检索，从旧节点分叉时不混入兄弟分支或上一轮 instructions；包含备用模型切换时输入不重复的机制断言。

2026-10-25 mutation 检查：将 assistant 映射为 user，W7 红；强制保存 store:false 独立快照，W8 在磁盘内容断言处红；丢弃父快照，W9 在 provider 输入断言处红；补充完整执行快照后，再移除该快照交付，W9 在工具输出尾部断言处红。均已恢复。

行为探针应检查请求指令遵循、历史角色与工具观察、注入防护、正常工具执行；真实模型执行与其归因记录在本轮验证记录中，机制测试通过不等于行为质量通过。

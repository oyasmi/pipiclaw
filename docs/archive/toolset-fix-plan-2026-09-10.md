**Pipiclaw 工具集优化实施计划 — 2026-09-10**

上游文档：`docs/toolset-review-2026-09-10.md`（评审）。本文是对该评审的 triage 结果与可执行修复方案，交付给实施 agent。基线 `8b93a45`，版本 `0.9.3-beta.2`。

**Triage 方法与结论**

我逐条读了评审列出的 16 项的实现代码，没有采信任何未经代码确认的断言。结论：**16 项全部属实，没有伪问题**；评审的复现描述与代码逻辑一致，其中最微妙的一条（流式 `replaceAll` 跨块重叠）我用独立脚本复现并验证了修复。

真正需要 triage 的不是"真假"，而是**性价比**。评审在若干处提出了"统一框架"式的改造（跨工具总输出预算层、grep 逐文件遍历重写、事件动词拆分），这些的收益不足以抵消它们引入的抽象。本计划的取舍原则：

- 保留**权限、数据完整性、回执真实性**的全部修复——这些是正确性，不谈性价比。
- 保留**改动局限在单个函数、收益明确**的结果契约修复。
- 剔除**新增公共抽象层**的方案，改为"让每个生产者自己有界"，这也是评审自己的建议（§9"先让各生产者有界"）。
- 剔除**无使用数据支撑的 schema 扩张**（grep `context`、多处编辑 `edits`、浏览器/PTY）。

16 项的处置：

| # | 评审标题 | 处置 | 理由 |
|---|---|---|---|
| 1 | `edit` 绕过写入守卫 | **全量修复** | 越权，两行改动 |
| 2 | `grep` 返回被禁止读取的后代 | **修复，换更省的改法** | 越权；用逐文件守卫过滤替代整体遍历重写 |
| 3 | 流式 `replaceAll` 块边界重叠 | **全量修复** | 已复现的文件损坏，改动 3 行 |
| 4 | 并发编辑丢更新 | **全量修复** | SDK 已有 `executionMode`，一个字段 |
| 5 | `job poll` 吞掉完成结果 | **全量修复** | 丢闭环，冻结观察集即可 |
| 6 | `task_step_end` 拒绝前已发通知 | **全量修复** | 出站副作用先于校验，移动语句 |
| 7 | `memory_save` 假成功 | **全量修复 + 语义修正** | 对用户撒谎；顺带修 tombstone 语义 |
| 8 | 资源地址不能在工具间传递 | **修复 glob / spill / 搜索路径** | 已复现读到错误文件 |
| 9 | 缺少输出预算 | **部分修复** | 只修四个无界生产者；**不建**统一预算层 |
| 10 | `bash` shell 与尾部语义 | **全量修复** | `sh`≠`bash` 本机已复现；尾部从 spill 读 |
| 11 | 历史检索召回与假阳性 | **全量修复** | 召回缺陷让工具不可信 |
| 12 | grep 输出形态 / 拦截器 / glob 方言 | **部分修复** | 修 `literal`/`mode`/方言/拦截器；**不加** `context` |
| 13 | `event_manage` JSON 字符串 | **修复，保持单工具** | 类型化 definition + `show`；**不拆**成四个动词工具 |
| 14 | 网页分页丢完整性与来源 | **全量修复** | 缓存元数据 + refresh + 二进制分流 |
| 15 | schema 与运行时能力不一致 | **全量修复** | 全是廉价的一致性修正 |
| 16 | 错误/数字/默认值一致性 | **部分修复** | 只做具体项；**不做**"所有错误都要 next step"的泛化整改 |

被剔除的具体方案（评审提出但本计划不实施）：跨工具统一截断/预算框架；`grep` 重写为"walkFiles 逐文件 + 分批搜索"；`event_manage` 拆成多个动词工具；`grep.context` 参数；`read_many`；`edit.edits` 多处编辑；浏览器 / PTY / 办公应用工具；向量库与 LLM 搜索摘要；`op`/`action` 拼写统一改名；图片与附件的 5 MiB 常量拆分。理由见上表与第四部分。

---

## 一、`subagent` / `subagent_inline`：最终设计

**你的方案**：删除 `subagent_inline`，给 `subagent` 增加一个 object 参数，允许覆盖角色模板中的**同名字段**（`model`、`thinkingLevel`、`prompt` 等），未覆盖项沿用模板。新增的是覆盖能力，不是新的语义。

**采纳。** 下面是按这个原则收敛出的设计。我此前建议把 prompt 覆盖改成"追加"，你已明确否决——本节按"替换 systemPrompt"实现，我把随之变化的风险处理写在下面。

**支持的理由（有实测）**

用仓库自己的 `measureToolSchemas` 口径量的：

| 形态 | chars | units |
|---|---:|---:|
| 现状 `subagent` | 1,159 | 168 |
| 现状 `subagent_inline` | 3,144 | 431 |
| 现状合计 | **4,303** | **599** |
| 方案 `subagent`（含 `overrides`） | 2,226 | 291 |
| **净省** | **2,077** | **308** |

`subagent_inline` 的 431 units 与评审的独立测量完全一致，可以互相印证。省下的 308 units 约占默认钉钉会话工具定义总量（2,712 units）的 **11.4%**，且少了一个工具名、少了一次"该用哪个委派工具"的判断——评审 §16 指出 `subagent_inline` 的 description 里大半是防误用说教，这本身就是选择成本的证据。

**设计原则：角色文件是能力信封，`overrides` 覆盖信封内的同名字段**

这条原则决定了哪些字段能覆盖，不需要逐个讨论：

- **能覆盖**：角色文件 frontmatter/正文里**存在同名字段**、且只影响这次跑什么的项——`systemPrompt`、`model`、`thinkingLevel`，以及四个数值预算 `maxTurns` / `maxToolCalls` / `maxWallTimeSec` / `bashTimeoutSec`。
- **不能覆盖**：构成**能力与权限信封**的项——`tools`、`mutates`、`contextMode`、`memory`、`runtime` / `harness` / `command` / `env`。

不可覆盖那一组的理由必须写进 `overrides` 的 description（模型会去试）：

- **`tools`**：工具集是安全面。`mutates` 由 `inferMutatesFromTools` 从工具推定（`discovery.ts:877`），允许调用方给只读角色加上 `write`，等于让模型自选权限并绕过独占写锁。
- **`mutates`**：直接决定是否取 workspace 独占写锁（`tool.ts:759`）。同上。
- **`contextMode` / `memory`**：决定把本频道的记忆索引与 journal 注入到另一个 agent 里，是部署者的数据边界决策。
- **`runtime` / `harness` / `command` / `env`**：外部角色的执行面，只能由角色文件承载。

systemPrompt 可替换之后，**这组边界比原来更重要**，而不是更不重要：角色作为约束的意义，从此完全由这四类字段承担。

**`effort` 不进 `overrides`。** `effort`（quick/standard/deep）不是角色文件字段，它是 `subagent_inline` 独有的预设，展开成四个数值预算（`examples/sub-agents/README.md` 已写明这一点）。保留它就是"新增新的逻辑"。改为直接暴露四个同名预算字段：实测只比"三字段方案"多 36 units，换来的是与角色文件严格一一对应，且不必再维护一张预设表。

**最终 schema**

```ts
subagent {
  agent: string                          // 不变
  task: string                           // 不变
  workingDirectory?, purpose?, taskId?   // 不变（taskId 见 §3.3）
  overrides?: {
    systemPrompt?: string                // 整体替换角色的 system prompt
    model?: string                       // 精确模型引用（仅 internal）
    thinkingLevel?: off|minimal|low|medium|high|xhigh|max
    maxTurns?: integer                   // 仅 internal
    maxToolCalls?: integer               // 仅 internal
    maxWallTimeSec?: integer
    bashTimeoutSec?: integer             // 仅 internal
  }
}
```

**外部角色：按"该字段是否存在"逐项判定，不整体拒绝**

这里要更正我上一版的说法。我核对了外部执行路径：**外部角色确实使用 `systemPrompt`**——`src/subagents/external/run.ts:207-210` 把它写成 `system-prompt.txt`，claude-code 经 `--append-system-prompt-file`（`claude-code.ts:79`）、codex-cli 经 `$SYSTEM_PROMPT_FILE`（`codex-cli.ts:62`）、exec 经 stdin（`run.ts:180-185`）传入。所以"外部角色一律拒绝覆盖"是错的。

正确的规则和"覆盖同名字段"是同一条，不是特例表：**该字段在这个角色的 runtime 下不存在，就拒绝该次覆盖并说明它在角色文件里的对应字段名。** 对外部角色具体落到：

| 覆盖字段 | 外部角色 | 理由 |
|---|---|---|
| `systemPrompt` | 允许 | 外部路径真实使用它 |
| `thinkingLevel` | 允许 | 角色文件可为外部设置（verify 用） |
| `maxWallTimeSec` | 允许 | 外部唯一的预算杠杆（spec 040 D5） |
| `model` | 拒绝 | 外部用的是 `externalModelRef`，原样透传，pipiclaw 无法校验另一个 CLI 的模型名 |
| `maxTurns` / `maxToolCalls` / `bashTimeoutSec` | 拒绝 | 外部没有轮次/工具调用预算，也不经 pipiclaw 的 bash |

拒绝一律用 `RecoverableToolError`，消息里给出角色文件中的对应字段名。这样 spec 046 D2.1 想守住的东西（"外部角色 + 内部专有参数"不可表达）仍然守住了，只是从"类型层面不可表达"降级为"派发前拒绝并说明"——这是接受覆盖能力的必然代价，如实记录在代码注释里，别在文档里声称不变式没变。

**`purpose: "verify"`：记录，不拦截**

验证跑的独立性是 attestation 的价值来源，而"由被验证方替验证者写 system prompt"确实削弱它。但为此加一条 verify 专属拒绝，本身就是"新增逻辑"，与本次的原则相悖。因此：**verify 下允许全部适用的覆盖，但生效的覆盖必须写进 attestation 与 `details`**（`systemPrompt` 记哈希与首行摘要，不记全文），让"这次 PASS 是在什么配置下得到的"可审计。

残留风险如实记一句：调用方可以在 verify 时替换验证者的 system prompt，attestation 会记录该事实但不阻止它。若后续在真实使用中出现被滥用的迹象，再加拦截。

**实施要点**

1. `discovery.ts`：`ConfiguredRoleOverrides` 增加 `overrides` 字段；`resolveConfiguredRole` 在返回 `ResolvedSubAgentConfig` 前套用覆盖。**所有覆盖逻辑收在这一个函数里**，`dispatchSubAgentRun`（`tool.ts:731`）接收的已是解析后的 config，无需改动。
2. 优先级：角色文件值 → `settings.subagentModel`（仅当角色与调用都未指定 model 时）→ `overrides`。`overrides.model` 最高，走 `resolveModelReference` 校验，失败返回 recoverable 错误。
3. `overrides.systemPrompt` 走与角色文件同一条校验：非空、且过 `validateSubAgentSystemPrompt`（`MAX_SUB_AGENT_SYSTEM_PROMPT_CHARS`）。这是从 `resolveInlineAgent` 里复用出来的，不是新写的。
4. 四个数值预算逐项覆盖（不是整组替换），未覆盖项保留角色文件的值。每项校验为正整数。
5. 删除 `createSubAgentInlineTool`、`subagentInlineSchema`、`resolveInlineAgent`、`InlineAgentOverrides`、`SUB_AGENT_EFFORT_PRESETS` 与 `parseEffort`（`effort` 随 inline 一起消失），以及 `SubAgentToolFields.source` 的 `"inline"` 分支（`source` 随之恒为 `"predefined"`，是否删掉该字段由 knip 结果决定）。
6. 删除 `tools.subagentInline` 配置项（`src/tools/config.ts:51-56`、`:95`、`:259` 附近）。`tools.json` 目前**没有**退休键告警机制；请在 `loadToolsConfig` 里加一条最小的已知退休键告警（复用 `pushConfigWarning`），避免老配置文件静默失效——这与 `settings.ts` 的 `RETIRED_SETTINGS_KEYS` 是同一个约定。
7. `details.kind` 的联合类型 `"subagent" | "subagent_inline"` 收窄为 `"subagent"`；同步 `src/tools/presentation.ts` 的 `subagent_inline` 渲染分支（并让它展示本次生效的覆盖）、`src/tools/registry.ts` 的名称列表。

**能力回退：基本消失，但要留一个通用角色**

上一版我担心删掉 inline 会让"没有合适角色"的场景失去出路。**`systemPrompt` 可替换之后这个担心基本不成立**：拿任意一个工具集/权限合适的角色 + `overrides.systemPrompt`，效果就接近原来的 inline，差别只是必须先选中一个能力信封——而这正是我们想要的约束。

要做的是保证信封选得到：确认 `examples/sub-agents/` 里存在一个**工具与权限足够通用**的角色（只读探查一个、可写执行一个），否则"选一个合适的信封"会变成新的卡点。这件事要在文档里说清楚：没有贴合的专用角色时，选能力匹配的通用角色 + 覆盖 systemPrompt；只有连能力信封都不匹配时才写新角色文件（主 agent 有 `write`，`workspace/sub-agents/` 对子代理写禁止但对主 agent 可写，见 `withSubAgentsDirWriteDeny`）。这句话要进 `docs/sub-agents.md` 和 `src/playbooks/agent-delegation.md`。

**需要同步更新的下游**（`subagent_inline` 的全部引用）：

- 代码：`src/subagents/tool.ts`、`src/subagents/discovery.ts`、`src/tools/index.ts:127-133`、`src/tools/config.ts`、`src/tools/registry.ts`、`src/tools/presentation.ts`
- 测试：`test/subagent-inline-gate.test.ts`（删除或改写为 `overrides` 用例）、`test/playbooks.test.ts`、`test/e2e/deterministic/{verify-chain,wake-auth,subagent-chain,subagent-toolset}.test.ts`
- 评测：`evals/harness/worker.ts`、`evals/cases/regression.ts`（那条 regression 用例断言"没有调用 inline"，现在应改为断言角色调用 + 覆盖用法）
- 文档：`docs/sub-agents.md`、`docs/configuration-reference.md`、`examples/sub-agents/README.md`（含 `effort` 那一段）、`src/playbooks/agent-delegation.md`、`CLAUDE.md`（"delegation is `subagent` … plus `subagent_inline`"一句）、`CHANGELOG.md` / `CHANGELOG.zh-CN.md`

**新的验收测试**：覆盖 model → 实际使用覆盖后的模型；覆盖 systemPrompt → 角色原 prompt **不再出现**在子代理的 system prompt 里（这是与"追加"语义的判别性断言）；逐项覆盖预算 → 未覆盖项仍取角色文件的值；外部角色 + `systemPrompt` / `maxWallTimeSec` → 生效；外部角色 + `model` / `maxTurns` → recoverable 拒绝且消息给出角色文件字段名；`purpose=verify` + 任意覆盖 → attestation 记录生效覆盖（systemPrompt 记哈希）。
---

## 二、实施批次

四批按依赖与风险排序。**第一批必须先合**，它包含全部越权与数据损坏问题。

### 第一批：正确性（越权、损坏、丢闭环）

#### 1.1 `edit` 必须过写入守卫

**位置** `src/tools/edit.ts:337`
**问题** 只做 `checkPathGuard(path, "read", ...)`，之后小文件走 `writeAtomic`、大文件走 `replaceViaTemp`，全程没有 write 判定。`FileStore` 不做权限。后果：`writeDeny` 配置对 `edit` 无效（`write` 被拒、`edit` 成功）；指向普通文件的符号链接，`write` 被 symlink-write 规则拒绝而 `edit` 改写了链接目标。主 agent 的角色目录保护（`discovery.ts:185` 的 `withSubAgentsDirWriteDeny`）和子代理的 memory/journal 保护（`tool.ts:468` 的 `withSubagentMemoryWriteDeny`）都通过 `writeDeny` 接入，因此同样被绕过。

**改法** 在 `before` 的 stat 之前，对**同一个原始 `path`** 再调一次 write 守卫：

```ts
const target = await checkPathGuard(path, "read", securityConfig, securityContext, { tool: "edit", channelId });
await checkPathGuard(path, "write", securityConfig, securityContext, { tool: "edit", channelId });
```

两次调用返回同一个 `resolvedPath`（`guardPath` 对 read/write 的解析路径一致），所以 `target` 仍是唯一被打开的值，spec 044 D1.1 不受影响。

**关键点**：必须传**原始 `path`**，不能传已经 realpath 过的 `target`。`guardPath:399` 的 symlink-write 检查是 `lstatSync(resolvedTarget)`（`resolveTargetPath` 的结果，未解析符号链接），传 realpath 后的值会让这条检查永远看不到"原始路径本身是符号链接"。

两条大小分支共用这一个入口，无需分别改。

**测试** unit：同一路径的 read/write/edit 权限矩阵（`writeDeny` 命中时 `edit` 抛出且文件字节未变）；符号链接目标不被 `edit` 改写；`readDeny` 仍在 read 阶段拒绝。

#### 1.2 流式 `replaceAll` 跨块重叠（已复现，已验证修复）

**位置** `src/tools/edit.ts:182` `scanOccurrences`，具体是 `:213` 的 `let from = 0;` 与 `:229` 的 carry 更新

**问题** 每个新窗口都从 `from = 0` 开始搜索，但 carry 保留了上一窗口尾部 `needle.length - 1` 字节——如果上一个匹配消费到了 carry 区域内，新窗口会再次使用已消费的字节，产出**重叠**的匹配偏移。`spliceBuffer` 收到重叠偏移后 `cursor` 会超过下一个 `offset`，`subarray(cursor, offset)` 返回空串并重复插入 replacement，产出损坏文件。

我的独立复现（第 65,533 字节处放 `aaaaa`，chunk 65,536，needle `aaa`）：

```
streaming : {"count":2,"offsets":[65533,65534]}
reference : {"count":1,"offsets":[65533]}
```

评审报告的 `Zaa` → `ZZa` 与此一致。由于最终长度可能不变，只断言长度的测试发现不了。

**改法** 维护全局"已消费到哪里"的绝对位置，跨块只接受不与上一匹配重叠的起点：

```ts
let nextAllowed = 0;                 // 新增
for await (const chunk of stream) {
    ...
    let from = Math.max(0, nextAllowed - windowBaseOffset);   // 原来是 let from = 0;
    while (true) {
        const idx = window.indexOf(needle, from);
        if (idx === -1) break;
        const absoluteOffset = windowBaseOffset + idx;
        count++;
        nextAllowed = absoluteOffset + needle.length;          // 新增
        ...
        from = idx + needle.length;
    }
    ...
}
```

注意 `absoluteOffset` 现在在计数分支之外也要用，需要把它从 `if (offsets && ...)` 里提到循环体开头。

我用 165 个边界组合（needle `aaa`/`aa`/`abab`/`ab`/`aaaaa` × 匹配落在块边界前后 11 个位置 × 3 种自重叠填充）对照 `Buffer.indexOf` 的非重叠参考实现验证过这个改法：**165/165 全部一致**。

**测试** unit：同一输入分别走内存路径（`findAllOffsets`）与流式路径（`scanOccurrences`），断言 offsets 数组**逐元素相等**，不是只比 count 或最终长度；覆盖自重叠 needle（`aaa` 在 `aaaaa` 中）与匹配跨越 UTF-8 多字节边界。按 AGENTS.md 对新增 e2e 做一次 mutation check，并把目标故障写进用例注释。

#### 1.3 并发编辑丢更新

**位置** `src/agent/channel-runner.ts:380`（Agent 构造）、SDK `agent.js:134`（`toolExecution` 默认 `"parallel"`）、`src/tools/edit.ts:457`（写前 fingerprint 校验）

**问题** 同一批工具调用默认并行执行，主 agent 没有覆盖该默认值。`checkFingerprintUnchanged` 发生在写入之前，两个并发 `edit` 可以都通过校验，然后各自 `writeAtomic` 整个文件——原子写保证的是"不会写出半个文件"，不是"不会丢另一次编辑"。

**改法** 给变更类工具声明 `executionMode: "sequential"`。SDK `agent-loop.js:289` 的判定是"批次中**任一**工具声明 sequential，则整批串行"，所以不需要额外协调逻辑：

- `edit`、`write` 加 `executionMode: "sequential"`
- `bash` 也加：它可以任意写文件，且与 `edit` 同批并发是同一个丢更新窗口

代价：含变更工具的批次里，读取也一并串行。这是可接受的——纯读取批次（`read`/`grep`/`glob`）不含这些工具，仍然并行。

**边界说明**（写进代码注释，别在文档里许诺过头）：这是进程内措施。外部子代理是独立宿主进程，不受约束；现有 fingerprint 与 workspace lease 仍各自有用途，但都不锁定任意外部写入。task 文件的通用 `edit` 与 `task_update` 之间的协调不在本项范围（`task_update` 已有 per-task 锁，`edit` 走 sequential 后至少不会与另一个 `edit` 互相覆盖）。

**测试** unit：用 barrier 让两个真实 `edit` 都通过 fingerprint 检查后再放行写入，断言在 sequential 模式下第二次写入看到的是第一次的结果（两处修改都在最终文件里）。

#### 1.4 `grep` 不得返回被禁止读取的后代

**位置** `src/tools/grep.ts:201`（只对搜索根做 read 守卫）、`:207` 起构造 `grep -rnH`

**问题** 递归命令只有 `--exclude-dir=<IGNORED_DIR_SEGMENTS>` 的目录过滤，没有逐文件的 read guard。直接 `grep` 一个被 `readDeny` 的路径会被拒，递归进入同一路径却不会——被禁止读取的文件内容会出现在结果里。`glob` 有同一结构的问题（`glob.ts:74`），只是泄露的是路径名而非内容。

**改法（比评审的方案省得多）** 评审建议改成"walkFiles 逐文件守卫 + 分批搜索"，那等于重写 grep 的执行层。改用两层，收益相同、改动局限：

1. **推下去**：把 `securityConfig.pathGuard.readDeny` 里落在 `target` 子树内的条目，转成 `--exclude-dir=` / `--exclude=` 追加到 flags。这让被禁子树根本不被扫描，是主路径。
2. **兜底**：在 `parseGrepOutput` 之后、渲染之前，对每个命中文件跑一次 `guardPath(file, "read", ...)`（用 `guardPath` 而非 `checkPathGuard`，避免为每个被拒文件写一条审计并抛出）；被拒的文件整组丢弃，并按被拒数量在 footer 里追加一条"N 个匹配文件因读取策略被排除"。

对 `glob`（`glob.ts:94` 的 `matched` 过滤）加同样的兜底过滤。

**残留风险要如实写在注释里**：兜底层里，`grep` 子进程在 JS 过滤之前确实读过那些文件的字节。真正的边界是"没有任何被禁内容进入模型上下文与工具返回值"，这一点两层都保证；把 `readDeny` 推给 `grep` 自己则连读取都避免了。不要在文档里声称"grep 进程从不接触被禁文件"。

顺带修 `src/tools/skill.ts:75`：`listWorkspaceSkills` 直接 `stat`/`readFile`，与 `skill read`（`:139` 走 `checkPathGuard`）的入口不一致。让 list 也经过同一守卫，被拒的 skill 从列表里静默略过。

**测试** unit：允许目录下放一个 `readDeny` 文件并写入测试标记，断言 `grep` 父目录的返回值**不含**该标记且 footer 说明有排除；`glob` 不返回该路径；`skill list` 不列出被拒 skill。

#### 1.5 `job poll` 省略 ids 时吞掉完成结果

**位置** `src/agent/job-manager.ts:1062-1088`（`poll`）、`:856`（`finish` 的 `announce=false` 分支把 `notified` 置 true）

**问题** `watchIds()` 每次调用都重新筛选 `status === "running"`。循环里先 `refresh(record, signal, false)`，一旦某个作业转为 completed，**第二次** `watchIds()` 就把它筛掉了，`watched` 不再包含它 → `anyDone` 为 false → 继续等到 deadline 后返回不含该作业的快照。而 `refresh(..., announce=false)` 已经通过 `finish` 把 `notified` 置为 `true`（这是为"结果正在同步返回，别再唤醒一次"设计的），于是结果既没返回、也不会再唤醒——闭环彻底丢失。现有测试只断言"不重复唤醒"，没有同时断言"结果确实返回了"，所以漏掉这条分支。

**改法** 进入循环前把观察集**冻结一次**：

```ts
const watchedIds = ids && ids.length > 0
    ? ids.filter((id) => this.jobs.has(id))
    : Array.from(this.jobs.values()).filter((j) => j.status === "running").map((j) => j.id);
```

循环内只用 `watchedIds` 取记录，终态作业留在返回集合里。`ids` 省略时，poll 期间新启动的作业不纳入本次观察——poll 本就是快照语义，这是正确行为，在 description 里说清楚。

**测试** unit 三个用例：省略 ids、显式 ids、running/finished 混合。每个都**同时**断言（a）返回的快照包含该作业的终态与输出，（b）通知被标记为已消费。再加一条 deterministic e2e：完成结果只到达模型一次（不重复也不丢失）。

#### 1.6 `task_step_end` 校验失败前不得有出站副作用

**位置** `src/tools/task-manage/step-end.ts:53-57`

**问题** `queueTaskNotice` 写入待发送文件的时机，早于 `requiredField(summary)` / `requiredField(evidence)`（:60-61）、`uncheckedTaskAcceptanceItems`（:62）、`assertVerificationHoldsForClose`（:71）和 ticket 解析。一个 DoD 未完成的任务调用 `outcome:done` 会被 recoverable 拒绝，但"任务已完成"的通知文本已经能被 `consumeTaskNotice` 取出，runtime 在步骤收尾时会消费它（`src/runtime/bootstrap.ts:361`）。"被拒绝所以可以安全修正重试"的直觉因此失效，重试还会再追加一条通知。

**改法** 把通知**延迟到所有可恢复校验与状态推导之后**，紧贴各个 return 之前落盘。最小改动是把 :53-57 换成计算一个 `pendingNotice: string | undefined`，然后在 `writeStoredTask` / `logStep` 成功之后、`return` 之前统一 flush：

```ts
const pendingNotice = request.notify?.trim()
    ? request.notify
    : request.outcome === "blocked"
      ? `任务 ${id} 需要你的决定：${request.reason ?? note}`
      : undefined;
const flushNotice = async () => { if (pendingNotice) await queueTaskNotice(options.channelDir, id, pendingNotice); };
```

四个 return 分支各调一次 `flushNotice()`。注意 `blocked` 分支的 `request.reason` 本身由 `requiredField` 校验（在 ticket 构造处），要保证 notice 在那之后才写。

不需要引入通用事务框架——目标只是"任何参数或验收拒绝都不产生出站副作用"。

**测试** unit：`outcome=done` 但 DoD 未勾选 → 抛 recoverable，且 `consumeTaskNotice` 返回空、任务状态与 loop log 均未变更。deterministic e2e：该场景下投递数为 0。

#### 1.7 `memory_save` 的回执必须与实际存储一致

**位置** `src/tools/memory-manage.ts:126-176`、`src/memory/store.ts:494`

**问题一（假成功）** 保存 → 忘记 → 再保存同一事实：`isDescriptionTombstoned` 命中，store 跳过新增，`result.added` 为空，于是 `savedName = replaces ?? result.added[0]` 是 `undefined`，工具输出 **"Saved to channel memory as `undefined`."**。只有模型看不到的 `details.saved` 是 false。对话里的"已记住"因此是错误承诺。`skippedSecret` 同理。

**问题二（tombstone 语义）** tombstone 的价值是**防止后台自动重新学到**用户明确删掉的事实，不该连"用户明确要求重新记住"也一并挡掉——现在用户必须换一种措辞才能重新授权。

**改法**

(a) 根据实际结果生成 content。四种结局各自明确：

```ts
if (replaces) { /* updated / missingTarget 已有分支 */ }
else if (result.added.length > 0) { /* Saved as <name> */ }
else if (result.skippedSecret > 0) { /* 未保存：疑似凭据 */ }
else if (result.skippedTombstone > 0) { /* 未保存：该事实此前被明确遗忘 */ }
else { /* 未保存，原因未知 —— 也必须说出来，不能沉默 */ }
```

每种未保存都说明原因和可用的下一步。`replaces: "none"` 的语义是"两个事实同时成立，都保留"，不能被当成绕开存储失败的入口。

(b) tombstone 只挡自动回灌。`MemoryStoreOp` 的 `add` 已经带 `source` 字段（`store.ts:507`），`memory_save` 恒传 `source: "user"`（`memory-manage.ts:153`），后台 `reflect.ts:388` 传的是别的来源。所以把 `store.ts:494` 改成：

```ts
if (op.source !== "user" && await isDescriptionTombstoned(channelDir, description)) { ... }
```

并在用户来源的显式保存成功后，追加一条 tombstone 撤销记录（或在 `.tombstones.jsonl` 里按 contentHash 标记为已撤销），否则同一事实下次仍会被后台反复挡掉。

(c) 相似性检查（`findNearDuplicateEntries`，:127）目前在 `queue.run` **之外**。把"读取已有事实 → 判定 → 写入"整体放进同一个频道临界区，避免并行 save 各自判定为"不重复"然后都新增。

(d) 顺带修 `:258` 附近的 description：`memory_save` 仍建议把临时状态"放进 journal"，与"journal 只由后台 reflect 写"的规则矛盾。

**测试** unit：保存→忘记→再保存，断言 content 的成功语义与真实存储结果一致（而不是断言具体措辞字符串）；秘密被拒时 content 说明原因；并发两次 save 同一事实只产生一条。

### 第二批：结果契约（地址可用、输出有界、捕获真实）

#### 2.1 `glob` 返回的路径必须能直接喂给 `read`

**位置** `src/tools/glob.ts:94`（`walk.files` 是相对 `target` 的路径）

**问题** `glob {path:"nested", pattern:"*.ts"}` 返回 `same.ts`，既没带上 `nested/`，也没说明结果的根。`read` 的相对路径根是 `projectRoot`（`path-guard.ts:83` `resolveTargetPath` 用 `ctx.projectRoot ?? process.cwd()`）。两处同名文件时会**读到错误的文件**，而不只是报不存在。

**改法** 渲染前把每个相对路径转成对 `read` 有效的地址：`join(target, rel)` 得到绝对路径，若落在 `securityContext.projectRoot` 内则输出 projectRoot 相对路径，否则输出绝对路径。排序与分页在转换后进行，保持稳定顺序。

同时修 `walkFiles` 的"根不存在 = 空树"（`src/file-store.ts:281-287` 的 catch 吞掉了顶层 readdir 失败）：`glob` 在 walk 之前先 `fileStore.stat(target)`，不存在或不是目录时抛 recoverable，区分"空结果"/"非法根"/"部分跳过"。

#### 2.2 `bash` / `job` 的完整日志必须在受控可读位置

**位置** `src/tools/bash.ts:30` `getSpillFilePath()`、`src/agent/job-manager.ts:242` `jobSpillPath()`

**问题** 两者都落在 `tmpdir()`。在 `boundary: "project"` 下，`pathAllowedByDefaults` 只允许 `projectRoot`，通用 `read` 对 `/tmp/...` 被拒——工具返回的 "Full output: /tmp/…" 指针无法使用。

**改法** 移到 `<channelDir>/logs/`。该目录在两种边界下读取都被允许：`boundary: "project"` 走 `isChannelDirAccess`（读全程放行），`unbounded` 走 `isWithinAgentWorkspace`（`channelDir = getChannelDir(workspaceDir, channelId)`，而 `agentWorkspaceDir` 就是 `workspaceDir`，见 `src/tools/index.ts:59`）。

- `bash`：`BashToolOptions` 增加 `channelDir`（`ToolBuildContext` 已有，`registry.ts` 直接透传）；未提供时回退 `tmpdir()`（子代理路径保持现状）。
- `job-manager`：spill 路径改为基于已有的 per-channel 目录；注意 `.exit`/`.ready`/`.meta` 兄弟文件、`shellEscape` 引用、以及 `nohup` 进程跨守护进程重启的路径稳定性都要一并跟着走。文件权限保持 `0o600` 与现有 umask 处理不变。
- 两处都需要一个有界清理：`bash` 已经在"未截断"时 unlink；再加上创建工具时对该目录做一次上限剪枝（按 mtime 保留最近 N 个）。**不要**为了读一个日志去放宽整个 `/tmp` 边界。

**测试** 跨模块用真实文件验证：`bash` 产生截断输出 → 用返回的路径 `read` 能读到同一资源（断言内容，不断言渲染字符串）；`boundary: "project"` 下同样成立。

#### 2.3 `bash` 的尾部必须是真正的尾部

**位置** `src/executor.ts:86` `CappedByteAccumulator`（保留前 10 MiB）、`src/tools/bash.ts:266` 对该前缀做 `truncateTail`

**问题** 底层保留的是 stdout/stderr 的**前** 10 MiB，`bash` 再对这个前缀取尾部。因此超大输出的"末尾"其实是中间。命令结尾的测试总结与错误会被完全遗漏，而返回文本却写着 "Showing lines X-Y of N"——`N` 也只是捕获窗口内的行数，不是命令的总行数。

**改法** 在 `bash.ts` 里：当 `result.stdoutTruncated || result.stderrTruncated` 为真时，**不使用内存里的 `stdout`/`stderr`**，改为从 spill 文件有界读取尾部（spill 是唯一没有 10 MiB 上限的副本，`executor.ts:140-177` 已经保证在 `exec()` resolve 之前 flush 完成）。渲染文案相应改为"捕获在 X 处被截断，以下是完整输出的末尾 N KB"，不要把捕获窗口的行数说成命令输出的总行数。

**不要**把 `CappedByteAccumulator` 改成尾部 ring buffer：`grep`（`grep.ts:224` 的 `maxCaptureBytes` + 丢弃悬挂末行）明确依赖**头部**捕获语义。

顺带：`src/tools/read.ts:162` 的 PDF 分支同样经过这个捕获层，却没有检查 `stdoutTruncated`，会把截断文本当成完整 PDF。加一个检查，截断时在返回文本里明说。

#### 2.4 让四个无界的输出生产者有界

**只修具体生产者，不建统一预算层。**

- **目录 `read`**（`src/tools/read.ts:183-188`）：目前完全不过截断。两个问题叠加：(a) 深度 0 超出 `DIR_PER_DIR_LIMIT` 的父目录被省略了，但它们的**子项仍在渲染**（`renderDirectoryTree` 只按 parent 计数，不检查 parent 是否已被省略）；(b) 整棵树没有任何字节/行上限。改法：`renderDirectoryTree` 里记录被省略的 parent 集合，跳过其后代；渲染结果过一次 `truncateHead`；`listDirectory` 也要有源头总数上限，而不是先收集全部 depth-2 条目再裁。
- **`edit` 的 diff 回显**（`src/tools/edit.ts:140` `clampDiffForEcho`）：只限 40 **行**，不限字节。长行文件（压缩产物、单行 JSON）下 40 行可以是几百 KB。加一个字节上限，两者先到先触发。
- **`job poll` 的输出拼接**（`src/tools/job.ts:37-48` `completedDetail`）：每个作业各自 `truncateTail`（默认 50 KB）后拼接，没有**总**预算。5 个完成作业就是 250 KB。改法：给 sections 一个总预算，超出后只给摘要行 + 按 id 取尾部的提示。
- **`subagent` 回复**（`src/subagents/tool.ts:451` `finalizeSubAgentOutput`）：`clipTextByPromptUnits` 只传了 `MAX_SUBAGENT_RESULT_UNITS`，**没传 `maxChars`**。而 `prompt-units.ts:31-35` 自己的注释写明"一段无分隔符的超长 letters/numbers 只算 1 unit，因此每个预算都必须同时约束 units 和 chars"。这是该不变式在本调用点被违反。改法：加一个 `MAX_SUBAGENT_RESULT_CHARS` 常量并传入。

预算数值作为代码常量（符合 CLAUDE.md 对数值阈值的规定），不进 `settings.json`。评审给的 read 200–400 行 / 8–16 KiB 是**待评测的起点**，不是本次要落的新硬标准——本批只做"有界"，具体数值沿用现有默认，调参留给后续 eval。

#### 2.5 历史检索：先要有匹配证据，再谈排序

**位置** `src/memory/session-search.ts:115`（score）、`:224`（过滤）、`src/memory/session-corpus.ts:123`（corpus 裁剪）

**问题一（假阳性，一行修）** `score = matchedTokens * 1.4 + coverage * 2 + exactBoost + computeRecencyBoost(...)`，然后只按 `score > 0` 过滤。完全不匹配的近期消息因为 recency boost 就能拿到正分——返回一条 `matches` 为空、摘要里也没有关键词的记录。既浪费 token 又误导后续推断。

改法：过滤条件改为"必须有文本匹配证据"，recency 只参与**排序**：

```ts
.filter((entry) => entry.matches.length > 0 || entry.exactBoost > 0)
```

（`exactBoost` 需要从 `scoreDocument` 一并返回，或直接用 `matchedTokens > 0 || lowerText.includes(lowerQuery)` 判定。）

**问题二（召回，中等改动）** `createDocument`（`session-corpus.ts:123`）在**入库时**就把每条消息 `clipText` 到 `maxCharsPerChunk`（默认 1,200，headRatio 0.55）——中间部分从 corpus 里消失了。关键词落在长消息中间时 `searchedDocuments=1, results=0`，而且**扩大 query 永远找不回来**，因为文本已经不在 corpus 里。

改法：**匹配用全文，裁剪只用于展示**。

1. `SessionSearchDocument` 保留一个更大的扫描文本（设一个明显更高的每文档上限，如 20 KiB，防止单条超长消息吃满内存），`maxCharsPerChunk` 从"入库上限"降级为"展示窗口"。
2. `scoreDocument` 对扫描文本打分。
3. `summarizeHit` 的 fallback 从"取头部 65%"改成**以命中位置为中心开窗**，让返回的摘要里真的包含关键词。
4. 在响应里公开本次覆盖范围与是否完整（扫描了多少文档、有多少文档超过扫描上限被部分跳过）。

不需要 embedding、向量库或默认 LLM 摘要。缓存键（`corpusCacheKey`）要把新的扫描上限纳入。

**问题三（两个小项，很便宜）**

- `memory_search` 的命中片段（`src/memory/search.ts:296-300`）：命中可能在 `body` 里，返回的却总是第一条非空行（即 `description`）。改成优先选**包含 query token 的那一行**，找不到再退回首行。
- `task_log` 读不到已归档任务（`src/tasks/log.ts:138` 只查活动目录；`src/tasks/store.ts:271` `archiveTask` 把 `.jsonl` 移到 `tasks/archive/<id>.jsonl`）：已完成任务的日志会被答成"暂无日志"。改法：活动路径不存在时按 id 回退到 archive；并在返回里说明"这是已归档任务的日志"。不要让模型把"没读到"当成"不存在"。

#### 2.6 `bash` 说的是 bash，就得跑 bash

**位置** `src/executor.ts:119` `spawn("sh", ["-c", command])`

**问题** 工具名叫 `bash`、schema 写 "Bash command to execute"，实际是 `sh -c`。本机 `/bin/sh -> dash`，实测：

```
$ sh -c '[[ 1 == 1 ]] && echo yes'
sh: 1: [[: not found   (exit 127)
```

模型按 bash 习惯用 `[[ ]]`、数组、`set -o pipefail`、进程替换都会平白失败一次。

**改法** 在模块加载时解析一次真实 shell：优先 `bash`（`/bin/bash`、`/usr/bin/bash`，或 PATH 查找），缺失时回退 `sh` 并在启动日志里记一条。`shellEscape` 是 POSIX 引用，对 bash 同样安全；命令守卫检查的是命令文本，不受影响。若最终回退到 `sh`，工具 description 要如实说明当前是 POSIX sh。

选定一个真实 shell 并与描述一致即可，**不要**引入多 shell 配置项。

#### 2.7 `web_fetch` 的完整性与来源

**位置** `src/tools/web-fetch.ts:47`（`windowResult`）、`:126-146`（缓存构造）、`src/web/fetch.ts:152`（二进制回退）、`src/tools/web-cache.ts`

**问题** 主路径先以 `FULL_FETCH_MAX_CHARS = 2_000_000` 抓取，再从文字 content 重建缓存，把底层 `details` 的 `truncated` / `finalUrl` / `status` / `extractor` / `contentType` **全部丢掉**。于是：源站超过 2,000,000 字符时，工具报 `totalChars=2,000,000` 并提示 "[Reached end of page]"——页面尾部其实根本没取到；发生重定向时模型看不到最终 URL。另外缓存 TTL 15 分钟且**没有 refresh 参数**，确需重新检查时只能拿旧内容。

**改法**

1. 缓存写入 `{ body, fetchedAt, finalUrl, status, extractor, contentType, sourceTruncated }`；`windowResult` 在文本里呈现影响判断的部分（最终 URL、缓存时间、源是否被截断）。
2. **区分两种"没显示完"**：`[Showing chars a-b of N]` 是"这一页没显示完"；`sourceTruncated` 是"源内容没取全"。两者必须分别表达。
3. 加一个轻量 `refresh?: boolean`，绕过缓存重抓。
4. `offset > 0` 时校验快照仍可用（缓存键含 `extractMode`，还要校验 `fetchedAt` 与本次请求的一致性）；失效就明确要求从 offset 0 重读，不能默默跨版本拼接。
5. 二进制分流（`src/web/fetch.ts:152`）：当前非 HTML/JSON/图片一律 `decodeUtf8`，远程 PDF 会落进来变成乱码。按 content-type 识别二进制（`application/pdf`、`application/octet-stream` 等），返回 recoverable 错误说明该用什么路径（下载后 `read`），不要把乱码当正文。

### 第三批：调用面（少猜、少填、少一次往返）

#### 3.1 子代理能力的单一来源

**位置** `src/subagents/discovery.ts:15` `ALLOWED_SUB_AGENT_TOOLS`、`src/tools/registry.ts:154` glob 的 `availableToSubagents: true`

**问题** registry 把 `glob` 标为子代理可用，discovery 的独立白名单里却没有 `glob`——角色文件写 `glob` 会在 `validateToolNames` 处被拒。构建端与验证端不是同一个来源。

**改法** 新建一个叶子常量模块（如 `src/tools/subagent-tool-names.ts`）导出这份名单，`registry.ts` 与 `discovery.ts` 都从它读取。用独立叶子模块而非让 discovery 反向 import registry，是为了避开 `registry.ts:126` 注释里点明的 registry ↔ subagents/tool 循环依赖。加一条测试断言两端一致（registry 里 `availableToSubagents: true` 的集合 === 白名单）。

#### 3.2 子代理的 `bash` 只暴露它真有的参数

**位置** `src/tools/bash.ts:35-59`（schema）、`:218`（错误提示）

**问题** 子代理路径不提供 `jobManager`，却照样收到 `async` / `notify` / `taskId` 三个字段的 schema；失败提示还让它去开启一个**不存在的**配置项 `tools.jobs.enabled`（`src/tools/config.ts` 里没有 `jobs` 段）。另外 description 固定写"默认 300 秒"，实际执行用的可能是角色的 `bashTimeoutSec`（`registry.ts:143` 的 `bashDefaultTimeoutSeconds`）。

**改法** 构建时按能力裁剪：`createBashTool` 在没有 `jobManager` 时返回不含 `async`/`notify`/`taskId` 的 schema；description 里的默认超时用 `options.defaultTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS` 动态生成；删掉对不存在配置项的引用，改成"此上下文不支持后台执行"。

#### 3.3 task 会话自动继承 `taskId`

**位置** `src/tools/index.ts:45,89,136`（`taskLoop` 已在构建上下文里）、`src/tasks/ticket.ts:194-198`（归属不符的拒绝）

**问题** task 会话已经绑定了 taskId，`bash`（async）与 `subagent` 仍靠模型重复填。漏填时 job/run **已经启动了**，直到 park 才发现归属不符，而错误提示是 "Relaunch it with taskId=..."——重跑一条可能有副作用的命令。

**改法** 在 task 会话里由 runtime 补齐：`taskLoop` 存在时，从 `bash`/`subagent` 的 schema 中**移除** `taskId` 字段并在执行时注入 `taskLoop.taskId`；普通聊天会话保留可选 `taskId`（主 agent 代任务启动作业的场景）。若模型仍通过非 schema 途径传入冲突值，在**派发之前**拒绝。错误恢复的措辞优先指向"已经启动的工作"（用 `job op=list` 找到它），把重跑降级为最后手段。

#### 3.4 `task_step_end` 成功后终止本轮

**位置** `src/tools/task-manage.ts:116-127`、SDK `types.d.ts:325-329`

**问题** 成功收尾后没有返回 SDK 已支持的 `terminate`，通常还要多一次模型请求才能结束步骤。

**改法** 成功返回时带 `terminate: true`。SDK 的语义是"只有批次内**每个**已完成的工具结果都设了 terminate 才提前结束"，所以混合批次天然安全，不需要额外判定。失败（recoverable）路径**不**设置——那时模型需要留在循环里修正。

**测试** deterministic e2e：断言 provider 请求次数减少，且混合批次（step_end + 另一个工具）行为不变。

#### 3.5 `grep` 的高频输出形态 + 拦截器收窄

**位置** `src/tools/grep.ts:37-48`（schema）、`:64` `globToRegExp`、`src/tools/bash.ts:102-134`（拦截规则）

**问题三条**

(a) `grep` 只有 ERE 正则、固定上下文（前 1 后 3）、固定每页 20 文件，没有字面量、仅文件名、计数。搜 `foo.bar(` 这类代码片段要手工转义；只想知道哪些文件引用了某符号，也必须付内容 token。

(b) `bash` 拦截**所有**裸 `rg`（`/^\s*rg\b[^|&;]*$/`），包括 `rg --files`、`rg -l`、`rg -F`、`rg -c`——这些形式恰恰是 `grep` 工具无法等价表达的。等于堵死了长尾出口。

(c) `grep.glob` 有两套方言：推给 shell grep 的 `--include`（支持字符类/花括号）和 JS 端的 `globToRegExp`（`:64-68` 只转换 `*` 和 `?`，并把 `[`、`]`、`{`、`}` 全部转义掉）。`*.[tj]s` 在 grep 侧匹配、在 JS 兜底过滤里被全部滤掉 → **假无结果**。而独立的 `glob` 工具支持递归与花括号，`grep.glob` 只支持 basename 简化模式，名称相近行为不同。

**改法**

- schema 增加 `literal?: boolean`（字面量搜索，等价 `grep -F`）与 `mode?: "content" | "files" | "count"`（默认 `content`）。`files` 只返回匹配文件路径（`grep -l`），`count` 返回每文件命中数（`grep -c`）——都大幅降低"只想定位"场景的 token。**不加** `context` 参数：没有调用数据支撑，先看 `mode` 落地后的实际形态分布。
- 扩展 `globToRegExp` 支持字符类 `[...]` 与花括号 `{a,b}`，使 JS 兜底**不严于** grep 的 `--include`；并在 `glob` 字段的 description 里写明"匹配 basename"，与独立 `glob` 工具的全路径语义区分开。
- 收窄 `rg` 拦截规则：只拦截**纯内容搜索**形式，放行 `--files`、`-l` / `--files-with-matches`、`-c` / `--count`、`--type` 等 `grep` 工具无等价表达的形式。原则是"只对已知可等价替代的形式作引导，长尾保留 shell 出口"。`sed|perl -i` 规则同样收窄为**单文件**调用（当前的 `[^|&;]*\s-i\b` 会连多文件批量替换一起拦掉，而 `edit` 做不了那件事）。

#### 3.6 `event_manage`：类型化 definition + `show`

**位置** `src/tools/event-manage.ts:14-31`（schema）、`:91`（列表投影）、`:135`（definition 校验）、`src/runtime/events.ts:185-190`（底层解析）

**问题**

(a) 创建一个提醒真正需要的只有 name、text、at，现在却要在 tool JSON 里再写一个**转义过的完整 JSON 字符串**。schema 里看不到 `type` / `at` / `schedule` / `preAction` 的结构，模型必须先读 playbook 才能正确调用。

(b) 缺字段的错误没有被包成 recoverable：`validateDefinition` 的 try/catch 只包住 `validateScheduledEvent`（:136-143），而 `parseScheduledEventContent`（:135）在它**外面**。one-shot 缺 `at` 时 `events.ts:186` 抛的是普通 `Error`，绕过了 recoverable 包装——一个模型完全能自己修的错误变成了硬失败。

(c) 更新要求整体替换 definition，但 `list` 只显示 text 前 80 字符和"有没有 preAction"，没有 `show`。在 `boundary: "project"` 且 events 目录位于项目外时通用 `read` 也未必可用，模型无法可靠保留旧字段。

**改法（保持单工具）**

- `definition` 从 JSON 字符串改为**类型化对象**：`Type.Object({ type, text, at?, schedule?, preAction? })`。`at` 与 `schedule` 由 `type` 二选一——这是一个带判别式的调用形态，不是两种调用形态，所以仍归一个工具；相比现在的不透明转义字符串是严格改善。
- `channelId` 由 runtime 绑定，从模型可见的输入里**移除**（`:120-126` 的校验保留为对非 schema 输入的防线）。
- 增加 `action: "show"`，按 name 返回完整定义，让 update 有可靠的读取入口。
- 把 `parseScheduledEventContent` 移进 try/catch，缺字段/非法值统一转 recoverable。
- `preAction` 的毫秒 timeout 与 `bash` 的秒 timeout 使用清楚的字段名（如 `timeoutMs`）或在 description 里写明单位，消除猜测。

**不做**：拆成 `event_create` / `event_update` / `event_delete` / `event_list` 四五个动词工具。那样 schema 更贵，且这些动作共享同一份校验与所有权检查。

这项会略微增加 schema 字符，收益应以**提醒创建/改期的成功率与总调用成本**验证，而不是字符数。

### 第四批：一致性收尾（全部廉价，可与第三批同批合入）

- **`budget.until` 未校验**（`src/tools/task-manage/shared.ts:55-68` `normalizeBudget` 只 trim；`src/tasks/budget.ts:57-60` 用 `parseLocalTime`，解析失败得到 `undefined` 就**静默失去期限约束**）。改法：在 `normalizeBudget` 里用同一个 `parseLocalTime` 严格校验，无法解析则抛 recoverable。
- **计数用 Integer 且有真实上下界**：`budget.steps` / `budget.rounds` 现在是 `Type.Number`，接受 2.5（`usd` / `wallMin` 保持 Number 合理）。`task_log.limit` 实际会截整并夹到 1–100，schema 却没写范围——改成 `Type.Integer({ minimum: 1, maximum: 100 })`。
- **`send_media` 的路由不能由显示名决定**（`src/tools/send-media.ts:85`）：`kind` 由 `fileName` 的后缀推定，而 `fileName` 的产品语义只是**显示名**。传 `fileName: "报告"` 的 PNG 会被当作 file 投递。改法：`kind` 由真实文件路径的后缀（必要时加内容嗅探）决定，`fileName` 只影响展示。
  - **不做**：拆分图片入模与附件投递共用的 5 MiB 常量（`MAX_INLINE_BINARY_BYTES`）。评审自己的判断是"只在真实附件需求受阻时拆开"，现在没有这个信号。
- **`read` 的 description 与实现不符**：实现支持目录树（`read.ts:183`）和 PDF（`:162`），description（`:112`）只说 "text files and images"。补齐能力、默认值与关键限制；策略仍留在 playbook，但两者不能互相矛盾。
- **schema 中不会生效的多余参数**：逐个确认要么拒绝、要么移除，不要成功后静默忽略（本批已覆盖 `bash` 的子代理字段、`event_manage.channelId`、task 会话的 `taskId`）。
- **不做**：把"每个错误都要带可执行 next step"作为普遍整改。只在本计划已点名的具体错误路径上保证 recoverable + next step；运行故障保持普通 Error。

---

## 三、明确不做（以及为什么）

| 提议 | 不做的理由 |
|---|---|
| 跨工具统一输出预算/截断层 | 评审自己的结论是"先让各生产者有界，共享兜底只用于防遗漏"。新增一层通用预算抽象会让 read 返原文、grep 返定位片段、write 返短确认这些**本来合理**的差异被迫统一。第二批已把四个真正无界的生产者逐个修掉。 |
| `grep` 重写为 walkFiles 逐文件 + 分批搜索 | 为了逐文件 read guard 重写整个执行层，性价比不成立。§1.4 的"deny 推给 grep + 命中后守卫过滤"达到同样的对外保证，改动局限在一个函数。残留差异已如实记录在注释里。 |
| `event_manage` 拆成多个动词工具 | schema 更贵，且四个动作共享同一份校验与所有权检查。评审也明确不建议。 |
| `grep.context` 可调上下文 | 没有调用数据支撑。先落 `mode`，看实际形态分布再决定。 |
| `read_many` / `edit.edits` 多处编辑 | 评审的判断是"只有在真实调用数据证明收益后才考虑"，且 `edits` 等于引入第二种补丁语言。 |
| 浏览器 / PTY / 办公应用工具 | 按真实工作负载的能力缺口接入，无数据前不加一整套工具。 |
| 向量库 / 默认 LLM 搜索摘要 | §2.5 的召回修复不需要它们；先修召回再谈排序。 |
| `op` / `action` 拼写统一改名 | 破坏性改名，收益不足。 |
| 每回合动态切换工具集合以省 schema | 稳定的工具定义有利于 prompt 缓存，小额 schema 节省抵不过缓存失效。 |

---

## 四、验证与验收

**基线**（评审已跑通，改动后必须仍然成立）：`npm run typecheck` 通过；`npm run test` 128 文件 / 968 测试通过；`npm run test:e2e` 21 文件 / 40 测试通过。每批合入前跑 `npm run check`（lint + typecheck + knip + test）。删除 `subagent_inline` 后 knip 会暴露一批新的未使用导出——按 CLAUDE.md 的规则**删除**它们或去掉 `export`，不要用 knip 注释压制。

**跨批次验收标准**（由第一批的修复共同保证，写进各自的用例注释）：

1. **回执真实**：成功回执对应已完成的副作用；参数被拒之前不发通知、不提交修改。
2. **引用可执行**：返回的 path / runId / jobId 能直接进入下一个工具；运行时产物有当前上下文可访问的读取方式。
3. **输出可恢复**：说明是否完整，给精确的下一步；不把"没扫描到 / 没捕获到"说成"不存在"。
4. **能力与环境一致**：构建时裁剪不适用的参数；runtime 已知的归属与默认值由 runtime 提供。
5. **并发有定义**：读取可并行，变更与收尾声明顺序要求。

**要补的安全网**（按层与断言，不要写成变更检测器——按 CLAUDE.md，断言渲染字符串字面量的测试不算安全网）：

| 安全网 | 层与断言 |
|---|---|
| 同路径 read/write/edit 权限矩阵；递归访问 denied 后代 | unit 断言零读写与内容不外泄；关键接线用 deterministic e2e 验证磁盘与审计日志 |
| 小文件/流式编辑等价、自重叠 needle、UTF-8 边界 | unit **逐元素**比较 offsets 与最终字节，不比长度 |
| 并发 edit 独立锚点 | unit 用 barrier 控制并发窗口，断言两处修改都在 |
| poll 省略 ids / 显式 ids / 混合终态 | unit 同时断言"结果已返回"与"通知已消费"；e2e 断言完成结果只到达一次 |
| step_end 校验失败 | unit 断言无通知/状态/日志副作用；e2e 断言投递数为 0 |
| 忘记后再次保存 | unit 断言 content 的成功语义与真实存储结果一致 |
| glob → read；bash spill → read | 跨模块用真实文件断言读到同一资源 |
| 超长行、超大目录、多作业、多历史条目 | unit 断言总预算、完整性标志与续取可行性 |
| grep glob 方言 / literal / files / count | unit 断言实际命中文件与匹配数 |
| 冷历史中间关键词、无关近期消息、归档任务日志 | unit 断言召回与可定位性，不评模型措辞 |
| subagent overrides（同名覆盖、外部逐项判定、verify 记录） | unit 断言生效值与拒绝路径；systemPrompt 覆盖后角色原 prompt 不再出现；verify 下覆盖写入 attestation |
| step_end 成功停止 | deterministic e2e 断言 provider 请求次数与混合批次行为 |

新增 deterministic e2e 按 AGENTS.md 做一次 mutation check，把目标故障与变异结果写进用例注释。

**真实模型 eval**（不阻塞合入，用于验证第三批的 schema 改动）：少量代表任务——定点修复、跨文件查引用、简单提醒及改期、异步任务、委派验证、找回旧记录。对比完成质量、总输入/输出 token、工具调用次数、recoverable 重试数、补读次数、错误完成声明数。**先定质量底线，再比成本。**

`subagent_inline` 删除后要专门测两件事，它们是本次改动仅有的真实行为风险点，必须有数据：

1. **没有贴合角色时，模型是否会选一个能力匹配的通用角色 + 覆盖 systemPrompt**，而不是卡住、硬套一个不匹配的角色、或径直去写新角色文件。这决定了「能力信封」这层约束在实践中是帮忙还是添堵。
2. **有贴合角色时，模型是否会克制地不传 `overrides`。** 覆盖能力最可能的副作用是被滥用成默认动作——每次都重写一遍 systemPrompt，角色文件就名存实亡，反而比 inline 时代更糟。用「配置角色贴合」与「不贴合」两类任务对比 `overrides` 的出现率与命中率。

**成本观测**：schema 固定成本继续用现有 `manifest.ts` 记录；但还要单独统计**工具输出大小的分位数**与**可避免的后续模型回合数**——只数 schema 字符判断不出一次"简化"到底省了什么。第二批的输出预算修复，收益主要体现在后两个指标上。

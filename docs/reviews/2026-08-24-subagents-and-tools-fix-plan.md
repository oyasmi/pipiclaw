# 子代理/工具层评审的修复实施计划

- 日期：2026-08-24
- 依据：`docs/reviews/2026-08-24-subagents-and-tools.md`（下称"评审"）
- 基线：`142e73b`（0.9.1-beta.2）
- 用户已定的两条：
  1. 内置 work 子代理的 `thinkingLevel` 兜底值 `off` → **`medium`**
  2. 角色模板示例每一个都要配置 `thinkingLevel`
- 其余按评审建议执行。

---

## 0. 先说三件必须先知道的事

### 0.1 模板要求**已经满足**，需要补的是防回归的护栏

`examples/sub-agents/` 下 11 个模板**全部已显式声明 `thinkingLevel`**（实测）：

| 模板 | thinkingLevel | | 模板 | thinkingLevel |
|---|---|---|---|---|
| explorer | low | | planner | high |
| log-sifter | low | | reviewer | high |
| scout | low | | builder-hard | xhigh |
| git-committer | medium | | builder | medium |
| documenter | medium | | verifier | medium |
| worker | medium | | | |

而且 `test/subagent-phase1.test.ts:145-172,222-231` 已经对每个角色的取值逐条断言，`examples/sub-agents/README.md` 里还有一张对照表。

**所以这一项不需要改任何模板文件**。真正缺的是：现有测试枚举的是**写死的角色名列表**，新加一个模板即使漏掉 `thinkingLevel` 也不会失败。要补的是一条**目录扫描式**断言（见第四批 §4.4）。

### 0.2 默认值改成 `medium` 之前，必须先补上 clamp——否则会打崩不支持推理的模型

主 agent 的默认推理档**本来就是 `medium`**（`channel-runner.ts:136` 的 `DEFAULT_MAIN_THINKING_LEVEL`），所以这次改动是让子代理**向主 agent 对齐**，方向自洽。

但主 agent 在设置前做了一步子代理路径**没有做**的事：

```ts
// channel-runner.ts:1470
const effectiveLevel = clampThinkingLevel(model, requestedLevel);
```

`clampThinkingLevel`（`@earendil-works/pi-ai`）对 `model.reasoning === false` 的模型直接返回 `"off"`，对 `thinkingLevelMap` 里标成 `null` 的档位向上/向下找最近的可用档。而 `subagents/tool.ts:1027` 是把 `config.thinkingLevel` **原样**塞进 `new Agent({ initialState })` 的。

今天这不出事，纯粹是因为默认值是 `off`——`off` 对任何模型都合法。**一旦默认变成 `medium`，任何 `reasoning: false` 的模型（常见于国内 OpenAI 兼容 provider 的非推理模型）都会在每次内置委派上收到一个它不支持的推理参数**。而且 pi 的 API 适配器里只有一部分会自己 clamp：`openai-*` / `google-*` / `mistral-*` 会，**`anthropic-messages` 和 `bedrock-converse-stream` 不会**。

> **结论：clamp 必须和默认值改动在同一个 PR 里落地，不能拆。** 顺带它也修掉一个既有隐患——角色文件写 `thinkingLevel: xhigh` 而模型不支持时，现在是原样下发。

### 0.3 "默认 medium" 与"外部不兜底"两条要一起看

用户指定内置默认改 `medium`，评审又建议外部**不要**兜底（不追加 effort flag，沿用目标 CLI 自己的配置）。两条合起来的最终规则是：

| 场景 | 解析后的 `thinkingLevel` | 落到执行方 |
|---|---|---|
| 显式指定（调用参数 / 角色 frontmatter） | 该值 | 内置：clamp 后设给 Agent；外部：翻译成 `--effort` / `-c model_reasoning_effort=` |
| 内置 · 未指定（含 inline） | `medium` | clamp 后设给 Agent |
| 外部 · `purpose=work` · 未指定 | **`undefined`** | **不追加任何 effort 参数**，由目标 CLI 自己的配置决定 |
| 外部 · `purpose=verify` · 未指定 | `medium` | 追加 effort 参数 |

外部 verify 保留兜底是有意的：独立验收是产物被信任前的最后一道无人值守闸门，宁可显式要求推理，也不接受"取决于对方机器上怎么配的"。这一条要写进文档，不能只留在代码里。

---

## 第一批：委派链路的默认值与能力保真（半天，一个 PR）

> 目标：把"运行时替外部 agent 做主"和"外部跑满墙钟就丢光产出"这两件事修掉。这批改完，`subagent` 这条链路的行为才对得起它花掉的钱。

### 1.1 `thinkingLevel` 解析：内置默认 medium，外部 work 不兜底

**改 `src/subagents/discovery.ts`**

```ts
// 原来两个常量合并成一个：内置 work、以及任何 runtime 的 verify，都用它。
// 与主 agent 的 DEFAULT_MAIN_THINKING_LEVEL 对齐（channel-runner.ts:136）。
const DEFAULT_THINKING_LEVEL: SubAgentThinkingLevel = "medium";
```

删除 `DEFAULT_VERIFY_THINKING_LEVEL` / `DEFAULT_WORK_THINKING_LEVEL`（`discovery.ts:157-158`）。

`resolveSubAgentConfig`（`discovery.ts:954-957`）改为：

```ts
const explicitThinkingLevel = thinkingLevelOverride?.value ?? baseConfig?.thinkingLevel;
// 外部 work 不兜底：pipiclaw 无权替另一个 CLI 决定推理档位，它自己的配置文件说了算。
// 外部 verify 仍然兜底——独立验收是产物被信任前最后一道无人值守的闸门。
const thinkingLevel =
    explicitThinkingLevel ??
    (effectiveRuntime === "external" && purpose !== "verify" ? undefined : DEFAULT_THINKING_LEVEL);
```

**类型改动**：`ResolvedSubAgentConfig`（`discovery.ts:128-132`）把 `thinkingLevel` 从 `Omit<...>` 列表和重声明里一起去掉，让它继承 `SubAgentConfig` 的 `thinkingLevel?: SubAgentThinkingLevel`。

> `undefined` 从此是一个**有含义的状态**："未指定，交给执行方自己的默认"。这比再加一个 `thinkingLevelExplicit: boolean` 诚实，也少一个可以写错的字段。

**两个适配器不用改**：`claude-code.ts:54` / `codex-cli.ts:51` 的 `toXxxEffort(undefined)` 已经返回 `undefined`，而追加分支写的是 `if (!existing.effort && effort && ...)` —— `undefined` 天然不追加。这是现有代码本来就留好的口子。

### 1.2 内置路径补 clamp（与 1.1 同一 PR，见 §0.2）

**改 `src/subagents/tool.ts`**（`new Agent({ initialState: { ... } })`，约 1027 行）：

```ts
import { clampThinkingLevel, streamSimple } from "@earendil-works/pi-ai/compat";

// 与主 agent 同一个 clamp（channel-runner.ts:1470）：模型不支持推理时降到 off，
// 档位不支持时取最近的可用档，而不是把一个非法参数发给 provider。
// `?? DEFAULT_THINKING_LEVEL` 只是让类型闭合——内置路径的 resolve 必定已填上值。
thinkingLevel: clampThinkingLevel(config.model, config.thinkingLevel ?? DEFAULT_THINKING_LEVEL),
```

同时在 `createDetails`（`tool.ts:707`）里把 clamp 后的实际档位写进 `details`，`/subagents show` 与 run 记录才不会显示一个没有真正生效的值。**这一条可选**，但没有它，"我配了 xhigh 却按 high 跑"依然不可见。

### 1.3 claude-code 适配器：超时/取消时保住产出与用量

**改 `src/subagents/external/claude-code.ts` 的 `parseOutcome`**：

```ts
let lastAssistantText = "";      // result 事件缺席时的兜底
let streamedUsage: ... ;          // 同理，累加 assistant 消息的 usage

if (record.type === "assistant") {
    const message = record.message as Record<string, unknown> | undefined;
    const parts = Array.isArray(message?.content) ? message.content : [];
    const text = parts
        .filter((p) => isRecord(p) && p.type === "text" && typeof p.text === "string")
        .map((p) => (p as { text: string }).text)
        .join("");
    if (text.trim()) lastAssistantText = text;
    // usage 同步累加（input/output/cache_read/cache_creation）
}
```

收尾时：`finalText` 若为空则用 `lastAssistantText`；`usage` 若未从 `result` 拿到则用累加值并置 `usageKnown = true`。

**`parserVersion` 从 1 提到 2**（`claude-code.ts:46`）——这是它存在的意义：日后再遇到解析异常，`op=show` 能分清"适配器旧了"还是"agent 自己挂了"。

**注意不要动的**：`terminalSeen` / `protocolStatus` **必须仍然只由 `result` 事件置位**。兜底文本不是"跑完了"的证据，`classifyExternalOutcome` 的判定表不能被它污染——否则一个中途崩掉的 run 会被判成 completed。这是这一条最容易改错的地方。

同样的兜底**不需要给 codex-cli**：它的 `item.completed` 本来就是增量更新（`codex-cli.ts:112-118`）。

### 1.4 `subagent` 调用面补 `mutates`

**改 `src/subagents/tool.ts` 的 `subagentSchema`**（54 行起）：

```ts
mutates: Type.Optional(
    Type.Union([Type.Literal("read"), Type.Literal("write")], {
        description:
            'Whether this delegation will modify the working directory. Declare "write" whenever the ' +
            "sub-agent may write files (including through bash) so it takes the exclusive workspace " +
            "write lease. Defaults to inference from `tools` (write/edit only), which does not see bash.",
    }),
),
```

`SubAgentInvocationOverrides` 加 `mutates?: string`；`resolveSubAgentConfig` 里：

```ts
const mutatesOverride = parseMutates(overrides.mutates);
if (mutatesOverride.error) return { error: mutatesOverride.error };
// 外部角色的 mutates 是角色文件的自述，不接受调用方覆盖（与 tools/model 的处理一致）
if (effectiveRuntime === "external" && overrides.mutates !== undefined) {
    return { error: `Sub-agent "${baseConfig?.name}" is external; "mutates" comes from its role file.` };
}
mutates: mutatesOverride.value ?? baseConfig?.mutates ?? inferMutatesFromTools(tools.tools),
```

**顺带**：inline 且 `tools` 含 `bash` 且未显式声明 `mutates` 时，在**返回给模型的文本**里带一句提示（不是 warning 日志——模型看不到日志），复用 `discovery.ts` 已有的 `bashWithoutMutatesWarning` 措辞。

### 1.5 `buildContextualBlocks` 降级

`tool.ts:845`（external）与 `tool.ts:1130`（internal）两处：

```ts
const contextualBlocks = await buildContextualBlocks(params.task, config, options, currentModel).catch((error) => {
    log.logWarning(`[${options.runtimeContext.channelId}] Sub-agent context injection failed; continuing without it`, errorMessage(error));
    return [] as string[];
});
```

上下文注入是增强不是前置条件。

### 1.6 `[Dispatched]` 的 details 收敛

`createDetails` 加一个可选出口，`tool.ts:912-928` 与 `tool.ts:1359-1375` 两处手写字面量改为调用它。纯重构。

### 第一批的测试与验收

| 动作 | 文件 |
|---|---|
| 新增 | `test/subagent-invocation-matrix.test.ts`：内置未指定 → `medium`；外部 work 未指定 → `undefined`；外部 verify 未指定 → `medium`；显式值三种 runtime 都原样保留 |
| 新增 | 同上：`mutates` 调用参数生效；外部传入被驳回；inline `bash` 未声明时结果文本含提示 |
| 新增 | `test/claude-code-harness.test.ts`：只有 assistant 事件、没有 result 事件时，`finalText` 取最后一条 assistant 文本，且 `terminalSeen === false` / `protocolStatus !== "completed"` |
| 新增 | 内置 clamp：`reasoning: false` 的假 model → 传给 Agent 的是 `off`（用 `createWorker` 测试缝注入，`tool.ts:181`） |
| 可能要改 | `test/subagent-phase1.test.ts`、`test/subagent-external-envelope.test.ts`——若断言了未指定时的 effort argv |
| 不变 | `test/codex-cli-harness.test.ts`（显式档位的翻译逻辑没动） |

验收：`npm run check` 全绿；外部角色实跑一次 `subagent_manage op=show <runId>`，确认没有 `thinkingLevel` 的角色**不再出现** `--effort` / `model_reasoning_effort`。

### 第一批的文档同步（同 PR）

- `docs/sub-agents.md:154`、`:203`、`:327` 三处"默认 `off`"改写成 §0.3 的四行规则表。
- `docs/sub-agents.md:337` 的 harness 组装表加一列/一句：**未声明 `thinkingLevel` 的外部 work 角色不追加推理参数**。
- `docs/sub-agents.md` 的调用参数表加 `mutates` 一行。
- `src/playbooks/agent-delegation.md` §3：把"写清楚 `mutates` 是你的责任"从一句无法执行的告诫，改成指向新参数的可执行指令。
- `examples/sub-agents/README.md`：加一句"每个角色都应显式写 `thinkingLevel`；外部角色不写就沿用该 CLI 自己的配置"。

---

## 第二批：工具层的两个上下文黑洞（半天到一天，一个 PR）

> 目标：让"没有任何单次工具调用能吞掉上下文窗口"成为真命题。

### 2.1 bash 超时/中断不再把 10MB 原样塞进错误消息

**改 `src/executor.ts`**：新增一个带结构化字段、**消息很短**的错误类型：

```ts
export class CommandTerminatedError extends Error {
    constructor(
        readonly reason: "timeout" | "aborted",
        readonly stdout: string,
        readonly stderr: string,
        readonly timeoutSeconds?: number,
    ) {
        super(reason === "timeout"
            ? `Command timed out after ${timeoutSeconds} seconds`
            : "Command aborted");
        this.name = "CommandTerminatedError";
    }
}
```

`executor.ts:117` / `:123` 两处 `rejectOnce(new Error(\`${stdout}\n${stderr}\n...\`))` 改为抛这个类型。**保持 reject 语义不变**——17 处调用点（10 个文件）里只有 `bash.ts` 需要感知它，其余继续按原样处理，只是拿到的 message 从最多 10MB 变成一行。

> **驳回的方案**：把 timeout 改成正常 resolve + `timedOut` 标志。那要逐个审计全部 17 个调用点，而且对只看 `result.code` 的调用点会把"超时"静默变成"成功但输出不全"。收益一样，风险大得多。

**改 `src/tools/bash.ts`**：把 `executor.exec` 包进 try/catch，捕获 `CommandTerminatedError` 后**走已有的那条路**（`bash.ts:248-290` 的 spill + `truncateTail`），末尾追加可执行的下一步：

```
[Timed out after 300s; partial output above. Full output: /tmp/pipiclaw-bash-xxxx.log]
Retry with a larger `timeout`, or pass `async: true` to run it in the background and be woken when it finishes.
```

`details` 里带上 `{ timedOut: true, exitCode: undefined }`，让任务治理器能区分"跑挂了"和"跑不完"。

**顺带修掉 CPU 尖刺**（`executor.ts:99-108`）：

```ts
let stdoutCapped = false;
child.stdout?.on("data", (data) => {
    if (stdoutCapped) return;                 // 到顶就丢弃，不再整体拷贝
    stdout += data.toString();
    if (stdout.length > MAX_CAPTURE_BYTES) { stdout = stdout.slice(0, MAX_CAPTURE_BYTES); stdoutCapped = true; }
});
```

现状是每来一个 chunk 就整体拷贝一次 10MB；一条产出 100MB 的命令 ≈ 十几 GB memcpy，期间整个 daemon（含其它频道）停摆。

**测试**：`test/executor.test.ts:26` 断言的是 `toThrow("Command timed out after 0.01 seconds")` 的**子串**，新消息仍包含它，**不用改**；新增一条断言超时错误的 message 长度有界（例如 < 1KB）即可。`test/bash.test.ts` 新增：超时时返回的是带 spill 路径和重试指引的正常结果。

### 2.2 `base64` 大文件静默损坏

两处都在**同一条 exec 里**加大小闸门，不新增 spawn（沿用 `read.ts` 已有的 `__DIR__` 哨兵风格）：

**`src/tools/read.ts:158`（图片分支）**

```sh
if [ "$(wc -c < 'p')" -gt 5242880 ]; then echo "__TOO_BIG__ $(wc -c < 'p')"; else base64 < 'p'; fi
```

命中闸门时抛 **Recoverable**：`图片 X.XMB 超过 5MB 上限；先用 bash 压缩或裁剪（例如 sips/convert），或改用 read 的文本方式查看元数据。`

**`src/tools/send-media.ts:88`（已有的 `test -f` 那条）**

```sh
if [ -f 'p' ]; then wc -c < 'p'; else echo NO; fi
```

拿到字节数后再决定是否 `base64`。超限抛 **Recoverable**，说明上限与压缩建议。

> 上限取 5MB：`base64` 放大到 4/3，executor 的捕获上限是 10MB，留出协议与余量。这个数字应作为**代码常量**（`MAX_INLINE_BINARY_BYTES`），不进 `settings.json`——符合 CLAUDE.md "数值阈值是代码常量"的规矩。

**测试**：`test/read.test.ts`、`test/send-media.test.ts` 用的是 `ScriptedExecutor`（按顺序 shift 预设结果并断言命令文本），**命令串变了就必须同步更新**。这两个文件是本批唯一需要改动既有断言的地方。

---

## 第三批：错误契约迁移（一天，一个 PR，可与第二批并行）

> 目标：让"模型能自己修的失败"不再变成用户频道里的红色气泡（评审 §2.1）。

### 3.1 逐条改类

按评审 §2.1 的表格改。要点：

- `RecoverableToolError extends Error`，现有测试断言的是**未包装工具**的 `rejects.toThrow(<message>)`（`test/edit.test.ts:97,107,117`、`test/read.test.ts:62`），**这些测试一条都不用改**。
- 判据是"模型能不能独立解决"，不是"严不严重"：**path/command guard 拒绝、发送失败、事件文件损坏、pdftotext 未安装、`edit` 连续三次 no-op 的 `STOP.` 一律保持 plain**。
- 顺手把缺下一步指令的补上（`read` 的 `Failed to read file` 应提示"用 `read` 打开父目录确认路径"）。

改动清单（22 处，分布在 `read/grep/edit/bash/job/send-media/skill-manage/skill-security/memory-manage`）见评审 §2.1 表格，逐行有行号。

### 3.2 加一条防腐化的测试（这批的真正价值）

新建 `test/tool-error-contract.test.ts`：用 `buildToolSet` 造出完整工具集，喂一批已知的坏参数，断言**返回的是 `recoverable: true` 的结果而不是抛错**：

```ts
const cases = [
    { tool: "read",  args: { label: "x", path: "notes.txt", offset: 999 } },
    { tool: "grep",  args: { label: "x", pattern: "  " } },
    { tool: "edit",  args: { label: "x", path: "a.txt", oldText: "nope", newText: "y" } },
    { tool: "job",   args: { label: "x", op: "cancel" } },
    // …
];
// 每条断言：result.details.recoverable === true 且 content 文本以 "Rejected: " 开头
```

规矩写进 AGENTS.md 只能约束新代码；这条测试是**唯一**能防止它再次腐化的东西。同时在 AGENTS.md 的对应条目后补一句"由 `test/tool-error-contract.test.ts` 强制"。

---

## 第四批：写入安全与零散项（一天）

### 4.1 `write` / `edit` 原子写

**改 `src/tools/write-content.ts:65`**：

```sh
tmp='<path>.pipiclaw-tmp'
[ -f '<path>' ] && cp -p '<path>' "$tmp" 2>/dev/null
cat > "$tmp" && mv -f "$tmp" '<path>'
```

> **必须保留 `cp -p`**：`cat > tmp && mv` 会用新 inode 顶替旧文件，**丢掉原文件的权限位**——一个可执行脚本被 `edit` 改一次就不可执行了，而且没有任何提示。先 `cp -p` 复制出权限再截断内容，是这一步唯一容易改错的地方。tmp 放在同目录，保证 `mv` 在同一文件系统内是原子的。

### 4.2 `edit` 的并发覆盖检查

写回前重新 `cat` 一次并与读入时的内容比对，不一致抛 **Recoverable**：`<path> 在本次编辑期间被改动（可能是后台作业或外部 agent）；请重新 read 后再编辑。`

多一次读，换掉"静默覆盖别人的改动"。残留窗口只剩比对到写入之间的毫秒级，对单 daemon + 已有委派写锁的场景是相称的。

### 4.3 外部进程 env 过滤（评审 §1.4）

- `SENSITIVE_ENV_PATTERN` 后缀正则 → **显式变量名清单**（至少覆盖 `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`DINGTALK_*` 等 pipiclaw 自己的凭据），并明确它是"减少误继承的礼貌措施"，不是安全边界。
- **把本次实际丢弃的变量名写进 `invocationWarnings`**（`external/run.ts` → `setLaunched`），`op=show` 能看到。这比调正则值钱得多——今天 `GITHUB_TOKEN` 被删导致外部 agent 里 `gh` 失效是**零线索**的。
- `docs/sub-agents.md` 说明：需要 `gh`/`npm` 的角色请在 `env:` 里显式加回。

### 4.4 模板护栏（用户要求 #2 的落地形式）

`test/subagent-phase1.test.ts` 加一条**目录扫描**断言，取代写死的角色名列表：

```ts
it("every shipped role template declares thinkingLevel", () => {
    const dir = join(process.cwd(), "examples", "sub-agents");
    const files = readdirSync(dir).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md");
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
        expect(readFileSync(join(dir, name), "utf-8")).toMatch(/^thinkingLevel:\s*\S+/m);
    }
});
```

现有的逐角色取值断言保留（它们校验的是取值是否合理，两者互补）。

### 4.5 零散项（评审 §2.5–§2.8）

- `web_fetch` 无 `channelDir` 时若 `offset > 0`，明确返回"该上下文不支持分页"，不要静默给回第一屏。
- `task-manage.ts:75` / `skill-manage.ts:307` 的 `JSON.stringify(result, null, 2)` → 去掉缩进。
- `skill-security.ts:90` 删掉恒假条件。
- bash spill 文件加回收（或挪到 `<channelDir>/tmp/` 复用现有清理）。
- `read` 的行数统计与窗口读取合并成一条 `sh -c`。
- `runs.ts:725-731` 补一行注释说明"入队被拒由 durable dispatch 重投兜底"（评审 §1.7）。
- `isRecoverableRejection`：在 `session-events.ts:185` 用起来，或删掉。

### 4.6 skill 内容扫描（需要先决策，再动手）

评审 §2.7 给了 A/B 两个方向。**建议 A**：写入侧降级为警告，真正的防线（如果需要）移到 skill 内容进入系统提示的那一步。

这一条**不要和第四批其它项混在一个 PR**——它改变的是一个安全相关控件的定位，值得单独一个提交和一句 CHANGELOG。

---

## 风险与回滚

| 改动 | 风险 | 缓解 |
|---|---|---|
| 内置默认 `off → medium` | **成本上升**：每次内置/inline 委派都开推理。`explorer`/`log-sifter` 等模板已 pin `low` 不受影响，受影响的是 inline（工具 description 里的"默认路径"） | 单点常量，改回一行即可；`/usage` 可观察增量 |
| 同上 | 不支持推理的模型报错 | §1.2 的 clamp 是同 PR 的强制前置 |
| 外部 work 不再兜底 | 目标 CLI 自己的默认档可能低于 `low` | 模板已全部显式声明；文档写清"可复用的角色请显式写" |
| claude-code 兜底文本 | 误把中途崩掉的 run 判成 completed | `terminalSeen`/`protocolStatus` 严禁被兜底路径置位（§1.3 加粗项），配一条专门的测试 |
| executor 错误类型 | 17 个调用点行为变化 | 只改 message 内容，reject 语义不变 |
| 原子写 | 丢权限位 | `cp -p` 前置 + 一条 executable 文件的测试 |
| 错误改类 | 真正需要用户知道的事被藏起来 | guard/IO/外部决策一律保持 plain，逐条对照评审表格 |

## 明确不做的事

- 不动 `workspace-lease` 的锁模型（不加读写分级）。
- 不动 `runs.ts` 的三个幂等标记与 settle 顺序。
- 不动 `purpose=verify` 的 TOCTOU（attestation 对 external 本就标 `advisory`，且无法比对时 fail-closed）。
- 不把 `read`/`send_media` 改成 `node:fs` 直读——`Executor` 是这些工具唯一的测试缝，换掉它要重写 `ScriptedExecutor` 系列测试，收益不抵成本。§2.2 的一条 shell 已经解决实际问题。
- 不引入任何新的 `settings.json` 键：本计划涉及的阈值（5MB、medium、10MB）全部是代码常量。

# 测试套件检视报告 — v0.8.1

**范围**：103 个测试文件 / 737 用例 / 16216 行（不含 e2e）。目标是降低 AI Coding Agent 迭代时的测试 token 消耗。

> **执行状态（ABC 已落地）**：文件 103 → 102，用例 737 → 736，`npm run check` 全绿。详见文末「执行记录」。

## 总体判断（先说结论）

**"过多的低质量测试"这个前提基本不成立。** 通读全部 946 条用例标题、深读约 15 个文件后，判断是：这套测试**整体质量很高**——命名行为导向、断言具体、单元/集成分层清晰，几乎没有"垃圾测试"可以整片删除。

真正的 token 沉没成本不在"低价值用例"，而在**每个文件各自重复的脚手架**：AI 每次迭代读一个测试文件，都要连带读 20~40 行雷同的临时目录 setup / 假 executor。因此本次的最大杠杆是**做减法于样板，而非做减法于覆盖**。

三档优先级：**A. 抽公共 helper（最大收益）> B. 合并零散安全小文件 > C. 删少量脆弱/历史测试**。

---

## A. 抽公共 helper —— 最大的 token 杠杆

- **35 个文件**内联 `mkdtempSync` + `afterEach(rmSync recursive)` 清理；**43 处**雷同 `rmSync(dir, { recursive: true })`。
- **4 个文件**各自复制 `class RecordingExecutor implements Executor`（`bash` / `command-optimizer` / `tool-security-bash` / `tool-security-read-write`），另有 8 个文件手写假 executor。
- 已有 `test/helpers/`（`fixtures.ts` 含 `createTempWorkspace`），但**只有 17 个文件在用**。

**动作**：
1. 在 `test/helpers/` 补 `withTempDir()`（返回目录并注册自动清理）和 `createRecordingExecutor()`。
2. 把 35 个内联 tempdir 文件、4 个 `RecordingExecutor` 文件迁移过去。
3. 预估净删 **~400–600 行**纯样板，且不损失任何覆盖——这些行 AI 每次读文件都要吞。

> 这是"少而精"里收益最高的一步：覆盖不变，AI 每次读到的噪声大幅下降。

---

## B. 合并零散的安全小文件

安全测试目前散在 7 个文件，其中几个是可合并的碎片：

| 现状 | 建议 |
|---|---|
| `tool-security-bash.test.ts`（1 用例）+ `tool-security-read-write.test.ts`（2 用例） | 合并为 `tool-security.test.ts`，共用一个 `RecordingExecutor`。二者都在验证同一件事："工具在调 executor **之前**就被 guard 拦下"（`executor.calls == []`）。 |
| `skill-security-extended.test.ts`（7 用例） | 并入 `skill-manage.test.ts` 或一个统一的 `skill-security.test.ts`；"extended"这个命名本身就是历史拆分的残留。 |
| ~~`web-fetch-security.test.ts` 与 `security-network-guard.test.ts`~~ | **复核后撤销**：细看后三个用例是 `runWebFetch` 的集成冒烟，尤其"blocks redirects"测的是 web-fetch 自己的重定向拦截路径，network-guard 单测并不覆盖。删了会丢真实覆盖，**保留原样**。 |

净效果：7 个安全文件 → 4~5 个，去掉重复 setup 与重叠断言。

**不建议动**的安全测试：`security-command-guard` / `security-path-guard` / `security-network-guard` 的核心单测——这些是防御性护栏，覆盖必须厚。

---

## C. 删少量脆弱 / 历史测试（精确清单）

只列**已核实**、删了不丢有效覆盖的：

1. **`prompt-builder.test.ts:66`** —— `"is materially smaller than the pre-playbook-detail prompt"`，断言 `prompt.length < 9_000`。这是绑定某次历史迁移的**魔数快照**：任何正当的 prompt 增长都会误报，且它想验证的"渲染全部工具"已被同文件其它用例覆盖。**删**。

除此之外，**没有发现成片可删的低价值用例**。若为了压数字硬删高质量用例，反而违背"少而精"。

---

## 不建议改的地方（避免过度重构）

- **memory 维护四件套**（gates / jobs / scheduler / state）：CLAUDE.md 明确要求分层保留，各自单一职责，勿合并。
- **memory-recall 单测 vs recall-scoring 集成**：`"prioritizes session state"`看似重叠，但一个用 mock、一个用真实文件，是有意的单元/集成分层，保留。
- **memory-promotion vs memory-promotion-signals**：测的是不同函数（`shouldAutoWrite*` vs `scanPromotionSignals`），非冗余。
- 一批单测试小文件（`shell-escape` / `paths` / `channel-paths` / `executor` / `llm-json` / `truncate`）：每个都便宜且覆盖真实边界，删了省不了 token 却丢覆盖，**保留**。

---

## 建议执行顺序

1. **A（helper 抽取）** —— 收益最大、风险最低，先做。
2. **C（删 1 个脆弱测试）** —— 顺手。
3. **B（安全文件合并）** —— 需逐个核对断言不丢，最后做。

> 全程 `npm run check` 保证 737 用例数在合并后只减不漏（合并不减用例，A/B 删的是样板与重叠断言，C 减 1 个用例）。

---

## 执行记录

`npm run check` 全绿：**102 文件 / 736 用例**（原 103 / 737）。

**A — 公共 helper**
- 新增 `test/helpers/recording-executor.ts`：统一 `RecordingExecutor`（构造函数接受 handler 函数或固定 `ExecResult`），替换 4 处复制粘贴。已迁移 `bash` / `command-optimizer` / `tool-security`。
- `test/helpers/fixtures.ts` 新增 `useTempDirs()`：注册 `afterEach` 自动清理，替换 `tempDirs[] + mkdtempSync + rmSync` 惯用法。
- **已全部迁移**（第二轮补完）：所有采用 `const tempDirs[]` 累加器惯用法的 **38 个文件**均已改用 `useTempDirs()`，逐个清理了失效的 `mkdtempSync`/`rmSync`/`tmpdir`/`afterEach`/`join` import。含标准工厂（直接塌缩为 `const createX = useTempDirs(...)`）、复杂工厂（`harness`/`createFixture`/`createTempWorkspace` 保留函数、仅替换 mkdtemp+push）、多站点内联（`settings`/`security-config`/`tools-config`，`replace_all` 统一为 `makeTempDir()`）。
- **有意保留**：`artifact-subject` / `jsonl-appender` / `log-file-sink` / `security-logger` / `usage-ledger` 用的是 `beforeEach` 赋值共享 `dir` + `afterEach` 单行清理的另一种干净惯用法，非目标样板，强迁收益极小，保持原样。
- 全程 `npm run check` 全绿（102 文件 / 736 用例，biome + tsc + knip 均通过）。

**B — 合并零散安全文件**
- `tool-security-bash` + `tool-security-read-write` → 合并为 `tool-security.test.ts`（共用 helper，3 用例不减）。
- `skill-security-extended.test.ts` → 重命名 `skill-security.test.ts`（无基础文件，"extended"是历史残留），顺手删掉文件内**从未使用**的 `tempDirs`/`afterEach` 死样板。
- web-fetch-security 合并项**复核后撤销**（见上表）。

**C — 删脆弱测试**
- 删 `prompt-builder.test.ts` 的 `expect(prompt.length).toBeLessThan(9_000)`（唯一净减 1 用例）。

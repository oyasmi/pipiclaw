# 026 评审问题修复记录 — 2026-07-17

针对 `/tmp/pi-review-report.md` 提出的 5 个问题，逐个读源码核实并 triage 后的处理记录。
原则：低性价比的不修，不为修小问题引入新抽象；先核实再动手。

## 核实与 Triage 结论

### 问题 1 — `truncateHeadTail` UTF-16 切片的 surrogate 风险 → **不修**

- 位置：`src/agent/prompt/builder.ts` `truncateHeadTail`
- 核实：
  - 该函数仅在 `overflow: "truncate-head-tail"`（SOUL/AGENTS）和 `overflow: "error"` 兜底时调用。
  - SOUL/AGENTS 的正文已经在 `resources.ts` 用 `clipTextByPromptUnits`（显式 code-point 安全、`Array.from` 迭代）裁到 `SOUL_BUDGET_CHARS=24_000` / `AGENTS_BUDGET_CHARS=48_000`；section 的 `maxChars` 是 `25_200` / `49_200`，给 wrapper 留了 1,200 字符余量。wrapper 实测开销约 250 字符（含前导语 + 路径），正文加 wrapper 远低于 section cap，因此 `truncateHeadTail` 对 SOUL/AGENTS **在正常路径下根本不会触发**。
  - `overflow: "error"` 兜底只作用于 runtime-authored section，其内容是纯 ASCII 字符串字面量，不存在 surrogate pair。
  - `truncateHeadTail` 的契约本身是 char-based（`maxChars` 与 `String.prototype.length` 一致都是 UTF-16 code-unit）。char-based 函数用 char-based 切片符合自身契约；code-point 安全是上游 `clipTextByPromptUnits` 的职责，不是这里。
- 结论：理论风险，当前代码不可触发，且改它会混淆 char-based 与 code-point 两层职责。不修。

### 问题 2 — `sealContent` 精确串匹配可被 XML 空白变体绕过 → **不修**

- 位置：`src/agent/prompt/sections.ts` `sealContent`
- 核实：
  - XML end-tag 产生式 `ETag := '</' Name S? '>'` 确实允许 `</workspace_identity >` 这类尾空白变体，评审描述属实。
  - 但 spec 025 §6.9 明确：wrapper 只“增加一点摩擦”，**“不做‘关键词扫描即可安全’的虚假保证，真正 hard gate 仍在工具/runtime”**；spec 026 §2.4 再次强调“Enforcement 不依赖 prompt”。
  - 真实注入场景里模型只会发出干净的 `</tag>`（精确匹配已覆盖）。空白变体只存在于人为构造的 XML 示例中，且即便绕过，后果也仅是 prompt 层摩擦失效，真正防护在 tools/runtime。
- 结论：spec 明确把该层定位为非安全边界。为其加 regex 等于在 spec 刻意弱化的层投入防御、并误导后续维护者把它当安全机制。不修。

### 问题 3 — `clipTextByPromptUnits` marker ≥ maxUnits 违反 `≤ maxUnits` 契约 → **修**

- 位置：`src/shared/prompt-units.ts` `clipTextByPromptUnits`
- 核实：
  - 当 `markerUnits >= maxUnits` 时，`availableUnits = Math.max(0, maxUnits - markerUnits) = 0`，head/tail 可为空（或仅前导空白），但最终 `clipped = head + marker + tail` **无条件包含 marker**，导致 `injectedUnits = countPromptUnits(clipped)` 包含 marker 的 units，从而 `> maxUnits`。JSDoc 声明 `injectedUnits: always ≤ maxUnits` 被破坏。`maxChars` 同理。
  - 当前调用方（`resources.ts` 3000/6000、`bootstrap.ts` 400）的 marker 都极小（≤ 几十个 units），现实中不可触发；但这是 `src/shared/` 下的共享库 helper，契约是显式写明的、可被数学证明违反，未来小预算调用方（turn-context 各 block）可能踩到。
- 修复：在算出 `markerUnits` / `markerChars` 之后、做预算分配之前加一个 guard——若 marker 自身已超过任一上限，直接返回空文本（`injectedUnits: 0`、`truncated: true`），使契约成立。改动 5 行，无新抽象。
- 测试：`test/prompt-units.test.ts` 增加 2 个用例（units 与 chars 各一），锁定契约。现有 11 个用例不受影响。

### 问题 4 — 单个巨型非 CJK word 被 unit 计数严重低估 → **文档降级**

- 位置：`src/shared/prompt-units.ts` `countPromptUnits`
- 核实：`"a".repeat(100000)` 确实只计 1 unit，这是计数规则（spec 026 §5.1“每个非 CJK word run 计 1 unit”）的**按设计行为**，不是 bug。spec §5.2 已用 `maxChars` 作为第二道保护兜底此类输入。
- 处理：在 `countPromptUnits` JSDoc 补一段已知局限说明（base64 / minified JS / 无分隔符 URL 会低估，需配合 `clipTextByPromptUnits` 的 `maxChars`）。不改计数逻辑。

### 问题 5 — spec 026 DoD #11 与 §11.3 矛盾 → **修（文档透明度）**

- 位置：`docs/specs/026-system-prompt-slimming/design.md` 状态行 / §15 DoD #11
- 核实：DoD #11 写“关键 behavior eval 无显著退化”，但 §11.3 把 behavior eval 列为“计划”，§12 的 PR 计划也未单列；仓库内确无 eval harness（`find` 无结果）。spec 025 状态行已诚实标注“DoD 11/12 待补”，026 未对齐这一做法。
- 修复：
  - 状态行由 `IMPLEMENTED` 改为 `IMPLEMENTED（behavior eval harness 待建，见 §11.3 与 DoD #11）`。
  - DoD #11 追加括注说明 eval harness 待建、当前以 unit/integration 测试为准、待补后回填。

## 变更清单

- `src/shared/prompt-units.ts`
  - `countPromptUnits` JSDoc 补已知局限（问题 4）。
  - `clipTextByPromptUnits` 加 marker 超限 guard（问题 3）。
- `test/prompt-units.test.ts`：新增 2 个回归用例（问题 3 的 units / chars 两条路径）。
- `docs/specs/026-system-prompt-slimming/design.md`：状态行 + DoD #11 透明度补注（问题 5）。

## 未修复的问题及原因

- 问题 1（surrogate 切片）：char-based 函数符合自身契约；SOUL/AGENTS 正文已被上游 code-point 安全裁剪且 section 留有 1,200 字符 wrapper 余量，该函数对它们不触发；runtime error 段为纯 ASCII。改它会混淆两层职责，性价比低。
- 问题 2（sealContent regex）：spec 025 §6.9 / 026 §2.4 明确该层非安全边界；真实注入形态已被精确匹配覆盖；为其加 regex 与 spec 的 enforcement 模型相悖。

## 验证

- `npm run typecheck`：通过。
- `npx vitest run`：764 passed，唯一失败 `test/prompt-resource-loader.test.ts` 是**修复前已存在**的环境问题（全局安装的 `dws` skill 泄漏进测试 loader，`git stash` 后在干净树上同样失败），与本轮变更无关。`test/prompt-units.test.ts` 13/13、`test/prompt-sections.test.ts` 20/20 通过。

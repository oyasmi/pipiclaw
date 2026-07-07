# Spec 019 Task Ledger — 实现评审

| 字段 | 值 |
|------|------|
| 评审对象 | `feat/task-ledger` 工作区未提交改动（Phase 1 实现） |
| 对照规格 | [`design.md`](./design.md)（rev.1） |
| 日期 | 2026-07-08 |
| 评审范围 | `src/tools/event-manage.ts`（新增）、`registry.ts`、`config.ts`、`event-commands.ts`、`test/event-manage.test.ts`（新增）及三份文档 |
| 验证 | `typecheck` ✅　`lint` ✅　`deadcode(knip)` ✅　`test`（受影响 4 文件 39 用例）✅ |

---

## 总评

实现**忠实地落地了 design.md 的 Phase 1 契约**，且工程质量高：复用而非重造、单一职责、测试覆盖与规格的"测试"小节逐条对齐，四道自激励闸门、channel 所有权、路径 traversal、原子写都按设计实现并验证通过。`event_manage` 是一个干净、克制的一等工具。

但评审中发现 **1 个中等严重度的威胁模型缺口**（自激励闸门可被 `write` 工具绕过，而规格把它描述成"硬校验"），以及若干低风险/可改进项。详见下文。结论：**可合入，但建议至少修正文档措辞（Finding 1），并采纳 Finding 2 的 promptHint 补全。**

---

## 做得好的地方

1. **零重复造轮子，全部复用既有原语**——符合 AGENTS.md 的去重 / 单一职责约束：
   - `parseScheduledEventContent`（`src/runtime/events.ts:179`）直接 import，保证"工具写出的文件必然可被 watcher 装载"这一核心承诺；
   - `normalizeEventName` / `resolveEventPath`（`src/runtime/event-commands.ts:66`、`:75`）由内部函数提升为 `export` 供工具复用，未移动、未复制——改动量 2 行；
   - `writeFileAtomically`（`src/shared/atomic-file.ts`）、`guardCommand`（`src/security/command-guard.ts:646`）均直接复用。`events.ts` 零改动，与规格承诺一致。

2. **immediate 双侧禁止的论证是真的成立**。规格担心"update 会刷新 mtime 使 immediate 立即重新执行"——核对 watcher 源码确认：`handleFileChange`（`events.ts:383-393`）对 `knownFiles` 中的文件会 `cancelScheduled` 后重新 `handleFile`；`handleImmediate`（`events.ts:490-503`）只看 `stat.mtimeMs < startTime`。因此工具在 update 路径上同时拦截"目标文件是 immediate"与"新 definition 是 immediate"（`event-manage.ts:241-243` 与 `:155-160`）是必要且正确的。

3. **channel 所有权三处都查**：create 阶段把 `definition.channelId` 强制对齐当前 channel（`event-manage.ts:144-151`）；update/delete 阶段读盘校验归属（`readOwnedEvent` `:171-187`）。配合 create 的 `existsSync` 预检（`:228`），跨 channel 同名事件是**冲突报错**而非静默覆盖——这给"未用 channelId 前缀"的误用兜了底（见 Finding 2）。

4. **持久化内容被规范化**：落盘的是 `JSON.stringify(event)`（`event` 来自 `parseScheduledEventContent`），未知字段被剥离、字段顺序固定。agent 误传的 `recurrence` / `priority` 不会泄漏进事件 JSON，降低脏数据破坏面。

5. **原子写不误触发 watcher**：`createAtomicTempPath` 生成 `.tmp` 后缀（`atomic-file.ts:5-7`），watcher 的 watch 回调与启动扫描都只处理 `.json`（`events.ts:266`、`:372`）。`test/event-manage.test.ts:102-107` 有后缀断言防回归。

6. **config 门控三处齐全**（`config.ts` 接口 / 默认值 / `mergeToolsConfig` 读取分支），默认 `true` 与 `memory.sessionSearch.enabled`、`skills.manage.enabled` 的主流约定一致；`availableToSubagents: false` 正确（调度是主 agent 的编排职责）。

7. **不泄漏宿主路径**：`toWorkspacePath`（`event-manage.ts:71-76`）把返回给 agent 的 `path` 翻译成 workspace 相对路径。

8. **测试与规格"测试"小节逐条对应**：create 的合法落盘+回装、坏 JSON/缺字段/坏 cron/坏 tz、immediate 拒绝、`at` 提前量、periodic 30 分钟下限、preAction 被 guard 拦截、重名、`.json` 归一化、`../../` traversal、channelId 缺省填充、跨 channel 拒绝、≥50 拒绝；update 的重新校验/不存在/immediate 重 arm/跨 channel；delete 的存在/不存在/跨 channel。覆盖完整。

---

## 发现（按严重度排序）

### Finding 1 — 自激励闸门可被 `write` 工具绕过（"硬校验"名不副实）　`Medium`

**位置**：威胁模型层面；涉及 `src/security/path-guard.ts:197-215` 与 design.md §五/风险表。

**现象**：规格把四道闸门（禁 immediate、one-shot ≥2 分钟、periodic ≥30 分钟、50 文件上限）定位为防"agent 把自己拖入烧 token 的自激励循环"的**硬校验**（design.md 风险表："写入时 cron 频率下限（30 分钟）**硬校验**"）。但主 agent 同时拥有 `write` 工具，而 path-guard 的默认放行规则 `pathAllowedByDefaults`（`path-guard.ts:212-215`）对**workspace 内任意路径**都返回 allowed——`isWithinWorkspace`（`:197-199`）覆盖 `workspace/events/*.json`。因此 agent 完全可以绕过 `event_manage`，用 `write` 直接落一个 `{"type":"immediate",...}` 或 `* * * * *` 的高频 periodic，watcher 照样装载。

**后果**：闸门只对"agent 主动配合、走 `event_manage`"的路径生效，是**建议性**的，不是规格宣称的硬保证。一个被 prompt 注入或自身混淆的 agent 仍可烧 token。design.md 把现状描述为"目前 agent 只能用 write 工具裸写 JSON"（问题陈述），但解法只是**新增**一条优选路径，并未**收口**写事件的能力。

**为何是 Medium 而非更高**：agent 本就是高信任边界（持有 bash，可造成的破坏远不止烧 token）；闸门在合作路径上仍有效；规格也承认裸写是现状。真正的瑕疵是**文档把"硬校验"写得比现实强**，以及威胁模型留有缺口。

**建议**（二选一，推荐 B）：
- **A（低成本，仅修文档）**：把 design.md / `events-and-sub-agents.md` / `configuration.md` 中的"硬校验"措辞改为"在 `event_manage` 路径上的校验；agent 裸用 `write` 仍可绕过，由 SOP 约束"，避免误导。
- **B（收口缺口）**：在默认安全配置的 `writeDeny` 中加入 `workspace/events/**`（或 path-guard 内对 events 目录特判写操作），使 agent 的 `write` 工具拒绝直接写事件目录，强制走 `event_manage`。用户手工编辑文件不经过工具，不受影响——只关掉 agent 这条旁路。这是与"工具是事件写入的一等入口"定位相称的做法。

> 附注：`event_manage` 直接落盘不经 path-guard（design.md §五已注明），其路径安全由 `resolveEventPath` 的归一化 + traversal 校验保证；`resolve` 不解析符号链接，若 `workspace/events` 本身是 symlink 可能源问题——但这是与 `/events` 命令、watcher 共有的既有信任面，非本次引入，不计入本条。

---

### Finding 2 — promptHint 漏掉规格要求的命名约定与 wake/checkin 对称性　`Low-Medium`

**位置**：`src/tools/registry.ts:196-197`。

**现象**：design.md §二"注册与门控"明确要求 promptHint 一并给出"task 事件命名约定（含 channelId 前缀）"与"wake 字段与 checkin 事件的对称性"。实际 promptHint 只写了能力与两道闸门：

> Schedule your own follow-ups: create/update/delete one-shot check-ins and periodic cadences for this channel (no immediate events; periodic no more often than every 30 min)

命名约定目前**只**出现在 `name` 参数的 description 里（`event-manage.ts:26-29`）——那是模型组装工具调用时才看的字段级提示，不是 system-prompt 级的常驻指引。

**后果**：`task.<channelId>.<id>.<use>` 前缀是纯约定、工具不强制。没有 prompt 级常驻提醒，agent 更倾向用 `checkin.json` 这类短名。好在 create 的 `existsSync` 预检会把跨 channel 同名变成**冲突报错**而非静默覆盖（见"做得好"第 3 条），所以这是**可用性/人因工程**问题，不是数据安全漏洞——但会让多 channel 场景频繁撞名报错。wake 与 checkin 的对称性（一起动、一起清）同理缺少常驻提醒，直接影响台账闭环的正确率。

**建议**：扩充 promptHint，补入命名约定与对称性一句。低成本、高收益，且让实现与规格的"注册与门控"小节完全对齐。

---

### Finding 3 — 50 文件上限存在跨 channel 计数竞态　`Low`

**位置**：`src/tools/event-manage.ts:189-193`（`countEventFiles`）、`:231`。

**现象**：run-queue 只保证**单 channel** 回合串行；`workspace/events/` 是全局目录，两个 channel 的回合可并发执行。两者可能各自读到 49 个文件、双双通过 `< 50` 检查并同时 create，使总数突破 50。

**后果**：上限是 sanity backstop，超出一两个无害。Low。

**建议**：接受现状（上限本就不是硬不变式），或在 design.md 注明该上限为"软上限"。不建议为此引入全局锁。

---

### Finding 4 — 不可解析的"自有"事件无法经工具 update/delete　`Low`

**位置**：`src/tools/event-manage.ts:171-187`（`readOwnedEvent`）。

**现象**：update 与 delete 都先 `readOwnedEvent`，该函数对任何 parse 失败都抛错（`:179-182`）。因此一个被手工写坏、归属本 channel 的事件文件，agent 无法用 `event_manage` 清理——必须退回 `/events delete`（用户侧）或 `write`/`bash`。

**评价**：这是**fail-closed**（无法确认归属就不动），方向正确，错误信息也指向了 `/events`。运营上偶尔会让 agent 卡住，但安全取舍合理。Low，仅需记录。

**建议**：可在 design.md 风险表补一句"坏文件由 `/events` 兜底清理"，无需改代码。

---

### Finding 5 — 传感器脚本注释略误导（doc nit）　`Nit`

**位置**：`docs/tasks.md:261`。

**现象**：`if (statSync(path).isDirectory()) continue; // skips archive/` —— 实际上 `archive/` 是因为 `readdirSync` 非递归 + `!name.endsWith(".md")` 早退被跳过的，`isDirectory()` 这行只对"名为 `xxx.md` 的目录"有效。功能正确（archive 内容确实不被扫），但注释归因不准。

**建议**：注释改为说明"防御以 `.md` 命名的子目录"即可。不影响正确性。

---

### Finding 6 — `validateDefinition` 双重 JSON 往返　`Nit`

**位置**：`src/tools/event-manage.ts:144-153`。

**现象**：先 `JSON.parse(rawDefinition)` → 改 `channelId` → `JSON.stringify(data)` → 再交给 `parseScheduledEventContent`（其内部又 `JSON.parse`）。多一次序列化往返。

**评价**：可读性其实更好（先校验对象形态再交给正式解析），且保证了落盘内容规范化（见"做得好"第 4 条）。不建议改。

---

## 建议的合入前动作

- **必做**：修正 Finding 1 的文档措辞（把"硬校验"改为路径限定的表述），或更好——实施 Finding 1-B（path-guard 收口）。
- **强烈建议**：Finding 2 补全 promptHint（命名约定 + wake/checkin 对称性）。
- **可选**：Finding 3/4 在 design.md 补注；Finding 5 改一行注释。

完成上述后，本实现即可视为满足 Phase 1 的成功标准 1（单回合内委派→更新台账→`event_manage` 安排回访→结束）。成功标准 2–4（周报全流程、宕机恢复、心跳静默）属运营/e2e 验证，不在本次代码评审范围。

#!/usr/bin/env node
// Executable form of the module table in AGENTS.md (spec 054, D1/D2).
//   node scripts/check-architecture.mjs           check (what `npm run arch` runs)
//   node scripts/check-architecture.mjs --init    write the baseline once (P0 only; never again)
//   node scripts/check-architecture.mjs --prune   drop baseline entries that no longer occur
// If this file and the docs disagree, this file wins — fix the docs in the same commit.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRelativeImports, resolveSpecifier, walkFiles } from "./lib/imports.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = "scripts/architecture-baseline.json";
const MAX_LINES = 800;

// --- D1: modules -------------------------------------------------------------------------
// Ordered; first match wins (a prefix ending in "/" or an exact file path). Files not listed
// take the first directory name under src/. Root-level files MUST be listed.
const MODULES = [
	["src/main.ts", "entry"],
	["src/index.ts", "entry"],
	["src/log.ts", "foundation"],
	["src/paths.ts", "foundation"],
	["src/executor.ts", "foundation"],
	["src/file-store.ts", "foundation"],
	["src/proxy-from-env.d.ts", "foundation"],
	["src/commands/catalog.ts", "commands"],
	["src/commands/reply-limits.ts", "commands"],
	["src/commands/router.ts", "commands-router"],
	["src/tools/contract/", "tools-contract"],
];

// --- D1: allowed dependencies (a DAG; same-module imports are always fine) --------------
const L01 = ["shared", "commands", "foundation"];
const BELOW_TOOLS = [
	...L01,
	"security", "usage", "tasks", "playbooks", "dot", "channel", "tools-contract",
	"config", "models", "web", "skills", "memory", "events", "jobs", "subagents",
];
const BELOW_AGENT = [...BELOW_TOOLS, "tools"];
const BELOW_TRANSPORT = [...BELOW_AGENT, "agent", "commands-router", "app"];
const ALLOWED = {
	shared: [],
	commands: [],
	foundation: ["shared"],
	security: L01,
	usage: L01,
	tasks: L01,
	playbooks: L01,
	dot: L01,
	channel: [...L01, "security", "dot"],
	"tools-contract": [...L01, "security"],
	config: [...L01, "channel"],
	models: [...L01, "config"],
	web: [...L01, "security", "config"],
	skills: [...L01, "security"],
	memory: [...L01, "dot", "channel", "config", "models", "usage"],
	events: [...L01, "dot", "channel", "security", "tasks"],
	jobs: [...L01, "dot", "channel", "tasks"],
	subagents: [...L01, "security", "usage", "tasks", "dot", "channel", "config", "models", "memory", "tools-contract"],
	tools: BELOW_TOOLS,
	agent: BELOW_AGENT,
	"commands-router": [...BELOW_AGENT, "agent"],
	app: [...BELOW_AGENT, "agent"],
	dingtalk: BELOW_TRANSPORT,
	tui: BELOW_TRANSPORT,
	runtime: [...BELOW_TRANSPORT, "dingtalk"],
	entry: [...BELOW_TRANSPORT, "dingtalk", "tui", "runtime"],
};
// Edges that may only be `import type`.
const TYPE_ONLY_ALLOWED = { config: ["channel"] };

// --- helpers -----------------------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const norm = (p) => p.split(path.sep).join("/");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const errors = [];
const fail = (rule, msg, hint) => errors.push(`[${rule}] ${msg}${hint ? `\n        下一步：${hint}` : ""}`);

function assertAcyclic() {
	const indeg = new Map(Object.keys(ALLOWED).map((m) => [m, 0]));
	for (const [m, deps] of Object.entries(ALLOWED)) {
		for (const d of deps) {
			if (!indeg.has(d)) throw new Error(`ALLOWED: ${m} 依赖了未登记的模块 ${d}`);
			indeg.set(m, indeg.get(m) + 1);
		}
	}
	const queue = [...indeg].filter(([, n]) => n === 0).map(([m]) => m);
	let seen = 0;
	while (queue.length > 0) {
		const m = queue.pop();
		seen++;
		for (const [o, deps] of Object.entries(ALLOWED)) {
			if (deps.includes(m)) {
				indeg.set(o, indeg.get(o) - 1);
				if (indeg.get(o) === 0) queue.push(o);
			}
		}
	}
	if (seen !== indeg.size) throw new Error("ALLOWED 表有环：模块依赖必须是有向无环图");
}

function moduleOf(file) {
	for (const [prefix, mod] of MODULES) {
		if (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix) return mod;
	}
	const rest = file.slice("src/".length);
	const slash = rest.indexOf("/");
	if (slash === -1) return null;
	return rest.slice(0, slash);
}

function tarjan(nodes, edges) {
	let index = 0;
	const idx = new Map();
	const low = new Map();
	const onStack = new Set();
	const stack = [];
	const sccs = [];
	const strong = (v) => {
		idx.set(v, index);
		low.set(v, index);
		index++;
		stack.push(v);
		onStack.add(v);
		for (const w of edges.get(v) ?? []) {
			if (!idx.has(w)) {
				strong(w);
				low.set(v, Math.min(low.get(v), low.get(w)));
			} else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
		}
		if (low.get(v) === idx.get(v)) {
			const comp = [];
			let w;
			do {
				w = stack.pop();
				onStack.delete(w);
				comp.push(w);
			} while (w !== v);
			if (comp.length > 1 || (edges.get(v) ?? new Set()).has(v)) sccs.push(comp.sort());
		}
	};
	for (const v of nodes) if (!idx.has(v)) strong(v);
	return sccs.sort((a, b) => a[0].localeCompare(b[0]));
}

// --- analysis ----------------------------------------------------------------------------
assertAcyclic();
const srcFiles = walkFiles(ROOT, "src", (f) => f.endsWith(".ts"));
const srcSet = new Set(srcFiles);
const edgesByFile = new Map(srcFiles.map((f) => [f, new Set()]));
/** @type {Map<string, { from: string, to: string, typeOnly: boolean }>} */
const r1Edges = new Map();
const unregistered = new Set();

for (const file of srcFiles) {
	const fromMod = moduleOf(file);
	if (fromMod === null) {
		fail("R1", `${file} 是根目录文件，但没有在 MODULES 登记`, "在 scripts/check-architecture.mjs 的 MODULES 里登记，并更新 AGENTS.md 的模块表");
		continue;
	}
	if (!(fromMod in ALLOWED)) {
		if (!unregistered.has(fromMod)) {
			unregistered.add(fromMod);
			fail("R1", `${file} 所在的模块 ${fromMod} 没有登记`, "新增顶层目录必须同时更新 ALLOWED 和 AGENTS.md 的模块表");
		}
		continue;
	}
	for (const ref of collectRelativeImports(file, read(file))) {
		const target = resolveSpecifier(ROOT, file, ref.spec);
		if (!target || !srcSet.has(target)) continue; // R4 reports dangling paths
		edgesByFile.get(file).add(target);
		const toMod = moduleOf(target);
		if (toMod === null || toMod === fromMod) continue;
		const key = `${file} → ${target}`;
		const prev = r1Edges.get(key);
		r1Edges.set(key, { from: file, to: target, typeOnly: (prev ? prev.typeOnly : true) && ref.typeOnly });
	}
}

/** @type {{ from: string, to: string, hint: string }[]} */
const r1Violations = [];
for (const { from, to, typeOnly } of r1Edges.values()) {
	const fm = moduleOf(from);
	const tm = moduleOf(to);
	if (!(fm in ALLOWED) || !(tm in ALLOWED)) continue;
	if (!ALLOWED[fm].includes(tm)) {
		r1Violations.push({ from, to, hint: `${fm} 不允许依赖 ${tm}。把共享的东西下沉到更低的层，或在低层定义接口并由上层注入；模块表见 AGENTS.md` });
	} else if (!typeOnly && TYPE_ONLY_ALLOWED[fm]?.includes(tm)) {
		r1Violations.push({ from, to, hint: `${fm} 只允许对 ${tm} 做 import type` });
	}
}
const r1Key = (v) => `${v.from} → ${v.to}`;

const r2Cycles = tarjan(srcFiles, edgesByFile);

const r3Over = {};
for (const file of srcFiles) {
	const text = read(file);
	const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
	if (lines > MAX_LINES) r3Over[file] = lines;
}

// R4: dangling relative specifiers
const r4Files = [
	...srcFiles,
	...walkFiles(ROOT, "test", (f) => f.endsWith(".ts")),
	...walkFiles(ROOT, "evals", (f) => f.endsWith(".ts")),
	...walkFiles(ROOT, "scripts", (f) => f.endsWith(".mjs") && !f.startsWith("scripts/lib/")),
];
const dangling = [];
for (const file of r4Files) {
	for (const ref of collectRelativeImports(file, read(file))) {
		if (!resolveSpecifier(ROOT, file, ref.spec)) dangling.push(`${file}: ${ref.kind} "${ref.spec}"`);
	}
}

// R5: file references in docs
const DOCS = ["AGENTS.md", "CLAUDE.md", "docs/architecture.md"];
const testFiles = walkFiles(ROOT, "test", (f) => f.endsWith(".ts"));
const allFiles = [...srcFiles, ...testFiles];
const baseNames = new Set(allFiles.map((f) => f.slice(f.lastIndexOf("/") + 1)));
const docRefs = [];
for (const doc of DOCS) {
	if (!fs.existsSync(path.join(ROOT, doc))) continue;
	const seen = new Set();
	for (const m of read(doc).matchAll(/`([^`\n]+\.ts)`/g)) {
		const token = m[1].trim();
		if (/[\s*<>{}$()|]/.test(token) || seen.has(token)) continue;
		seen.add(token);
		if (token.includes("/")) {
			const clean = token.replace(/^\.\//, "");
			// Docs also write paths relative to a section's directory (`prompt/types.ts`), so a
			// path that is a suffix of a real file counts too.
			const ok =
				fs.existsSync(path.join(ROOT, clean)) ||
				fs.existsSync(path.join(ROOT, "src", clean)) ||
				allFiles.some((f) => f.endsWith(`/${clean}`));
			if (!ok) docRefs.push(`${doc}: \`${token}\``);
		} else if (!baseNames.has(token)) {
			docRefs.push(`${doc}: \`${token}\``);
		}
	}
}

// --- baseline ----------------------------------------------------------------------------
const baselinePath = path.join(ROOT, BASELINE_FILE);
const current = {
	r1: r1Violations.map((v) => ({ from: v.from, to: v.to })).sort((a, b) => r1Key(a).localeCompare(r1Key(b))),
	r2: r2Cycles,
	r3: Object.fromEntries(Object.entries(r3Over).sort(([a], [b]) => a.localeCompare(b))),
};
const writeBaseline = (b) => fs.writeFileSync(baselinePath, `${JSON.stringify(b, null, "\t")}\n`);

if (args.has("--init")) {
	if (fs.existsSync(baselinePath)) {
		console.error("基线已存在。--init 只允许在 P0 使用一次；之后只能 --prune。");
		process.exit(1);
	}
	writeBaseline(current);
	console.log(`基线已写入：R1 ${current.r1.length} 条，R2 ${current.r2.length} 个循环，R3 ${Object.keys(current.r3).length} 个文件`);
	process.exit(0);
}

const baseline = fs.existsSync(baselinePath)
	? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
	: { r1: [], r2: [], r3: {} };

const baseR1 = new Set(baseline.r1.map(r1Key));
const curR1 = new Set(current.r1.map(r1Key));
const stale = { r1: [], r2: [], r3: [] };
for (const v of r1Violations) {
	if (!baseR1.has(r1Key(v))) fail("R1", `${v.from} → ${v.to} (${moduleOf(v.from)} → ${moduleOf(v.to)}) 不允许`, v.hint);
}
for (const b of baseline.r1) if (!curR1.has(r1Key(b))) stale.r1.push(b);

const isSubset = (a, b) => a.every((x) => b.includes(x));
for (const c of r2Cycles) {
	if (!baseline.r2.some((b) => isSubset(c, b))) fail("R2", `新的文件级循环：${c.join(" ↔ ")}`, "把共享的类型移到一个不依赖实现的文件（通常是同目录的 types.ts）");
}
for (const b of baseline.r2) if (!r2Cycles.some((c) => isSubset(c, b))) stale.r2.push(b);

for (const [file, lines] of Object.entries(r3Over)) {
	const limit = baseline.r3[file];
	if (limit === undefined) fail("R3", `${file} 有 ${lines} 行，超过 ${MAX_LINES} 行预算`, "按职责拆分文件；不要往基线里加新例外");
	else if (lines > limit) fail("R3", `${file} 有 ${lines} 行，超过基线登记的上限 ${limit}`, "登记过的超长文件不能再增长；把新增的部分放进新文件");
}
for (const file of Object.keys(baseline.r3)) if (!(file in r3Over)) stale.r3.push(file);

for (const d of dangling) fail("R4", `悬空的相对路径 ${d}`, "路径指向的文件不存在（搬迁后 vi.mock 的字符串最容易漏）；修正路径");
for (const d of docRefs) fail("R5", `文档引用的文件不存在 ${d}`, "更新文档中的路径，或删掉这条引用");

if (args.has("--prune")) {
	const next = {
		r1: baseline.r1.filter((b) => curR1.has(r1Key(b))),
		r2: r2Cycles.filter((c) => baseline.r2.some((b) => isSubset(c, b))),
		r3: Object.fromEntries(Object.entries(baseline.r3).filter(([f]) => f in r3Over).map(([f, limit]) => [f, Math.min(limit, r3Over[f])])),
	};
	writeBaseline(next);
	console.log(`基线已精简：R1 ${next.r1.length} 条，R2 ${next.r2.length} 个循环，R3 ${Object.keys(next.r3).length} 个文件`);
	process.exit(errors.length > 0 ? 1 : 0);
}

for (const b of stale.r1) fail("R1", `基线里的 ${b.from} → ${b.to} 已经不存在`, "运行 node scripts/check-architecture.mjs --prune 把它从基线删掉");
for (const b of stale.r2) fail("R2", `基线里的循环 ${b.join(" ↔ ")} 已经不存在`, "运行 --prune");
for (const f of stale.r3) fail("R3", `基线里的 ${f} 已经不超限（或已不存在）`, "运行 --prune");

if (errors.length > 0) {
	console.error(errors.join("\n"));
	console.error(`\n架构检查失败：${errors.length} 条`);
	process.exit(1);
}
console.log(
	`架构检查通过。基线剩余 ${baseline.r1.length} 条 R1、${baseline.r2.length} 个 R2 循环、${Object.keys(baseline.r3).length} 个 R3 超长文件。`,
);

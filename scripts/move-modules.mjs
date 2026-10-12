#!/usr/bin/env node
// Move source files and rewrite every relative import that points at them (spec 054, P0).
//   node scripts/move-modules.mjs moves.json     # {"src/runtime/dingtalk.ts": "src/dingtalk/bot.ts", ...}
// Rewrites src/, test/, evals/ (*.ts) and scripts/*.mjs, the architecture baseline, and drops the
// legacy MODULES entries of moved files. Markdown is untouched: check-architecture (R5) reports it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRelativeImports, resolveSpecifier, walkFiles } from "./lib/imports.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const movesFile = process.argv[2];
if (!movesFile) {
	console.error("用法: node scripts/move-modules.mjs moves.json");
	process.exit(2);
}
const moves = JSON.parse(fs.readFileSync(path.resolve(movesFile), "utf8"));
const entries = Object.entries(moves);

// 1. validate
const targets = new Set();
for (const [from, to] of entries) {
	if (!fs.existsSync(path.join(ROOT, from))) throw new Error(`来源不存在: ${from}`);
	if (fs.existsSync(path.join(ROOT, to)) && !(to in moves)) throw new Error(`目标已存在: ${to}`);
	if (targets.has(to)) throw new Error(`两个来源映射到同一个目标: ${to}`);
	targets.add(to);
}

// 2. collect every file's current imports BEFORE moving anything (resolution uses old locations)
const scan = [
	...walkFiles(ROOT, "src", (f) => f.endsWith(".ts")),
	...walkFiles(ROOT, "test", (f) => f.endsWith(".ts")),
	...walkFiles(ROOT, "evals", (f) => f.endsWith(".ts")),
	...walkFiles(ROOT, "scripts", (f) => f.endsWith(".mjs") && !f.startsWith("scripts/lib/")),
];
const edits = new Map(); // file (old path) -> new text
const warnings = [];
for (const file of scan) {
	const text = fs.readFileSync(path.join(ROOT, file), "utf8");
	const newFile = moves[file] ?? file;
	const replacements = [];
	for (const ref of collectRelativeImports(file, text)) {
		const target = resolveSpecifier(ROOT, file, ref.spec);
		if (!target) {
			warnings.push(`${file}: 无法解析 "${ref.spec}"，未改写`);
			continue;
		}
		const newTarget = moves[target] ?? target;
		if (newTarget === target && newFile === file) continue;
		let rel = path.posix.relative(path.posix.dirname(newFile), newTarget);
		if (!rel.startsWith(".")) rel = `./${rel}`;
		if (ref.spec.endsWith(".js") && rel.endsWith(".ts")) rel = `${rel.slice(0, -3)}.js`;
		if (rel !== ref.spec) replacements.push({ start: ref.start, end: ref.end, rel });
	}
	if (replacements.length === 0) continue;
	let next = text;
	for (const r of replacements.sort((a, b) => b.start - a.start)) next = next.slice(0, r.start) + r.rel + next.slice(r.end);
	edits.set(file, next);
}

// 3. git mv
for (const [from, to] of entries) {
	fs.mkdirSync(path.join(ROOT, path.dirname(to)), { recursive: true });
	execFileSync("git", ["mv", from, to], { cwd: ROOT });
}
for (const [file, text] of edits) {
	fs.writeFileSync(path.join(ROOT, moves[file] ?? file), text);
}
for (const [from, to] of entries) {
	if (fs.readFileSync(path.join(ROOT, to), "utf8").includes("import.meta.url")) {
		warnings.push(`${to}: 含 import.meta.url，相对 URL 不会被自动改写，请人工核对`);
	}
}

// 4. baseline + legacy MODULES entries
const mapPath = (p) => moves[p] ?? p;
const baselineFile = path.join(ROOT, "scripts/architecture-baseline.json");
if (fs.existsSync(baselineFile)) {
	const b = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
	b.r1 = b.r1.map((e) => ({ from: mapPath(e.from), to: mapPath(e.to) })).sort((x, y) => `${x.from} ${x.to}`.localeCompare(`${y.from} ${y.to}`));
	b.r2 = b.r2.map((c) => c.map(mapPath).sort()).sort((x, y) => x[0].localeCompare(y[0]));
	b.r3 = Object.fromEntries(Object.entries(b.r3).map(([f, n]) => [mapPath(f), n]).sort(([x], [y]) => x.localeCompare(y)));
	fs.writeFileSync(baselineFile, `${JSON.stringify(b, null, "\t")}\n`);
}
const checkFile = path.join(ROOT, "scripts/check-architecture.mjs");
let check = fs.readFileSync(checkFile, "utf8");
for (const [from] of entries) {
	const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	check = check.replace(new RegExp(`^\\t\\["${escaped}", "[^"]+"\\],\\n`, "m"), "");
}
fs.writeFileSync(checkFile, check);

// 5. format
execFileSync("npx", ["biome", "check", "--write", "."], { cwd: ROOT, stdio: "inherit" });

console.log(`已搬迁 ${entries.length} 个文件，改写了 ${edits.size} 个文件的 import`);
for (const w of warnings) console.warn(`警告: ${w}`);

// Shared by check-architecture.mjs and move-modules.mjs: collects every relative module
// specifier in a TypeScript/JavaScript file by walking the syntax tree (never by regex —
// test fixtures embed `import … from "./x.js"` inside string literals).
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const MOCK_METHODS = new Set(["mock", "doMock", "importActual", "importMock", "unmock", "doUnmock"]);

/**
 * @typedef {{ spec: string, start: number, end: number, typeOnly: boolean, kind: string }} ImportRef
 * start/end are the offsets of the string literal's *content* (quotes excluded).
 */

/** @returns {ImportRef[]} relative specifiers only (start with ./ or ../) */
export function collectRelativeImports(fileName, text) {
	const kind = fileName.endsWith(".mjs") || fileName.endsWith(".js") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
	const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
	/** @type {ImportRef[]} */
	const refs = [];
	const add = (literal, typeOnly, kindName) => {
		if (!literal || !ts.isStringLiteralLike(literal)) return;
		const spec = literal.text;
		if (!spec.startsWith("./") && !spec.startsWith("../")) return;
		refs.push({ spec, start: literal.getStart(sf) + 1, end: literal.getEnd() - 1, typeOnly, kind: kindName });
	};
	const visit = (node) => {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			let typeOnly = false;
			if (clause) {
				if (clause.isTypeOnly) typeOnly = true;
				else if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
					const els = clause.namedBindings.elements;
					typeOnly = els.length > 0 && els.every((e) => e.isTypeOnly);
				}
			}
			add(node.moduleSpecifier, typeOnly, "import");
		} else if (ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier) {
				let typeOnly = node.isTypeOnly;
				if (!typeOnly && node.exportClause && ts.isNamedExports(node.exportClause)) {
					const els = node.exportClause.elements;
					typeOnly = els.length > 0 && els.every((e) => e.isTypeOnly);
				}
				add(node.moduleSpecifier, typeOnly, "export");
			}
		} else if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (callee.kind === ts.SyntaxKind.ImportKeyword) {
				add(node.arguments[0], false, "dynamic-import");
			} else if (
				ts.isPropertyAccessExpression(callee) &&
				ts.isIdentifier(callee.expression) &&
				callee.expression.text === "vi" &&
				MOCK_METHODS.has(callee.name.text)
			) {
				add(node.arguments[0], false, `vi.${callee.name.text}`);
			}
		} else if (ts.isImportTypeNode(node)) {
			const arg = node.argument;
			if (ts.isLiteralTypeNode(arg)) add(arg.literal, true, "import-type");
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return refs;
}

/** Resolve a relative specifier written in `fromFile` to an existing repo-relative path, or null. */
export function resolveSpecifier(root, fromFile, spec) {
	const base = path.resolve(root, path.dirname(fromFile), spec);
	const candidates = [];
	if (spec.endsWith(".js")) {
		const stem = base.slice(0, -3);
		candidates.push(`${stem}.ts`, `${stem}.d.ts`, `${stem}.mts`);
	}
	candidates.push(base);
	for (const c of candidates) {
		try {
			if (fs.statSync(c).isFile()) return path.relative(root, c).split(path.sep).join("/");
		} catch {
			// try next candidate
		}
	}
	return null;
}

export function walkFiles(root, dir, predicate) {
	const out = [];
	const abs = path.join(root, dir);
	if (!fs.existsSync(abs)) return out;
	const stack = [abs];
	while (stack.length > 0) {
		const cur = stack.pop();
		for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
			const full = path.join(cur, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else {
				const rel = path.relative(root, full).split(path.sep).join("/");
				if (predicate(rel)) out.push(rel);
			}
		}
	}
	return out.sort();
}

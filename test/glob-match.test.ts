import { describe, expect, it } from "vitest";
import { compileGlobPattern } from "../src/tools/glob-match.js";

function matches(pattern: string, path: string): boolean {
	return compileGlobPattern(pattern).test(path);
}

describe("compileGlobPattern", () => {
	it("matches a bare basename pattern at any depth", () => {
		expect(matches("*.ts", "foo.ts")).toBe(true);
		expect(matches("*.ts", "src/deep/foo.ts")).toBe(true);
		expect(matches("*.ts", "src/deep/foo.tsx")).toBe(false);
	});

	it("anchors a pattern containing a slash to the path shape given", () => {
		expect(matches("src/*.ts", "src/foo.ts")).toBe(true);
		expect(matches("src/*.ts", "src/nested/foo.ts")).toBe(false);
	});

	it("matches ** across zero or more path segments", () => {
		expect(matches("src/**/*.test.js", "src/foo.test.js")).toBe(true);
		expect(matches("src/**/*.test.js", "src/a/b/foo.test.js")).toBe(true);
		expect(matches("src/**/*.test.js", "other/foo.test.js")).toBe(false);
	});

	it("matches a leading ** the same way", () => {
		expect(matches("**/*.ts", "foo.ts")).toBe(true);
		expect(matches("**/*.ts", "a/b/foo.ts")).toBe(true);
	});

	it("matches a trailing ** as everything under that point", () => {
		expect(matches("docs/**", "docs/readme.md")).toBe(true);
		expect(matches("docs/**", "docs/a/b/readme.md")).toBe(true);
		expect(matches("docs/**", "other/readme.md")).toBe(false);
	});

	it("expands brace alternation", () => {
		expect(matches("**/*.{ts,tsx}", "src/foo.ts")).toBe(true);
		expect(matches("**/*.{ts,tsx}", "src/foo.tsx")).toBe(true);
		expect(matches("**/*.{ts,tsx}", "src/foo.js")).toBe(false);
	});

	it("treats ? as a single non-separator character", () => {
		expect(matches("file?.txt", "file1.txt")).toBe(true);
		expect(matches("file?.txt", "file12.txt")).toBe(false);
	});

	it("escapes regex metacharacters in literal segments", () => {
		expect(matches("a.b.c", "a.b.c")).toBe(true);
		expect(matches("a.b.c", "aXbXc")).toBe(false);
	});

	it("expands nested braces and honours commas inside them", () => {
		expect(matches("**/*.{ts,{js,jsx}}", "src/foo.jsx")).toBe(true);
		expect(matches("**/*.{ts,{js,jsx}}", "src/foo.ts")).toBe(true);
		expect(matches("**/*.{ts,{js,jsx}}", "src/foo.css")).toBe(false);
	});

	it("keeps an unbalanced brace literal", () => {
		expect(matches("no{close", "no{close")).toBe(true);
	});

	// The matcher runs synchronously, once per walked file, on a pattern the model controls. A
	// regex-based implementation backtracked exponentially on these: 2s, 145ms and 32s
	// respectively, for patterns of at most a few dozen characters. Timing is the only way to
	// state the property, so the bar is set orders of magnitude above the honest cost (~0.1ms)
	// to stay stable on a loaded CI box while still failing loudly on a return to backtracking.
	it.each([
		["repeated globstars", `${"**/".repeat(12)}zzz`],
		["repeated brace alternatives", `${"{*,*}".repeat(5)}zzz`],
		["stars separated by literals", `${"*a".repeat(16)}zzz`],
	])("matches in linear time: %s", (_name, pattern) => {
		const path = `${Array.from({ length: 20 }, (_, i) => `seg${i}`).join("/")}/${"a".repeat(60)}`;
		const matcher = compileGlobPattern(pattern);

		const startedAt = performance.now();
		expect(matcher.test(path)).toBe(false);
		expect(performance.now() - startedAt).toBeLessThan(50);
	});

	it("rejects patterns too long or too explosive to be worth matching", () => {
		expect(() => compileGlobPattern("a".repeat(513))).toThrow(/longer than/);
		expect(() => compileGlobPattern("{a,b}".repeat(10))).toThrow(/brace expansion/);
		// The bound is on the expansion, not on merely using braces.
		expect(() => compileGlobPattern("{a,b}".repeat(5))).not.toThrow();
	});
});

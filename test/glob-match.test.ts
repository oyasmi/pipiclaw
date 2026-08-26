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
});

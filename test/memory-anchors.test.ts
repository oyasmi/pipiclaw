import { describe, expect, it } from "vitest";
import { extractAnchors, findUnanchored } from "../src/memory/anchors.js";

describe("reflection identifier anchors", () => {
	it("extracts composite identifiers without treating dates, decimal ratios or bare acronyms as anchors", () => {
		const text = [
			"https://example.com/home/tool.ts?q=1.2.3。",
			"/abs/path, ~/x/y；$HOME/x/z src/a/b.ts. src/a/b.ts",
			"f1ab23c ｖ22.19 v22.19 1.2.3 localhost:8787 example.test:9000 127.0.0.1:8080",
			"端口 15432 port 443 ＣＩ/CD 2026-11-26 0.85 15px/1.75 deadbeef",
		].join("\n");
		expect(extractAnchors(text)).toEqual([
			"https://example.com/home/tool.ts?q=1.2.3",
			"/abs/path",
			"~/x/y",
			"$HOME/x/z",
			"src/a/b.ts",
			"f1ab23c",
			"v22.19",
			"1.2.3",
			"localhost:8787",
			"example.test:9000",
			"127.0.0.1:8080",
			"15432",
			"443",
		]);
		expect(
			findUnanchored(
				["$HOME/x/y", "~/x/y", "/home/operator/x/z", "https://example.com/docs/", "src/system/File.ts"],
				"/home/operator/x/y and $HOME/x/z are covered, see https://example.com/docs, src/system/file.ts",
				"/home/operator",
			),
		).toEqual(["src/system/File.ts"]);
	});
});

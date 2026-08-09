import { describe, expect, it } from "vitest";
import { splitH2Sections } from "../src/shared/markdown-sections.js";

describe("splitH2Sections", () => {
	it("splits markdown sections by level-two headings", () => {
		expect(
			splitH2Sections(`# Root

## First

Alpha

## Second

Beta`),
		).toEqual([
			{ heading: "First", content: "Alpha" },
			{ heading: "Second", content: "Beta" },
		]);
		expect(splitH2Sections("")).toEqual([]);
	});
});

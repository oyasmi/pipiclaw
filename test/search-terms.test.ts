import { describe, expect, it } from "vitest";
import {
	buildMatchExpression,
	buildQueryTerms,
	countMatchedUnits,
	effectiveTermCount,
	enoughMatches,
	searchTextFor,
} from "../src/memory/search-terms.js";

describe("FTS query terms", () => {
	it("keeps Chinese fragments and the Latin quota independent", () => {
		// A shared cap loses identifiers after a long Chinese phrase.
		expect(buildQueryTerms("请问钉钉如何发布？猫")).toEqual({ latin: [], cjk: ["钉钉", "发布", "猫"] });
		const query =
			"甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥乾坤春夏秋冬东西南北 " +
			Array.from({ length: 20 }, (_, i) => `error-${i}`).join(" ");
		const terms = buildQueryTerms(query);
		expect(terms.cjk).toHaveLength(24);
		expect(terms.latin).toHaveLength(16);
		expect(terms.latin[0]).toBe("error-0");
	});

	it("binds operator and punctuation inputs as quoted terms in real FTS5", async () => {
		// Unquoted MATCH operators or leading punctuation could make the tool fail.
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		try {
			db.exec("CREATE VIRTUAL TABLE test_fts USING fts5(text)");
			db.prepare("INSERT INTO test_fts VALUES (?)").run("NOT NEAR err:code config.yaml prefixation");
			const find = db.prepare("SELECT count(*) AS n FROM test_fts WHERE test_fts MATCH ?");
			for (const query of [
				'"',
				"AND",
				"OR",
				"NOT",
				"NEAR",
				"*",
				":",
				"^",
				"(",
				"-",
				"c++",
				"😀",
				"--+-",
				'"err:code"*',
				"config.yaml",
				"prefix",
			]) {
				const expression = buildMatchExpression(buildQueryTerms(query));
				if (expression) expect(() => find.get(expression)).not.toThrow();
			}
			expect(find.get(buildMatchExpression(buildQueryTerms('"err:code"*')))).toMatchObject({ n: 1 });
			expect(find.get(buildMatchExpression(buildQueryTerms("prefix")))).toMatchObject({ n: 1 });
			expect(buildMatchExpression(buildQueryTerms('("*:^😀)'))).toBeNull();
		} finally {
			db.close();
		}
	});

	it("inserts reversible token boundaries so FTS can match an interior bigram", async () => {
		const { DatabaseSync } = await import("node:sqlite");
		const db = new DatabaseSync(":memory:");
		try {
			const original = "先用钉钉发布ASR版とカナ";
			const searchText = searchTextFor(original);
			expect(searchText?.replaceAll("\u200b", "")).toBe(original);
			expect(searchTextFor("ASCII")).toBeNull();
			db.exec("CREATE VIRTUAL TABLE test_fts USING fts5(text)");
			db.prepare("INSERT INTO test_fts VALUES (?)").run(searchText);
			expect(
				db
					.prepare("SELECT count(*) AS n FROM test_fts WHERE test_fts MATCH ?")
					.get(buildMatchExpression(buildQueryTerms("钉钉"))),
			).toMatchObject({ n: 1 });
		} finally {
			db.close();
		}
	});

	it("rejects single-unit noise in a long question but allows precise short queries", () => {
		for (const [query, accepted] of [
			["kubernetes ingress controller service health", false],
			["kubernetes", true],
		] as const) {
			const terms = buildQueryTerms(query);
			expect(enoughMatches(countMatchedUnits("kubernetes", terms), effectiveTermCount(terms))).toBe(accepted);
		}
	});
});

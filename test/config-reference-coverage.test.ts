import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SECURITY_CONFIG_TOP_LEVEL_KEYS } from "../src/security/types.js";
import { SETTINGS_TOP_LEVEL_KEYS } from "../src/settings.js";
import { TOOLS_CONFIG_SECTION_KEYS } from "../src/tools/config.js";

/**
 * Structural coverage, not text-pinning (AGENTS.md's "no change-detector" rule): this asserts
 * every current config key is *mentioned somewhere* in its reference doc, never what the doc
 * says about it. It only goes red when someone adds/renames a `settings.json`/`tools.json`/
 * `security.json` key and forgets the doc — the exact drift `docs/README.md`'s "责任边界"
 * promises `configuration-reference.md`/`security.md` will not have.
 *
 * The key lists themselves (`SETTINGS_TOP_LEVEL_KEYS` etc.) are kept in sync with their
 * interfaces by a `satisfies` + `AssertNoMissingKeys` pair at the definition site, checked by
 * `npm run typecheck` — so this test can trust them without re-deriving the interfaces itself.
 */

function readDoc(path: string): string {
	return readFileSync(path, "utf-8");
}

describe("config reference doc coverage", () => {
	it("mentions every settings.json top-level key in configuration-reference.md", () => {
		const doc = readDoc("docs/configuration-reference.md");
		const missing = SETTINGS_TOP_LEVEL_KEYS.filter((key) => !doc.includes(key));
		expect(missing, `undocumented settings.json key(s): ${missing.join(", ")}`).toEqual([]);
	});

	it("mentions every tools.json section key in configuration-reference.md", () => {
		const doc = readDoc("docs/configuration-reference.md");
		const missing = TOOLS_CONFIG_SECTION_KEYS.filter((key) => !doc.includes(`tools.${key}`) && !doc.includes(key));
		expect(missing, `undocumented tools.json section(s): ${missing.join(", ")}`).toEqual([]);
	});

	it("mentions every security.json top-level key in security.md", () => {
		const doc = readDoc("docs/security.md");
		const missing = SECURITY_CONFIG_TOP_LEVEL_KEYS.filter((key) => !doc.includes(key));
		expect(missing, `undocumented security.json key(s): ${missing.join(", ")}`).toEqual([]);
	});
});

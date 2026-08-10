import { describe, expect, it } from "vitest";
import { expandPlaceholders, formatDroppedPlaceholderWarnings } from "../src/subagents/external/harness.js";

/**
 * Spec 042, D10: a token that still references a placeholder after substitution (its value was
 * `undefined`) must not reach argv as a literal string — it is exactly the failure D4's "argv, not
 * a shell string" design exists to prevent, just arriving through a missing value instead of a
 * shell-quoting bug. Before this fix, `claude --model $MODEL` with no `model:` configured spawned
 * `claude --model '$MODEL'` verbatim.
 */
describe("expandPlaceholders (spec 042, D10)", () => {
	it("substitutes a placeholder when its value is provided", () => {
		const { argv, used, dropped } = expandPlaceholders(["--model", "$MODEL"], { $MODEL: "sonnet" });
		expect(argv).toEqual(["--model", "sonnet"]);
		expect(used.has("$MODEL")).toBe(true);
		expect(dropped).toHaveLength(0);
	});

	it("drops only the token containing an unresolved placeholder, leaving a sibling flag orphaned", () => {
		// The dropped token is "$MODEL" itself; "--model" is a separate argv token that contains no
		// placeholder, so it is not touched — it is left as a flag with no value. This orphan is a
		// known, accepted residue (not this function's job to fix); the discovery-time check in
		// discovery.ts is the complementary fix that catches it before a role is ever dispatched.
		const { argv, used, dropped } = expandPlaceholders(["--model", "$MODEL", "--verbose"], {});
		expect(argv).toEqual(["--model", "--verbose"]);
		expect(argv).not.toContain("$MODEL");
		expect(used.has("$MODEL")).toBe(false);
		expect(dropped).toEqual(["$MODEL"]);
	});

	it("drops a token combining a flag and an unresolved placeholder in one string", () => {
		const { argv, dropped } = expandPlaceholders(["-c", "model_reasoning_effort=$EFFORT"], {});
		expect(argv).toEqual(["-c"]);
		expect(dropped).toEqual(["model_reasoning_effort=$EFFORT"]);
	});

	it("only drops the token that actually references the missing placeholder", () => {
		const { argv, dropped } = expandPlaceholders(["--model", "$MODEL", "--effort", "$EFFORT"], {
			$EFFORT: "high",
		});
		expect(argv).toEqual(["--model", "--effort", "high"]);
		expect(dropped).toEqual(["$MODEL"]);
	});

	it("formatDroppedPlaceholderWarnings names the dropped token", () => {
		const warnings = formatDroppedPlaceholderWarnings(["$MODEL"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("$MODEL");
	});
});

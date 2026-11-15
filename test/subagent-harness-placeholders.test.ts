import { describe, expect, it } from "vitest";
import { claudeCodeHarness } from "../src/subagents/external/claude-code.js";
import { detectExistingFlags, expandPlaceholders } from "../src/subagents/external/harness.js";

/**
 * Spec 042, D10: a token that still references a placeholder after substitution (its value was
 * `undefined`) must not reach argv as a literal string — it is exactly the failure D4's "argv, not
 * a shell string" design exists to prevent, just arriving through a missing value instead of a
 * shell-quoting bug. Before this fix, `claude --model $MODEL` with no `model:` configured spawned
 * `claude --model '$MODEL'` verbatim.
 */
describe("expandPlaceholders (spec 042, D10)", () => {
	it("drops a token combining a flag and an unresolved placeholder in one string", () => {
		const { argv, dropped } = expandPlaceholders(["-c", "model_reasoning_effort=$EFFORT"], {});
		expect(argv).toEqual(["-c"]);
		expect(dropped).toEqual(["model_reasoning_effort=$EFFORT"]);

		// Codex `-c`/`--config` key=value detection is opt-in so non-Codex harnesses never suppress
		// `--model` / `--effort` injection when `-c` appears in a user command.
		const codexStyleArgs = ["-c", "model=gpt-5", "--config=model_reasoning_effort=high"];
		expect(detectExistingFlags(codexStyleArgs)).toEqual({ model: false, effort: false });
		expect(detectExistingFlags(codexStyleArgs, { codexConfigFlag: true })).toEqual({
			model: true,
			effort: true,
		});
		expect(
			detectExistingFlags(["-m", "foo", "--thinking", "high"], {
				shortModelFlag: false,
				thinkingAlias: false,
			}),
		).toEqual({ model: false, effort: false });
		expect(
			detectExistingFlags(["--model", "foo", "--effort=high"], {
				shortModelFlag: false,
				thinkingAlias: false,
			}),
		).toEqual({ model: true, effort: true });

		const claudePlan = claudeCodeHarness.buildInvocation({
			argv: ["claude", "-c", "model=ignored"],
			artifactDir: "/work/artifacts",
			promptFile: "/work/artifacts/prompt.txt",
			model: "claude-sonnet-4-6",
			thinkingLevel: "high",
		});
		expect(claudePlan.args).toContain("--model");
		expect(claudePlan.args).toContain("claude-sonnet-4-6");
		expect(claudePlan.args).toContain("--effort");
	});

	it("substitutes provided placeholders and drops only the token referencing a missing one", () => {
		// The dropped token is "$MODEL" itself; "--model" is a separate argv token that contains no
		// placeholder, so it is not touched — it is left as a flag with no value. This orphan is a
		// known, accepted residue (not this function's job to fix); the discovery-time check in
		// discovery.ts is the complementary fix that catches it before a role is ever dispatched.
		const { argv, used, dropped } = expandPlaceholders(["--model", "$MODEL", "--effort", "$EFFORT"], {
			$EFFORT: "high",
		});
		expect(argv).toEqual(["--model", "--effort", "high"]);
		expect(used.has("$EFFORT")).toBe(true);
		expect(used.has("$MODEL")).toBe(false);
		expect(dropped).toEqual(["$MODEL"]);
	});
});

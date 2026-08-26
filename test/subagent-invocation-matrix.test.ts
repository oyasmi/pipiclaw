import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
	ROLE_FIELD_MATRIX,
	resolveConfiguredRole,
	resolveInlineAgent,
	type SubAgentConfig,
} from "../src/subagents/discovery.js";

/**
 * Spec 042, D3: the field legality matrix is data, not scattered `if`s, so a field added later
 * cannot silently land as "supported" by omission — this test iterates the table itself rather
 * than re-asserting each field's message (that per-field behavior is covered end-to-end in
 * subagent-discovery-external.test.ts). Unaffected by spec 046's invocation-surface split: this
 * table governs role-*file* frontmatter, not the call-time overrides.
 */
describe("ROLE_FIELD_MATRIX (spec 042, D3)", () => {
	it("every listed field is rejected for exactly one runtime and supported for the other", () => {
		for (const support of Object.values(ROLE_FIELD_MATRIX)) {
			const runtimes = Object.keys(support).sort();
			expect(runtimes).toEqual(["external", "internal"]);
			const rejectedCount = (["external", "internal"] as const).filter(
				(runtime) => support[runtime] === "rejected",
			).length;
			// A field with no runtime distinction (rejected for both, or neither) does not belong in
			// this table — the matrix exists specifically to answer "which runtime is this for".
			expect(rejectedCount).toBe(1);
		}
	});
});

const model = getModel("openai", "gpt-4o-mini")!;

const externalRole: SubAgentConfig = {
	name: "reviewer",
	description: "d",
	systemPrompt: "Review things.",
	tools: [],
	maxTurns: 24,
	maxToolCalls: 48,
	maxWallTimeSec: 1800,
	bashTimeoutSec: 120,
	contextMode: "isolated",
	memory: "none",
	paths: [],
	source: "predefined",
	runtime: "external",
	harness: "codex-cli",
	command: "codex exec",
	mutates: "read",
};

/**
 * Spec 046, D2.1/D4: the three "external role + tools/model/mutates" rejections spec 042 D3 added
 * to the combined resolver (`discovery.ts:868-888` in the pre-split code) are gone because
 * `ConfiguredRoleOverrides` — the `subagent` tool's own invocation type — has no `tools`, `model`,
 * or `mutates` field to reject in the first place. There is no runtime test for "rejects tools on
 * an external role" any more because there is no code path that could accept one; the guarantee
 * moved from a unit test to the type checker.
 */
describe("resolveConfiguredRole (spec 046, D2.1)", () => {
	it("resolves an external role with no overrides cleanly", () => {
		const result = resolveConfiguredRole([], model, [externalRole], { agent: "reviewer" });
		expect(result.error).toBeUndefined();
		expect(result.config?.runtime).toBe("external");
	});

	it("resolves an internal role cleanly, falling back to the parent's current model", () => {
		const internalRole: SubAgentConfig = {
			...externalRole,
			runtime: "internal",
			harness: undefined,
			command: undefined,
			externalModelRef: undefined,
		};
		const result = resolveConfiguredRole([model], model, [internalRole], { agent: "reviewer" });
		expect(result.error).toBeUndefined();
		expect(result.config).toBeDefined();
	});

	it("reports unknown agent names with the available list", () => {
		const result = resolveConfiguredRole([model], model, [externalRole], { agent: "ghost" });
		expect(result.config).toBeUndefined();
		expect(result.error).toContain("Unknown sub-agent");
		expect(result.error).toContain("reviewer");
	});
});

/**
 * Fix plan §1.1/§1.4 (docs/reviews/2026-08-24-subagents-and-tools-fix-plan.md): the resolved
 * thinkingLevel/mutates matrix across runtime x purpose x explicit-vs-default, so a future change
 * cannot silently re-introduce "external work gets force-clamped to the lowest reasoning effort"
 * or "inline delegations can't declare mutates". Split per spec 046: a configured role only ever
 * gets an explicit thinkingLevel from its own role file (no invocation override exists), so the
 * "explicit override wins" half of this matrix now applies to `resolveInlineAgent` only.
 */
const externalWorkRole: SubAgentConfig = {
	...externalRole,
	name: "external-worker",
	description: "external work role",
	systemPrompt: "Do the work.",
};

describe("thinkingLevel resolution matrix", () => {
	it("configured roles default by runtime x purpose from the role file alone", () => {
		// External work: stays undefined — no effort flag added by the caller.
		const externalWork = resolveConfiguredRole([model], model, [externalWorkRole], { agent: "external-worker" });
		expect(externalWork.config?.thinkingLevel).toBeUndefined();

		// External verify: defaults to medium.
		const externalVerify = resolveConfiguredRole([model], model, [externalWorkRole], {
			agent: "external-worker",
			purpose: "verify",
		});
		expect(externalVerify.config?.thinkingLevel).toBe("medium");
	});

	it("inline delegations default to medium and let an explicit thinkingLevel win", () => {
		const inline = resolveInlineAgent([model], model, { systemPrompt: "Do it" });
		expect(inline.config?.thinkingLevel).toBe("medium");

		const explicit = resolveInlineAgent([model], model, { systemPrompt: "Do it", thinkingLevel: "high" });
		expect(explicit.config?.thinkingLevel).toBe("high");
	});
});

describe("mutates invocation parameter (spec 046, D2.1: inline-only)", () => {
	it("an inline delegation can declare mutates: write via the invocation", () => {
		const result = resolveInlineAgent([model], model, { systemPrompt: "Do it", tools: ["read"], mutates: "write" });
		expect(result.config?.mutates).toBe("write");
	});

	it("without an explicit mutates, inline still infers from tools (write/edit only)", () => {
		const result = resolveInlineAgent([model], model, { systemPrompt: "Do it", tools: ["read", "edit"] });
		expect(result.config?.mutates).toBe("write");
	});

	it("an inline delegation with bash and no explicit mutates gets a warning back for the model", () => {
		const result = resolveInlineAgent([model], model, { systemPrompt: "Do it", tools: ["read", "bash"] });
		expect(result.config?.mutates).toBe("read");
		expect(result.warning).toContain("mutates");
	});

	it("an inline delegation that declares mutates explicitly gets no warning", () => {
		const result = resolveInlineAgent([model], model, {
			systemPrompt: "Do it",
			tools: ["read", "bash"],
			mutates: "write",
		});
		expect(result.warning).toBeUndefined();
	});
});

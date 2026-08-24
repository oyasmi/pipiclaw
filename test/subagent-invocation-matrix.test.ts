import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { ROLE_FIELD_MATRIX, resolveSubAgentConfig, type SubAgentConfig } from "../src/subagents/discovery.js";

/**
 * Spec 042, D3: the field legality matrix is data, not scattered `if`s, so a field added later
 * cannot silently land as "supported" by omission — this test iterates the table itself rather
 * than re-asserting each field's message (that per-field behavior is covered end-to-end in
 * subagent-discovery-external.test.ts).
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

describe("resolveSubAgentConfig invocation-side matrix (spec 042, D3)", () => {
	it("rejects tools and model overrides on an external role instead of silently ignoring them", () => {
		const tools = resolveSubAgentConfig([model], model, [externalRole], {
			agent: "reviewer",
			tools: ["read", "bash"],
		});
		expect(tools.config).toBeUndefined();
		expect(tools.error).toContain("tools");
		expect(tools.error).toContain("external");

		// Empty availableModels: if this ever fell through to resolution, "totally-bogus-model"
		// would fail with "not found among available models" — asserting the error does NOT say
		// that distinguishes "rejected because external" from "rejected because resolution failed".
		const mdl = resolveSubAgentConfig([], model, [externalRole], {
			agent: "reviewer",
			model: "totally-bogus-model",
		});
		expect(mdl.config).toBeUndefined();
		expect(mdl.error).toContain("model");
		expect(mdl.error).not.toContain("not found among available models");
	});

	it("resolves an internal role's model override normally, and an external role with no overrides cleanly", () => {
		const internalRole: SubAgentConfig = {
			...externalRole,
			runtime: "internal",
			harness: undefined,
			command: undefined,
			externalModelRef: undefined,
		};
		const result = resolveSubAgentConfig([model], model, [internalRole], {
			agent: "reviewer",
			model: "openai/gpt-4o-mini",
		});
		expect(result.error).toBeUndefined();
		expect(result.config).toBeDefined();

		const untouched = resolveSubAgentConfig([], model, [externalRole], { agent: "reviewer" });
		expect(untouched.error).toBeUndefined();
		expect(untouched.config?.runtime).toBe("external");
	});
});

/**
 * Fix plan §1.1/§1.4 (docs/reviews/2026-08-24-subagents-and-tools-fix-plan.md): the resolved
 * thinkingLevel/mutates matrix across runtime x purpose x explicit-vs-default, so a future change
 * to `resolveSubAgentConfig` cannot silently re-introduce "external work gets force-clamped to the
 * lowest reasoning effort" or "inline delegations can't declare mutates".
 */
const externalWorkRole: SubAgentConfig = {
	...externalRole,
	name: "external-worker",
	description: "external work role",
	systemPrompt: "Do the work.",
};

describe("thinkingLevel resolution matrix", () => {
	it("defaults by runtime x purpose (unspecified) and lets an explicit thinkingLevel win everywhere", () => {
		const internal = resolveSubAgentConfig([model], model, [], { name: "inline", systemPrompt: "Do it" });
		expect(internal.config?.thinkingLevel).toBe("medium");

		// External work: stays undefined — no effort flag added by the caller.
		const externalWork = resolveSubAgentConfig([model], model, [externalWorkRole], { agent: "external-worker" });
		expect(externalWork.config?.thinkingLevel).toBeUndefined();

		// External verify: defaults to medium.
		const externalVerify = resolveSubAgentConfig([model], model, [externalWorkRole], {
			agent: "external-worker",
			purpose: "verify",
		});
		expect(externalVerify.config?.thinkingLevel).toBe("medium");

		for (const [resolved, expected] of [
			[resolveSubAgentConfig([model], model, [], { name: "inline", systemPrompt: "Do it", thinkingLevel: "high" }), "high"],
			[resolveSubAgentConfig([model], model, [externalWorkRole], { agent: "external-worker", thinkingLevel: "low" }), "low"],
			[
				resolveSubAgentConfig([model], model, [externalWorkRole], {
					agent: "external-worker",
					purpose: "verify",
					thinkingLevel: "xhigh",
				}),
				"xhigh",
			],
		] as const) {
			expect(resolved.config?.thinkingLevel).toBe(expected);
		}
	});
});

describe("mutates invocation parameter", () => {
	it("an inline delegation can declare mutates: write via the invocation", () => {
		const result = resolveSubAgentConfig([model], model, [], {
			name: "inline",
			systemPrompt: "Do it",
			tools: ["read"],
			mutates: "write",
		});
		expect(result.config?.mutates).toBe("write");
	});

	it("without an explicit mutates, inline still infers from tools (write/edit only)", () => {
		const result = resolveSubAgentConfig([model], model, [], {
			name: "inline",
			systemPrompt: "Do it",
			tools: ["read", "edit"],
		});
		expect(result.config?.mutates).toBe("write");
	});

	it("an external role rejects a caller-supplied mutates -- it comes from the role file", () => {
		const result = resolveSubAgentConfig([model], model, [externalWorkRole], {
			agent: "external-worker",
			mutates: "write",
		});
		expect(result.config).toBeUndefined();
		expect(result.error).toContain("mutates");
	});

	it("an inline delegation with bash and no explicit mutates gets a warning back for the model", () => {
		const result = resolveSubAgentConfig([model], model, [], {
			name: "inline",
			systemPrompt: "Do it",
			tools: ["read", "bash"],
		});
		expect(result.config?.mutates).toBe("read");
		expect(result.warning).toContain("mutates");
	});

	it("an inline delegation that declares mutates explicitly gets no warning", () => {
		const result = resolveSubAgentConfig([model], model, [], {
			name: "inline",
			systemPrompt: "Do it",
			tools: ["read", "bash"],
			mutates: "write",
		});
		expect(result.warning).toBeUndefined();
	});
});

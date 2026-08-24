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
	it("rejects a tools override on an external role instead of silently ignoring it", () => {
		const result = resolveSubAgentConfig([model], model, [externalRole], {
			agent: "reviewer",
			tools: ["read", "bash"],
		});
		expect(result.config).toBeUndefined();
		expect(result.error).toContain("tools");
		expect(result.error).toContain("external");
	});

	it("rejects a model override on an external role without resolving it against models.json", () => {
		// Empty availableModels: if this ever fell through to resolution, "totally-bogus-model"
		// would fail with "not found among available models" — asserting the error does NOT say
		// that distinguishes "rejected because external" from "rejected because resolution failed".
		const result = resolveSubAgentConfig([], model, [externalRole], {
			agent: "reviewer",
			model: "totally-bogus-model",
		});
		expect(result.config).toBeUndefined();
		expect(result.error).toContain("model");
		expect(result.error).not.toContain("not found among available models");
	});

	it("still resolves an internal role's model override normally", () => {
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
	});

	it("an unset tools/model override on an external role resolves without error", () => {
		const result = resolveSubAgentConfig([], model, [externalRole], { agent: "reviewer" });
		expect(result.error).toBeUndefined();
		expect(result.config?.runtime).toBe("external");
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
	it("internal, unspecified: defaults to medium", () => {
		const result = resolveSubAgentConfig([model], model, [], { name: "inline", systemPrompt: "Do it" });
		expect(result.config?.thinkingLevel).toBe("medium");
	});

	it("external work, unspecified: stays undefined -- no effort flag added by the caller", () => {
		const result = resolveSubAgentConfig([model], model, [externalWorkRole], { agent: "external-worker" });
		expect(result.config?.thinkingLevel).toBeUndefined();
	});

	it("external verify, unspecified: defaults to medium", () => {
		const result = resolveSubAgentConfig([model], model, [externalWorkRole], {
			agent: "external-worker",
			purpose: "verify",
		});
		expect(result.config?.thinkingLevel).toBe("medium");
	});

	it("explicit thinkingLevel wins for all three cases above", () => {
		const internal = resolveSubAgentConfig([model], model, [], {
			name: "inline",
			systemPrompt: "Do it",
			thinkingLevel: "high",
		});
		expect(internal.config?.thinkingLevel).toBe("high");

		const externalWork = resolveSubAgentConfig([model], model, [externalWorkRole], {
			agent: "external-worker",
			thinkingLevel: "low",
		});
		expect(externalWork.config?.thinkingLevel).toBe("low");

		const externalVerify = resolveSubAgentConfig([model], model, [externalWorkRole], {
			agent: "external-worker",
			purpose: "verify",
			thinkingLevel: "xhigh",
		});
		expect(externalVerify.config?.thinkingLevel).toBe("xhigh");
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

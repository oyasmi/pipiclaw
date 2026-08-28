import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
	discoverSubAgents,
	getSubAgentsDir,
	resolveConfiguredRole,
	resolveInlineAgent,
	type SubAgentConfig,
} from "../src/subagents/discovery.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Spec 042, D3: role-file fields that only make sense for the other runtime are rejected rather
 * than silently ignored. Test this through public discovery behavior; the representation of the
 * legality table is an implementation detail.
 */

const createTempWorkspace = useTempDirs("pipiclaw-subagent-invocation-matrix-");

describe("role-file field legality (spec 042, D3)", () => {
	it("rejects fields that only apply to the other runtime", () => {
		const workspaceDir = createTempWorkspace();
		const subAgentsDir = getSubAgentsDir(workspaceDir);
		mkdirSync(subAgentsDir, { recursive: true });
		writeFileSync(
			join(subAgentsDir, "internal-with-external-fields.md"),
			`---
name: internal-with-external-fields
description: internal role with external-only fields
harness: exec
command: echo hi
shell: true
env:
  FOO: bar
---

Body.
`,
			"utf-8",
		);
		writeFileSync(
			join(subAgentsDir, "external-with-internal-fields.md"),
			`---
name: external-with-internal-fields
description: external role with internal-only fields
runtime: external
harness: exec
command: echo hi
mutates: read
tools: read
maxTurns: 1
maxToolCalls: 1
bashTimeoutSec: 1
---

Body.
`,
			"utf-8",
		);

		const result = discoverSubAgents(workspaceDir, [model]);
		expect(result.agents).toHaveLength(0);
		const internalWarning = result.warnings.find((warning) => warning.startsWith("internal-with-external-fields.md"));
		const externalWarning = result.warnings.find((warning) => warning.startsWith("external-with-internal-fields.md"));
		for (const field of ["harness", "command", "shell", "env"]) {
			expect(internalWarning).toContain(field);
		}
		for (const field of ["tools", "maxTurns", "maxToolCalls", "bashTimeoutSec"]) {
			expect(externalWarning).toContain(field);
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

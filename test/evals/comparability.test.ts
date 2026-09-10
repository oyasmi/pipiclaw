import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { caseHash } from "../../evals/harness/cases.js";
import { type ComparisonEvidence, comparisonBlockers, renderDiff } from "../../evals/harness/diff.js";
import { canonicalConfigHash } from "../../evals/harness/fingerprint.js";
import { fileContains, recallQuiz } from "../../evals/harness/graders.js";
import { freezeLocalProfile, publicModelConfig, resolveProfileModels } from "../../evals/harness/profile.js";
import { gitDirtyFingerprint } from "../../evals/harness/run.js";
import type { CaseDescriptor, CaseSummary, EvalCase, RunManifest, RunPlan } from "../../evals/harness/schema.js";
import { defaultModel } from "../../src/models/utils.js";
import { createDeterministicHome } from "../support/setup.js";

const roots: string[] = [];
const temp = () => {
	const root = mkdtempSync(join(tmpdir(), "eval-compare-"));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const summary: CaseSummary = {
	caseId: "C-probe-01",
	suite: "regression",
	gate: "required",
	passed: 0,
	valid: 3,
	invalid: 0,
	budgetExceeded: 0,
	planned: 3,
	started: 3,
	invariantViolations: 0,
	invariantUnknown: 0,
	medianCostUsd: 1,
	medianWallMs: 100,
	medianToolCalls: 1,
};
const descriptor: CaseDescriptor = {
	schemaVersion: 2,
	id: summary.caseId,
	suite: summary.suite,
	source: "test",
	description: "test",
	caseHash: "same",
	graders: [],
	stepKinds: [],
};
const manifest: RunManifest = {
	schemaVersion: 2,
	runId: "a",
	startedAt: "2026-09-10",
	gitSha: "sha",
	gitDirtyDiffHash: "clean",
	packageVersion: "test",
	lockfileHash: "lock",
	harnessSchemaVersions: { TrialRecord: 4 },
	configuredModel: "provider/main",
	thinkingLevel: "off",
	providerEndpoint: "https://fixture.invalid",
	settingsHash: "settings",
	toolsConfigHash: "tools",
	securityConfigHash: "security",
	costBasis: "provider",
	trialConfigHashes: { "C-probe-01:1": ["settings", "tools", "security"] },
	environment: { node: "v22", platform: "linux", arch: "x64", concurrency: 1 },
	profile: {
		source: "local",
		agent: { requested: "provider/main", resolved: "provider/main", endpoint: "https://fixture.invalid" },
		judge: {
			requested: "provider/judge",
			resolved: "provider/judge",
			endpoint: "https://fixture.invalid",
			thinking: "off",
		},
		thinking: "off",
		modelsHash: "models",
		fallback: null,
	},
};
const plan: RunPlan = {
	schemaVersion: 1,
	runId: "a",
	scoring: {
		schemaVersion: 1,
		gates: { "C-probe-01": { gate: "required", minPass: "2/3" } },
		plannedTrials: { "C-probe-01": 3 },
		maxInvalidShare: 0.1,
	},
	cases: [descriptor],
	profile: manifest.profile!,
	gitSha: "sha",
	gitDirtyDiffHash: "clean",
	lockfileHash: "lock",
	environment: manifest.environment!,
	fixtureSeeds: { "C-probe-01:1": "seed" },
	budgets: { "C-probe-01": { maxCostUsd: 0.5, maxWallMs: 180000, maxTurns: 12, maxSteps: 24 } },
};
const evidence: ComparisonEvidence = {
	leftCases: [descriptor],
	rightCases: [descriptor],
	leftPlan: plan,
	rightPlan: plan,
};

// F5/F6: these controls must change comparability without spending any model tokens.
describe("eval fingerprints and controlled comparisons", () => {
	// Mutation checked 2026-09-10: omitting explicit grader parameters from caseHash makes this fail.
	it("hashes regex flags, captured factory parameters, thresholds, and imported evaluator helpers", () => {
		const root = temp();
		mkdirSync(join(root, "evals/cases"), { recursive: true });
		writeFileSync(join(root, "evals/cases/probe.ts"), 'import { value } from "./helper.js";');
		writeFileSync(join(root, "evals/cases/helper.ts"), 'export const value = "A";');
		const item: EvalCase = {
			id: "C-probe-01",
			suite: "regression",
			source: "test",
			description: "test",
			definitionFile: "evals/cases/probe.ts",
			script: [{ kind: "user", text: "test" }],
			graders: [fileContains("file", "a.txt", /AAA/)],
		};
		const first = caseHash(item, root);
		for (const grader of [
			fileContains("file", "a.txt", /BBB/),
			fileContains("file", "a.txt", /AAA/i),
			fileContains("file", "b.txt", /AAA/),
		])
			expect(caseHash({ ...item, graders: [grader] }, root)).not.toBe(first);
		const quiz = (minRecall: number) => ({
			...item,
			graders: [recallQuiz("quiz", [{ expected: /A/, distractor: /B/ }], { minRecall })],
		});
		expect(caseHash(quiz(0.5), root)).not.toBe(caseHash(quiz(0.9), root));
		writeFileSync(join(root, "evals/cases/helper.ts"), 'export const value = "B";');
		expect(caseHash(item, root)).not.toBe(first);
	});

	it("does not mistake staged changes for a clean worktree", () => {
		const root = temp();
		const git = (args: string[]) => {
			const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
			expect(result.status).toBe(0);
		};
		git(["init"]);
		writeFileSync(join(root, "tracked"), "before");
		git(["add", "."]);
		git(["-c", "user.name=Eval", "-c", "user.email=eval@example.invalid", "commit", "-m", "fixture"]);
		const clean = gitDirtyFingerprint(root);
		writeFileSync(join(root, "tracked"), "after");
		const modified = gitDirtyFingerprint(root);
		git(["add", "tracked"]);
		expect(gitDirtyFingerprint(root)).toBe(modified);
		expect(gitDirtyFingerprint(root)).not.toBe(clean);
	});

	it("normalizes trial mounts without dropping real security policy differences", () => {
		const policy = (root: string, action: string) => ({ pathGuard: { writeDeny: [`${root}/canary`] }, action });
		const a = canonicalConfigHash(policy("/tmp/a", "deny"), { "/tmp/a": "<TRIAL_ROOT>" });
		expect(canonicalConfigHash(policy("/tmp/b", "deny"), { "/tmp/b": "<TRIAL_ROOT>" })).toBe(a);
		expect(canonicalConfigHash(policy("/tmp/b", "allow"), { "/tmp/b": "<TRIAL_ROOT>" })).not.toBe(a);
	});

	it("permits only the declared experimental variable", () => {
		expect(comparisonBlockers(manifest, manifest, evidence)).toEqual([]);
		expect(comparisonBlockers(manifest, { ...manifest, gitSha: "new" }, evidence)).toContain("git");
		expect(
			comparisonBlockers(
				manifest,
				{ ...manifest, gitSha: "new" },
				{ ...evidence, experiment: "runtime", rightPlan: { ...plan, gitSha: "new" } },
			),
		).toEqual([]);
		expect(
			comparisonBlockers(
				manifest,
				{ ...manifest, configuredModel: "provider/new" },
				{ ...evidence, experiment: "runtime" },
			),
		).toContain("model");
		expect(
			comparisonBlockers(
				manifest,
				{
					...manifest,
					configuredModel: "provider/new",
					profile: { ...manifest.profile!, agent: { ...manifest.profile!.agent, resolved: "provider/new" } },
				},
				{
					...evidence,
					experiment: "model",
					rightPlan: {
						...plan,
						profile: { ...plan.profile, agent: { ...plan.profile.agent, resolved: "provider/new" } },
					},
				},
			),
		).toEqual([]);
		expect(
			comparisonBlockers(manifest, { ...manifest, observedModels: ["unrecorded-fallback"] }, evidence),
		).toContain("observed model drift");
	});

	it("refuses quality deltas for a changed oracle, missing samples, or historical evidence", () => {
		const changed = { ...summary, passed: 3 };
		expect(renderDiff("a", "b", manifest, manifest, [summary], [changed], evidence)).toContain("+100pp");
		const incomparable = [
			renderDiff("a", "b", manifest, manifest, [summary], [changed], {
				...evidence,
				rightCases: [{ ...descriptor, caseHash: "other" }],
			}),
			renderDiff("a", "b", manifest, manifest, [], [changed], evidence),
			renderDiff("a", "b", manifest, manifest, [summary], [{ ...changed, valid: 0 }], evidence),
			renderDiff("a", "b", manifest, manifest, [summary], [changed]),
			renderDiff("a", "b", manifest, { ...manifest, lockfileHash: "other" }, [summary], [changed], evidence),
		];
		for (const report of incomparable) {
			expect(report).not.toContain("+100pp");
			expect(report).toContain("N/A");
		}
		const repriced = renderDiff(
			"a",
			"b",
			manifest,
			{ ...manifest, costBasis: "fallback" },
			[summary],
			[changed],
			evidence,
		);
		expect(repriced).toContain("+100pp");
		expect(repriced).toContain("N/A (cost basis)");
	});
});

describe("frozen eval profiles", () => {
	it("resolves the configured agent and judge separately, without fuzzy fallback", () => {
		const main = { ...defaultModel, id: "main", provider: "test" };
		const judge = { ...defaultModel, id: "judge", provider: "test" };
		const resolved = resolveProfileModels({ defaultProvider: "test", defaultModel: "main" }, [main, judge], {
			EVAL_JUDGE_MODEL: "test/judge",
		});
		expect(resolved.profile.agent.resolved).toBe("test/main");
		expect(resolved.profile.judge.resolved).toBe("test/judge");
		expect(() => resolveProfileModels({}, [main, judge], { PIPICLAW_E2E_MODEL: "mai" })).toThrow(
			/missing or ambiguous/,
		);
		expect(() =>
			resolveProfileModels({}, [main], {
				PIPICLAW_E2E_MODEL: "test/main",
				PIPICLAW_E2E_ENDPOINT: "https://other.invalid",
			}),
		).toThrow(/endpoint/);
	});

	it("writes effective thinking and model settings into the worker template without a model call", async () => {
		const homeDir = temp();
		createDeterministicHome({ homeDir, mockBaseUrl: "http://127.0.0.1:1" });
		const profile = await freezeLocalProfile(homeDir, {});
		const settings = JSON.parse(readFileSync(join(homeDir, "settings.json"), "utf8"));
		expect(settings).toMatchObject({
			defaultProvider: "e2e-mock",
			defaultModel: "mock-main",
			defaultThinkingLevel: "off",
			fallbackModel: null,
		});
		expect(profile.agent.resolved).toBe("e2e-mock/mock-main");
		expect(profile.judge.resolved).toBe(profile.agent.resolved);
		expect(
			JSON.stringify(
				publicModelConfig({ apiKey: "private", headers: { Authorization: "Bearer private" }, maxTokens: 123 }),
			),
		).not.toContain("private");
		expect(publicModelConfig({ maxTokens: 123 })).toEqual({ maxTokens: 123 });
	});
});

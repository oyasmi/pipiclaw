import type { UsageTokens } from "../../src/usage/ledger.js";
import type { FrozenProfile } from "./profile.js";
import type { ResourceUsage } from "./resources.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type Suite = "regression" | "safety" | "capability";
export type Gate = "required" | "report-only" | "quarantine";
export type Outcome = "pass" | "fail" | "invariant-violation" | "budget-exceeded" | "invalid";
export type Severity = "quality" | "hard-invariant";

export interface RunManifest {
	schemaVersion: 1 | 2;
	profile?: FrozenProfile;
	environment?: { node: string; platform: string; arch: string; concurrency: number; judgeConcurrency?: number };
	runId: string;
	startedAt: string;
	label?: string;
	gitSha: string;
	gitDirtyDiffHash?: string;
	packageVersion: string;
	lockfileHash: string;
	harnessSchemaVersions: Record<string, number>;
	configuredModel: string;
	observedModels?: string[];
	thinkingLevel?: string;
	providerEndpoint?: string;
	trialConfigHashes?: Record<string, [string, string, string]>;
	settingsHash: string;
	toolsConfigHash: string;
	securityConfigHash: string;
	judgeModel?: string;
	/**
	 * How the run's money figures were produced: `provider` when the gateway reported amounts,
	 * `fallback` when they were priced from token counts with the harness rate card, `mixed`
	 * when both occurred. Two runs on different bases are not comparable on cost.
	 */
	costBasis?: "provider" | "fallback" | "mixed";
}

export interface CaseDescriptor {
	schemaVersion: 1 | 2;
	dependencyHashes?: Record<string, string>;
	id: string;
	suite: Suite;
	source: string;
	description: string;
	caseHash: string;
	stepKinds: string[];
	graders: Array<{ graderId: string; graderVersion: string; rubricHash?: string; parameters?: JsonValue }>;
}

export interface TraceEvent {
	schemaVersion: 1;
	seq: number;
	ts: string;
	segment: number;
	stepIndex?: number;
	correlationId?: string;
	kind: "turn-start" | "turn-end" | "tool-call" | "tool-result" | "step" | "usage" | "runtime-log" | "model-result";
	tool?: string;
	fields?: Record<string, string>;
	argsHash?: string;
	ok?: boolean;
}

export interface CapturedDelivery {
	method:
		| "ensureCard"
		| "appendToCard"
		| "replaceCard"
		| "streamToCard"
		| "finalizeExistingCard"
		| "finalizeCard"
		| "discardCard"
		| "sendMedia"
		| "sendPlain";
	channelId: string;
	text?: string;
	media?: {
		fileName: string;
		kind: "image" | "file";
		bytes: number;
		hash: string;
	};
	ts: number;
}

export interface OutcomeSnapshot {
	schemaVersion: 1;
	deliveries: CapturedDelivery[];
	fileTree: Array<{ path: string; hash: string }>;
	canaries: Array<{ path: string; intact: boolean }>;
	externalRequests: Array<{ ts: string; method: string; url: string; bodyHash: string }>;
}

export interface GradeResult {
	schemaVersion: 1;
	graderId: string;
	graderVersion: string;
	/** Whether the verdict came from a code assertion or a model judge; drives calibration sampling. */
	graderKind?: "code" | "model";
	modelIdentity?: { requested: string; resolved: string; reported: string };
	resources?: ResourceUsage;
	status: "pass" | "fail" | "error" | "skipped";
	severity: Severity;
	score?: number;
	evidence: Array<{ kind: "trace" | "file" | "delivery" | "snapshot"; ref: string }>;
	rationale: string;
}

export interface TrialResult {
	execution: "completed" | "agent-limit" | "provider-error" | "harness-error" | "fixture-error" | "cancelled";
	acceptance: "pass" | "fail" | "unknown";
	invariants: "intact" | "violated" | "unknown";
	grading: "complete" | "partial" | "error";
	/** Live grading evidence completeness; archive/regrade completeness is tracked separately in stage 3. */
	evidenceComplete: boolean;
	stopReason?: { source: string; code: string; evidenceId: string };
}

/** Frozen scoring policy; the full experiment/profile plan follows in renovation stage 2. */
export interface ScoringPlan {
	schemaVersion: 1;
	gates: Record<string, GateRule>;
	plannedTrials: Record<string, number>;
	maxInvalidShare: number;
}

export interface RunPlan {
	schemaVersion: 1;
	runId: string;
	scoring: ScoringPlan;
	cases: CaseDescriptor[];
	profile: FrozenProfile;
	gitSha: string;
	gitDirtyDiffHash: string;
	lockfileHash: string;
	environment: NonNullable<RunManifest["environment"]>;
	fixtureSeeds: Record<string, string>;
	budgets: Record<string, Required<NonNullable<EvalCase["budget"]>>>;
}

export interface TrialRecord {
	/** v4 adds orthogonal result fields; v3 remains readable as historical evidence. */
	schemaVersion: 3 | 4 | 5;
	result?: TrialResult;
	configHashes?: [string, string, string];
	archiveComplete?: boolean;
	resources?: ResourceUsage;
	runId: string;
	caseId: string;
	caseHash: string;
	trial: number;
	observedModel: string;
	promptFingerprint?: string;
	outcome: Outcome;
	grades: GradeResult[];
	metrics: {
		costUsd: number;
		/** Whether `costUsd` came from the provider or the harness rate card. */
		costBasis: "provider" | "fallback" | "mixed";
		tokens: UsageTokens;
		wallMs: number;
		agentWallMs?: number;
		gradeWallMs?: number;
		queueWallMs?: number;
		turns: number;
		toolCalls: number;
		segments: number;
		duplicateExternalEffects: number;
		userEscalations: number;
	};
	startedAt: string;
}

export interface TrialContext {
	homeDir: string;
	workspaceDir: string;
	channelDir: string;
	deliveries: CapturedDelivery[];
	trace: TraceEvent[];
	snapshot: OutcomeSnapshot;
}

export type Step =
	| { kind: "user"; text: string }
	| { kind: "syntheticTaskTurn"; taskId: string }
	| { kind: "runTaskDriver"; at?: string }
	/** Drives one real `MemoryMaintenanceScheduler.runOnce(at)` pass: the reflect job (spec 050). */
	| { kind: "runMemoryMaintenance"; at?: string }
	| { kind: "restart" }
	| { kind: "crash"; mode: "atStepBoundary" | "midTurn"; delayMs?: number }
	| { kind: "waitFor"; predicate: (ctx: TrialContext) => boolean; timeoutMs: number };

export interface CodeGrader {
	parameters?: JsonValue;
	kind?: "code";
	graderId: string;
	graderVersion: string;
	severity?: Severity;
	grade: (ctx: TrialContext) => Promise<GradeResult> | GradeResult;
}

export interface ModelGrader {
	parameters?: JsonValue;
	kind: "model";
	graderId: string;
	graderVersion: string;
	severity?: Severity;
	rubric: string;
	artifacts: (ctx: TrialContext) => string;
}

export type Grader = CodeGrader | ModelGrader;

export interface TrialSetup {
	homeDir: string;
	workspaceDir: string;
	channelDir: string;
	canaryPath: string;
	externalBaseUrl: string;
}

export interface ArtifactSpec {
	root: "workspace" | "channel";
	path: string;
	optional?: boolean;
	maxBytes?: number;
}

export interface EvalCase {
	artifacts?: ArtifactSpec[];
	id: string;
	suite: Suite;
	source: string;
	description: string;
	/** Repository-relative source module used in the reproducibility hash. */
	definitionFile: string;
	/** Additional evaluator/fixture dependencies outside the case module. */
	dependencies?: string[];
	trials?: number;
	budget?: { maxCostUsd?: number; maxWallMs?: number; maxTurns?: number; maxSteps?: number };
	fixtures?: string[];
	setup?: (ctx: TrialSetup) => Promise<void>;
	script: Step[];
	graders: Grader[];
	invariants?: CodeGrader[];
}

export interface HumanReviewRecord {
	schemaVersion: 1;
	caseId: string;
	trial: number;
	verdict: "agree" | "overturn-to-pass" | "overturn-to-fail";
	graderId: string;
	note: string;
	reviewer: string;
	ts: string;
}

export interface GateRule {
	gate: Gate;
	minPass?: string;
	minSamples?: number;
}

export interface CaseSummary {
	caseId: string;
	suite: Suite;
	gate: Gate;
	passed: number;
	valid: number;
	invalid: number;
	/** Agent-limit trials remain in valid; this is an overlapping diagnostic count. */
	budgetExceeded: number;
	planned?: number;
	started?: number;
	unknown?: number;
	invariantViolations?: number;
	invariantUnknown?: number;
	medianCostUsd: number;
	unknownCostSamples?: number;
	medianWallMs: number;
	medianToolCalls: number;
}

export type WorkerMessage =
	| { protocol: 1; type: "trace"; event: TraceEvent }
	| { protocol: 1; type: "delivery"; delivery: CapturedDelivery }
	| { protocol: 1; type: "ready"; reason: "crash-boundary" | "mid-turn-started" }
	| { protocol: 1; type: "complete"; observedModel: string; promptFingerprint?: string };

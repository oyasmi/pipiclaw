import type { UsageTokens } from "../../src/usage/ledger.js";

export type Suite = "regression" | "safety" | "capability";
export type Gate = "required" | "report-only" | "quarantine";
export type Outcome = "pass" | "fail" | "invariant-violation" | "budget-exceeded" | "invalid";
export type Severity = "quality" | "hard-invariant";

export interface RunManifest {
	schemaVersion: 1;
	runId: string;
	startedAt: string;
	label?: string;
	gitSha: string;
	gitDirtyDiffHash?: string;
	packageVersion: string;
	lockfileHash: string;
	harnessSchemaVersions: Record<string, number>;
	configuredModel: string;
	thinkingLevel?: string;
	providerEndpoint?: string;
	settingsHash: string;
	toolsConfigHash: string;
	securityConfigHash: string;
	judgeModel?: string;
}

export interface CaseDescriptor {
	schemaVersion: 1;
	id: string;
	suite: Suite;
	source: string;
	description: string;
	caseHash: string;
	stepKinds: string[];
	graders: Array<{ graderId: string; graderVersion: string; rubricHash?: string }>;
}

export interface TraceEvent {
	schemaVersion: 1;
	seq: number;
	ts: string;
	segment: number;
	correlationId?: string;
	kind: "turn-start" | "turn-end" | "tool-call" | "tool-result" | "step" | "usage" | "runtime-log";
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
		| "sendPlain";
	channelId: string;
	text?: string;
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
	status: "pass" | "fail" | "error" | "skipped";
	severity: Severity;
	score?: number;
	evidence: Array<{ kind: "trace" | "file" | "delivery" | "snapshot"; ref: string }>;
	rationale: string;
}

export interface TrialRecord {
	schemaVersion: 2;
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
		tokens: UsageTokens;
		wallMs: number;
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
	| { kind: "restart" }
	| { kind: "crash"; mode: "atStepBoundary" | "midTurn"; delayMs?: number }
	| { kind: "waitFor"; predicate: (ctx: TrialContext) => boolean; timeoutMs: number };

export interface CodeGrader {
	kind?: "code";
	graderId: string;
	graderVersion: string;
	severity?: Severity;
	grade: (ctx: TrialContext) => Promise<GradeResult> | GradeResult;
}

export interface ModelGrader {
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

export interface EvalCase {
	id: string;
	suite: Suite;
	source: string;
	description: string;
	/** Repository-relative source module used in the reproducibility hash. */
	definitionFile: string;
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
}

export interface CaseSummary {
	caseId: string;
	suite: Suite;
	gate: Gate;
	passed: number;
	valid: number;
	invalid: number;
	medianCostUsd: number;
	medianWallMs: number;
	medianToolCalls: number;
}

export type WorkerMessage =
	| { protocol: 1; type: "trace"; event: TraceEvent }
	| { protocol: 1; type: "delivery"; delivery: CapturedDelivery }
	| { protocol: 1; type: "ready"; reason: "crash-boundary" | "mid-turn-started" }
	| { protocol: 1; type: "complete"; observedModel: string; promptFingerprint?: string };

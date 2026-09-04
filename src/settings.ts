/**
 * Settings management for pipiclaw.
 *
 * `log.jsonl` and `context.jsonl` are treated as raw cold storage.
 * They are not proactively scanned or loaded as part of the memory model.
 *
 * This module currently provides only PipiclawSettingsManager.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import * as log from "./log.js";
import { getMemoryMaintenanceTuning, type MemoryMaintenanceTuning } from "./memory/maintenance-tuning.js";
import type { ResponseMode } from "./runtime/dingtalk.js";
import { writeFileAtomicallySync } from "./shared/atomic-file.js";
import type { ConfigDiagnostic } from "./shared/config-diagnostic.js";
import { fileStamp } from "./shared/file-stamp.js";

type SettingsError = {
	scope: "global" | "project";
	error: Error;
};

// ============================================================================
// PipiclawSettingsManager - Simple settings for pipiclaw
// ============================================================================
//
// Two layers, deliberately different shapes (spec 035 D2):
//
// - The `Pipiclaw*Settings` interfaces below are the *runtime* contract. They
//   carry every value the consuming module needs and are passed around whole
//   (`maintenance-gates.ts`, `scheduler.ts`, `recall.ts`, `session-search.ts`
//   all destructure them), so they are the channel through which the constants
//   reach their consumers.
// - `PipiclawSettings` is the *user input* contract — what may appear in
//   `settings.json`. It is much narrower: booleans and enums only. Numeric
//   thresholds are algorithm parameters and live in code.
//
// The two therefore do not mirror each other, and that is the point.

export interface PipiclawCompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface PipiclawRetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

// Whether the autonomous task mechanism runs at all is governed by the single
// `tools.tasks.enabled` switch in tools.json (task_* tools + TaskDriver +
// task digest together). Cadence and size are fixed constants — settings.json has no field for
// either, so these two are plain exported constants (`TASK_DIGEST_SETTINGS`/`TASK_DRIVER_SETTINGS`
// below), not `PipiclawSettingsManager` getters like every settings.json-backed shape here.
export interface PipiclawTaskDigestSettings {
	maxTasks: number;
	maxChars: number;
}

export interface PipiclawTaskDriverSettings {
	/** Earliest continuation after a task changed during its previous run. */
	continuationDelayMinutes: number;
	/** Retry delay when a dispatched task made no observable ledger progress. */
	stalledRetryMinutes: number;
	/** Global enqueue cap per scan, with round-robin fairness across channels. */
	maxDispatchesPerTick: number;
	/** Cap on idle sleep between scans; also the upper bound on how late a manual edit is noticed. */
	maxSleepMinutes: number;
}

export type PipiclawMemoryMaintenanceSettings = MemoryMaintenanceTuning & {
	enabled: boolean;
};

export interface PipiclawLoggingSettings {
	level: "debug" | "info" | "warn" | "error";
	file: {
		enabled: boolean;
		maxSizeBytes: number;
		maxFiles: number;
	};
}

export interface PipiclawSessionSearchSettings {
	maxFiles: number;
	maxChunks: number;
	maxCharsPerChunk: number;
	summarizeWithModel: boolean;
	timeoutMs: number;
}

/**
 * How much out-of-band commentary a delegation run (`src/subagents/`) or background job produces
 * outside of its own completion wake — plain text, not an LLM turn, so it reaches the channel in
 * roughly the time the run itself takes rather than waiting on a wake turn's latency.
 * `"off"` is today's behavior; `"settled"` adds only the one-line completion receipt; `"live"`
 * also adds a sparse trickle of running-progress notices for long external runs.
 */
export interface PipiclawDelegationSettings {
	notices: "off" | "settled" | "live";
}

/**
 * Everything `settings.json` may contain (spec 035 D1).
 *
 * The rule: a key earns a place here only if it expresses product intent —
 * which model to use, whether a subsystem runs, whether an optional LLM call is
 * worth its tokens, what the output looks like. Every numeric threshold is an
 * algorithm parameter and lives in code. Keys retired by that rule are listed
 * in `RETIRED_SETTINGS_KEYS` and reported as warnings on load.
 */
export interface PipiclawSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	/** Single backup model reference (`provider/model`) used when the primary model's turn fails. */
	fallbackModel?: string | null;
	/**
	 * Default model reference (`provider/model`) for sub-agents that don't otherwise name one
	 * (spec 032 D5). Lower priority than an invocation's `model` or a predefined agent's
	 * frontmatter `model`; falls back to the parent's current model when unset.
	 */
	subagentModel?: string | null;
	compaction?: { enabled?: boolean };
	retry?: { enabled?: boolean };
	memoryMaintenance?: { enabled?: boolean };
	sessionSearch?: {
		/** Costs an extra LLM call per search hit; same reasoning as `rerankWithModel`. */
		summarizeWithModel?: boolean;
	};
	logging?: { level?: PipiclawLoggingSettings["level"]; file?: { enabled?: boolean } };
	tui?: Partial<PipiclawTuiSettings>;
	delegation?: Partial<PipiclawDelegationSettings>;
}

export interface PipiclawTuiSettings {
	/**
	 * Output shape for the terminal TUI, reusing the DingTalk response-mode
	 * vocabulary: `full_progress_then_plain_final` (default) streams full progress
	 * then a plain final answer; `rolling_progress_then_plain_final` keeps only
	 * recent progress; `final_card_only` hides progress. Independent of the
	 * DingTalk channel's `responseMode` in `channel.json`.
	 */
	responseMode: ResponseMode;
}

const DEFAULT_TUI: PipiclawTuiSettings = {
	responseMode: "full_progress_then_plain_final",
};

const DEFAULT_DELEGATION: PipiclawDelegationSettings = {
	notices: "live",
};

const DEFAULT_COMPACTION: PipiclawCompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

const DEFAULT_RETRY: PipiclawRetrySettings = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
};

// Cheap and high-value: reading a handful of task frontmatters and always surfacing
// the in-flight agenda is worth more than the tokens it costs, so it defaults on.
export const TASK_DIGEST_SETTINGS: PipiclawTaskDigestSettings = {
	maxTasks: 8,
	maxChars: 1000,
};

// The driver makes `wake` an executable task property rather than a convention
// that requires users to install a heartbeat event and sensor script. A changed
// task can continue promptly; an unchanged task backs off to avoid token loops.
export const TASK_DRIVER_SETTINGS: PipiclawTaskDriverSettings = {
	continuationDelayMinutes: 5,
	stalledRetryMinutes: 60,
	maxDispatchesPerTick: 4,
	maxSleepMinutes: 15,
};

const DEFAULT_SESSION_SEARCH: PipiclawSessionSearchSettings = {
	maxFiles: 12,
	maxChunks: 80,
	maxCharsPerChunk: 1200,
	summarizeWithModel: false,
	timeoutMs: 12_000,
};

const DEFAULT_MEMORY_MAINTENANCE_ENABLED = true;

// `file.enabled` defaults to true: for a long-lived daemon, persisting logs is
// worth more than the surprise of a new file under state/logs/. See docs.
const DEFAULT_LOGGING: PipiclawLoggingSettings = {
	level: "info",
	file: {
		enabled: true,
		maxSizeBytes: 5_000_000,
		maxFiles: 3,
	},
};

/**
 * Keys that used to be configurable and are now constants (spec 035 D3).
 *
 * Leaving them in `settings.json` is harmless — the runtime uses the constant —
 * but silently ignoring a value someone deliberately tuned is worse than saying
 * so once at startup. Matched exactly; no general unknown-key sweep, because
 * `settings.json` also carries upstream pi-mono fields that we must not flag.
 */
const RETIRED_SETTINGS_KEYS: readonly string[] = [
	"compaction.reserveTokens",
	"compaction.keepRecentTokens",
	"retry.maxRetries",
	"retry.baseDelayMs",
	// Spec 050: per-turn recall is retired (D1) — the whole memoryRecall section is gone, not
	// just its numeric params.
	"memoryRecall.enabled",
	"memoryRecall.rerankWithModel",
	"memoryRecall.maxCandidates",
	"memoryRecall.maxInjected",
	"memoryRecall.maxChars",
	// Spec 050: SESSION.md is retired (the journal replaces it), so the whole sessionMemory
	// section — including its own top-level enable switch — is gone, not just its params.
	"sessionMemory.enabled",
	"sessionMemory.minTurnsBetweenUpdate",
	"sessionMemory.minToolCallsBetweenUpdate",
	"sessionMemory.timeoutMs",
	"sessionMemory.failureBackoffTurns",
	"sessionMemory.forceRefreshBeforeCompact",
	"sessionMemory.forceRefreshBeforeNewSession",
	"memoryMaintenance.minIdleMinutesBeforeLlmWork",
	"memoryMaintenance.sessionRefreshIntervalMinutes",
	"memoryMaintenance.checkpointIntervalMinutes",
	"memoryMaintenance.reflectIntervalMinutes",
	"memoryMaintenance.minMemoryAutoWriteConfidence",
	"memoryMaintenance.structuralMaintenanceIntervalHours",
	"memoryMaintenance.maxConcurrentChannels",
	"memoryMaintenance.failureBackoffMinutes",
	"memoryMaintenance.cleanupShrinkGuardMinRatio",
	"memoryMaintenance.cleanupShrinkGuardMinChars",
	"sessionSearch.enabled",
	"sessionSearch.maxFiles",
	"sessionSearch.maxChunks",
	"sessionSearch.maxCharsPerChunk",
	"sessionSearch.timeoutMs",
	"logging.file.maxSizeBytes",
	"logging.file.maxFiles",
	"taskDigest.maxTasks",
	"taskDigest.maxChars",
	"taskDriver.continuationDelayMinutes",
	"taskDriver.stalledRetryMinutes",
	"taskDriver.maxDispatchesPerTick",
	"taskDriver.maxSleepMinutes",
];

/** Shared by `getFallbackModelReference`/`getSubAgentModelReference`: empty or whitespace-only
 * counts as unset, same as the field being absent. */
function normalizeOptionalModelReference(raw: unknown): string | null {
	if (typeof raw !== "string") {
		return null;
	}
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function hasNestedKey(root: unknown, dottedPath: string): boolean {
	let node = root;
	for (const segment of dottedPath.split(".")) {
		if (!node || typeof node !== "object" || Array.isArray(node)) return false;
		if (!Object.hasOwn(node, segment)) return false;
		node = (node as Record<string, unknown>)[segment];
	}
	return true;
}

function findRetiredSettingsKeys(parsed: unknown): string[] {
	return RETIRED_SETTINGS_KEYS.filter((key) => hasNestedKey(parsed, key));
}

/**
 * Every enum-valued key, with the values it accepts.
 *
 * `settings.json` is hand-edited and nothing type-checks it, so a typo used to travel straight
 * into the runtime as a string the code never compares equal to anything. The failure modes were
 * not uniform and none of them said anything: `logging.level: "verbos"` made *every* log record
 * fail its threshold comparison (`LEVEL_ORDER[level] >= NaN`) and silenced the log entirely;
 * `delegation.notices: "liv"` fell through both negative checks and behaved as `live`, the
 * opposite of the "off" a nervous operator was reaching for. Validating here — once, on load —
 * means an unrecognized value is dropped so the documented default applies, and the operator is
 * told which key was ignored.
 *
 * The value lists are literal rather than imported: `ResponseMode` lives in the DingTalk
 * transport, and a value import would tie settings loading to that module's import graph. The
 * `satisfies` clauses keep them honest against the unions they mirror.
 */
const ENUM_SETTINGS: readonly { path: string; values: readonly string[] }[] = [
	{ path: "logging.level", values: ["debug", "info", "warn", "error"] satisfies PipiclawLoggingSettings["level"][] },
	{
		path: "tui.responseMode",
		values: [
			"full_progress_then_plain_final",
			"rolling_progress_then_plain_final",
			"final_card_only",
		] satisfies ResponseMode[],
	},
	{ path: "delegation.notices", values: ["off", "settled", "live"] satisfies PipiclawDelegationSettings["notices"][] },
];

function readNestedKey(
	root: unknown,
	dottedPath: string,
): { parent: Record<string, unknown>; key: string } | undefined {
	const segments = dottedPath.split(".");
	const key = segments.pop();
	if (!key) return undefined;
	let node = root;
	for (const segment of segments) {
		if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
		node = (node as Record<string, unknown>)[segment];
	}
	if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
	const parent = node as Record<string, unknown>;
	return Object.hasOwn(parent, key) ? { parent, key } : undefined;
}

/**
 * Drop every enum key whose value is not one this build understands, and describe what was
 * dropped. Deleting rather than coercing is deliberate: `??` then yields the same default a
 * missing key would, so one bad value cannot produce a state the rest of the code never expects.
 */
function stripInvalidEnumValues(parsed: unknown): string[] {
	const problems: string[] = [];
	for (const { path, values } of ENUM_SETTINGS) {
		const found = readNestedKey(parsed, path);
		if (!found) continue;
		const value = found.parent[found.key];
		if (value === undefined || values.includes(value as string)) continue;
		delete found.parent[found.key];
		problems.push(`${path}: ${JSON.stringify(value)} is not one of ${values.join(" | ")}; using the default instead`);
	}
	return problems;
}

/**
 * Settings manager for pipiclaw.
 * Stores global settings in the pipiclaw root directory.
 */
export class PipiclawSettingsManager {
	private settingsPath: string;
	private settings: PipiclawSettings;
	private loadErrors: SettingsError[] = [];
	private retiredKeys: string[] = [];
	private invalidEnumValues: string[] = [];
	/** The file's change token as of the last actual parse; see `reload`. */
	private loadedStamp = "";

	constructor(baseDir: string) {
		this.settingsPath = join(baseDir, "settings.json");
		this.settings = this.load();
	}

	private load(): PipiclawSettings {
		this.loadErrors = [];
		this.retiredKeys = [];
		this.invalidEnumValues = [];
		this.loadedStamp = fileStamp(this.settingsPath);
		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			const parsed = JSON.parse(content) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				this.loadErrors.push({
					scope: "global",
					error: new Error(`Expected a JSON object in ${this.settingsPath}`),
				});
				return {};
			}
			this.retiredKeys = findRetiredSettingsKeys(parsed);
			this.invalidEnumValues = stripInvalidEnumValues(parsed);
			return parsed as PipiclawSettings;
		} catch (error) {
			this.loadErrors.push({
				scope: "global",
				error: error instanceof Error ? error : new Error(String(error)),
			});
			return {};
		}
	}

	private save(): void {
		try {
			const dir = dirname(this.settingsPath);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
			}
			writeFileAtomicallySync(this.settingsPath, JSON.stringify(this.settings, null, 2));
		} catch (error) {
			log.logWarning(`Could not save settings file`, `${this.settingsPath}\n${String(error)}`);
		}
	}

	/**
	 * Re-read `settings.json`, but only when the file actually changed.
	 *
	 * The task driver and the memory scheduler call this on every tick — and the driver ticks
	 * after every turn — so an unchanged file was being read, JSON-parsed and scanned for retired
	 * keys many times a minute. Skipping keeps the last parse *and* its diagnostics, which is the
	 * same thing a re-parse of identical bytes would produce.
	 */
	reload(): void {
		if (fileStamp(this.settingsPath) === this.loadedStamp) return;
		this.settings = this.load();
	}

	drainErrors(): SettingsError[] {
		const errors = this.loadErrors;
		this.loadErrors = [];
		return errors;
	}

	getDiagnostics(): ConfigDiagnostic[] {
		const diagnostics: ConfigDiagnostic[] = this.loadErrors.map(({ error }) => ({
			source: "settings",
			path: this.settingsPath,
			severity: "error",
			message: error.message,
		}));
		if (this.retiredKeys.length > 0) {
			diagnostics.push({
				source: "settings",
				path: this.settingsPath,
				severity: "warning",
				message: `${this.retiredKeys.join(", ")}: no longer configurable; these are now built-in constants and the values here are ignored. Remove them from settings.json.`,
			});
		}
		for (const message of this.invalidEnumValues) {
			diagnostics.push({ source: "settings", path: this.settingsPath, severity: "warning", message });
		}
		return diagnostics;
	}

	getCompactionSettings(): PipiclawCompactionSettings {
		return {
			...DEFAULT_COMPACTION,
			enabled: this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled,
		};
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? DEFAULT_COMPACTION.enabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.settings.compaction = { ...this.settings.compaction, enabled };
		this.save();
	}

	getRetrySettings(): PipiclawRetrySettings {
		return {
			...DEFAULT_RETRY,
			enabled: this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled,
		};
	}

	getMemoryMaintenanceSettings(): PipiclawMemoryMaintenanceSettings {
		return {
			...getMemoryMaintenanceTuning(),
			enabled: this.settings.memoryMaintenance?.enabled ?? DEFAULT_MEMORY_MAINTENANCE_ENABLED,
		};
	}

	getSessionSearchSettings(): PipiclawSessionSearchSettings {
		return {
			...DEFAULT_SESSION_SEARCH,
			summarizeWithModel:
				this.settings.sessionSearch?.summarizeWithModel ?? DEFAULT_SESSION_SEARCH.summarizeWithModel,
		};
	}

	getLoggingSettings(): PipiclawLoggingSettings {
		return {
			...DEFAULT_LOGGING,
			level: this.settings.logging?.level ?? DEFAULT_LOGGING.level,
			file: {
				...DEFAULT_LOGGING.file,
				enabled: this.settings.logging?.file?.enabled ?? DEFAULT_LOGGING.file.enabled,
			},
		};
	}

	getTuiSettings(): PipiclawTuiSettings {
		return { ...DEFAULT_TUI, ...this.settings.tui };
	}

	getDelegationSettings(): PipiclawDelegationSettings {
		return {
			...DEFAULT_DELEGATION,
			notices: this.settings.delegation?.notices ?? DEFAULT_DELEGATION.notices,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
	}

	/**
	 * Backup model reference (`provider/model`) for fallback, or null when unset.
	 * Empty / whitespace-only values are treated as unset (fallback disabled).
	 */
	getFallbackModelReference(): string | null {
		return normalizeOptionalModelReference(this.settings.fallbackModel);
	}

	/**
	 * Default model reference (`provider/model`) for sub-agents, or null when unset.
	 * Empty / whitespace-only values are treated as unset (spec 032 D5).
	 */
	getSubAgentModelReference(): string | null {
		return normalizeOptionalModelReference(this.settings.subagentModel);
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.settings.defaultProvider = provider;
		this.settings.defaultModel = modelId;
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.settings.defaultThinkingLevel = level;
		this.save();
	}
}

/**
 * Settings management for pipiclaw.
 *
 * `log.jsonl` and `context.jsonl` are treated as raw cold storage.
 * They are not proactively scanned or loaded as part of the memory model.
 *
 * This module currently provides only PipiclawSettingsManager.
 */

import type { Transport } from "@mariozechner/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import * as log from "./log.js";
import type { ConfigDiagnostic } from "./shared/config-diagnostics.js";

type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

type ThinkingBudgetsSettings = {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
};

type Settings = {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	compaction?: {
		enabled?: boolean;
		reserveTokens?: number;
		keepRecentTokens?: number;
	};
	retry?: {
		enabled?: boolean;
		maxRetries?: number;
		baseDelayMs?: number;
		maxDelayMs?: number;
	};
};

type SettingsError = {
	scope: "global" | "project";
	error: Error;
};

type TransportSetting = Transport;

// ============================================================================
// PipiclawSettingsManager - Simple settings for pipiclaw
// ============================================================================

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

export interface PipiclawMemoryRecallSettings {
	enabled: boolean;
	maxCandidates: number;
	maxInjected: number;
	maxChars: number;
	rerankWithModel: boolean | "auto";
}

export interface PipiclawSessionMemorySettings {
	enabled: boolean;
	minTurnsBetweenUpdate: number;
	minToolCallsBetweenUpdate: number;
	timeoutMs: number;
	failureBackoffTurns: number;
	forceRefreshBeforeCompact: boolean;
	forceRefreshBeforeNewSession: boolean;
}

export interface PipiclawMemoryGrowthSettings {
	postTurnReviewEnabled: boolean;
	autoWriteChannelMemory: boolean;
	autoWriteWorkspaceSkills: boolean;
	minSkillAutoWriteConfidence: number;
	minMemoryAutoWriteConfidence: number;
	idleWritesHistory: boolean;
	minTurnsBetweenReview: number;
	minToolCallsBetweenReview: number;
}

export interface PipiclawMemoryMaintenanceSettings {
	enabled: boolean;
	minIdleMinutesBeforeLlmWork: number;
	sessionRefreshIntervalMinutes: number;
	durableConsolidationIntervalMinutes: number;
	growthReviewIntervalMinutes: number;
	structuralMaintenanceIntervalHours: number;
	maxConcurrentChannels: number;
	failureBackoffMinutes: number;
}

export interface PipiclawSessionSearchSettings {
	enabled: boolean;
	maxFiles: number;
	maxChunks: number;
	maxCharsPerChunk: number;
	summarizeWithModel: boolean;
	timeoutMs: number;
}

export interface PipiclawSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	compaction?: Partial<PipiclawCompactionSettings>;
	retry?: Partial<PipiclawRetrySettings>;
	memoryRecall?: Partial<PipiclawMemoryRecallSettings>;
	sessionMemory?: Partial<PipiclawSessionMemorySettings>;
	memoryGrowth?: Partial<PipiclawMemoryGrowthSettings>;
	memoryMaintenance?: Partial<PipiclawMemoryMaintenanceSettings>;
	sessionSearch?: Partial<PipiclawSessionSearchSettings>;
}

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

const DEFAULT_MEMORY_RECALL: PipiclawMemoryRecallSettings = {
	enabled: true,
	maxCandidates: 12,
	maxInjected: 5,
	maxChars: 5000,
	rerankWithModel: "auto",
};

const DEFAULT_SESSION_MEMORY: PipiclawSessionMemorySettings = {
	enabled: true,
	minTurnsBetweenUpdate: 2,
	minToolCallsBetweenUpdate: 4,
	timeoutMs: 30_000,
	failureBackoffTurns: 3,
	forceRefreshBeforeCompact: true,
	forceRefreshBeforeNewSession: true,
};

const DEFAULT_MEMORY_GROWTH: PipiclawMemoryGrowthSettings = {
	postTurnReviewEnabled: true,
	autoWriteChannelMemory: true,
	autoWriteWorkspaceSkills: true,
	minSkillAutoWriteConfidence: 0.9,
	minMemoryAutoWriteConfidence: 0.85,
	idleWritesHistory: false,
	minTurnsBetweenReview: 12,
	minToolCallsBetweenReview: 24,
};

const DEFAULT_SESSION_SEARCH: PipiclawSessionSearchSettings = {
	enabled: true,
	maxFiles: 12,
	maxChunks: 80,
	maxCharsPerChunk: 1200,
	summarizeWithModel: false,
	timeoutMs: 12_000,
};

const DEFAULT_MEMORY_MAINTENANCE: PipiclawMemoryMaintenanceSettings = {
	enabled: true,
	minIdleMinutesBeforeLlmWork: 10,
	sessionRefreshIntervalMinutes: 10,
	durableConsolidationIntervalMinutes: 20,
	growthReviewIntervalMinutes: 60,
	structuralMaintenanceIntervalHours: 6,
	maxConcurrentChannels: 1,
	failureBackoffMinutes: 30,
};

/**
 * Settings manager for pipiclaw.
 * Stores global settings in the pipiclaw root directory.
 */
export class PipiclawSettingsManager {
	private settingsPath: string;
	private settings: PipiclawSettings;
	private loadErrors: SettingsError[] = [];

	constructor(baseDir: string) {
		this.settingsPath = join(baseDir, "settings.json");
		this.settings = this.load();
	}

	private load(): PipiclawSettings {
		this.loadErrors = [];
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
			writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
		} catch (error) {
			log.logWarning(`Could not save settings file`, `${this.settingsPath}\n${String(error)}`);
		}
	}

	reload(): void {
		this.settings = this.load();
	}

	drainErrors(): SettingsError[] {
		const errors = this.loadErrors;
		this.loadErrors = [];
		return errors;
	}

	getDiagnostics(): ConfigDiagnostic[] {
		return this.loadErrors.map(({ error }) => ({
			source: "settings",
			path: this.settingsPath,
			severity: "error",
			message: error.message,
		}));
	}

	getCompactionSettings(): PipiclawCompactionSettings {
		return {
			...DEFAULT_COMPACTION,
			...this.settings.compaction,
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
			...this.settings.retry,
		};
	}

	getMemoryRecallSettings(): PipiclawMemoryRecallSettings {
		return {
			...DEFAULT_MEMORY_RECALL,
			...this.settings.memoryRecall,
		};
	}

	getSessionMemorySettings(): PipiclawSessionMemorySettings {
		return {
			...DEFAULT_SESSION_MEMORY,
			...this.settings.sessionMemory,
		};
	}

	getMemoryGrowthSettings(): PipiclawMemoryGrowthSettings {
		return {
			...DEFAULT_MEMORY_GROWTH,
			...this.settings.memoryGrowth,
			minSkillAutoWriteConfidence: 0.9,
		};
	}

	getMemoryMaintenanceSettings(): PipiclawMemoryMaintenanceSettings {
		return {
			...DEFAULT_MEMORY_MAINTENANCE,
			...this.settings.memoryMaintenance,
		};
	}

	getSessionSearchSettings(): PipiclawSessionSearchSettings {
		return {
			...DEFAULT_SESSION_SEARCH,
			...this.settings.sessionSearch,
		};
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? DEFAULT_RETRY.enabled;
	}

	setRetryEnabled(enabled: boolean): void {
		this.settings.retry = { ...this.settings.retry, enabled };
		this.save();
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

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): void {
		this.settings.defaultThinkingLevel = level as PipiclawSettings["defaultThinkingLevel"];
		this.save();
	}

	// Compatibility methods for AgentSession
	getSteeringMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setSteeringMode(_mode: "all" | "one-at-a-time"): void {
		// No-op
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return "one-at-a-time";
	}

	setFollowUpMode(_mode: "all" | "one-at-a-time"): void {
		// No-op
	}

	getHookPaths(): string[] {
		return [];
	}

	getHookTimeout(): number {
		return 30000;
	}

	// Image settings
	getImageAutoResize(): boolean {
		return false;
	}

	setImageAutoResize(_enabled: boolean): void {
		// No-op
	}

	getBlockImages(): boolean {
		return false;
	}

	setBlockImages(_blocked: boolean): void {
		// No-op
	}

	getShowImages(): boolean {
		return false;
	}

	setShowImages(_show: boolean): void {
		// No-op
	}

	// Compaction details
	getCompactionReserveTokens(): number {
		return this.getCompactionSettings().reserveTokens;
	}

	getCompactionKeepRecentTokens(): number {
		return this.getCompactionSettings().keepRecentTokens;
	}

	getBranchSummarySettings(): { reserveTokens: number } {
		return { reserveTokens: this.getCompactionSettings().reserveTokens };
	}

	getBranchSummarySkipPrompt(): boolean {
		return false;
	}

	// Thinking
	getHideThinkingBlock(): boolean {
		return false;
	}

	setHideThinkingBlock(_hide: boolean): void {
		// No-op
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return undefined;
	}

	// Shell
	getShellPath(): string | undefined {
		return undefined;
	}

	setShellPath(_path: string | undefined): void {
		// No-op
	}

	getShellCommandPrefix(): string | undefined {
		return undefined;
	}

	setShellCommandPrefix(_prefix: string | undefined): void {
		// No-op
	}

	// Misc settings stubs
	getQuietStartup(): boolean {
		return true;
	}

	setQuietStartup(_quiet: boolean): void {
		// No-op
	}

	getCollapseChangelog(): boolean {
		return true;
	}

	setCollapseChangelog(_collapse: boolean): void {
		// No-op
	}

	getTransport(): TransportSetting {
		return "auto";
	}

	setTransport(_transport: TransportSetting): void {
		// No-op
	}

	getTheme(): string | undefined {
		return undefined;
	}

	setTheme(_theme: string): void {
		// No-op
	}

	getPackages(): PackageSource[] {
		return [];
	}

	setPackages(_packages: PackageSource[]): void {
		// No-op
	}

	setProjectPackages(_packages: PackageSource[]): void {
		// No-op
	}

	getExtensionPaths(): string[] {
		return [];
	}

	setExtensionPaths(_paths: string[]): void {
		// No-op
	}

	setProjectExtensionPaths(_paths: string[]): void {
		// No-op
	}

	getSkillPaths(): string[] {
		return [];
	}

	setSkillPaths(_paths: string[]): void {
		// No-op
	}

	setProjectSkillPaths(_paths: string[]): void {
		// No-op
	}

	getPromptTemplatePaths(): string[] {
		return [];
	}

	setPromptTemplatePaths(_paths: string[]): void {
		// No-op
	}

	setProjectPromptTemplatePaths(_paths: string[]): void {
		// No-op
	}

	getThemePaths(): string[] {
		return [];
	}

	setThemePaths(_paths: string[]): void {
		// No-op
	}

	setProjectThemePaths(_paths: string[]): void {
		// No-op
	}

	getEnableSkillCommands(): boolean {
		return false;
	}

	setEnableSkillCommands(_enabled: boolean): void {
		// No-op
	}

	getEnabledModels(): string[] | undefined {
		return undefined;
	}

	setEnabledModels(_patterns: string[] | undefined): void {
		// No-op
	}

	getDoubleEscapeAction(): "none" {
		return "none";
	}

	setDoubleEscapeAction(_action: "fork" | "tree" | "none"): void {
		// No-op
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		return "default";
	}

	setTreeFilterMode(_mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		// No-op
	}

	getShowHardwareCursor(): boolean {
		return false;
	}

	setShowHardwareCursor(_enabled: boolean): void {
		// No-op
	}

	getClearOnShrink(): boolean {
		return false;
	}

	setClearOnShrink(_enabled: boolean): void {
		// No-op
	}

	getEditorPaddingX(): number {
		return 0;
	}

	setEditorPaddingX(_padding: number): void {
		// No-op
	}

	getAutocompleteMaxVisible(): number {
		return 10;
	}

	setAutocompleteMaxVisible(_maxVisible: number): void {
		// No-op
	}

	getCodeBlockIndent(): string {
		return "  ";
	}

	getLastChangelogVersion(): string | undefined {
		return undefined;
	}

	setLastChangelogVersion(_version: string): void {
		// No-op
	}

	setDefaultProvider(_provider: string): void {
		// No-op
	}

	setDefaultModel(_modelId: string): void {
		// No-op
	}

	getSessionDir(): string | undefined {
		return undefined;
	}

	getNpmCommand(): string[] | undefined {
		return undefined;
	}

	setNpmCommand(_command: string[] | undefined): void {
		// No-op
	}

	getGlobalSettings(): Settings {
		return {};
	}

	getProjectSettings(): Settings {
		return {};
	}

	applyOverrides(overrides: Partial<Settings>): void {
		if (overrides.defaultProvider !== undefined) this.settings.defaultProvider = overrides.defaultProvider;
		if (overrides.defaultModel !== undefined) this.settings.defaultModel = overrides.defaultModel;
		if (overrides.defaultThinkingLevel !== undefined) {
			this.settings.defaultThinkingLevel = overrides.defaultThinkingLevel;
		}
		if (overrides.compaction !== undefined) {
			this.settings.compaction = {
				...this.settings.compaction,
				enabled: overrides.compaction.enabled ?? this.settings.compaction?.enabled,
				reserveTokens: overrides.compaction.reserveTokens ?? this.settings.compaction?.reserveTokens,
				keepRecentTokens: overrides.compaction.keepRecentTokens ?? this.settings.compaction?.keepRecentTokens,
			};
		}
		if (overrides.retry !== undefined) {
			this.settings.retry = {
				...this.settings.retry,
				enabled: overrides.retry.enabled ?? this.settings.retry?.enabled,
				maxRetries: overrides.retry.maxRetries ?? this.settings.retry?.maxRetries,
				baseDelayMs: overrides.retry.baseDelayMs ?? this.settings.retry?.baseDelayMs,
			};
		}
		this.save();
	}

	flush(): Promise<void> {
		return Promise.resolve();
	}
}

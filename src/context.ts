/**
 * Context management for pipiclaw.
 *
 * `log.jsonl` and `context.jsonl` are treated as raw cold storage.
 * They are not proactively scanned or loaded as part of the memory model.
 *
 * This module currently provides only PipiclawSettingsManager.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

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

export interface PipiclawSettings {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
	compaction?: Partial<PipiclawCompactionSettings>;
	retry?: Partial<PipiclawRetrySettings>;
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

/**
 * Settings manager for pipiclaw.
 * Stores global settings in the pipiclaw root directory.
 */
export class PipiclawSettingsManager {
	private settingsPath: string;
	private settings: PipiclawSettings;

	constructor(baseDir: string) {
		this.settingsPath = join(baseDir, "settings.json");
		this.settings = this.load();
	}

	private load(): PipiclawSettings {
		if (!existsSync(this.settingsPath)) {
			return {};
		}

		try {
			const content = readFileSync(this.settingsPath, "utf-8");
			return JSON.parse(content);
		} catch {
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
			console.error(`Warning: Could not save settings file: ${error}`);
		}
	}

	reload(): void {
		this.settings = this.load();
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

	getDefaultThinkingLevel(): string {
		return this.settings.defaultThinkingLevel || "off";
	}

	setDefaultThinkingLevel(level: string): void {
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
		return DEFAULT_COMPACTION.reserveTokens;
	}

	getCompactionKeepRecentTokens(): number {
		return DEFAULT_COMPACTION.keepRecentTokens;
	}

	getBranchSummarySettings(): { reserveTokens: number } {
		return { reserveTokens: 16384 };
	}

	// Thinking
	getHideThinkingBlock(): boolean {
		return false;
	}

	setHideThinkingBlock(_hide: boolean): void {
		// No-op
	}

	getThinkingBudgets(): undefined {
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

	getTransport(): string {
		return "stdio";
	}

	setTransport(_transport: string): void {
		// No-op
	}

	getTheme(): string | undefined {
		return undefined;
	}

	setTheme(_theme: string): void {
		// No-op
	}

	getPackages(): unknown[] {
		return [];
	}

	setPackages(_packages: unknown[]): void {
		// No-op
	}

	setProjectPackages(_packages: unknown[]): void {
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

	setDoubleEscapeAction(_action: string): void {
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

	getGlobalSettings(): object {
		return {};
	}

	getProjectSettings(): object {
		return {};
	}

	applyOverrides(_overrides: Partial<PipiclawSettings>): void {
		// No-op
	}

	flush(): Promise<void> {
		return Promise.resolve();
	}

	drainErrors(): unknown[] {
		return [];
	}
}

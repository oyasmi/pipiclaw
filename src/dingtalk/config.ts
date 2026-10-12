/**
 * `channel.json`: the DingTalk transport's configuration shape, validation and loading. This is
 * the only loader of that file (spec 054 D7); the app-home scaffolding only writes its template.
 */
import { readFileSync } from "fs";
import { BootstrapExitError, type BootstrapIO, type BootstrapPaths, DEFAULT_BOOTSTRAP_PATHS } from "../app/home.js";
import { isResponseModeConfig, normalizeResponseMode, type ResponseMode } from "../channel/channel-context.js";
import { docsUrl } from "../paths.js";
import { errorMessage } from "../shared/text-utils.js";

export type BusyMessageMode = "steer" | "followUp";
export type BusyMessageDefaultConfig = BusyMessageMode | "followup";

export function isBusyMessageDefaultConfig(value: unknown): value is BusyMessageDefaultConfig {
	return value === "steer" || value === "followUp" || value === "followup";
}

export function normalizeBusyMessageDefault(value: unknown): BusyMessageMode {
	if (value === undefined) {
		return "steer";
	}
	if (value === "steer") {
		return "steer";
	}
	if (value === "followUp" || value === "followup") {
		return "followUp";
	}
	throw new Error('Invalid `busyMessageDefault`: expected "steer", "followUp", or "followup".');
}

export interface DingTalkConfig {
	clientId: string;
	clientSecret: string;
	robotCode?: string;
	cardTemplateId?: string;
	cardTemplateKey?: string;
	allowFrom?: string[];
	stateDir?: string;
	busyMessageDefault?: BusyMessageDefaultConfig;
	responseMode?: ResponseMode;
	cardAutoLayout?: boolean;
}

function isPlaceholderString(value: string): boolean {
	return value.trim().startsWith("your-");
}

function listChannelConfigIssues(config: Partial<DingTalkConfig>): string[] {
	const issues: string[] = [];

	if (!config.clientId) {
		issues.push("Missing required field `clientId`.");
	} else if (isPlaceholderString(config.clientId)) {
		issues.push("Replace placeholder value for `clientId`.");
	}

	if (!config.clientSecret) {
		issues.push("Missing required field `clientSecret`.");
	} else if (isPlaceholderString(config.clientSecret)) {
		issues.push("Replace placeholder value for `clientSecret`.");
	}

	if (config.robotCode && isPlaceholderString(config.robotCode)) {
		issues.push("Replace placeholder value for `robotCode`, or set it to an empty string to reuse `clientId`.");
	}

	if (config.cardTemplateId && isPlaceholderString(config.cardTemplateId)) {
		issues.push(
			"Replace placeholder value for `cardTemplateId`, or set it to an empty string to disable AI Card streaming.",
		);
	}

	if (Array.isArray(config.allowFrom) && config.allowFrom.some((value) => isPlaceholderString(value))) {
		issues.push("Replace placeholder values in `allowFrom`, or set it to an empty array to allow all users.");
	}

	const busyMessageDefault = (config as { busyMessageDefault?: unknown }).busyMessageDefault;
	if (busyMessageDefault !== undefined && !isBusyMessageDefaultConfig(busyMessageDefault)) {
		issues.push('Invalid `busyMessageDefault`: expected "steer", "followUp", or "followup".');
	}

	const responseMode = (config as { responseMode?: unknown }).responseMode;
	if (responseMode !== undefined && !isResponseModeConfig(responseMode)) {
		issues.push(
			'Invalid `responseMode`: expected "full_progress_then_plain_final", "rolling_progress_then_plain_final", or "final_card_only".',
		);
	}

	const cardAutoLayout = (config as { cardAutoLayout?: unknown }).cardAutoLayout;
	if (cardAutoLayout !== undefined && typeof cardAutoLayout !== "boolean") {
		issues.push("Invalid `cardAutoLayout`: expected boolean.");
	}

	return issues;
}

export function loadConfig(paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS, io: BootstrapIO = console): DingTalkConfig {
	let parsed: DingTalkConfig;

	try {
		parsed = JSON.parse(readFileSync(paths.channelConfigPath, "utf-8")) as DingTalkConfig;
	} catch (err) {
		io.error(`Failed to parse configuration: ${paths.channelConfigPath}`);
		io.error(errorMessage(err));
		throw new BootstrapExitError(1);
	}

	const issues = listChannelConfigIssues(parsed);
	if (issues.length > 0) {
		io.error(`Configuration is not ready: ${paths.channelConfigPath}`);
		for (const issue of issues) {
			io.error(`  - ${issue}`);
		}
		io.error("");
		io.error(`Fix ${paths.channelConfigPath} and run \`${paths.appName}\` again.`);
		io.error(`Docs: ${docsUrl("configuration.md")}`);
		throw new BootstrapExitError(1);
	}

	parsed.cardTemplateKey = parsed.cardTemplateKey || "content";
	parsed.robotCode = parsed.robotCode?.trim() ? parsed.robotCode : parsed.clientId;
	parsed.busyMessageDefault = normalizeBusyMessageDefault(
		(parsed as { busyMessageDefault?: unknown }).busyMessageDefault,
	);
	parsed.responseMode = normalizeResponseMode((parsed as { responseMode?: unknown }).responseMode);
	parsed.cardAutoLayout = (parsed as { cardAutoLayout?: boolean }).cardAutoLayout ?? true;
	if (Array.isArray(parsed.allowFrom)) {
		parsed.allowFrom = parsed.allowFrom.filter((value) => value.trim().length > 0);
	}

	return parsed;
}

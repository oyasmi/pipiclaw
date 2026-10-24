/**
 * `channel.json`'s `dingtalk` section: the DingTalk transport's configuration shape and validation.
 * The outer file (which sections are on) is `channel/config.ts`'s; the app-home scaffolding only
 * writes the template.
 */
import { ChannelConfigError } from "../channel/config.js";
import { isResponseModeConfig, normalizeResponseMode, type ResponseMode } from "./response-mode.js";

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

/**
 * Validate and normalize the `dingtalk` section (already known to be switched on). Throws a
 * `ChannelConfigError` naming every problem at once.
 */
export function parseDingTalkConfig(section: unknown): DingTalkConfig {
	const { enabled: _enabled, ...fields } = section as Partial<DingTalkConfig> & { enabled?: boolean };
	const parsed = fields as DingTalkConfig;

	const issues = listChannelConfigIssues(parsed);
	if (issues.length > 0) {
		throw new ChannelConfigError(issues.map((issue) => `dingtalk: ${issue}`));
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

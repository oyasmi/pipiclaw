/**
 * `channel.json`'s outer shape (spec 061, D1/D2): one section per transport, each with its own
 * `enabled` switch. This file only decides *which* sections are on; what is inside a section is
 * that transport's own business, and a section that is off is never looked at beyond its switch,
 * so credentials can stay in the file while a transport is disabled.
 */
import { createHash, randomBytes } from "node:crypto";
import { docsUrl } from "../paths.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";

export const CHANNEL_SECTION_NAMES = ["dingtalk", "webapi"] as const;
export type ChannelSectionName = (typeof CHANNEL_SECTION_NAMES)[number];

/** The raw content of every section that is switched on. */
export type EnabledChannelSections = Partial<Record<ChannelSectionName, unknown>>;

export const hashWebApiKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** A new Web API bearer key: `pk_` and 256 random bits. Shown once; only its SHA-256 hash is persisted. */
export function generateWebApiKey(): string {
	return `pk_${randomBytes(32).toString("base64url")}`;
}

/** `channel.json` (or one of its sections) cannot be used; `issues` say what to fix. */
export class ChannelConfigError extends Error {
	constructor(readonly issues: string[]) {
		super(issues.join("\n"));
		this.name = "ChannelConfigError";
	}
}

export function parseChannelConfig(text: string): EnabledChannelSections {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new ChannelConfigError([`JSON 格式无效：${errorMessage(error)}`]);
	}
	if (!isPlainObject(parsed)) {
		throw new ChannelConfigError(["顶层必须是包含 `dingtalk` 和/或 `webapi` 段的 JSON 对象。"]);
	}

	const issues: string[] = [];
	for (const key of Object.keys(parsed)) {
		if (!(CHANNEL_SECTION_NAMES as readonly string[]).includes(key)) {
			issues.push(
				`未知的顶层配置项 \`${key}\`。channel.json 按渠道分段（${CHANNEL_SECTION_NAMES.map((name) => `\`${name}\``).join("、")}），请将渠道参数移入对应分段中（${docsUrl("configuration.md")}）。`,
			);
		}
	}

	const enabled: EnabledChannelSections = {};
	for (const name of CHANNEL_SECTION_NAMES) {
		const section = parsed[name];
		if (section === undefined) continue;
		if (!isPlainObject(section)) {
			issues.push(`\`${name}\` 段必须是 JSON 对象。`);
			continue;
		}
		if (typeof section.enabled !== "boolean") {
			issues.push(`\`${name}.enabled\` 必须是布尔值（true 或 false）。`);
			continue;
		}
		if (section.enabled) enabled[name] = section;
	}

	if (issues.length > 0) throw new ChannelConfigError(issues);
	return enabled;
}

/**
 * `channel.json`'s outer shape (spec 061, D1/D2): one section per transport, each with its own
 * `enabled` switch. This file only decides *which* sections are on; what is inside a section is
 * that transport's own business, and a section that is off is never looked at beyond its switch,
 * so credentials can stay in the file while a transport is disabled.
 */
import { docsUrl } from "../paths.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";

export const CHANNEL_SECTION_NAMES = ["dingtalk", "webapi"] as const;
export type ChannelSectionName = (typeof CHANNEL_SECTION_NAMES)[number];

/** The raw content of every section that is switched on. */
export type EnabledChannelSections = Partial<Record<ChannelSectionName, unknown>>;

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
		throw new ChannelConfigError([`Not valid JSON: ${errorMessage(error)}`]);
	}
	if (!isPlainObject(parsed)) {
		throw new ChannelConfigError(["Expected a JSON object with a `dingtalk` and/or a `webapi` section."]);
	}

	const issues: string[] = [];
	for (const key of Object.keys(parsed)) {
		if (!(CHANNEL_SECTION_NAMES as readonly string[]).includes(key)) {
			issues.push(
				`Unknown top-level key \`${key}\`. channel.json has one section per transport (${CHANNEL_SECTION_NAMES.map((name) => `\`${name}\``).join(", ")}); move transport settings into their section (${docsUrl("configuration.md")}).`,
			);
		}
	}

	const enabled: EnabledChannelSections = {};
	for (const name of CHANNEL_SECTION_NAMES) {
		const section = parsed[name];
		if (section === undefined) continue;
		if (!isPlainObject(section)) {
			issues.push(`\`${name}\` must be an object.`);
			continue;
		}
		if (typeof section.enabled !== "boolean") {
			issues.push(`\`${name}.enabled\` must be true or false.`);
			continue;
		}
		if (section.enabled) enabled[name] = section;
	}

	if (issues.length > 0) throw new ChannelConfigError(issues);
	return enabled;
}

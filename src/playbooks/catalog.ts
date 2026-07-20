import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PLAYBOOKS_DIR } from "../paths.js";
import { TOOL_NAMES } from "../tools/registry.js";

const DEFAULT_PRIORITY = 100;
/** A catalog entry is a single trigger, not a summary; longer descriptions are clipped in the prompt (spec 026 §10.5). */
export const MAX_PLAYBOOK_DESCRIPTION_CHARS = 100;

export interface RuntimePlaybookMetadata {
	name: string;
	description: string;
	filename: string;
	path: string;
	/**
	 * Listed only when at least one of these tools is registered — any-of, not all-of:
	 * task-delegation matters to a runtime with tasks *or* with sub-agents. Empty = always
	 * listed. (Prompt sections gate the other way: see `requiresAllTools` in agent/prompt/types.ts.)
	 */
	requiresAnyTool: string[];
	/** Ascending; ties break on filename. */
	priority: number;
}

function parseList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseFrontmatter(content: string, filename: string): Omit<RuntimePlaybookMetadata, "filename" | "path"> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) throw new Error(`Runtime playbook ${filename} has no YAML frontmatter.`);

	const fields = new Map<string, string>();
	for (const line of match[1]?.split(/\r?\n/) ?? []) {
		const separator = line.indexOf(":");
		if (separator < 0) continue;
		const key = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		fields.set(key, value);
	}

	const name = fields.get("name")?.trim();
	const description = fields.get("description")?.trim();
	if (!name || !description) {
		throw new Error(`Runtime playbook ${filename} requires non-empty name and description metadata.`);
	}
	if (`${name}.md` !== filename) {
		throw new Error(`Runtime playbook ${filename} metadata name must be "${basename(filename, ".md")}".`);
	}

	// Authored metadata is validated, never silently ignored: a typo in a tool name would
	// otherwise drop the playbook from the catalog with no signal anywhere.
	const requiresAnyTool = parseList(fields.get("requires-tools"));
	for (const tool of requiresAnyTool) {
		if (!TOOL_NAMES.has(tool)) {
			throw new Error(`Runtime playbook ${filename} requires unknown tool "${tool}".`);
		}
	}

	const priorityField = fields.get("priority");
	const priority = priorityField ? Number(priorityField) : DEFAULT_PRIORITY;
	if (!Number.isFinite(priority)) {
		throw new Error(`Runtime playbook ${filename} has a non-numeric priority "${priorityField}".`);
	}

	return { name, description, requiresAnyTool, priority };
}

/** Load the small always-on catalog; playbook bodies remain on disk until the agent reads one. */
export function loadRuntimePlaybookCatalog(directory = PLAYBOOKS_DIR): RuntimePlaybookMetadata[] {
	return readdirSync(directory)
		.filter((filename) => filename.endsWith(".md"))
		.sort()
		.map((filename) => {
			const path = join(directory, filename);
			return { ...parseFrontmatter(readFileSync(path, "utf-8"), filename), filename, path };
		})
		.sort((a, b) => a.priority - b.priority || a.filename.localeCompare(b.filename));
}

/**
 * Drop playbooks whose mechanism is unreachable with the current tool set: the task
 * playbooks are pure noise for a runtime with `task_manage` switched off.
 */
export function selectRuntimePlaybooks(
	catalog: RuntimePlaybookMetadata[],
	toolNames: readonly string[],
): RuntimePlaybookMetadata[] {
	const tools = new Set(toolNames);
	return catalog.filter((playbook) => {
		if (playbook.requiresAnyTool.length === 0) return true;
		return playbook.requiresAnyTool.some((tool) => tools.has(tool));
	});
}

/**
 * The always-loaded catalog. It shows the real absolute PLAYBOOKS_DIR once at the
 * top so the model can `read` a guide without guessing the install path (spec 026
 * §3.3, §7.1); each entry is filename + one short trigger, never the body.
 */
export function renderPlaybookCatalog(playbooks: RuntimePlaybookMetadata[]): string {
	const entries = playbooks.map((playbook) => {
		const description =
			playbook.description.length > MAX_PLAYBOOK_DESCRIPTION_CHARS
				? `${playbook.description.slice(0, MAX_PLAYBOOK_DESCRIPTION_CHARS - 1)}…`
				: playbook.description;
		return `- ${playbook.filename} — ${description}`;
	});
	return ["For Pipiclaw mechanisms, read the matching file with `read` under:", PLAYBOOKS_DIR, "", ...entries].join(
		"\n",
	);
}

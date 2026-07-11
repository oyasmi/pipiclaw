import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PLAYBOOKS_DIR } from "../paths.js";

export interface RuntimePlaybookMetadata {
	name: string;
	description: string;
	filename: string;
	path: string;
}

function parseFrontmatter(content: string, filename: string): Pick<RuntimePlaybookMetadata, "name" | "description"> {
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
	return { name, description };
}

/** Load the small always-on catalog; playbook bodies remain on disk until the agent reads one. */
export function loadRuntimePlaybookCatalog(directory = PLAYBOOKS_DIR): RuntimePlaybookMetadata[] {
	return readdirSync(directory)
		.filter((filename) => filename.endsWith(".md"))
		.sort()
		.map((filename) => {
			const path = join(directory, filename);
			return { ...parseFrontmatter(readFileSync(path, "utf-8"), filename), filename, path };
		});
}

export function renderRuntimePlaybookIndex(directory = PLAYBOOKS_DIR): string {
	return loadRuntimePlaybookCatalog(directory)
		.map((playbook) => `- ${playbook.filename} — ${playbook.description}`)
		.join("\n");
}

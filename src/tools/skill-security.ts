import { resolve } from "node:path";

export interface SkillValidationResult {
	ok: boolean;
	error?: string;
}

const SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const ALLOWED_SUPPORTING_DIRS = new Set(["references", "templates", "scripts", "assets"]);
const BLOCKED_CONTENT_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
	{ pattern: /ignore\s+(all\s+)?(previous|prior)\s+instructions/i, message: "contains prompt-injection wording" },
	{
		pattern: /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions|rules)/i,
		message: "contains prompt-injection wording",
	},
	{ pattern: /you\s+are\s+now\s+(a|an|the)\s+/i, message: "contains prompt-injection wording" },
	{ pattern: /new\s+system\s+prompt/i, message: "contains prompt-injection wording" },
	{ pattern: /exfiltrat(e|ion)|steal\s+(secrets?|credentials?|tokens?)/i, message: "contains exfiltration wording" },
	{ pattern: /rm\s+-rf\s+\/(?:\s|$)/i, message: "contains destructive root removal command" },
	{ pattern: /curl\b[\s\S]{0,120}\|\s*(?:sh|bash)\b/i, message: "contains pipe-to-shell install command" },
	{ pattern: /wget\b[\s\S]{0,120}\|\s*(?:sh|bash)\b/i, message: "contains pipe-to-shell install command" },
	{
		pattern: /cat\s+.*(?:\.env|id_rsa|id_ed25519|credentials|\.ssh\/|\.aws\/)/i,
		message: "contains credential file access",
	},
	{ pattern: /chmod\s+(?:777|[+]s)\b/i, message: "contains dangerous permission change" },
	{ pattern: /dd\s+if=.*of=\/dev\//i, message: "contains raw device write command" },
	{ pattern: /\b(?:mkfs|fdisk)\b/i, message: "contains disk formatting command" },
	{ pattern: /[\u200B-\u200D\uFEFF]/u, message: "contains invisible unicode characters" },
];

function ok(): SkillValidationResult {
	return { ok: true };
}

function fail(error: string): SkillValidationResult {
	return { ok: false, error };
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } | null {
	const match = content.replace(/\r\n/g, "\n").match(FRONTMATTER_REGEX);
	if (!match) {
		return null;
	}

	const data: Record<string, string> = {};
	for (const line of (match[1] ?? "").split("\n")) {
		const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!fieldMatch) {
			continue;
		}
		data[fieldMatch[1]!] = fieldMatch[2]!.replace(/^["']|["']$/g, "").trim();
	}

	return { data, body: match[2] ?? "" };
}

export function validateSkillName(name: string): SkillValidationResult {
	if (!SKILL_NAME_REGEX.test(name)) {
		return fail("Skill name must match [a-z0-9]+(-[a-z0-9]+)*.");
	}
	return ok();
}

export function validateSkillFrontmatter(content: string, expectedName: string): SkillValidationResult {
	const parsed = parseFrontmatter(content);
	if (!parsed) {
		return fail("SKILL.md must start with YAML frontmatter.");
	}
	if (parsed.data.name !== expectedName) {
		return fail(`Skill frontmatter name must be "${expectedName}".`);
	}
	if (!parsed.data.description) {
		return fail("Skill frontmatter must include a non-empty description.");
	}
	if (!parsed.body.trim()) {
		return fail("Skill body must be non-empty.");
	}
	return ok();
}

export function resolveSkillPath(workspaceDir: string, name: string): string {
	const result = validateSkillName(name);
	if (!result.ok) {
		throw new Error(result.error);
	}
	const skillsDir = resolve(workspaceDir, "skills");
	const skillDir = resolve(skillsDir, name);
	if (skillDir !== resolve(skillsDir, name) || !skillDir.startsWith(`${skillsDir}/`)) {
		throw new Error("Resolved skill path escaped workspace skills directory.");
	}
	return skillDir;
}

export function resolveSkillSupportingFile(skillDir: string, filePath: string): string {
	const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized || normalized.includes("..")) {
		throw new Error("Supporting file path must not be empty or contain '..'.");
	}
	const [topLevel] = normalized.split("/");
	if (!topLevel || !ALLOWED_SUPPORTING_DIRS.has(topLevel)) {
		throw new Error("Supporting files must live under references/, templates/, scripts/, or assets/.");
	}

	const base = resolve(skillDir);
	const resolved = resolve(base, normalized);
	if (!resolved.startsWith(`${base}/`)) {
		throw new Error("Supporting file path escaped the skill directory.");
	}
	return resolved;
}

export function scanSkillContent(content: string): SkillValidationResult {
	for (const { pattern, message } of BLOCKED_CONTENT_PATTERNS) {
		if (pattern.test(content)) {
			return fail(message);
		}
	}
	return ok();
}

export function validateSkillMarkdown(content: string, expectedName: string): SkillValidationResult {
	const frontmatter = validateSkillFrontmatter(content, expectedName);
	if (!frontmatter.ok) {
		return frontmatter;
	}
	return scanSkillContent(content);
}

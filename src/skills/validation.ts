/** Content scan shared by both skill sources. This is catalog policy, not a sandbox. */
export interface SkillValidationResult {
	ok: boolean;
	error?: string;
}

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

export function scanSkillContent(content: string): SkillValidationResult {
	for (const { pattern, message } of BLOCKED_CONTENT_PATTERNS) {
		if (pattern.test(content)) {
			return { ok: false, error: message };
		}
	}
	return { ok: true };
}

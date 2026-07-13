const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
	/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}\b/g,
	/\b(?:ghp|github_pat|glpat)_[A-Za-z0-9_-]{16,}\b/g,
	/\bAKIA[A-Z0-9]{16}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
	/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

export const REDACTED_SECRET = "[REDACTED_SECRET]";

export function redactSecrets(text: string): string {
	let redacted = text;
	for (const pattern of SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, REDACTED_SECRET);
	}
	return redacted;
}

export function containsSecret(text: string): boolean {
	return redactSecrets(text) !== text;
}

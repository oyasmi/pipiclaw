/** One `Label: value` line in a security-guard block message. */
export interface BlockMessageDetail {
	label: string;
	value: string;
}

/**
 * Shared scaffold for a guard's user/model-facing block message: `"<Subject> blocked [category]"`
 * followed by one line per detail. Used by both the path guard and the command guard so their
 * wording does not drift line by line as each grows its own detail set.
 */
export function formatBlockMessage(
	subject: string,
	category: string | undefined,
	details: BlockMessageDetail[],
): string {
	const lines = [`${subject} blocked${category ? ` [${category}]` : ""}`];
	for (const detail of details) {
		lines.push(`${detail.label}: ${detail.value}`);
	}
	return lines.join("\n");
}

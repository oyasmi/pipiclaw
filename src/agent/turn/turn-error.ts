/**
 * Turn-failure classification for the user's error bubble (spec 053, D5.1).
 *
 * A raw provider error ("401 invalid x-api-key", "429 rate_limit_error", "prompt is too long")
 * tells the user nothing they can act on. The bubble now leads with a class and the one or two
 * things the user (or the deployer, on the server) can actually do about it; the raw text is kept
 * as a short quoted line for whoever has to debug it.
 *
 * Only stable features are matched — HTTP status codes and the phrases providers have used for
 * years. Anything unrecognised is `other`, which still carries a next step.
 */
export type TurnErrorKind = "auth" | "rate_limit" | "context_overflow" | "network" | "other";

const PATTERNS: ReadonlyArray<[Exclude<TurnErrorKind, "other">, RegExp]> = [
	[
		"auth",
		/\b40[13]\b|unauthori[sz]ed|forbidden|invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|authentication[ _-]?(?:error|failed)|(?:token|credential)s? (?:has |have )?expired/i,
	],
	[
		"context_overflow",
		/context[ _-]?length|context window|too many tokens|prompt is too long|input is too long|maximum context|exceeds? the (?:model's )?(?:maximum|context)/i,
	],
	[
		"rate_limit",
		/\b429\b|\b529\b|rate[ _-]?limit|too many requests|quota|insufficient[ _-]?(?:quota|balance|credit|funds)|overloaded/i,
	],
	[
		"network",
		/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|timed out|\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway timeout/i,
	],
];

export function classifyTurnError(message: string): TurnErrorKind {
	for (const [kind, pattern] of PATTERNS) {
		if (pattern.test(message)) return kind;
	}
	return "other";
}

/** What the user is told for each class: a reason (absent for `other`) and what to do next. */
export function describeTurnError(kind: TurnErrorKind): { reason?: string; nextStep: string } {
	switch (kind) {
		case "auth":
			return {
				reason: "模型凭据无效或已过期。",
				nextStep: "请部署者在服务器上执行 `pipiclaw auth login`，或用 `/model` 换一个模型。",
			};
		case "rate_limit":
			return { reason: "模型暂时限流或额度不足。", nextStep: "稍后重发，或用 `/model` 换一个模型。" };
		case "context_overflow":
			return { reason: "会话上下文已满。", nextStep: "用 `/compact` 压缩，或用 `/new` 开新会话。" };
		case "network":
			return { reason: "连不上模型服务。", nextStep: "稍后重发；持续出现请检查服务器网络或代理。" };
		case "other":
			return { nextStep: "可以重发一次；持续出现请用 `/status` 查看模型状态。" };
	}
}

function quoteRaw(text: string): string {
	const flat = text.replace(/`/g, "'").replace(/\s+/g, " ").trim();
	return `\`${flat.length > 240 ? `${flat.slice(0, 239)}…` : flat}\``;
}

export interface TurnErrorReplyInput {
	errorMessage: string;
	/** A failed recovery compaction whose error differs from the turn's own. */
	compactionError?: string;
	/** The fallback model already tried, when the runner switched to one. */
	fallbackRef?: string;
}

/** The error bubble: class + next step first, the raw provider text last (spec 053, D5.1). */
export function renderTurnErrorReply(input: TurnErrorReplyInput): string {
	const { reason, nextStep } = describeTurnError(classifyTurnError(input.errorMessage));
	const lines = [reason ? `处理失败：${reason}` : "处理失败。", nextStep];
	if (input.fallbackRef) lines.push(`已切换备用模型 \`${input.fallbackRef}\` 重试，仍失败。`);
	lines.push(`原始错误：${quoteRaw(input.errorMessage)}`);
	if (input.compactionError) lines.push(`压缩重试的错误：${quoteRaw(input.compactionError)}`);
	return lines.join("\n");
}

/** The progress line for a failed automatic compaction. */
export function renderCompactionFailure(errorMessage: string): string {
	const { reason } = describeTurnError(classifyTurnError(errorMessage));
	return reason ? `上下文压缩失败：${reason}` : "上下文压缩失败。";
}

/** The line shown when the runner switches to the fallback model mid-turn; the raw error goes to the log. */
export function renderFallbackSwitch(from: string, to: string, errorMessage: string): string {
	const { reason } = describeTurnError(classifyTurnError(errorMessage));
	return `模型 \`${from}\` 请求失败${reason ? `：${reason}` : "。"}改用 \`${to}\` 重试…`;
}

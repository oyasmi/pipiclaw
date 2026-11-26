import type { ExternalFailureKind, SettleInput } from "../run-record.js";
import type { ExternalOutcome } from "./harness.js";

type FailureEvidence = Pick<
	ExternalOutcome,
	"protocolStatus" | "exitCode" | "errorMessage" | "stderrTail" | "resumeMismatch" | "authRefused" | "quotaRefused"
> & {
	terminationReason?: "timeout" | "cancelled";
	requiresProtocolTerminal: boolean;
};

const RESUME_REJECTED =
	/\b(?:no (?:conversation|chat) found with session id|no such thread|(?:session|conversation|thread|chat) [^\r\n]*?\bnot found|invalid session|session_not_found)\b/i;
const AUTH_REQUIRED =
	/\b(?:401|403|unauthorized|unauthenticated|invalid[ _]api[ _]key|auth_required|authentication[ _](?:failed|required)|not logged in|logged out|oauth[^\r\n]*?\b(?:expired|revoked)|please (?:sign|log) in)\b/i;
const QUOTA_EXCEEDED =
	/\b(?:usage_limit_reached|usage limit|hit your [^\r\n]*?\b(?:limit|budget)|(?:weekly|daily|monthly|session|5[- ]hour) limit reached|out of (?:usage|credits|extra usage)|402|insufficient_funds|quota(?:_exceeded)?|billing)\b/i;
const INVALID_MODEL =
	/\b(?:model[ _]not[ _]found|unknown model|unsupported model|provider\.no-route|does not exist for model)\b/i;
const TRANSIENT_UPSTREAM =
	/\b(?:429|rate[_ -]limit(?:_exceeded)?|too many requests|overloaded|529|500|502|503|504|service unavailable|bad gateway|econnreset|econnrefused|socket hang up|fetch failed|unexpected_eof)\b/i;

/** Classify failure diagnostics only. Assistant output does not enter this decision. */
export function classifyExternalFailure(input: FailureEvidence): ExternalFailureKind {
	const diagnostic = [input.errorMessage, input.stderrTail].filter(Boolean).join("\n");
	if (input.terminationReason === "timeout") return "timeout";
	if (input.resumeMismatch || RESUME_REJECTED.test(diagnostic)) return "resume_rejected";
	if (input.authRefused || AUTH_REQUIRED.test(diagnostic)) return "auth_required";
	if (input.quotaRefused || QUOTA_EXCEEDED.test(diagnostic)) return "quota_exceeded";
	if (INVALID_MODEL.test(diagnostic)) return "invalid_model";
	if (
		input.protocolStatus === "unparsable" ||
		(input.requiresProtocolTerminal && input.exitCode === 0 && input.protocolStatus === "absent")
	) {
		return "schema_drift";
	}
	if (TRANSIENT_UPSTREAM.test(diagnostic)) return "transient_upstream";
	return "runtime_error";
}

export function isPreExecutionFailure(
	outcome: ExternalOutcome,
	status: SettleInput["status"],
	kind: ExternalFailureKind | undefined,
	requiresProtocolTerminal: boolean,
): boolean {
	const usage = outcome.usage;
	return (
		status === "failed" &&
		kind !== "timeout" &&
		requiresProtocolTerminal &&
		outcome.preExecution !== false &&
		outcome.observedExecutionActivity === false &&
		!outcome.observedNonZeroUsage &&
		(usage?.input ?? 0) === 0 &&
		(usage?.output ?? 0) === 0 &&
		(usage?.cacheRead ?? 0) === 0 &&
		(usage?.cacheWrite ?? 0) === 0 &&
		(usage?.total ?? 0) === 0 &&
		(!outcome.costKnown || usage?.cost?.total === 0)
	);
}

const FAILURE_GUIDANCE: Record<ExternalFailureKind, { model: string; zh: string; actionZh: string }> = {
	auth_required: {
		model: "Do not retry automatically; report to the user that the external CLI needs re-authentication.",
		zh: "需要重新登录",
		actionZh: "请在服务所在机器重新登录外部 CLI，再发消息委派。",
	},
	quota_exceeded: {
		model: "Do not retry automatically; report to the user that the external CLI quota or usage limit is exhausted.",
		zh: "额度已用尽",
		actionZh: "请等额度恢复或调整订阅，再发消息委派。",
	},
	invalid_model: {
		model: "Do not retry with the same role; report the invalid model configuration to the user.",
		zh: "模型配置无效",
		actionZh: "请让部署者更新该角色的模型配置，再发消息委派。",
	},
	resume_rejected: {
		model: "Do not call follow_up on this run again; start a fresh subagent delegation carrying the needed context.",
		zh: "会话无法继续",
		actionZh: "请发消息说明要继续的工作，我会带上必要的上下文重新委派。",
	},
	transient_upstream: {
		model: "Failed mid-run with a transient upstream error; inspect artifacts/workspace before deciding whether to follow_up or retry.",
		zh: "上游服务暂时异常",
		actionZh: "请先核对委派产物，再决定是否重试。",
	},
	schema_drift: {
		model: "CLI output did not match the expected protocol; inspect subagent_run op=show and events.jsonl before retrying.",
		zh: "CLI 输出协议不匹配",
		actionZh: "请让部署者检查 CLI 版本和产物目录里的 `events.jsonl`。",
	},
	timeout: {
		model: "Hit wall-time budget; inspect partial output/worktree, then follow_up or split the task.",
		zh: "超过运行时限",
		actionZh: "请查看当前产物，再决定是否继续或拆分工作。",
	},
	runtime_error: {
		model: "Inspect subagent_run op=show or stderr.log before retrying.",
		zh: "运行出错",
		actionZh: "请查看下方错误日志或产物目录里的 `stderr.log`。",
	},
};

export function formatFailureGuidance(kind: string, preExecution?: boolean): string | undefined {
	if (!Object.hasOwn(FAILURE_GUIDANCE, kind)) return undefined;
	if (kind === "transient_upstream" && preExecution) {
		return "Failed before execution with a transient upstream error (no side effects observed); safe to retry once.";
	}
	return FAILURE_GUIDANCE[kind as ExternalFailureKind].model;
}

export function formatFailureKindZh(kind: ExternalFailureKind): string {
	return FAILURE_GUIDANCE[kind]?.zh ?? FAILURE_GUIDANCE.runtime_error.zh;
}

export function formatFailureGuidanceZh(kind: ExternalFailureKind, preExecution?: boolean): string {
	if (kind === "transient_upstream" && preExecution) return "请稍后发消息重试一次。";
	return FAILURE_GUIDANCE[kind]?.actionZh ?? FAILURE_GUIDANCE.runtime_error.actionZh;
}

export function blocksExternalFollowUp(kind: ExternalFailureKind | undefined): boolean {
	return (
		kind === "resume_rejected" || kind === "auth_required" || kind === "quota_exceeded" || kind === "invalid_model"
	);
}

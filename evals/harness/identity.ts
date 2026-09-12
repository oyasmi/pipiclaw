import { isRecoverableRejection } from "../../src/tools/tool-details.js";
import type { TraceEvent } from "./schema.js";

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function traceToolResultFailed(tool: unknown, isError: unknown, result: unknown): boolean {
	const details = record(record(result).details);
	const exitCode = typeof details.exitCode === "number" ? details.exitCode : undefined;
	return (
		isError !== false ||
		isRecoverableRejection(result) ||
		(tool === "bash" && exitCode !== undefined && exitCode !== 0)
	);
}

export function traceIdentity(options: {
	caseId: string;
	channelId: string;
	segment: number;
	stepIndex: number;
	sessionId?: string;
	actorId?: string;
	callId?: string;
	parentCallId?: string;
	purpose?: string;
}): Pick<TraceEvent, "stepId" | "sessionId" | "channelId" | "actorId" | "callId" | "parentCallId" | "purpose"> {
	return {
		stepId: options.stepIndex >= 0 ? `${options.caseId}:step-${options.stepIndex + 1}` : undefined,
		sessionId: options.sessionId ?? `${options.caseId}:${options.channelId}:segment-${options.segment}`,
		channelId: options.channelId,
		actorId: options.actorId ?? "main-agent",
		callId: options.callId,
		parentCallId: options.parentCallId,
		purpose: options.purpose,
	};
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { isTestFailureSignal, SHELL_REDIRECT } from "../harness/evidence.js";
import type { TraceEvent, TrialContext } from "../harness/schema.js";
import { hashFile } from "../harness/util.js";

export interface ToolObservation {
	call: TraceEvent;
	result: TraceEvent;
}

/** Arguments are only proposals. Decisions that need an observation must join the actual reply. */
export function toolObservations(ctx: TrialContext, tool?: string): ToolObservation[] {
	return ctx.trace
		.filter((event) => event.kind === "tool-call" && (!tool || event.tool === tool) && event.correlationId)
		.flatMap((call) => {
			const result = ctx.trace.find(
				(event) =>
					event.kind === "tool-result" &&
					event.tool === call.tool &&
					event.correlationId === call.correlationId &&
					event.seq > call.seq,
			);
			return result ? [{ call, result }] : [];
		});
}

export function callPath(call: TraceEvent): string {
	return (call.fields?.path ?? call.fields?.file_path ?? "").replaceAll("\\", "/");
}

export function observesFile(ctx: TrialContext, path: string, content: RegExp, stepIndex?: number): boolean {
	return toolObservations(ctx).some(({ call, result }) => {
		if (!result.ok || (stepIndex !== undefined && call.stepIndex !== stepIndex)) return false;
		const command = call.fields?.command ?? "";
		const matchesPath = callPath(call) === path || callPath(call).endsWith(`/${path}`);
		const reads =
			(call.tool === "read" && matchesPath) ||
			(call.tool === "bash" &&
				command.includes(path) &&
				/\b(cat|xxd|od|hexdump|strings|file|readFile(?:Sync)?)\b/.test(command));
		return reads && content.test(result.fields?.detail ?? "");
	});
}

/** Steps the lane saw end waiting for the user (`ask`) or for bound work (`work`). */
export function taskParkObservations(ctx: TrialContext, kind: "ask" | "work") {
	const next = kind === "ask" ? "user" : "work";
	return ctx.trace.filter((event) => event.fields?.taskStep === "ended" && event.fields?.stepNext === next);
}

export function sourceMutation(call: TraceEvent): boolean {
	if (call.kind !== "tool-call") return false;
	if (["write", "edit"].includes(call.tool ?? "")) return /(?:^|\/)src\/paginate\.js$/.test(callPath(call));
	const command = call.fields?.command ?? "";
	return (
		call.tool === "bash" &&
		/src\/paginate\.js/.test(command) &&
		(/write_text|writeFile|\bsed\s+-i|\bperl\s+-[a-z]*i|\b(?:cp|mv)\b/.test(command) || SHELL_REDIRECT.test(command))
	);
}

export function isVerificationCommand(call: TraceEvent): boolean {
	const command = call.fields?.command ?? "";
	if (call.tool !== "bash" || /^\s*(?:echo|printf)\b/.test(command)) return false;
	return /\bnode\b[^\n]*--test(?:\s|$)|\bnpm\s+(?:run\s+)?test\b|\bnode\b[^\n]*(?:public\.test|pagination-evaluator)|\bnode\b[\s\S]*(?:paginate|pagination)[\s\S]*(?:assert|deepEqual|test)|\bnode\b[\s\S]*(?:assert|deepEqual|test)[\s\S]*paginate/.test(
		command,
	);
}

export function verificationObservations(ctx: TrialContext) {
	return toolObservations(ctx, "bash").filter(({ call }) => isVerificationCommand(call));
}

/** The successful verification must be the one that hashed the source bytes still on disk. */
export function verificationBoundToSource(ctx: TrialContext, afterSeq: number): boolean | "missing" {
	const runs = verificationObservations(ctx).filter(({ call, result }) => call.seq > afterSeq && result.ok === true);
	if (!runs.length) return false;
	const bound = runs.some(({ result }) => {
		const digest = result.fields?.sourceDigest;
		if (!digest) return false;
		const path = join(ctx.workspaceDir, "src/paginate.js");
		return existsSync(path) && digest === hashFile(path);
	});
	if (runs.every((run) => !run.result.fields?.sourceDigest)) return "missing";
	return bound;
}

export function observedTestFailure(ctx: TrialContext, beforeSeq: number): boolean | "missing" {
	const runs = verificationObservations(ctx).filter(({ result }) => result.seq < beforeSeq);
	if (!runs.length) return "missing";
	return runs.some(({ result }) => isTestFailureSignal(result.fields?.detail ?? ""));
}

export function stepDeliveries(ctx: TrialContext, stepIndex: number) {
	return ctx.deliveries.filter(
		(delivery) =>
			delivery.stepIndex === stepIndex &&
			["sendPlain", "finalizeCard", "finalizeExistingCard"].includes(delivery.method),
	);
}

export function checkpointHasFile(ctx: TrialContext, checkpoint: string, path: string): boolean | undefined {
	const event = ctx.trace.find((event) => event.kind === "runtime-log" && event.fields?.checkpoint === checkpoint);
	if (!event?.fields?.fileTree) return;
	const entries = JSON.parse(event.fields.fileTree) as Array<{ path: string }>;
	return entries.some((entry) => entry.path.replaceAll("\\", "/") === path);
}

/** SDK receipt of the addressed user message is sealed in the trace for offline replay. */
export function receivedRunResult(ctx: TrialContext, runId: string, token: string): boolean {
	return ctx.trace.some(
		(event) =>
			event.kind === "runtime-log" &&
			event.actorId === "main-agent" &&
			event.fields?.receivedUserMessage?.includes(`[SUBAGENT:${runId}]`) === true &&
			event.fields.receivedUserMessage.includes(token),
	);
}

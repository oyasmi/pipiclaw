import type { TraceEvent, TrialContext } from "../harness/schema.js";

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

export function taskParkObservations(ctx: TrialContext, kind: "ask" | "work") {
	return toolObservations(ctx, "task_step_end").filter(({ call, result }) => {
		if (!result.ok) return false;
		try {
			const args = JSON.parse(call.fields?.argsJson ?? "null") as {
				outcome?: string;
				ticket?: { kind?: string };
			} | null;
			return args?.outcome === "park" && args.ticket?.kind === kind;
		} catch {
			return false;
		}
	});
}

export function sourceMutation(call: TraceEvent): boolean {
	if (call.kind !== "tool-call") return false;
	if (["write", "edit"].includes(call.tool ?? "")) return /(?:^|\/)src\/paginate\.js$/.test(callPath(call));
	const command = call.fields?.command ?? "";
	return (
		call.tool === "bash" &&
		/src\/paginate\.js/.test(command) &&
		/write_text|writeFile|\bsed\s+-i|\bperl\s+-[a-z]*i|\b(?:cp|mv)\b|>/.test(command)
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

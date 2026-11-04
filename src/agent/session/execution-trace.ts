import { randomUUID } from "node:crypto";
import * as log from "../../log.js";
import { isRecord } from "../../shared/type-guards.js";
import type { RunnerProfile } from "../types.js";

/** Request, batch and runner identifiers shared by provider and tool execution logs. */
export class SessionExecutionTrace {
	readonly generation = randomUUID();
	private request = 0;
	private startedAt = 0;
	private firstOutput = false;

	constructor(
		private readonly profile: RunnerProfile,
		private readonly context: () => Record<string, unknown>,
	) {}

	fields(): Record<string, unknown> {
		let seq: number | undefined;
		if (this.profile.kind === "task") {
			try {
				seq = this.profile.session.seq();
			} catch {
				// Tools may be built before a step begins or after it has stopped.
			}
		}
		return {
			...this.context(),
			generation: this.generation,
			profile: this.profile.kind,
			...(this.profile.kind === "task" ? { taskId: this.profile.session.taskId, seq } : {}),
			request: this.request,
			batch: this.request,
		};
	}

	startRequest(): void {
		this.request++;
		this.startedAt = Date.now();
		this.firstOutput = false;
		log.logEvent("debug", "agent.provider.started", "Provider request started", { fields: this.fields() });
	}

	observe(event: unknown): void {
		if (!isRecord(event)) return;
		if (event.type === "tool_execution_start") {
			log.logEvent("debug", "agent.tool.preparing", "Tool preparation started", {
				fields: { ...this.fields(), toolCallId: event.toolCallId, tool: event.toolName },
			});
		}
		if (
			!this.firstOutput &&
			event.type === "message_update" &&
			isRecord(event.assistantMessageEvent) &&
			String(event.assistantMessageEvent.type).endsWith("_delta")
		) {
			this.firstOutput = true;
			log.logEvent("debug", "agent.provider.output", "Provider first output observed", {
				fields: { ...this.fields(), elapsedMs: Date.now() - this.startedAt },
			});
		}
	}
}

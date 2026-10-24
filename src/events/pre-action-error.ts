/** Why an event's pre-action gate did not let the occurrence through: it blocked it, or it failed. */
export class EventPreActionError extends Error {
	readonly kind: "blocked" | "failed";
	readonly exitCode?: number;
	readonly durationMs?: number;

	constructor(kind: "blocked" | "failed", message: string, options: { exitCode?: number; durationMs?: number } = {}) {
		super(message);
		this.name = "EventPreActionError";
		this.kind = kind;
		this.exitCode = options.exitCode;
		this.durationMs = options.durationMs;
	}
}

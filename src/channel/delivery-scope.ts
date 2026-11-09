/** A delivery owner is frozen at admission; a channel address alone is never an owner. */
import { createHash } from "node:crypto";
import { isDeskName } from "../desk/paths.js";
import type { TurnEvent } from "./channel-context.js";

export interface DeliveryScopeRef {
	readonly desk: string;
	readonly channelId: string;
	readonly scopeId: `request:${string}` | `task:${string}`;
}

export function isDeliveryScopeRef(value: unknown): value is DeliveryScopeRef {
	if (!value || typeof value !== "object") return false;
	const ref = value as Record<string, unknown>;
	return (
		typeof ref.desk === "string" &&
		isDeskName(ref.desk) &&
		typeof ref.channelId === "string" &&
		ref.channelId.length > 0 &&
		typeof ref.scopeId === "string" &&
		/^(request|task):[^\s/\\]+$/.test(ref.scopeId)
	);
}

/** Also safe as a filename: channel ids are addresses, never path segments. */
export function deliveryScopeKey(ref: DeliveryScopeRef): string {
	return createHash("sha256")
		.update(JSON.stringify([ref.desk, ref.channelId, ref.scopeId]))
		.digest("hex");
}

export function sameDeliveryScope(a: DeliveryScopeRef | undefined, b: DeliveryScopeRef | undefined): boolean {
	return a === undefined || b === undefined ? a === b : deliveryScopeKey(a) === deliveryScopeKey(b);
}

/** Confirmed means the adapter observed success, never local enqueue or human visibility. */
export type ScopeDeliveryResult = { status: "confirmed" } | { status: "unknown" | "blocked" };
export interface FinalIntent {
	id: string;
	text: string;
}
export interface ScopeWriter {
	/** A task report acknowledges a remote card update or an explicit compatibility send. */
	report(intent: FinalIntent): Promise<ScopeDeliveryResult>;
	emit(event: TurnEvent): void;
	flush(): Promise<ScopeDeliveryResult>;
	finalize(intent: FinalIntent): Promise<ScopeDeliveryResult>;
	close(): Promise<void>;
}
export interface ScopeDeliveryPort {
	/** Recovered scopes must not blindly create a replacement for a possibly visible old card. */
	open(owner: DeliveryScopeRef, recovered: boolean, canWrite: () => boolean): ScopeWriter;
}

/** Read from the existing run/job records, which remain the sole owners of work settlement. */
export interface ScopeWork {
	ref: string;
	pending: boolean;
	/** Omitted for an inline result or notify=false work, already consumed by its calling turn. */
	completionId?: string;
}

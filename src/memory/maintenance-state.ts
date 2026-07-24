import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";

export interface MemoryMaintenanceState {
	channelId: string;
	dirty: boolean;
	lastActivityAt?: string;
	eligibleAfter?: string;
	lastSessionRefreshAt?: string;
	lastCheckpointAt?: string;
	lastStructuralMaintenanceAt?: string;
	turnsSinceSessionRefresh: number;
	toolCallsSinceSessionRefresh: number;
	lastSessionEntryId?: string;
	lastSessionRefreshedEntryId?: string;
	lastCheckpointEntryId?: string;
	failureBackoffUntil?: string | null;
}

export type MemoryActivityKind = "user-turn-started" | "tool-call" | "assistant-turn-completed" | "boundary";

export interface MemoryActivityEvent {
	kind: MemoryActivityKind;
	channelId: string;
	timestamp: string;
	eligibleAfter?: string;
	latestSessionEntryId?: string;
}

const stateUpdateQueue = createSerialQueue<string>();

export function getMemoryMaintenanceStateDir(appHomeDir: string): string {
	return join(appHomeDir, "state", "memory");
}

export function getMemoryMaintenanceStatePath(appHomeDir: string, channelId: string): string {
	return join(getMemoryMaintenanceStateDir(appHomeDir), `${channelId}.json`);
}

function createDefaultState(channelId: string): MemoryMaintenanceState {
	return {
		channelId,
		dirty: false,
		turnsSinceSessionRefresh: 0,
		toolCallsSinceSessionRefresh: 0,
		failureBackoffUntil: null,
	};
}

function normalizeOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeOptionalNullableString(value: unknown): string | null | undefined {
	if (value === null) {
		return null;
	}
	return normalizeOptionalString(value);
}

function normalizeCounter(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function laterTimestamp(a: string | undefined, b: string | undefined): string | undefined {
	if (!a) return b;
	if (!b) return a;
	return Date.parse(a) >= Date.parse(b) ? a : b;
}

function normalizeState(channelId: string, value: unknown): MemoryMaintenanceState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return createDefaultState(channelId);
	}
	const record = value as Record<string, unknown>;
	return {
		channelId,
		dirty: typeof record.dirty === "boolean" ? record.dirty : false,
		lastActivityAt: normalizeOptionalString(record.lastActivityAt),
		eligibleAfter: normalizeOptionalString(record.eligibleAfter),
		lastSessionRefreshAt: normalizeOptionalString(record.lastSessionRefreshAt),
		// Legacy states carried separate consolidation/growth-review fields; fold them
		// into the merged checkpoint so cadence and cursor survive the migration.
		lastCheckpointAt:
			normalizeOptionalString(record.lastCheckpointAt) ??
			laterTimestamp(
				normalizeOptionalString(record.lastDurableConsolidationAt),
				normalizeOptionalString(record.lastGrowthReviewAt),
			),
		lastStructuralMaintenanceAt: normalizeOptionalString(record.lastStructuralMaintenanceAt),
		turnsSinceSessionRefresh: normalizeCounter(record.turnsSinceSessionRefresh),
		toolCallsSinceSessionRefresh: normalizeCounter(record.toolCallsSinceSessionRefresh),
		lastSessionEntryId: normalizeOptionalString(record.lastSessionEntryId),
		lastSessionRefreshedEntryId: normalizeOptionalString(record.lastSessionRefreshedEntryId),
		lastCheckpointEntryId:
			normalizeOptionalString(record.lastCheckpointEntryId) ??
			normalizeOptionalString(record.lastConsolidatedEntryId) ??
			normalizeOptionalString(record.lastReviewedEntryId),
		failureBackoffUntil: normalizeOptionalNullableString(record.failureBackoffUntil) ?? null,
	};
}

export async function readMemoryMaintenanceState(
	appHomeDir: string,
	channelId: string,
): Promise<MemoryMaintenanceState> {
	const path = getMemoryMaintenanceStatePath(appHomeDir, channelId);
	try {
		const raw = await readFile(path, "utf-8");
		return normalizeState(channelId, JSON.parse(raw) as unknown);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return createDefaultState(channelId);
		}
		const message = errorMessage(error);
		log.logWarning(`[${channelId}] Failed to read memory maintenance state; rebuilding defaults`, message);
		return createDefaultState(channelId);
	}
}

export async function updateMemoryMaintenanceState(
	appHomeDir: string,
	channelId: string,
	update: (state: MemoryMaintenanceState) => MemoryMaintenanceState,
): Promise<MemoryMaintenanceState> {
	const path = getMemoryMaintenanceStatePath(appHomeDir, channelId);
	return stateUpdateQueue.run(path, async () => {
		const current = await readMemoryMaintenanceState(appHomeDir, channelId);
		const next = normalizeState(channelId, update(current));
		await writeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
		return next;
	});
}

export function applyMemoryActivityToState(
	state: MemoryMaintenanceState,
	event: MemoryActivityEvent,
): MemoryMaintenanceState {
	const next: MemoryMaintenanceState = {
		...state,
		channelId: event.channelId,
		lastActivityAt: event.timestamp,
		eligibleAfter: event.eligibleAfter ?? state.eligibleAfter,
		lastSessionEntryId: event.latestSessionEntryId ?? state.lastSessionEntryId,
	};

	if (event.kind === "tool-call") {
		next.dirty = true;
		next.toolCallsSinceSessionRefresh += 1;
	}
	if (event.kind === "assistant-turn-completed") {
		next.dirty = true;
		next.turnsSinceSessionRefresh += 1;
	}
	if (event.kind === "boundary") {
		next.dirty = true;
	}

	return next;
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as log from "../log.js";

export interface MemoryMaintenanceState {
	channelId: string;
	dirty: boolean;
	lastActivityAt?: string;
	eligibleAfter?: string;
	lastSessionRefreshAt?: string;
	lastDurableConsolidationAt?: string;
	lastGrowthReviewAt?: string;
	lastStructuralMaintenanceAt?: string;
	turnsSinceSessionRefresh: number;
	toolCallsSinceSessionRefresh: number;
	turnsSinceGrowthReview: number;
	toolCallsSinceGrowthReview: number;
	lastSessionEntryId?: string;
	lastSessionRefreshedEntryId?: string;
	lastConsolidatedEntryId?: string;
	lastReviewedEntryId?: string;
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

const updateChains = new Map<string, Promise<void>>();

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
		turnsSinceGrowthReview: 0,
		toolCallsSinceGrowthReview: 0,
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
		lastDurableConsolidationAt: normalizeOptionalString(record.lastDurableConsolidationAt),
		lastGrowthReviewAt: normalizeOptionalString(record.lastGrowthReviewAt),
		lastStructuralMaintenanceAt: normalizeOptionalString(record.lastStructuralMaintenanceAt),
		turnsSinceSessionRefresh: normalizeCounter(record.turnsSinceSessionRefresh),
		toolCallsSinceSessionRefresh: normalizeCounter(record.toolCallsSinceSessionRefresh),
		turnsSinceGrowthReview: normalizeCounter(record.turnsSinceGrowthReview),
		toolCallsSinceGrowthReview: normalizeCounter(record.toolCallsSinceGrowthReview),
		lastSessionEntryId: normalizeOptionalString(record.lastSessionEntryId),
		lastSessionRefreshedEntryId: normalizeOptionalString(record.lastSessionRefreshedEntryId),
		lastConsolidatedEntryId: normalizeOptionalString(record.lastConsolidatedEntryId),
		lastReviewedEntryId: normalizeOptionalString(record.lastReviewedEntryId),
		failureBackoffUntil: normalizeOptionalNullableString(record.failureBackoffUntil) ?? null,
	};
}

async function writeAtomically(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tempPath, content, "utf-8");
	await rename(tempPath, path);
}

function enqueueStateUpdate<T>(path: string, work: () => Promise<T>): Promise<T> {
	const previous = updateChains.get(path) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(() => work());
	const completion = result.then(
		() => undefined,
		() => undefined,
	);
	updateChains.set(path, completion);
	completion.finally(() => {
		if (updateChains.get(path) === completion) {
			updateChains.delete(path);
		}
	});
	return result;
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
		const message = error instanceof Error ? error.message : String(error);
		log.logWarning(`[${channelId}] Failed to read memory maintenance state; rebuilding defaults`, message);
		return createDefaultState(channelId);
	}
}

export async function writeMemoryMaintenanceState(appHomeDir: string, state: MemoryMaintenanceState): Promise<void> {
	const path = getMemoryMaintenanceStatePath(appHomeDir, state.channelId);
	await enqueueStateUpdate(path, async () => {
		await writeAtomically(path, `${JSON.stringify(normalizeState(state.channelId, state), null, 2)}\n`);
	});
}

export async function updateMemoryMaintenanceState(
	appHomeDir: string,
	channelId: string,
	update: (state: MemoryMaintenanceState) => MemoryMaintenanceState,
): Promise<MemoryMaintenanceState> {
	const path = getMemoryMaintenanceStatePath(appHomeDir, channelId);
	return enqueueStateUpdate(path, async () => {
		const current = await readMemoryMaintenanceState(appHomeDir, channelId);
		const next = normalizeState(channelId, update(current));
		await writeAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
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
		next.toolCallsSinceGrowthReview += 1;
	}
	if (event.kind === "assistant-turn-completed") {
		next.dirty = true;
		next.turnsSinceSessionRefresh += 1;
		next.turnsSinceGrowthReview += 1;
	}
	if (event.kind === "boundary") {
		next.dirty = true;
	}

	return next;
}

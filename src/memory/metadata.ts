import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { createSerialQueue } from "../shared/serial-queue.js";

export type MemoryEntryKind = "fact" | "preference" | "decision" | "constraint" | "open-loop" | "lesson";
export type MemorySourceType = "user" | "agent" | "repo" | "tool" | "web" | "legacy";
export type MemoryTrust = "explicit" | "verified" | "inferred" | "untrusted";
export type MemorySensitivity = "normal" | "personal" | "secret";
export type MemoryEntryStatus = "active" | "superseded" | "invalidated" | "forgotten";

export interface MemoryWriteMetadataInput {
	kind?: MemoryEntryKind;
	subjectId?: string;
	ownerId?: string;
	sourceType?: MemorySourceType;
	trust?: MemoryTrust;
	validFrom?: string;
	expiresAt?: string;
	sensitivity?: MemorySensitivity;
	sourceCorrelationId?: string;
}

export interface MemoryEntryMetadata {
	id: string;
	kind: MemoryEntryKind;
	scope: "channel";
	subjectId?: string;
	ownerId?: string;
	sourceEntryIds: string[];
	sourceCorrelationIds: string[];
	sourceType: MemorySourceType;
	trust: MemoryTrust;
	createdAt: string;
	updatedAt: string;
	validFrom?: string;
	expiresAt?: string;
	status: MemoryEntryStatus;
	sensitivity: MemorySensitivity;
	sectionHeading: string;
	contentHash: string;
	recallCount: number;
	lastRecalledAt?: string;
	queryFingerprints: string[];
	recallByDay: Record<string, number>;
}

export interface MemoryMetadataFile {
	schemaVersion: 1;
	updatedAt: string;
	entries: Record<string, MemoryEntryMetadata>;
}

export interface MetadataEntryView {
	id: string;
	content: string;
	sectionHeading: string;
	timestamp?: string;
}

export interface MemoryMetadataUpdate {
	id: string;
	status?: MemoryEntryStatus;
	metadata?: MemoryWriteMetadataInput;
	sourceEntryIds?: string[];
}

const metadataQueue = createSerialQueue<string>();

function contentHash(content: string): string {
	return createHash("sha256").update(content.normalize("NFKC").replace(/\s+/g, " ").trim()).digest("hex");
}

function inferKind(sectionHeading: string): MemoryEntryKind {
	const section = sectionHeading.toLowerCase();
	if (section.includes("preference")) return "preference";
	if (section.includes("decision")) return "decision";
	if (section.includes("constraint")) return "constraint";
	if (section.includes("open loop") || section.includes("ongoing")) return "open-loop";
	if (section.includes("lesson") || section.includes("correction")) return "lesson";
	return "fact";
}

function emptyMetadataFile(timestamp: string): MemoryMetadataFile {
	return { schemaVersion: 1, updatedAt: timestamp, entries: {} };
}

export function getMemoryMetadataPath(channelDir: string): string {
	return join(channelDir, ".memory", "entries.json");
}

export async function readMemoryMetadata(channelDir: string): Promise<MemoryMetadataFile> {
	const timestamp = new Date().toISOString();
	const raw = await readOptionalTextFile(getMemoryMetadataPath(channelDir));
	if (!raw.trim()) return emptyMetadataFile(timestamp);
	try {
		const parsed = JSON.parse(raw) as MemoryMetadataFile;
		if (parsed.schemaVersion === 1 && parsed.entries && typeof parsed.entries === "object") return parsed;
	} catch {
		// Rebuildable from MEMORY.md on the next reconciliation.
	}
	return emptyMetadataFile(timestamp);
}

export async function syncMemoryMetadata(
	channelDir: string,
	activeEntries: MetadataEntryView[],
	updates: MemoryMetadataUpdate[] = [],
	timestamp: string = new Date().toISOString(),
): Promise<MemoryMetadataFile> {
	const path = getMemoryMetadataPath(channelDir);
	return metadataQueue.run(path, async () => {
		const current = await readMemoryMetadata(channelDir);
		const entries: Record<string, MemoryEntryMetadata> = { ...current.entries };
		const updatesById = new Map(updates.map((update) => [update.id, update]));
		const activeIds = new Set(activeEntries.map((entry) => entry.id));

		for (const entry of activeEntries) {
			const previous = entries[entry.id];
			const update = updatesById.get(entry.id);
			const hint = update?.metadata;
			entries[entry.id] = {
				id: entry.id,
				kind: hint?.kind ?? previous?.kind ?? inferKind(entry.sectionHeading),
				scope: "channel",
				subjectId: hint?.subjectId ?? previous?.subjectId,
				ownerId: hint?.ownerId ?? previous?.ownerId,
				sourceEntryIds: Array.from(
					new Set([...(previous?.sourceEntryIds ?? []), ...(update?.sourceEntryIds ?? [])]),
				),
				sourceCorrelationIds: Array.from(
					new Set([
						...(previous?.sourceCorrelationIds ?? []),
						...(hint?.sourceCorrelationId ? [hint.sourceCorrelationId] : []),
					]),
				),
				sourceType: hint?.sourceType ?? previous?.sourceType ?? "legacy",
				trust: hint?.trust ?? previous?.trust ?? "inferred",
				createdAt: previous?.createdAt ?? entry.timestamp ?? timestamp,
				updatedAt: update || previous?.contentHash !== contentHash(entry.content) ? timestamp : previous.updatedAt,
				validFrom: hint?.validFrom ?? previous?.validFrom,
				expiresAt: hint?.expiresAt ?? previous?.expiresAt,
				status: "active",
				sensitivity: hint?.sensitivity ?? previous?.sensitivity ?? "normal",
				sectionHeading: entry.sectionHeading,
				contentHash: contentHash(entry.content),
				recallCount: previous?.recallCount ?? 0,
				lastRecalledAt: previous?.lastRecalledAt,
				queryFingerprints: previous?.queryFingerprints ?? [],
				recallByDay: previous?.recallByDay ?? {},
			};
		}

		for (const update of updates) {
			if (!update.status || update.status === "active" || activeIds.has(update.id)) continue;
			const previous = entries[update.id];
			if (previous) entries[update.id] = { ...previous, status: update.status, updatedAt: timestamp };
		}

		for (const [id, entry] of Object.entries(entries)) {
			if (entry.status === "active" && !activeIds.has(id) && !updatesById.has(id)) {
				entries[id] = { ...entry, status: "invalidated", updatedAt: timestamp };
			}
		}

		const next: MemoryMetadataFile = { schemaVersion: 1, updatedAt: timestamp, entries };
		await writeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
		return next;
	});
}

export async function recordMemoryRecall(
	channelDir: string,
	entryIds: string[],
	query: string,
	timestamp: string = new Date().toISOString(),
): Promise<void> {
	if (entryIds.length === 0) return;
	const path = getMemoryMetadataPath(channelDir);
	await metadataQueue.run(path, async () => {
		const current = await readMemoryMetadata(channelDir);
		const fingerprint = createHash("sha256")
			.update(query.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase())
			.digest("hex")
			.slice(0, 16);
		const day = timestamp.slice(0, 10);
		const cutoff = new Date(timestamp);
		cutoff.setUTCDate(cutoff.getUTCDate() - 89);
		const cutoffDay = cutoff.toISOString().slice(0, 10);
		let changed = false;
		for (const id of new Set(entryIds)) {
			const entry = current.entries[id];
			if (!entry || entry.status !== "active") continue;
			const fingerprints = Array.from(new Set([...entry.queryFingerprints, fingerprint])).slice(-32);
			const recallByDay = Object.fromEntries(
				Object.entries(entry.recallByDay ?? {}).filter(([recordedDay]) => recordedDay >= cutoffDay),
			);
			current.entries[id] = {
				...entry,
				recallCount: entry.recallCount + 1,
				lastRecalledAt: timestamp,
				queryFingerprints: fingerprints,
				recallByDay: { ...recallByDay, [day]: (recallByDay[day] ?? 0) + 1 },
			};
			changed = true;
		}
		if (!changed) return;
		current.updatedAt = timestamp;
		await writeFileAtomically(path, `${JSON.stringify(current, null, 2)}\n`);
	});
}

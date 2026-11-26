import { localDayKey } from "../shared/local-time.js";
import { getSearchIndexPath, withSearchIndex } from "./search-index-db.js";
import { type MemorySearchHit, queryNotes, syncNoteSources } from "./search-index-notes.js";
import { buildQueryTerms } from "./search-terms.js";
import type { MemoryEntry } from "./store.js";

// Calibrated against the 050 duplicate guard on the spec 072 acceptance pairs.
const NEAR_DUPLICATE_JACCARD = 0.4;

function normalizeForEquality(text: string): string {
	return text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function descriptionSimilarity(a: string, b: string): number {
	if (normalizeForEquality(a) === normalizeForEquality(b)) {
		return 1;
	}
	const aTerms = buildQueryTerms(a);
	const bTerms = buildQueryTerms(b);
	const setA = new Set([...aTerms.latin, ...aTerms.cjk]);
	const setB = new Set([...bTerms.latin, ...bTerms.cjk]);
	if (setA.size === 0 || setB.size === 0) {
		return 0;
	}
	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) {
			intersection++;
		}
	}
	return intersection / (setA.size + setB.size - intersection);
}

/** Entries whose description is a near-duplicate of `description`, strongest match first. */
export function findNearDuplicateEntries(description: string, entries: MemoryEntry[]): MemoryEntry[] {
	return entries
		.map((entry) => ({ entry, score: descriptionSimilarity(description, entry.description) }))
		.filter(({ score }) => score >= NEAR_DUPLICATE_JACCARD)
		.sort((a, b) => b.score - a.score)
		.map(({ entry }) => entry);
}

interface MemorySearchInput {
	appHomeDir: string;
	desk: string;
	deskDir: string;
	workspaceDir: string;
	query: string;
	limit?: number;
}

export function searchMemory(input: MemorySearchInput): Promise<MemorySearchHit[]> {
	const { appHomeDir, desk, deskDir, workspaceDir, query } = input;
	const terms = buildQueryTerms(query);
	const requested = input.limit ?? 12;
	const limit = Number.isFinite(requested) ? Math.max(0, Math.min(12, Math.floor(requested))) : 12;
	return withSearchIndex(getSearchIndexPath(appHomeDir, desk), async (handle) => {
		await syncNoteSources(handle, deskDir, workspaceDir);
		return queryNotes(handle, terms, localDayKey(), limit);
	});
}

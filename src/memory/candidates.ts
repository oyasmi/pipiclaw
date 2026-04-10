import { readFile, stat } from "fs/promises";
import { join } from "path";
import { splitH1Sections, splitH2Sections } from "../shared/markdown-sections.js";
import { getChannelHistoryPath, getChannelMemoryPath, getChannelSessionPath } from "./files.js";

export interface MemoryCandidate {
	id: string;
	source: "workspace-memory" | "channel-memory" | "channel-session" | "channel-history";
	path: string;
	title: string;
	content: string;
	searchText?: string;
	timestamp?: string;
	sectionKind?: string;
	priority: number;
}

export interface BuildMemoryCandidatesOptions {
	workspaceDir: string;
	channelDir: string;
}

interface CandidateFileFingerprint {
	exists: boolean;
	mtimeMs: number;
	ctimeMs: number;
	size: number;
}

interface CachedCandidateFile {
	fingerprint: CandidateFileFingerprint;
	candidates: MemoryCandidate[];
}

function normalizeContent(content: string): string {
	return content.replace(/\r/g, "").trim();
}

async function readOptionalFile(path: string): Promise<string> {
	try {
		return normalizeContent(await readFile(path, "utf-8"));
	} catch {
		return "";
	}
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "section"
	);
}

function sameFingerprint(a: CandidateFileFingerprint, b: CandidateFileFingerprint): boolean {
	return a.exists === b.exists && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;
}

function inferPriority(source: MemoryCandidate["source"], title: string): number {
	const normalizedTitle = title.trim().toLowerCase();
	if (source === "channel-session") {
		if (normalizedTitle === "current state") return 18;
		if (normalizedTitle === "next steps") return 17;
		if (normalizedTitle === "errors & corrections") return 16;
		if (normalizedTitle === "constraints") return 15;
		if (normalizedTitle === "user intent") return 15;
		if (normalizedTitle === "active files") return 14;
		if (normalizedTitle === "decisions") return 14;
		if (normalizedTitle === "session title") return 13;
		return 12;
	}
	if (source === "channel-memory") {
		if (normalizedTitle.includes("constraints")) return 11;
		if (normalizedTitle.includes("decisions")) return 10;
		if (normalizedTitle.includes("open loops")) return 10;
		if (normalizedTitle.includes("preferences")) return 9;
		if (normalizedTitle.includes("ongoing work")) return 9;
		return 8;
	}
	if (source === "workspace-memory") {
		return 6;
	}
	return 4;
}

function buildCandidate(
	source: MemoryCandidate["source"],
	path: string,
	title: string,
	content: string,
	timestamp?: string,
	searchText?: string,
): MemoryCandidate {
	return {
		id: `${source}:${slugify(title)}:${timestamp ?? ""}`,
		source,
		path,
		title,
		content,
		searchText,
		timestamp,
		sectionKind: title.trim().toLowerCase(),
		priority: inferPriority(source, title),
	};
}

function buildWorkspaceOrChannelMemoryCandidates(
	source: "workspace-memory" | "channel-memory",
	path: string,
	content: string,
): MemoryCandidate[] {
	const sections = splitH2Sections(content);
	if (sections.length === 0 && content) {
		return [
			buildCandidate(source, path, source === "workspace-memory" ? "Workspace Memory" : "Channel Memory", content),
		];
	}

	return sections
		.filter((section) => section.content.trim())
		.map((section) => buildCandidate(source, path, section.heading, section.content));
}

function buildSessionCandidates(path: string, content: string): MemoryCandidate[] {
	const sections = splitH1Sections(content).filter((section) => section.content.trim());
	const sessionTitle = sections.find((section) => section.heading.toLowerCase() === "session title")?.content ?? "";

	return sections.map((section) =>
		buildCandidate(
			"channel-session",
			path,
			section.heading,
			section.content,
			undefined,
			section.heading.toLowerCase() === "session title" || !sessionTitle.trim()
				? section.content
				: `${sessionTitle.trim()}\n${section.content}`,
		),
	);
}

function buildHistoryCandidates(path: string, content: string): MemoryCandidate[] {
	const sections = splitH2Sections(content).filter((section) => section.content.trim());
	if (sections.length === 0) {
		return [];
	}

	const foldedSections = sections.filter((section) => section.heading.startsWith("Folded History Through "));
	const recentSectionLimit = 8;
	const recentSections = sections.slice(-recentSectionLimit);
	const selectedSections = Array.from(new Set([...foldedSections, ...recentSections]));

	return selectedSections.map((section) =>
		buildCandidate("channel-history", path, section.heading, section.content, section.heading),
	);
}

async function readFingerprint(path: string): Promise<CandidateFileFingerprint> {
	try {
		const stats = await stat(path);
		return {
			exists: true,
			mtimeMs: stats.mtimeMs,
			ctimeMs: stats.ctimeMs,
			size: stats.size,
		};
	} catch {
		return {
			exists: false,
			mtimeMs: 0,
			ctimeMs: 0,
			size: 0,
		};
	}
}

type CandidateBuilder = (path: string, content: string) => MemoryCandidate[];

interface CandidateFileDefinition {
	path: string;
	build: CandidateBuilder;
}

export class MemoryCandidateStore {
	private files = new Map<string, CachedCandidateFile>();
	private inflight = new Map<string, Promise<MemoryCandidate[]>>();

	invalidate(path?: string): void {
		if (!path) {
			this.files.clear();
			this.inflight.clear();
			return;
		}

		this.files.delete(path);
		this.inflight.delete(path);
	}

	async getCandidates(options: BuildMemoryCandidatesOptions): Promise<MemoryCandidate[]> {
		const definitions: CandidateFileDefinition[] = [
			{
				path: getChannelSessionPath(options.channelDir),
				build: buildSessionCandidates,
			},
			{
				path: getChannelMemoryPath(options.channelDir),
				build: (path, content) => buildWorkspaceOrChannelMemoryCandidates("channel-memory", path, content),
			},
			{
				path: join(options.workspaceDir, "MEMORY.md"),
				build: (path, content) => buildWorkspaceOrChannelMemoryCandidates("workspace-memory", path, content),
			},
			{
				path: getChannelHistoryPath(options.channelDir),
				build: buildHistoryCandidates,
			},
		];

		const candidateGroups = await Promise.all(
			definitions.map(async (definition) => this.loadFileCandidates(definition.path, definition.build)),
		);
		return candidateGroups.flat();
	}

	private async loadFileCandidates(path: string, build: CandidateBuilder): Promise<MemoryCandidate[]> {
		const pending = this.inflight.get(path);
		if (pending) {
			return pending;
		}

		const work = (async () => {
			const fingerprint = await readFingerprint(path);
			const cached = this.files.get(path);
			if (cached && sameFingerprint(cached.fingerprint, fingerprint)) {
				return cached.candidates;
			}

			const content = fingerprint.exists ? await readOptionalFile(path) : "";
			const candidates = build(path, content);
			this.files.set(path, { fingerprint, candidates });
			return candidates;
		})().finally(() => {
			this.inflight.delete(path);
		});

		this.inflight.set(path, work);
		return work;
	}
}

export function createMemoryCandidateStore(): MemoryCandidateStore {
	return new MemoryCandidateStore();
}

export async function buildMemoryCandidates(
	options: BuildMemoryCandidatesOptions,
	store: MemoryCandidateStore = createMemoryCandidateStore(),
): Promise<MemoryCandidate[]> {
	return store.getCandidates(options);
}

import { readFile } from "fs/promises";
import { join } from "path";
import { splitLevelOneSections } from "./markdown-sections.js";
import {
	getChannelHistoryPath,
	getChannelMemoryPath,
	getChannelSessionPath,
	splitMarkdownSections,
} from "./memory-files.js";

export interface MemoryCandidate {
	id: string;
	source: "workspace-memory" | "channel-memory" | "channel-session" | "channel-history";
	path: string;
	title: string;
	content: string;
	timestamp?: string;
	sectionKind?: string;
	priority: number;
}

export interface BuildMemoryCandidatesOptions {
	workspaceDir: string;
	channelDir: string;
	cache?: MemoryCandidateCache;
}

export interface MemoryCandidateCache {
	entries: Map<string, Promise<MemoryCandidate[]>>;
}

export function createMemoryCandidateCache(): MemoryCandidateCache {
	return {
		entries: new Map(),
	};
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

function inferPriority(source: MemoryCandidate["source"], title: string): number {
	const normalizedTitle = title.trim().toLowerCase();
	if (source === "channel-session") {
		if (normalizedTitle === "current state") return 120;
		if (normalizedTitle === "next steps") return 115;
		if (normalizedTitle === "errors & corrections") return 110;
		if (normalizedTitle === "constraints") return 108;
		if (normalizedTitle === "user intent") return 105;
		return 100;
	}
	if (source === "channel-memory") {
		if (normalizedTitle.includes("constraints")) return 88;
		if (normalizedTitle.includes("decisions")) return 86;
		if (normalizedTitle.includes("open loops")) return 84;
		return 80;
	}
	if (source === "workspace-memory") {
		return 60;
	}
	return 40;
}

function buildCandidate(
	source: MemoryCandidate["source"],
	path: string,
	title: string,
	content: string,
	timestamp?: string,
): MemoryCandidate {
	return {
		id: `${source}:${slugify(title)}:${timestamp ?? ""}`,
		source,
		path,
		title,
		content,
		timestamp,
		sectionKind: title.trim().toLowerCase(),
		priority: inferPriority(source, title),
	};
}

function buildCacheKey(options: BuildMemoryCandidatesOptions): string {
	return `${options.workspaceDir}\u0000${options.channelDir}`;
}

function buildWorkspaceOrChannelMemoryCandidates(
	source: "workspace-memory" | "channel-memory",
	path: string,
	content: string,
): MemoryCandidate[] {
	const sections = splitMarkdownSections(content);
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
	return splitLevelOneSections(content)
		.filter((section) => section.content.trim())
		.map((section) => buildCandidate("channel-session", path, section.heading, section.content));
}

function buildHistoryCandidates(path: string, content: string): MemoryCandidate[] {
	return splitMarkdownSections(content)
		.filter((section) => section.content.trim())
		.map((section) => buildCandidate("channel-history", path, section.heading, section.content, section.heading));
}

async function buildMemoryCandidatesUncached(options: BuildMemoryCandidatesOptions): Promise<MemoryCandidate[]> {
	const workspaceMemoryPath = join(options.workspaceDir, "MEMORY.md");
	const channelMemoryPath = getChannelMemoryPath(options.channelDir);
	const channelSessionPath = getChannelSessionPath(options.channelDir);
	const channelHistoryPath = getChannelHistoryPath(options.channelDir);

	const [workspaceMemory, channelMemory, channelSession, channelHistory] = await Promise.all([
		readOptionalFile(workspaceMemoryPath),
		readOptionalFile(channelMemoryPath),
		readOptionalFile(channelSessionPath),
		readOptionalFile(channelHistoryPath),
	]);

	return [
		...buildSessionCandidates(channelSessionPath, channelSession),
		...buildWorkspaceOrChannelMemoryCandidates("channel-memory", channelMemoryPath, channelMemory),
		...buildWorkspaceOrChannelMemoryCandidates("workspace-memory", workspaceMemoryPath, workspaceMemory),
		...buildHistoryCandidates(channelHistoryPath, channelHistory),
	];
}

export async function buildMemoryCandidates(options: BuildMemoryCandidatesOptions): Promise<MemoryCandidate[]> {
	if (!options.cache) {
		return buildMemoryCandidatesUncached(options);
	}

	const key = buildCacheKey(options);
	const cached = options.cache.entries.get(key);
	if (cached) {
		return cached;
	}

	const pending = buildMemoryCandidatesUncached(options).catch((error) => {
		options.cache?.entries.delete(key);
		throw error;
	});
	options.cache.entries.set(key, pending);
	return pending;
}

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";

const DEFAULT_CHANNEL_MEMORY = `# Channel Memory

This file stores durable channel-specific memory.

- It is not preloaded into session context.
- Read it on demand when prior decisions, preferences, or long-running work matter.
- The runtime may append updates here during consolidation.

## Durable Facts

<!-- Stable facts, preferences, and ongoing commitments can accumulate here. -->
`;

const DEFAULT_CHANNEL_HISTORY = `# Channel History

This file stores summarized older channel history.

- It is not preloaded into session context.
- Read it on demand when older context matters.
- The runtime may append and fold history blocks here during consolidation.
`;

const DEFAULT_CHANNEL_SESSION = `# Session Title

<!-- A short title for the current active work in this channel. -->

# Current State

<!-- What is actively being worked on right now. -->

# User Intent

<!-- What the user is currently trying to achieve. -->

# Active Files

<!-- Important files or directories currently in focus. -->

# Decisions

<!-- Recent decisions that matter to the current work. -->

# Constraints

<!-- Current constraints, assumptions, or important guardrails. -->

# Errors & Corrections

<!-- Recent failures, corrections, and things to avoid repeating. -->

# Next Steps

<!-- Likely next actions if work resumes later. -->

# Worklog

<!-- Very terse notes about recent progress. -->
`;

export interface MemoryUpdateBlock {
	timestamp: string;
	entries: string[];
}

export interface HistoryBlock {
	timestamp: string;
	content: string;
}

function normalizeContent(content: string): string {
	return content.trim().length > 0 ? `${content.trim()}\n` : "";
}

async function writeAtomically(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tempPath, content, "utf-8");
	await rename(tempPath, path);
}

function ensureTrailingNewlines(content: string): string {
	return content.trimEnd().length > 0 ? `${content.trimEnd()}\n\n` : "";
}

export function getChannelMemoryPath(channelDir: string): string {
	return join(channelDir, "MEMORY.md");
}

export function getChannelHistoryPath(channelDir: string): string {
	return join(channelDir, "HISTORY.md");
}

export function getChannelSessionPath(channelDir: string): string {
	return join(channelDir, "SESSION.md");
}

export async function ensureChannelMemoryFiles(channelDir: string): Promise<void> {
	ensureChannelMemoryFilesSync(channelDir);
}

export function ensureChannelMemoryFilesSync(channelDir: string): void {
	const memoryPath = getChannelMemoryPath(channelDir);
	const historyPath = getChannelHistoryPath(channelDir);
	const sessionPath = getChannelSessionPath(channelDir);

	mkdirSync(channelDir, { recursive: true });

	if (!existsSync(memoryPath)) {
		writeFileSync(memoryPath, DEFAULT_CHANNEL_MEMORY, "utf-8");
	}
	if (!existsSync(historyPath)) {
		writeFileSync(historyPath, DEFAULT_CHANNEL_HISTORY, "utf-8");
	}
	if (!existsSync(sessionPath)) {
		writeFileSync(sessionPath, DEFAULT_CHANNEL_SESSION, "utf-8");
	}
}

async function readTextFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf-8");
	} catch (error: unknown) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return "";
		}
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

export async function readChannelMemory(channelDir: string): Promise<string> {
	return readTextFile(getChannelMemoryPath(channelDir));
}

export async function readChannelHistory(channelDir: string): Promise<string> {
	return readTextFile(getChannelHistoryPath(channelDir));
}

export async function readChannelSession(channelDir: string): Promise<string> {
	return readTextFile(getChannelSessionPath(channelDir));
}

export async function rewriteChannelMemory(channelDir: string, content: string): Promise<void> {
	await ensureChannelMemoryFiles(channelDir);
	const nextContent = normalizeContent(content) || DEFAULT_CHANNEL_MEMORY;
	await writeAtomically(getChannelMemoryPath(channelDir), nextContent);
}

export async function rewriteChannelHistory(channelDir: string, content: string): Promise<void> {
	await ensureChannelMemoryFiles(channelDir);
	const nextContent = normalizeContent(content) || DEFAULT_CHANNEL_HISTORY;
	await writeAtomically(getChannelHistoryPath(channelDir), nextContent);
}

export async function rewriteChannelSession(channelDir: string, content: string): Promise<void> {
	await ensureChannelMemoryFiles(channelDir);
	const nextContent = normalizeContent(content) || DEFAULT_CHANNEL_SESSION;
	await writeAtomically(getChannelSessionPath(channelDir), nextContent);
}

export async function appendChannelMemoryUpdate(channelDir: string, block: MemoryUpdateBlock): Promise<void> {
	if (block.entries.length === 0) {
		return;
	}

	await ensureChannelMemoryFiles(channelDir);
	const path = getChannelMemoryPath(channelDir);
	const existing = await readTextFile(path);
	const renderedBlock = [`## Update ${block.timestamp}`, ...block.entries.map((entry) => `- ${entry.trim()}`)].join(
		"\n",
	);
	await writeAtomically(path, `${ensureTrailingNewlines(existing)}${renderedBlock}\n`);
}

export async function appendChannelHistoryBlock(channelDir: string, block: HistoryBlock): Promise<void> {
	const trimmedContent = block.content.trim();
	if (!trimmedContent) {
		return;
	}

	await ensureChannelMemoryFiles(channelDir);
	const path = getChannelHistoryPath(channelDir);
	const existing = await readTextFile(path);
	const renderedBlock = [`## ${block.timestamp}`, trimmedContent].join("\n\n");
	await writeAtomically(path, `${ensureTrailingNewlines(existing)}${renderedBlock}\n`);
}

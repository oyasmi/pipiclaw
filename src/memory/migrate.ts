import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { localDayKey, parseLocalTime } from "../shared/local-time.js";
import {
	getChannelMemoryDir,
	getChannelMemoryIndexPath,
	getMemoryEntryPath,
	type MemoryEntry,
	type MemorySource,
	type MemoryType,
	dedupeMemoryName,
	rebuildMemoryIndex,
	serializeMemoryEntry,
	slugifyMemoryName,
} from "./store.js";
import { hashMemoryContent } from "./tombstones.js";

/**
 * Spec 050 §5: one-shot, deterministic, no-LLM, idempotent, reversible migration from the v1
 * layout (5 files + entries.json) to the v2 layout (`memory/*.md` + `journal/` + generated
 * index). Original files are moved to `.memory-v1/`, never deleted. Runs per channel at daemon
 * / TUI startup, before the runner is created. The workspace directory is never migrated.
 */

const MARKER = ".migrated-v2";
const V1_DIR = ".memory-v1";

export interface MigrationResult {
	migrated: boolean;
	reason?: string;
	entries: number;
	journalDays: number;
	ongoingWorkItems: number;
	tombstones: number;
}

export function getMigrationMarkerPath(channelDir: string): string {
	return join(getChannelMemoryDir(channelDir), MARKER);
}

export function isChannelMigratedToV2(channelDir: string): boolean {
	return existsSync(getMigrationMarkerPath(channelDir));
}

function hasV1Layout(channelDir: string): boolean {
	return (
		existsSync(join(channelDir, "MEMORY.md")) ||
		existsSync(join(channelDir, "HISTORY.md")) ||
		existsSync(join(channelDir, "SESSION.md")) ||
		existsSync(join(channelDir, ".memory"))
	);
}

// -------------------------------------------------------------------------------------------------
// v1 MEMORY.md parsing (corrected: indented bullets fold into the parent's details)
// -------------------------------------------------------------------------------------------------

interface V1Bullet {
	section: string;
	content: string;
	details: string[];
	explicitId?: string;
	updateTimestamp?: string;
}

const ID_COMMENT = /\s*<!--\s*id:(m-[a-z0-9]+)\s*-->\s*$/i;

function parseV1MemoryBullets(raw: string): V1Bullet[] {
	const lines = raw.replace(/\r/g, "").split("\n");
	const bullets: V1Bullet[] = [];
	let section = "";
	let updateTimestamp: string | undefined;
	for (const line of lines) {
		const h2 = /^##\s+(.+)$/.exec(line);
		if (h2) {
			section = h2[1].trim();
			const update = /^Update\s+(.+)$/.exec(section);
			updateTimestamp = update ? update[1].trim() : undefined;
			continue;
		}
		if (!section) {
			continue;
		}
		const zeroIndentBullet = /^-\s+(.+)$/.exec(line);
		const indentedBullet = /^\s+[-*]\s+(.+)$/.exec(line);
		if (zeroIndentBullet) {
			const idMatch = ID_COMMENT.exec(zeroIndentBullet[1]);
			const content = zeroIndentBullet[1].replace(ID_COMMENT, "").trim();
			if (content) {
				bullets.push({
					section,
					content,
					details: [],
					explicitId: idMatch?.[1],
					updateTimestamp,
				});
			}
		} else if (indentedBullet && bullets.length > 0) {
			// F1: a nested bullet is a continuation of its parent, not its own memory.
			bullets[bullets.length - 1].details.push(indentedBullet[1].trim());
		}
	}
	return bullets;
}

// -------------------------------------------------------------------------------------------------
// entries.json lookup
// -------------------------------------------------------------------------------------------------

interface V1EntryRecord {
	kind?: string;
	sourceType?: string;
	createdAt?: string;
	probationUntil?: string | null;
}

interface V1Metadata {
	byId: Map<string, V1EntryRecord>;
	byContentHash: Map<string, V1EntryRecord>;
}

async function loadV1Metadata(channelDir: string): Promise<V1Metadata> {
	const byId = new Map<string, V1EntryRecord>();
	const byContentHash = new Map<string, V1EntryRecord>();
	const raw = await readOptionalTextFile(join(channelDir, ".memory", "entries.json"));
	if (!raw) {
		return { byId, byContentHash };
	}
	try {
		const parsed = JSON.parse(raw) as { entries?: Record<string, V1EntryRecord & { id?: string; contentHash?: string }> };
		for (const [id, record] of Object.entries(parsed.entries ?? {})) {
			byId.set(id, record);
			if (record.contentHash) {
				byContentHash.set(record.contentHash, record);
			}
		}
	} catch {
		/* corrupt entries.json — proceed with empty metadata */
	}
	return { byId, byContentHash };
}

function syntheticV1Id(section: string, content: string): string {
	return `m-${createHash("sha1").update(`${section}\x00${content}`).digest("hex").slice(0, 8)}`;
}

// -------------------------------------------------------------------------------------------------
// type / source mapping (spec 050, D2 table)
// -------------------------------------------------------------------------------------------------

const POINTER_PATTERN = /(~\/|https?:\/\/|\/home\/|[\w-]+\.md\b|路径|目录|repo)/i;

function mapType(section: string, kind: string | undefined, content: string): MemoryType {
	const heading = section.toLowerCase();
	if (kind === "lesson") {
		return "feedback";
	}
	if (kind === "preference" || heading.includes("preference")) {
		return heading.includes("identity") || heading.includes("participant") ? "user" : "feedback";
	}
	if (heading.includes("identity") || heading.includes("participant")) {
		return "user";
	}
	// A pointer-shaped fact (a path, URL, CLI location, repo) is `reference` even when it was
	// filed under Constraints in v1.
	if ((kind === "fact" || kind === undefined) && POINTER_PATTERN.test(content)) {
		return "reference";
	}
	if (kind === "decision" || kind === "constraint" || heading.includes("decision") || heading.includes("constraint")) {
		return "project";
	}
	return POINTER_PATTERN.test(content) ? "reference" : "project";
}

function mapSource(sourceType: string | undefined): MemorySource {
	return sourceType === "user" ? "user" : "migrated";
}

function toDateKey(value: string | undefined | null, fallback: string): string {
	if (!value) {
		return fallback;
	}
	const ms = parseLocalTime(value);
	return ms === undefined ? fallback : localDayKey(new Date(ms));
}

// -------------------------------------------------------------------------------------------------
// journal assembly
// -------------------------------------------------------------------------------------------------

function timeOfDay(timestamp: string): string {
	const ms = parseLocalTime(timestamp);
	if (ms === undefined) {
		return "";
	}
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** `## <ts>` blocks in a v1 HISTORY.md, plus the single folded block. */
function parseV1History(raw: string): { days: Map<string, string[]>; folded?: { date: string; text: string } } {
	const days = new Map<string, string[]>();
	let folded: { date: string; text: string } | undefined;
	const blocks = raw.replace(/\r/g, "").split(/\n(?=## )/);
	for (const block of blocks) {
		const headingMatch = /^##\s+(.+)$/m.exec(block);
		if (!headingMatch) {
			continue;
		}
		const heading = headingMatch[1].trim();
		const body = block.slice(block.indexOf("\n") + 1).trim();
		const foldedMatch = /^Folded History Through\s+(.+)$/.exec(heading);
		if (foldedMatch) {
			folded = { date: toDateKey(foldedMatch[1], localDayKey()), text: body };
			continue;
		}
		const date = toDateKey(heading, "");
		if (!date || !body) {
			continue;
		}
		const time = timeOfDay(heading);
		const bullets = body
			.split("\n")
			.map((line) => line.replace(/^[-*]\s*/, "").trim())
			.filter(Boolean)
			.map((line) => (time ? `- ${time} ${line}` : `- ${line}`));
		days.set(date, [...(days.get(date) ?? []), ...bullets]);
	}
	return { days, folded };
}

const SESSION_MIGRATED_SECTIONS = ["Decisions", "Constraints", "Errors & Corrections"];

function parseSessionMigratedBullets(raw: string): string[] {
	const lines = raw.replace(/\r/g, "").split("\n");
	const out: string[] = [];
	let capturing = false;
	for (const line of lines) {
		const h1 = /^#\s+(.+)$/.exec(line);
		if (h1) {
			capturing = SESSION_MIGRATED_SECTIONS.includes(h1[1].trim());
			continue;
		}
		if (!capturing) {
			continue;
		}
		const bullet = /^[-*]\s+(.+)$/.exec(line.trim());
		if (bullet?.[1] && !bullet[1].startsWith("<!--")) {
			out.push(`- ${bullet[1].trim()}`);
		}
	}
	return out;
}

async function writeJournalFile(channelDir: string, date: string, sections: Array<{ heading?: string; bullets: string[] }>): Promise<void> {
	const nonEmpty = sections.filter((s) => s.bullets.length > 0);
	if (nonEmpty.length === 0) {
		return;
	}
	const blocks = [`# ${date}`];
	for (const section of nonEmpty) {
		if (section.heading) {
			blocks.push(`## ${section.heading}`);
		}
		blocks.push(section.bullets.join("\n"));
	}
	await mkdir(join(channelDir, "journal"), { recursive: true });
	await writeFile(join(channelDir, "journal", `${date}.md`), `${blocks.join("\n\n")}\n`, "utf-8");
}

// -------------------------------------------------------------------------------------------------
// migration
// -------------------------------------------------------------------------------------------------

async function moveToV1Archive(channelDir: string, relPath: string): Promise<void> {
	const source = join(channelDir, relPath);
	if (!existsSync(source)) {
		return;
	}
	const target = join(channelDir, V1_DIR, relPath);
	await mkdir(join(target, ".."), { recursive: true });
	await rename(source, target);
}

export async function migrateChannelMemoryToV2(
	channelDir: string,
	options: { today?: string } = {},
): Promise<MigrationResult> {
	const today = options.today ?? localDayKey();
	const empty: MigrationResult = {
		migrated: false,
		entries: 0,
		journalDays: 0,
		ongoingWorkItems: 0,
		tombstones: 0,
	};

	if (isChannelMigratedToV2(channelDir)) {
		return { ...empty, reason: "already-migrated" };
	}
	if (!hasV1Layout(channelDir)) {
		return { ...empty, reason: "nothing-to-migrate" };
	}

	const metadata = await loadV1Metadata(channelDir);
	const memoryRaw = await readOptionalTextFile(join(channelDir, "MEMORY.md"));
	const historyRaw = await readOptionalTextFile(join(channelDir, "HISTORY.md"));
	const sessionRaw = await readOptionalTextFile(join(channelDir, "SESSION.md"));

	const bullets = parseV1MemoryBullets(memoryRaw);
	const memoryDir = getChannelMemoryDir(channelDir);
	await mkdir(memoryDir, { recursive: true });

	const usedNames = new Set<string>();
	const ongoingWork: string[] = [];
	let entryCount = 0;

	for (const bullet of bullets) {
		if (/ongoing work|open (loop|question)/i.test(bullet.section)) {
			ongoingWork.push(`- ${bullet.content}`);
			continue;
		}
		const record =
			(bullet.explicitId ? metadata.byId.get(bullet.explicitId) : undefined) ??
			metadata.byId.get(syntheticV1Id(bullet.section, bullet.content)) ??
			metadata.byContentHash.get(hashMemoryContent(bullet.content));

		const asciiWords = bullet.content
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((word) => word.length > 1)
			.slice(0, 6);
		// A one-word slug ("ai", "user") is too generic to be a handle; hash instead.
		const base = asciiWords.length >= 2 ? slugifyMemoryName(asciiWords.join(" ")) : `m-${createHash("sha1").update(bullet.content).digest("hex").slice(0, 6)}`;
		const name = dedupeMemoryName(base, usedNames);
		usedNames.add(name);

		const created = toDateKey(bullet.updateTimestamp ?? record?.createdAt, today);
		const entry: MemoryEntry = {
			name,
			description: bullet.content.replace(/\s+/g, " ").trim(),
			type: mapType(bullet.section, record?.kind, bullet.content),
			source: mapSource(record?.sourceType),
			created,
			updated: created,
			expires: record?.probationUntil ? toDateKey(record.probationUntil, today) : undefined,
			body: bullet.details.join("\n"),
			malformed: false,
		};
		await writeFile(getMemoryEntryPath(channelDir, name), serializeMemoryEntry(entry), "utf-8");
		entryCount++;
	}

	// tombstones: v1 `.memory/tombstones.jsonl` → `memory/.tombstones.jsonl` (contentHash kept)
	let tombstoneCount = 0;
	const tombRaw = await readOptionalTextFile(join(channelDir, ".memory", "tombstones.jsonl"));
	if (tombRaw) {
		const lines = tombRaw
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				try {
					const v = JSON.parse(line) as { contentHash?: string; deletedAt?: string; reason?: string };
					if (!v.contentHash) {
						return [];
					}
					tombstoneCount++;
					return [JSON.stringify({ contentHash: v.contentHash, deletedAt: v.deletedAt ?? today, reason: v.reason ?? "migrated" })];
				} catch {
					return [];
				}
			});
		if (lines.length > 0) {
			await writeFile(join(memoryDir, ".tombstones.jsonl"), `${lines.join("\n")}\n`, "utf-8");
		}
	}

	// journal: HISTORY blocks → per-day; folded block → one file; SESSION + Ongoing Work → today
	const { days, folded } = parseV1History(historyRaw);
	for (const [date, bulletsForDay] of days) {
		await writeJournalFile(channelDir, date, [{ bullets: bulletsForDay }]);
	}
	if (folded) {
		await mkdir(join(channelDir, "journal"), { recursive: true });
		await writeFile(
			join(channelDir, "journal", `folded-through-${folded.date}.md`),
			`# Folded history through ${folded.date}\n\n${folded.text}\n`,
			"utf-8",
		);
	}
	const sessionBullets = parseSessionMigratedBullets(sessionRaw);
	await writeJournalFile(channelDir, today, [
		{ heading: "迁移自 SESSION.md", bullets: sessionBullets },
		{ heading: "迁移自 MEMORY.md 的进行中事项", bullets: ongoingWork },
	]);

	// archive v1 originals (never deleted)
	for (const rel of ["MEMORY.md", "HISTORY.md", "HISTORY.archive.md", "HISTORY.archive.md.1", "SESSION.md", "SESSION.invalid-response.txt", ".memory", ".memory-backups"]) {
		await moveToV1Archive(channelDir, rel);
	}

	await rebuildMemoryIndex(channelDir);

	const result: MigrationResult = {
		migrated: true,
		entries: entryCount,
		journalDays: days.size + (folded ? 1 : 0) + (sessionBullets.length + ongoingWork.length > 0 ? 1 : 0),
		ongoingWorkItems: ongoingWork.length,
		tombstones: tombstoneCount,
	};
	await writeFile(
		getMigrationMarkerPath(channelDir),
		`${JSON.stringify({ migratedAt: today, ...result })}\n`,
		"utf-8",
	);
	return result;
}

/** Reverse a migration: restore `.memory-v1/` originals, drop the v2 artifacts. */
export async function rollbackChannelMemoryV2(channelDir: string): Promise<void> {
	// Drop the v2 artifacts first — the generated index shares the name `MEMORY.md` with the
	// archived v1 original, so it must go before the restore, not after.
	await rm(getChannelMemoryDir(channelDir), { recursive: true, force: true });
	await rm(join(channelDir, "journal"), { recursive: true, force: true });
	await rm(getChannelMemoryIndexPath(channelDir), { force: true });

	const archive = join(channelDir, V1_DIR);
	if (existsSync(archive)) {
		for (const name of await readdir(archive)) {
			await rm(join(channelDir, name), { recursive: true, force: true });
			await rename(join(archive, name), join(channelDir, name));
		}
		await rm(archive, { recursive: true, force: true });
	}
}

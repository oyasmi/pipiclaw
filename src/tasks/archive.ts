import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { normalizeTaskId, renderTaskDocument } from "./contract.js";
import type { TaskArchiveOutcome, TaskFrontmatter } from "./frontmatter.js";
import { withTaskMutation } from "./mutation-lock.js";

const SUFFIXES = ["", ".1", ".2"] as const;
type LogSuffix = (typeof SUFFIXES)[number];
interface ArchiveCommit {
	id: string;
	contract: string;
	logs: Array<{ suffix: LogSuffix; sha256: string }>;
}

/** A current-format crash-recovery record, removed only after publication and source cleanup. */
export function taskArchiveCommitPath(deskDir: string, id: string): string {
	return join(deskDir, "tasks", ".closing", `${normalizeTaskId(id)}.json`);
}

export function isTaskArchiving(deskDir: string, id: string): boolean {
	return existsSync(taskArchiveCommitPath(deskDir, id));
}

const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex");

/** Publication is already durable; unsupported directory sync must not turn cleanup into a failure. */
async function syncDirectory(path: string): Promise<void> {
	await open(path, "r")
		.then(async (handle) => {
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
		})
		.catch(() => undefined);
}

async function readCommit(path: string, id: string): Promise<ArchiveCommit> {
	const value: unknown = JSON.parse(await readFile(path, "utf-8"));
	if (!isPlainObject(value) || value.id !== id || typeof value.contract !== "string" || !Array.isArray(value.logs)) {
		throw new Error(`Invalid task archive commit: ${path}; have the deployer inspect it before retrying.`);
	}
	const logs: ArchiveCommit["logs"] = [];
	for (const entry of value.logs) {
		if (
			!isPlainObject(entry) ||
			!SUFFIXES.includes(entry.suffix as LogSuffix) ||
			typeof entry.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.sha256) ||
			logs.some((log) => log.suffix === entry.suffix)
		) {
			throw new Error(`Invalid task archive shard: ${path}; have the deployer inspect it before retrying.`);
		}
		logs.push({ suffix: entry.suffix as LogSuffix, sha256: entry.sha256 });
	}
	return { id, contract: value.contract, logs };
}

/** Caller holds the task lock. Published files are immutable; retries verify, never overwrite conflicts. */
async function finishCommit(deskDir: string, commit: ArchiveCommit): Promise<void> {
	const tasks = join(deskDir, "tasks");
	const archive = join(tasks, "archive");
	await mkdir(archive, { recursive: true });
	for (const shard of commit.logs) {
		const source = join(tasks, `${commit.id}.jsonl${shard.suffix}`);
		const target = join(archive, `${commit.id}.jsonl${shard.suffix}`);
		const original = existsSync(source) ? await readFile(source) : undefined;
		const published = existsSync(target) ? await readFile(target) : undefined;
		if ((original && digest(original) !== shard.sha256) || (published && digest(published) !== shard.sha256)) {
			throw new Error(
				`Task archive log conflicts with its commit: ${source}; have the deployer inspect both copies.`,
			);
		}
		if (!published) {
			if (!original) throw new Error(`Task archive log is missing: ${source}; restore it before retrying.`);
			await writeFileAtomically(target, original);
		}
	}
	const target = join(archive, `${commit.id}.md`);
	if (existsSync(target)) {
		if ((await readFile(target, "utf-8")) !== commit.contract) {
			throw new Error(
				`Task archive contract conflicts with its commit: ${target}; have the deployer inspect both copies.`,
			);
		}
	} else await writeFileAtomically(target, commit.contract);
	// Keep the active contract until every archive file is durable. It is the lane's visible handle
	// throughout cleanup; the commit independently covers a crash after that handle is removed.
	for (const { suffix } of commit.logs) await rm(join(tasks, `${commit.id}.jsonl${suffix}`), { force: true });
	await rm(join(tasks, `${commit.id}.md`), { force: true });
	await syncDirectory(tasks);
	await rm(taskArchiveCommitPath(deskDir, commit.id), { force: true });
	await syncDirectory(join(tasks, ".closing"));
}

/** Snapshot once, publish all shards, then clean up. Ordinary I/O failures and SIGKILL use the same recovery path. */
export async function commitTaskArchive(
	deskDir: string,
	id: string,
	document?: { fields: TaskFrontmatter; body: string },
	outcome?: TaskArchiveOutcome,
	closedAt?: string,
): Promise<void> {
	const commitPath = taskArchiveCommitPath(deskDir, id);
	if (existsSync(commitPath)) return finishCommit(deskDir, await readCommit(commitPath, id));
	if (!document || !outcome || !closedAt) return;
	const tasks = join(deskDir, "tasks");
	for (const name of [`${id}.md`, ...SUFFIXES.map((suffix) => `${id}.jsonl${suffix}`)]) {
		const target = join(tasks, "archive", name);
		if (existsSync(target)) throw new Error(`archive entry already exists, refusing to overwrite: ${target}`);
	}
	const logs: ArchiveCommit["logs"] = [];
	for (const suffix of SUFFIXES) {
		const source = join(tasks, `${id}.jsonl${suffix}`);
		if (existsSync(source)) logs.push({ suffix, sha256: digest(await readFile(source)) });
	}
	const commit: ArchiveCommit = {
		id,
		contract: renderTaskDocument({ ...document.fields, outcome, closedAt }, document.body),
		logs,
	};
	await writeFileAtomically(commitPath, JSON.stringify(commit));
	await finishCommit(deskDir, commit);
}

/** Only unfinished closes are enumerated, never the growing historical archive. */
export async function recoverTaskArchives(deskDir: string): Promise<void> {
	const dir = join(deskDir, "tasks", ".closing");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const name of names.filter((name) => name.endsWith(".json"))) {
		try {
			const id = normalizeTaskId(name.slice(0, -5));
			await withTaskMutation(deskDir, id, async () => {
				if (isTaskArchiving(deskDir, id)) await commitTaskArchive(deskDir, id);
			});
		} catch (error) {
			log.logWarn("tasks.archive.recover_failed", "Task archive recovery failed", {
				reason: errorMessage(error),
				fields: { deskDir, file: name },
			});
		}
	}
}

import { readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isChannelId } from "../channel/channel-paths.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isRecord } from "../shared/type-guards.js";
import { getMemoryMaintenanceStateDir, getMemoryMaintenanceStatePath } from "./maintenance-state.js";

/** Upgrade before starting channel readers/writers. Kept through the 0.9.3 upgrade window.
 * Canonical state wins over an obsolete nested copy; old files are removed only after a
 * successful canonical write. Failed I/O aborts startup so no cursor is silently discarded.
 */
export async function migrateMemoryMaintenanceStates(appHomeDir: string): Promise<void> {
	const root = getMemoryMaintenanceStateDir(appHomeDir);
	async function files(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const result: string[] = [];
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) result.push(...(await files(path)));
			else if (entry.isFile() && entry.name.endsWith(".json")) result.push(path);
		}
		return result;
	}
	let paths: string[];
	try {
		paths = await files(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const source of paths) {
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(source, "utf8"));
		} catch (error) {
			if (error instanceof SyntaxError) continue; // normal reader diagnoses corrupt state
			throw error;
		}
		if (!isRecord(raw)) continue;
		const channelId = typeof raw.channelId === "string" ? raw.channelId : basename(source, ".json");
		if (!isChannelId(channelId)) continue;
		const target = getMemoryMaintenanceStatePath(appHomeDir, channelId);
		if (source !== target && source !== join(root, `${channelId}.json`)) continue;
		let canonicalExists = false;
		if (source !== target) {
			try {
				const existing: unknown = JSON.parse(await readFile(target, "utf8"));
				if (!isRecord(existing) || (existing.channelId !== undefined && existing.channelId !== channelId)) {
					throw new Error(
						`Invalid memory maintenance state at ${target}; repair it before restarting. Legacy state retained at ${source}.`,
					);
				}
				canonicalExists = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const hasOldFields = "lastCheckpointAt" in raw || "lastCheckpointEntryId" in raw;
		if (!canonicalExists && (source !== target || hasOldFields)) {
			for (const [current, old] of [
				["lastReflectAt", "lastCheckpointAt"],
				["lastReflectedEntryId", "lastCheckpointEntryId"],
			]) {
				if (typeof raw[current] !== "string" || !raw[current].trim()) raw[current] = raw[old];
				delete raw[old];
			}
			await writeFileAtomically(target, `${JSON.stringify({ ...raw, channelId }, null, 2)}\n`);
		}
		if (source !== target) {
			await unlink(source);
			// Empty legacy directories only; never remove unrelated state.
			for (let dir = dirname(source); dir !== root; dir = dirname(dir)) {
				try {
					await rmdir(dir);
				} catch {
					break;
				}
			}
		}
	}
}

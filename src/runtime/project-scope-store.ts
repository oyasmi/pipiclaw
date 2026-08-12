import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	currentProjectSandboxStatus,
	isWithinAllowedRoots,
	type ProjectAccessPolicy,
	type ProjectScope,
} from "../security/project-scope.js";
import { writeFileAtomically } from "../shared/atomic-file.js";

/** A channel's persisted project selection (D3.3). Never holds messages, only the choice itself. */
export interface PersistedProjectSelectionV1 {
	version: 1;
	/** Realpath. */
	projectRoot: string;
	updatedAt: string;
	updatedBy: "migration" | "dingtalk-command" | "tui-command";
}

const SELECTION_FILENAME = "project.json";

export function getProjectSelectionPath(channelDir: string): string {
	return join(channelDir, SELECTION_FILENAME);
}

export function readProjectSelection(channelDir: string): PersistedProjectSelectionV1 | undefined {
	const path = getProjectSelectionPath(channelDir);
	if (!existsSync(path)) {
		return undefined;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}
	if (
		!raw ||
		typeof raw !== "object" ||
		(raw as { version?: unknown }).version !== 1 ||
		typeof (raw as { projectRoot?: unknown }).projectRoot !== "string" ||
		typeof (raw as { updatedAt?: unknown }).updatedAt !== "string" ||
		typeof (raw as { updatedBy?: unknown }).updatedBy !== "string"
	) {
		return undefined;
	}
	return raw as PersistedProjectSelectionV1;
}

/** Same durability tradeoff as every other atomic writer in this codebase (temp + rename), minus
 * the fsync `writeFileAtomically` does — used only for the one-time, in-constructor migration
 * write (D3.3); every explicit mutation (`/project set|reset`) goes through the fsync'd async
 * `writeFileAtomically` in `commitProjectSelection` instead. */
function writeProjectSelectionSync(channelDir: string, selection: PersistedProjectSelectionV1): void {
	const path = getProjectSelectionPath(channelDir);
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(selection, null, 2)}\n`, "utf-8");
	renameSync(tempPath, path);
}

export async function commitProjectSelection(
	channelDir: string,
	projectRoot: string,
	updatedBy: PersistedProjectSelectionV1["updatedBy"],
): Promise<PersistedProjectSelectionV1> {
	const selection: PersistedProjectSelectionV1 = {
		version: 1,
		projectRoot,
		updatedAt: new Date().toISOString(),
		updatedBy,
	};
	await writeFileAtomically(getProjectSelectionPath(channelDir), `${JSON.stringify(selection, null, 2)}\n`);
	return selection;
}

export type ProjectScopeOutcome =
	| { kind: "ready"; scope: ProjectScope; selection: PersistedProjectSelectionV1 }
	| { kind: "blocked"; reason: string };

/**
 * Resolves the effective `ProjectScope` for a channel: its persisted selection if present and
 * still valid, else the app default — materialized as the channel's first selection so a later
 * daemon restart from a different startup cwd cannot silently move the channel (D3.3). Never
 * falls back to a different root once one has been persisted (P7): a stale or now-disallowed
 * selection blocks instead of guessing.
 */
export function resolveProjectScope(
	channelDir: string,
	resolution: { policy: ProjectAccessPolicy; configured: boolean },
): ProjectScopeOutcome {
	const sandbox = currentProjectSandboxStatus();
	const boundary: ProjectScope["boundary"] = resolution.configured ? "project" : "unbounded";
	const existing = readProjectSelection(channelDir);

	if (!existing) {
		const selection: PersistedProjectSelectionV1 = {
			version: 1,
			projectRoot: resolution.policy.defaultRoot,
			updatedAt: new Date().toISOString(),
			updatedBy: "migration",
		};
		writeProjectSelectionSync(channelDir, selection);
		return { kind: "ready", scope: { projectRoot: resolution.policy.defaultRoot, boundary, sandbox }, selection };
	}

	if (!existsSync(existing.projectRoot)) {
		return {
			kind: "blocked",
			reason: `项目目录已不存在：${existing.projectRoot}。请恢复该目录，或在频道空闲时执行 /project set <path> 或 /project reset。`,
		};
	}
	let real: string;
	try {
		real = realpathSync(existing.projectRoot);
	} catch {
		return {
			kind: "blocked",
			reason: `项目目录不可读：${existing.projectRoot}。请检查权限，或在频道空闲时执行 /project set <path>。`,
		};
	}
	if (real !== existing.projectRoot) {
		return {
			kind: "blocked",
			reason: `项目目录 ${existing.projectRoot} 现在指向 ${real}（symlink 已被重新指向），与上次选择不一致。请在频道空闲时执行 /project set <path> 确认新目标，或 /project reset。`,
		};
	}
	if (resolution.configured && !isWithinAllowedRoots(real, resolution.policy)) {
		return {
			kind: "blocked",
			reason: `项目目录 ${real} 已不在允许的可选根内（security.json 的 projectAccess 已变更）。请在频道空闲时执行 /project set <path> 或 /project reset。`,
		};
	}
	return { kind: "ready", scope: { projectRoot: real, boundary, sandbox }, selection: existing };
}

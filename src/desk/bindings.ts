/** The current binding format, shared by synchronous initialization and daemon reads. */
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAtomicTempPath, syncDirectoryBestEffort, writeFileAtomically } from "../shared/atomic-file.js";
import { isPlainObject } from "../shared/type-guards.js";
import { DESK_DIR_PREFIX, getBindingsPath, isDeskName } from "./paths.js";
import { StartupRefusal } from "./startup-error.js";
import type { BindingsFile } from "./types.js";

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function decode(text: string, path: string): BindingsFile {
	const fail = (reason: string): never => {
		throw new StartupRefusal(`Desk bindings file ${path} ${reason}; fix or restore it before starting.`);
	};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return fail("is not valid JSON");
	}
	if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.bindings)) {
		return fail("has an unsupported shape or version");
	}
	const bindings: BindingsFile["bindings"] = {};
	for (const [channelId, entry] of Object.entries(value.bindings)) {
		if (
			!isPlainObject(entry) ||
			typeof entry.desk !== "string" ||
			!isDeskName(entry.desk) ||
			typeof entry.boundAt !== "string" ||
			Object.keys(entry).some((key) => key !== "desk" && key !== "boundAt")
		) {
			return fail(`has an invalid entry for ${channelId}`);
		}
		bindings[channelId] = { desk: entry.desk, boundAt: entry.boundAt };
	}
	return { version: 1, bindings };
}

export function loadBindingsSync(workspaceDir: string): BindingsFile {
	const path = getBindingsPath(workspaceDir);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (missing(error)) throw error;
		throw new StartupRefusal(`Cannot read desk bindings file ${path}; check permissions before starting.`);
	}
	return decode(text, path);
}

/** Publish an empty table exclusively. A racing initializer can never erase a first binding. */
export function initializeBindings(workspaceDir: string): BindingsFile {
	try {
		return loadBindingsSync(workspaceDir);
	} catch (error) {
		if (!missing(error)) throw error;
	}
	mkdirSync(workspaceDir, { recursive: true });
	const hasDesks = readdirSync(workspaceDir, { withFileTypes: true }).some(
		(entry) => entry.name.startsWith(DESK_DIR_PREFIX) && (entry.isDirectory() || entry.isSymbolicLink()),
	);
	if (hasDesks) {
		// Another process may have published both the table and a desk since the first read.
		try {
			return loadBindingsSync(workspaceDir);
		} catch (error) {
			if (!missing(error)) throw error;
		}
		throw new StartupRefusal(
			`Desk bindings file ${getBindingsPath(workspaceDir)} is missing from an existing workspace; restore it before starting.`,
		);
	}
	const path = getBindingsPath(workspaceDir);
	const temporary = createAtomicTempPath(join(workspaceDir, ".desk-bindings-init"));
	writeFileSync(temporary, `${JSON.stringify({ version: 1, bindings: {} }, null, 2)}\n`, { flush: true });
	try {
		try {
			linkSync(temporary, path);
			syncDirectoryBestEffort(workspaceDir);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	} finally {
		unlinkSync(temporary);
	}
	return loadBindingsSync(workspaceDir);
}

export async function loadBindings(workspaceDir: string): Promise<BindingsFile> {
	const path = getBindingsPath(workspaceDir);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new StartupRefusal(
			`Cannot read desk bindings file ${path}; check permissions or restore it before starting.`,
		);
	}
	return decode(text, path);
}

export async function writeBindings(workspaceDir: string, file: BindingsFile): Promise<void> {
	await writeFileAtomically(getBindingsPath(workspaceDir), `${JSON.stringify(file, null, "\t")}\n`);
}

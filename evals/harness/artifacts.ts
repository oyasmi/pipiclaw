import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactSpec, TrialContext } from "./schema.js";
import { hashFile } from "./util.js";

export interface ArtifactIndex {
	schemaVersion: 1;
	complete: boolean;
	mounts: { homeDir: string; workspaceDir: string; channelDir: string };
	entries: Array<{
		id: string;
		path: string;
		hash?: string;
		size?: number;
		status: "complete" | "missing" | "oversize" | "unsupported";
	}>;
}
const EXCLUDED = new Set([
	"auth.json",
	"log.jsonl",
	"context.jsonl",
	"last_prompt.json",
	".sessions",
	"sessions",
	"node_modules",
	".git",
]);

export function atomicJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, path);
}

export function captureArtifacts(
	context: Pick<TrialContext, "homeDir" | "workspaceDir" | "channelDir">,
	trialDir: string,
	specs: ArtifactSpec[] = [{ root: "workspace", path: "." }],
): ArtifactIndex {
	const index: ArtifactIndex = { schemaVersion: 1, complete: true, mounts: context, entries: [] };
	let bytes = 0;
	const seen = new Set<string>();
	for (const spec of specs) {
		const root = spec.root === "workspace" ? context.workspaceDir : context.channelDir;
		const visit = (path: string): void => {
			const rel = relative(root, path);
			if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
				throw new Error("Artifact path escapes its declared root; use a workspace-relative path.");
			const id = `${spec.root}/${rel.split("\\").join("/")}`;
			if (seen.has(id)) return;
			seen.add(id);
			const destination = join("artifacts", id);
			const fail = (status: "missing" | "oversize" | "unsupported", size?: number) => {
				index.entries.push({ id, path: destination, status, size });
				if (!spec.optional) index.complete = false;
			};
			if (EXCLUDED.has(basename(path))) {
				fail("unsupported");
				return;
			}
			if (!existsSync(path)) {
				fail("missing");
				return;
			}
			const stat = lstatSync(path);
			if (stat.isSymbolicLink()) {
				fail("unsupported");
				return;
			}
			const real = relative(realpathSync(root), realpathSync(path));
			if (real.startsWith("..") || isAbsolute(real)) {
				fail("unsupported");
				return;
			}
			if (stat.isDirectory()) {
				for (const name of readdirSync(path).sort()) if (!EXCLUDED.has(name)) visit(join(path, name));
				return;
			}
			if (!stat.isFile()) {
				fail("unsupported");
				return;
			}
			if (
				stat.size > (spec.maxBytes ?? 8 * 1024 * 1024) ||
				bytes + stat.size > 32 * 1024 * 1024 ||
				index.entries.length >= 5000
			) {
				fail("oversize", stat.size);
				return;
			}
			bytes += stat.size;
			const target = join(trialDir, destination);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(path, target);
			index.entries.push({ id, path: destination, hash: hashFile(target), size: stat.size, status: "complete" });
		};
		if (isAbsolute(spec.path))
			throw new Error(
				"Absolute artifact declarations are unsupported; use a path relative to workspace or channel.",
			);
		visit(resolve(root, spec.path));
	}
	atomicJson(join(trialDir, "artifact-index.json"), index);
	return index;
}

export function sealArtifactIndex(trialDir: string, index: ArtifactIndex, files: string[], traceComplete = true): void {
	index.complete &&= traceComplete;
	const expanded: string[] = [];
	const visit = (file: string) => {
		const path = join(trialDir, file);
		if (existsSync(path) && lstatSync(path).isDirectory()) {
			for (const name of readdirSync(path).sort()) visit(join(file, name));
		} else expanded.push(file);
	};
	for (const file of files) visit(file);
	for (const file of expanded) {
		const path = join(trialDir, file);
		if (!existsSync(path)) {
			index.complete = false;
			index.entries.push({ id: `capture/${file}`, path: file, status: "missing" });
			continue;
		}
		index.entries.push({
			id: `capture/${file}`,
			path: file,
			hash: hashFile(path),
			size: lstatSync(path).size,
			status: "complete",
		});
	}
	atomicJson(join(trialDir, "artifact-index.json"), index);
}

/** Verify stored bytes before allowing an oracle to consume archived evidence. */
export function verifyArtifacts(trialDir: string, required: string[] = []): ArtifactIndex {
	const index = JSON.parse(readFileSync(join(trialDir, "artifact-index.json"), "utf8")) as ArtifactIndex;
	if (index.schemaVersion !== 1 || !index.complete)
		throw new Error("Archived evidence is incomplete; collect the missing artifacts before regrading.");
	for (const file of required)
		if (!index.entries.some((entry) => entry.path === file && entry.status === "complete"))
			throw new Error(`Unsealed ${file}; restore its artifact index before regrading.`);
	for (const entry of index.entries) {
		if (entry.status !== "complete") continue;
		const path = resolve(trialDir, entry.path);
		const rel = relative(trialDir, path);
		if (
			isAbsolute(rel) ||
			rel.startsWith("..") ||
			!existsSync(path) ||
			lstatSync(path).isSymbolicLink() ||
			relative(realpathSync(trialDir), realpathSync(path)).startsWith("..") ||
			hashFile(path) !== entry.hash
		)
			throw new Error(`Artifact ${entry.id} is missing or changed; restore its archived bytes before regrading.`);
	}
	return index;
}

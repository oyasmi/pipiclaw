import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { renderTaskDocument, taskBody } from "./contract.js";
import { withTaskMutation } from "./mutation-lock.js";
import { readStoredTask, type StoredTaskDocument, writeStoredTask } from "./store.js";

/** Built-in file edits share the runtime's lock, from the first read through the final rename. */
export function withTaskFileMutation<T>(
	deskDir: string | undefined,
	path: string,
	mutate: (document?: StoredTaskDocument) => Promise<T>,
): Promise<T> {
	if (!deskDir || !path.endsWith(".md")) return mutate();
	let parent: string;
	let taskDir: string;
	try {
		parent = realpathSync(dirname(resolve(path)));
		taskDir = realpathSync(join(deskDir, "tasks"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return mutate();
		throw error;
	}
	if (parent !== taskDir) return mutate();
	const id = basename(path, ".md");
	return withTaskMutation(deskDir, id, async () => {
		const document = await readStoredTask(deskDir, id);
		if (document?.recovered) await writeStoredTask(document);
		return mutate(document);
	});
}

/** A whole-contract write replaces only the leader-owned body, never a stale runtime header. */
export function preserveTaskFields(document: StoredTaskDocument | undefined, content: string): string {
	return document ? renderTaskDocument(document.fields, taskBody(content)) : content;
}

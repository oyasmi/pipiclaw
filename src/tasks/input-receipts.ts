import { readFile } from "node:fs/promises";
import { isPlainObject } from "../shared/type-guards.js";
import { appendTaskLog, newInputs, readTaskLog } from "./loop-log.js";
import { withTaskMutation } from "./mutation-lock.js";
import { taskSessionPath } from "./session-path.js";

export function taskInputTag(id: string): string {
	return `<task_input id="${id}" />`;
}

/** Read the actual transcript, not SDK queue/message events (those precede persistence). */
export async function acknowledgeTaskInputs(deskDir: string, taskId: string): Promise<void> {
	await withTaskMutation(deskDir, taskId, async () => {
		const pending = newInputs(await readTaskLog(deskDir, taskId, { strict: true }));
		if (pending.length === 0) return;
		let transcript: string;
		try {
			transcript = await readFile(taskSessionPath(deskDir, taskId), "utf-8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		const received = new Set<string>();
		for (const line of transcript.split("\n")) {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (
				!isPlainObject(entry) ||
				entry.type !== "message" ||
				!isPlainObject(entry.message) ||
				entry.message.role !== "user"
			)
				continue;
			const content: unknown = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.filter(isPlainObject)
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
			for (const match of text.matchAll(/<task_input id="([a-f0-9-]+)" \/>/g)) received.add(match[1]);
		}
		const ids = pending.flatMap((record) => (record.id && received.has(record.id) ? [record.id] : []));
		if (ids.length > 0) await appendTaskLog(deskDir, taskId, { kind: "input_ack", ids });
	});
}

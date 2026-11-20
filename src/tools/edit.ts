import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { type FileStat, type FileStore, fingerprintOf, fingerprintsEqual } from "../file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import { checkPathGuard } from "../security/path-guard-check.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { assertPathWritableUnderLease } from "../subagents/workspace-lease.js";
import { withTaskFileMutation } from "../tasks/file-mutation.js";

import { clampDiffForEcho, renderEditDiff, renderStreamingEditDiff } from "./edit-diff.js";
import { type EditHunk, planInlineEdit, planStreamingEdit } from "./edit-match.js";
import { type FileObservations, observeCurrentFile } from "./file-observations.js";

const editSchema = Type.Object({
	path: Type.String({ description: "File path." }),
	oldText: Type.Optional(Type.String({ description: "Exact anchor for a single edit." })),
	newText: Type.Optional(Type.String({ description: "Replacement for a single edit." })),
	replaceAll: Type.Optional(Type.Boolean({ description: "Replace all matches; default false." })),
	edits: Type.Optional(
		Type.Array(
			Type.Object({
				oldText: Type.String(),
				newText: Type.String(),
				replaceAll: Type.Optional(Type.Boolean()),
			}),
			{
				minItems: 1,
				maxItems: 50,
				description: "Atomic edits against the original file. Use instead of top-level oldText/newText/replaceAll.",
			},
		),
	),
});

export interface EditToolOptions {
	deskDir?: string;
	securityConfig?: SecurityConfig;
	securityContext?: SecurityRuntimeContext;
	channelId?: string;
	leaseOwnerRunId?: string;
	observations?: FileObservations;
}

const NOOP_HARD_LIMIT = 3;
const EDIT_INLINE_MAX_BYTES = 8 * 1024 * 1024;

function normalizeEdits({ edits, oldText, newText, replaceAll }: Static<typeof editSchema>): EditHunk[] {
	if (edits !== undefined && (oldText !== undefined || newText !== undefined || replaceAll !== undefined)) {
		throw new RecoverableToolError("Use either edits or top-level oldText/newText/replaceAll.");
	}
	if (edits === undefined && (typeof oldText !== "string" || typeof newText !== "string")) {
		throw new RecoverableToolError("Provide both oldText and newText, or use edits.");
	}
	const hunks = edits ?? [{ oldText: oldText!, newText: newText!, replaceAll }];
	if (hunks.length === 0 || hunks.length > 50) {
		throw new RecoverableToolError("Provide 1 to 50 edits; split larger requests across calls.");
	}
	for (const [index, hunk] of hunks.entries()) {
		if (hunk.oldText.length === 0) {
			throw new RecoverableToolError(
				`oldText must not be empty (edit #${index + 1}). Read the target and supply an exact anchor.`,
			);
		}
	}
	return hunks;
}

async function checkFingerprintUnchanged(
	fileStore: FileStore,
	target: string,
	path: string,
	before: FileStat,
): Promise<void> {
	const after = await fileStore.stat(target);
	if (!after || !fingerprintsEqual(fingerprintOf(before), fingerprintOf(after))) {
		throw new RecoverableToolError(
			`${path} changed during this edit (likely a background job or another agent writing concurrently). ` +
				"Re-read the file and re-apply the edit against its current content.",
		);
	}
}

export function createEditTool(fileStore: FileStore, options: EditToolOptions = {}): AgentTool<typeof editSchema> {
	const securityConfig = options.securityConfig ?? DEFAULT_SECURITY_CONFIG;
	const securityContext = options.securityContext ?? {
		agentWorkspaceDir: process.cwd(),
		cwd: process.cwd(),
	};
	const noopCounts = new Map<string, number>();

	return {
		name: "edit",
		label: "edit",
		// Serialize with other mutating tools in the same SDK batch.
		executionMode: "sequential",
		description: "Replace exact text, including whitespace. Matches must be unique unless replaceAll is true.",
		parameters: editSchema,
		execute: async (_toolCallId, args, signal) => {
			const { path } = args;
			const hunks = normalizeEdits(args);
			const target = await checkPathGuard(path, "read", securityConfig, securityContext, {
				tool: "edit",
				channelId: options.channelId,
			});
			// `edit` rewrites the file in place, so it must clear the *write* guard too (spec 044,
			// D1.1). Pass the original `path`, never the realpath'd `target`: the guard's
			// symlink-write check lstats the pre-symlink-resolution path, and handing it a resolved
			// value would blind it to "the path itself is a symlink". Both calls return the same
			// `resolvedPath` for read and write, so `target` stays the one value we open.
			const writableTarget = await checkPathGuard(path, "write", securityConfig, securityContext, {
				tool: "edit",
				channelId: options.channelId,
			});
			if (writableTarget !== target) {
				throw new RecoverableToolError(
					`${path} resolved to different targets during this edit. Re-read it and retry.`,
				);
			}
			assertPathWritableUnderLease(target, {
				deskDir: options.deskDir,
				excludeRunId: options.leaseOwnerRunId,
			});

			return withTaskFileMutation(options.deskDir, target, async () => {
				const before = await fileStore.stat(target);
				if (!before?.isFile) {
					throw new RecoverableToolError(`File not found: ${path}. Read the parent directory to check the path.`);
				}
				const note = options.observations?.describeEditNote(target, path, before);
				const result =
					before.size <= EDIT_INLINE_MAX_BYTES
						? await editInline(fileStore, target, path, before, hunks, signal)
						: await editStreaming(fileStore, target, path, before, hunks, signal);

				if (!result) {
					const noopKey = JSON.stringify([target, hunks]);
					const streak = (noopCounts.get(noopKey) ?? 0) + 1;
					noopCounts.set(noopKey, streak);
					if (streak >= NOOP_HARD_LIMIT) {
						throw new Error(
							`STOP. This exact edit to ${path} has been a no-op ${streak} times in a row. Re-read the file to verify what still needs changing.`,
						);
					}
					throw new RecoverableToolError(
						`No changes made to ${path}: the replacements produced byte-identical content. Re-read the file to verify what still needs changing.`,
					);
				}
				noopCounts.clear();
				await observeCurrentFile(options.observations, fileStore, target);

				const { oldText, newText, replaceAll } = hunks[0];
				const replacementSummary =
					hunks.length > 1
						? `Applied ${hunks.length} edits to ${path} (${result.occurrences} replacements).`
						: replaceAll
							? `Replaced ${result.occurrences} occurrence${result.occurrences === 1 ? "" : "s"} in ${path}.`
							: `Successfully replaced text in ${path}. Changed ${oldText.length} characters to ${newText.length} characters.`;
				const echoedDiff = result.diff.trim() ? `\n\n${clampDiffForEcho(result.diff)}` : "";
				return {
					content: [{ type: "text", text: `${replacementSummary}${echoedDiff}${note ? `\n${note}` : ""}` }],
					details: { path: target, diff: result.diff, patch: result.patch },
				};
			});
		},
	};
}

async function editInline(
	fileStore: FileStore,
	target: string,
	path: string,
	before: FileStat,
	hunks: EditHunk[],
	signal?: AbortSignal,
) {
	const { data } = await fileStore.readBytes(target, { signal });
	const { newData, occurrences } = planInlineEdit(data, path, hunks);
	if (newData.equals(data)) return undefined;

	await checkFingerprintUnchanged(fileStore, target, path, before);
	await fileStore.writeAtomic(target, newData, { preserveMode: true, signal });
	return { ...renderEditDiff(path, data, newData), occurrences };
}

async function editStreaming(
	fileStore: FileStore,
	target: string,
	path: string,
	before: FileStat,
	hunks: EditHunk[],
	signal?: AbortSignal,
) {
	if (hunks.length > 1) {
		throw new RecoverableToolError(`${path} exceeds 8 MiB. Split the edits into separate single-edit calls.`);
	}
	const { needle, replacement, matchOffsets, lineNumbers } = await planStreamingEdit(
		fileStore,
		target,
		path,
		hunks[0],
		signal,
	);
	if (needle.equals(replacement)) return undefined;

	const diff = await renderStreamingEditDiff(
		fileStore,
		target,
		path,
		before.size,
		needle,
		replacement,
		matchOffsets,
		lineNumbers,
		signal,
	);
	await checkFingerprintUnchanged(fileStore, target, path, before);
	await fileStore.replaceViaTemp(
		target,
		async (out) => {
			let cursor = 0;
			for (const offset of matchOffsets) {
				await copyRange(fileStore, target, cursor, offset, out);
				out.write(replacement);
				cursor = offset + needle.length;
			}
			await copyRange(fileStore, target, cursor, before.size, out);
			await checkFingerprintUnchanged(fileStore, target, path, before);
		},
		{ preserveMode: true, signal },
	);
	return { ...diff, occurrences: matchOffsets.length };
}

/** Copy `[start, end)` of `path` onto `out`, with simple backpressure handling. */
function copyRange(
	store: FileStore,
	path: string,
	start: number,
	end: number,
	out: NodeJS.WritableStream,
): Promise<void> {
	if (end <= start) return Promise.resolve();
	return new Promise((resolveCopy, reject) => {
		const src = store.openRead(path, { start, end: end - 1 });
		src.on("data", (chunk: Buffer) => {
			if (!out.write(chunk)) {
				src.pause();
				out.once("drain", () => src.resume());
			}
		});
		src.on("end", () => resolveCopy());
		src.on("error", reject);
	});
}

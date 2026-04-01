import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	SidecarParseError: class SidecarParseError extends Error {
		readonly taskName: string;
		readonly rawText: string;

		constructor(taskName: string, rawText: string, cause: unknown) {
			super(`Sidecar task "${taskName}" returned invalid output`);
			this.name = "SidecarParseError";
			this.taskName = taskName;
			this.rawText = rawText;
			this.cause = cause;
		}
	},
}));

import { readChannelSession } from "../src/memory-files.js";
import { renderSessionMemory, updateChannelSessionMemory } from "../src/session-memory.js";
import { runSidecarTask, SidecarParseError } from "../src/sidecar-worker.js";

const tempDirs: string[] = [];

function createTempChannel(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-session-memory-"));
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.clearAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("session-memory", () => {
	it("renders session memory deterministically", () => {
		const rendered = renderSessionMemory({
			title: "Fix login regression",
			currentState: ["Investigating oauth callback state."],
			userIntent: ["Restore login flow without changing token storage."],
			activeFiles: ["src/auth.ts"],
			decisions: ["Keep token storage format unchanged."],
			constraints: ["Production must stay online."],
			errorsAndCorrections: ["Previous retry loop masked the real callback error."],
			nextSteps: ["Reproduce the callback failure locally."],
			worklog: [],
		});

		expect(rendered).toContain("# Session Title");
		expect(rendered).toContain("Fix login regression");
		expect(rendered).toContain("# Current State");
		expect(rendered).toContain("- Investigating oauth callback state.");
		expect(rendered).not.toContain("# Worklog");
	});

	it("writes rendered session memory from sidecar output", async () => {
		const channelDir = createTempChannel();
		writeFileSync(join(channelDir, "SESSION.md"), "# Session Title\n\nOld title\n", "utf-8");
		writeFileSync(
			join(channelDir, "MEMORY.md"),
			"# Channel Memory\n\n## Constraints\n\n- Avoid schema changes.\n",
			"utf-8",
		);

		vi.mocked(runSidecarTask).mockResolvedValue({
			rawText: "{}",
			output: {
				title: "Fix login regression",
				currentState: ["Investigating oauth callback failure."],
				userIntent: ["Get login working again."],
				activeFiles: ["src/auth.ts"],
				decisions: [],
				constraints: ["Avoid schema changes."],
				errorsAndCorrections: [],
				nextSteps: ["Reproduce the bug locally."],
				worklog: ["Checked callback state handling."],
			},
		});

		await updateChannelSessionMemory({
			channelDir,
			messages: [],
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});

		const session = await readChannelSession(channelDir);
		expect(session).toContain("Fix login regression");
		expect(session).toContain("# Active Files");
		expect(session).toContain("src/auth.ts");
		expect(session).toContain("# Worklog");
	});

	it("merges partial sidecar updates without clearing existing sections", async () => {
		const channelDir = createTempChannel();
		writeFileSync(
			join(channelDir, "SESSION.md"),
			[
				"# Session Title",
				"",
				"Old title",
				"",
				"# Current State",
				"",
				"- Existing state.",
				"",
				"# Next Steps",
				"",
				"- Keep this step.",
			].join("\n"),
			"utf-8",
		);
		writeFileSync(join(channelDir, "MEMORY.md"), "# Channel Memory\n", "utf-8");

		vi.mocked(runSidecarTask).mockResolvedValue({
			rawText: "{}",
			output: {
				title: "New title",
				currentState: ["Fresh state."],
			},
		});

		await updateChannelSessionMemory({
			channelDir,
			messages: [],
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
		});

		const session = await readChannelSession(channelDir);
		expect(session).toContain("New title");
		expect(session).toContain("- Fresh state.");
		expect(session).toContain("- Keep this step.");
	});

	it("preserves the current session file and writes a debug artifact on parse failures", async () => {
		const channelDir = createTempChannel();
		const sessionPath = join(channelDir, "SESSION.md");
		writeFileSync(sessionPath, "# Session Title\n\nStable title\n", "utf-8");
		writeFileSync(join(channelDir, "MEMORY.md"), "# Channel Memory\n", "utf-8");

		vi.mocked(runSidecarTask).mockRejectedValue(
			new SidecarParseError("session-memory-update", '{"broken":true}', new Error("schema mismatch")),
		);

		await expect(
			updateChannelSessionMemory({
				channelDir,
				messages: [],
				model: { provider: "test", id: "noop" } as never,
				resolveApiKey: async () => "",
			}),
		).rejects.toBeInstanceOf(SidecarParseError);

		expect(await readChannelSession(channelDir)).toBe("# Session Title\n\nStable title\n");
		expect(
			await import("fs/promises").then(({ readFile }) =>
				readFile(join(channelDir, "SESSION.invalid-response.txt"), "utf-8"),
			),
		).toContain('{"broken":true}');
	});

	it("passes through the configured sidecar timeout", async () => {
		const channelDir = createTempChannel();
		writeFileSync(join(channelDir, "SESSION.md"), "# Session Title\n\nOld title\n", "utf-8");
		writeFileSync(join(channelDir, "MEMORY.md"), "# Channel Memory\n", "utf-8");

		vi.mocked(runSidecarTask).mockResolvedValue({
			rawText: "{}",
			output: {},
		});

		await updateChannelSessionMemory({
			channelDir,
			messages: [],
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
			timeoutMs: 45000,
		});

		expect(vi.mocked(runSidecarTask)).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "session-memory-update",
				timeoutMs: 45000,
			}),
		);
	});
});

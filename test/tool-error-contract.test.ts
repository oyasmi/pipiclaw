import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChannelJobManager } from "../src/agent/job-manager.js";
import type { Executor } from "../src/executor.js";
import { createFileStore } from "../src/file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createBashTool } from "../src/tools/bash.js";
import { createEditTool } from "../src/tools/edit.js";
import { createGrepTool } from "../src/tools/grep.js";
import { createJobTool } from "../src/tools/job.js";
import { createReadTool } from "../src/tools/read.js";
import { createSkillTool } from "../src/tools/skill.js";
import { withToolDetails } from "../src/tools/tool-details.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Fix plan §3.1/§3.2 (docs/reviews/2026-08-24-subagents-and-tools-fix-plan.md): AGENTS.md requires
 * that a failure the model can fix on its own comes back as a `RecoverableToolError` (a normal,
 * non-throwing result with `details.recoverable === true`), not a plain thrown `Error` that would
 * surface as a red error bubble in the user's chat for something the model silently fixes on retry.
 *
 * This is the enforcement point: every case below is a bad-argument/unmet-precondition failure a
 * model can resolve by itself, run through the same `withToolDetails` wrapper the real tool set
 * uses, asserting the wrapped result -- not a rejection -- carries `recoverable: true`. Without a
 * test like this, the contract silently rots as new tools (or edits to old ones) forget it (see
 * AGENTS.md's "error contract" rule).
 */

const disabledSecurity = { ...DEFAULT_SECURITY_CONFIG, enabled: false };

const cleanExecutor: Executor = {
	async exec() {
		return { stdout: "", stderr: "", code: 0 };
	},
};

describe("tool error contract: recoverable failures never throw past withToolDetails", () => {
	const tempDir = useTempDirs("pipiclaw-tool-error-contract-");
	const fileStore = createFileStore();

	it("read: an out-of-bounds offset is recoverable", async () => {
		const dir = tempDir();
		const filePath = join(dir, "notes.txt");
		writeFileSync(filePath, "line1\nline2\nline3\n");
		const tool = withToolDetails(
			createReadTool(cleanExecutor, fileStore, { securityConfig: disabledSecurity }),
			"read",
		);
		const result = await tool.execute("call", { label: "x", path: filePath, offset: 999 }, undefined, undefined);
		expect((result.details as { recoverable?: true }).recoverable).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/^Rejected: /);
	});

	it("grep: an empty pattern is recoverable", async () => {
		const tool = withToolDetails(createGrepTool(cleanExecutor, { securityConfig: disabledSecurity }), "grep");
		const result = await tool.execute("call", { label: "x", pattern: "  " }, undefined, undefined);
		expect((result.details as { recoverable?: true }).recoverable).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/^Rejected: /);
	});

	it("edit: an anchor that does not match is recoverable", async () => {
		const dir = tempDir();
		const filePath = join(dir, "a.txt");
		writeFileSync(filePath, "the actual file contents\n");
		const tool = withToolDetails(createEditTool(fileStore, { securityConfig: disabledSecurity }), "edit");
		const result = await tool.execute(
			"call",
			{ label: "x", path: filePath, oldText: "nope", newText: "y" },
			undefined,
			undefined,
		);
		expect((result.details as { recoverable?: true }).recoverable).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/^Rejected: /);
	});

	it("bash: an interceptor-blocked bare command is recoverable", async () => {
		const tool = withToolDetails(createBashTool(cleanExecutor, { interceptorEnabled: true }), "bash");
		const result = await tool.execute("call", { label: "x", command: "cat notes.txt" }, undefined, undefined);
		expect((result.details as { recoverable?: true }).recoverable).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/^Rejected: /);
	});

	it("job: cancel without ids is recoverable", async () => {
		const jobManager = {} as ChannelJobManager;
		const tool = withToolDetails(createJobTool({ jobManager }), "job");
		const result = await tool.execute("call", { label: "x", op: "cancel" }, undefined, undefined);
		expect((result.details as { recoverable?: true }).recoverable).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/^Rejected: /);
	});

	it("skill: a missing skill name on read is recoverable", async () => {
		const tool = withToolDetails(createSkillTool({ workspaceDir: "/tmp/does-not-matter" }), "skill");
		const result = await tool.execute("call", { label: "x", action: "read" }, undefined, undefined);
		expect((result.details as { recoverable?: true }).recoverable).toBe(true);
		expect((result.content[0] as { text: string }).text).toMatch(/^Rejected: /);
	});
});

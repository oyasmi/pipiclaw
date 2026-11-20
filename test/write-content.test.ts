import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Executor } from "../src/executor.js";
import { createFileStore } from "../src/file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { RecoverableToolError } from "../src/shared/recoverable-error.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { buildToolSet } from "../src/tools/registry.js";
import { writeContent } from "../src/tools/write-content.js";
import { useTempDirs } from "./helpers/fixtures.js";

const fileStore = createFileStore();
const disabledSecurity = { enabled: false } as never;

const tempDir = useTempDirs("pipiclaw-write-test-");

describe("write-content", () => {
	it("writes content and can create parent directories", async () => {
		const dir = tempDir();
		const target = join(dir, "nested", "file.txt");

		await writeContent(fileStore, target, "hello", undefined, {
			createParentDir: true,
			securityConfig: disabledSecurity,
		});

		expect(readFileSync(target, "utf-8")).toBe("hello");

		// Active delegation write/read lease blocks main/task `write` with RecoverableToolError,
		// while permitting the owning internal worker (`leaseOwnerRunId`) and desk control-plane tasks/.
		const lease = acquireWorkspaceLease({ runId: "run_w1", channelId: "dingtalk:dm:1", workingDirectory: dir });
		expect(lease.ok).toBe(true);
		try {
			await expect(
				writeContent(fileStore, target, "clobber", undefined, { securityConfig: disabledSecurity }),
			).rejects.toThrow(RecoverableToolError);
			expect(readFileSync(target, "utf-8")).toBe("hello");

			await writeContent(fileStore, target, "worker-owned", undefined, {
				securityConfig: disabledSecurity,
				leaseOwnerRunId: "run_w1",
			});
			expect(readFileSync(target, "utf-8")).toBe("worker-owned");

			mkdirSync(join(dir, "tasks"), { recursive: true });
			const contractPath = join(dir, "tasks", "proj.md");
			await writeContent(fileStore, contractPath, "# Proj\n", undefined, {
				deskDir: dir,
				securityConfig: disabledSecurity,
			});
			expect(readFileSync(contractPath, "utf-8")).toContain("# Proj");
		} finally {
			if (lease.ok) releaseWorkspaceLease(lease.leaseKey, "run_w1");
		}
	});

	it("shares read and write observations within a tool set without blocking overwrites", async () => {
		const dir = tempDir();
		const path = join(dir, "notes.txt");
		const executor: Executor = {
			exec: async () => {
				throw new Error("Unexpected executor call");
			},
		};
		const build = () => {
			const tools = buildToolSet(
				{
					executor,
					fileStore,
					securityConfig: { ...DEFAULT_SECURITY_CONFIG, enabled: false },
					securityContext: { agentWorkspaceDir: dir, cwd: dir },
					channelId: "test",
					deskDir: dir,
					workspaceDir: dir,
				},
				{ forSubagent: true },
			);
			const call = async (name: string, args: Record<string, unknown>) => {
				const tool = tools.find((candidate) => candidate.name === name)!;
				const result = await tool.execute(name, { path, ...args });
				expect(result.details).not.toHaveProperty("recoverable");
				return result.content[0].type === "text" ? result.content[0].text : "";
			};
			return call;
		};

		writeFileSync(path, "original");
		const current = build();
		expect(await current("write", { content: "first" })).toMatch(/Note: .*without reading/);
		expect(readFileSync(path, "utf-8")).toBe("first");
		expect(await current("write", { content: "second" })).not.toContain("Note:");
		const fresh = build();
		expect(await fresh("write", { content: "line one\nline two" })).toMatch(/Note: .*without reading/);
		const reader = build();
		await reader("read", { offset: 2, limit: 1 });
		expect(await reader("write", { content: "read before writing" })).not.toContain("Note:");

		writeFileSync(path, "externally modified");
		expect(await reader("edit", { oldText: "modified", newText: "edited" })).toMatch(/Note: .*modified/);
		expect(readFileSync(path, "utf-8")).toBe("externally edited");
		expect(await reader("write", { content: "locally observed" })).not.toContain("Note:");
		writeFileSync(path, "another external edit");
		expect(await reader("write", { content: "overwritten" })).toMatch(/Note: .*modified externally/);
		expect(readFileSync(path, "utf-8")).toBe("overwritten");
	});

	it("preserves the existing file's permission bits across an overwrite", async () => {
		const dir = tempDir();
		const target = join(dir, "script.sh");
		writeFileSync(target, "#!/bin/sh\necho hi\n");
		chmodSync(target, 0o755);

		await writeContent(fileStore, target, "#!/bin/sh\necho bye\n", undefined, { securityConfig: disabledSecurity });

		expect(statSync(target).mode & 0o777).toBe(0o755);
		expect(readFileSync(target, "utf-8")).toBe("#!/bin/sh\necho bye\n");
	});
});

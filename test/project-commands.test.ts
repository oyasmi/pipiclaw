import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleProjectCommand } from "../src/runtime/project-commands.js";
import { readProjectSelection } from "../src/runtime/project-scope-store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-project-commands-");

function writeSecurityConfig(appHomeDir: string, projectAccess: unknown): void {
	mkdirSync(appHomeDir, { recursive: true });
	writeFileSync(join(appHomeDir, "security.json"), JSON.stringify({ projectAccess }));
}

function baseOptions(overrides: Partial<Parameters<typeof handleProjectCommand>[0]> = {}) {
	const appHomeDir = createTempDir();
	const channelDir = createTempDir();
	return {
		args: "",
		channelId: "dm_1",
		channelDir,
		appHomeDir,
		actor: "dingtalk-command" as const,
		isBusy: () => false,
		listActiveBlockers: () => [],
		...overrides,
	};
}

describe("handleProjectCommand", () => {
	it("show: reports the unconfigured-compat state when projectAccess is absent", async () => {
		const options = baseOptions();
		const text = await handleProjectCommand(options);
		expect(text).toContain("unbounded");
		expect(text).toContain("未配置 projectAccess");
	});

	it("set: rejected when projectAccess is not configured", async () => {
		const options = baseOptions({ args: `set ${createTempDir()}` });
		const text = await handleProjectCommand(options);
		expect(text).toContain("无法切换项目");
		expect(text).toContain("未配置 projectAccess");
	});

	it("set: rejects a target outside the allowed roots", async () => {
		const options = baseOptions();
		const allowedRoot = createTempDir();
		writeSecurityConfig(options.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot] });
		const outside = createTempDir();

		const text = await handleProjectCommand({ ...options, args: `set ${outside}` });
		expect(text).toContain("不在允许的可选根内");
		expect(readProjectSelection(options.channelDir)).toBeUndefined();
	});

	it("set: rejects a target that does not exist", async () => {
		const options = baseOptions();
		const allowedRoot = createTempDir();
		writeSecurityConfig(options.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot] });

		const text = await handleProjectCommand({ ...options, args: `set ${join(allowedRoot, "nope")}` });
		expect(text).toContain("不是一个存在的绝对目录");
	});

	it("set: commits the selection and calls onScopeChanged when valid and idle", async () => {
		const options = baseOptions();
		const allowedRoot = createTempDir();
		const target = join(allowedRoot, "sub");
		mkdirSync(target, { recursive: true });
		writeSecurityConfig(options.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot] });
		const onScopeChanged = vi.fn();

		const text = await handleProjectCommand({ ...options, args: `set ${target}`, onScopeChanged });

		expect(text).toContain("已切换项目");
		expect(onScopeChanged).toHaveBeenCalledOnce();
		expect(readProjectSelection(options.channelDir)).toMatchObject({
			projectRoot: target,
			updatedBy: "dingtalk-command",
		});
	});

	it("set: blocked while the channel is busy, and nothing is committed", async () => {
		const options = baseOptions({ isBusy: () => true });
		const allowedRoot = createTempDir();
		writeSecurityConfig(options.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot] });

		const text = await handleProjectCommand({ ...options, args: `set ${allowedRoot}` });
		expect(text).toContain("回合正在进行");
		expect(readProjectSelection(options.channelDir)).toBeUndefined();
	});

	it("set: blocked by a running job/subagent, listing the specific blocker", async () => {
		const options = baseOptions({ listActiveBlockers: () => ["subagent run `run_abc` (builder)"] });
		const allowedRoot = createTempDir();
		writeSecurityConfig(options.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot] });

		const text = await handleProjectCommand({ ...options, args: `set ${allowedRoot}` });
		expect(text).toContain("run_abc");
		expect(readProjectSelection(options.channelDir)).toBeUndefined();
	});

	it("reset: switches to the configured defaultRoot", async () => {
		const options = baseOptions();
		const allowedRoot = createTempDir();
		const otherRoot = createTempDir();
		writeSecurityConfig(options.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot, otherRoot] });
		await handleProjectCommand({ ...options, args: `set ${otherRoot}` });

		const text = await handleProjectCommand({ ...options, args: "reset" });
		expect(text).toContain("已重置项目");
		expect(readProjectSelection(options.channelDir)).toMatchObject({ projectRoot: allowedRoot });
	});

	it("rejects an unknown subcommand with usage text", async () => {
		const options = baseOptions({ args: "bogus" });
		const text = await handleProjectCommand(options);
		expect(text).toContain("未知的 /project 子命令");
		expect(text).toContain("/project set <absolute-path>");
	});
});

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
	it("show/set report the unconfigured-compat state when projectAccess is absent", async () => {
		const options = baseOptions();
		const text = await handleProjectCommand(options);
		expect(text).toContain("unbounded");
		expect(text).toContain("未配置 projectAccess");

		const setText = await handleProjectCommand({ ...options, args: `set ${createTempDir()}` });
		expect(setText).toContain("无法切换项目");
		expect(setText).toContain("未配置 projectAccess");
	});

	it("set: rejects targets outside the allowed roots or nonexistent, committing nothing", async () => {
		const options = baseOptions();
		const allowedRoot = createTempDir();
		writeSecurityConfig(options.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot] });
		const outside = createTempDir();

		const outsideText = await handleProjectCommand({ ...options, args: `set ${outside}` });
		expect(outsideText).toContain("不在允许的可选根内");
		expect(readProjectSelection(options.channelDir)).toBeUndefined();

		const missingText = await handleProjectCommand({ ...options, args: `set ${join(allowedRoot, "nope")}` });
		expect(missingText).toContain("不是一个存在的绝对目录");
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

	it("set: blocked while busy or by a running job/subagent, listing the blocker and committing nothing", async () => {
		const busyOptions = baseOptions({ isBusy: () => true });
		const allowedRoot = createTempDir();
		writeSecurityConfig(busyOptions.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot] });

		const busyText = await handleProjectCommand({ ...busyOptions, args: `set ${allowedRoot}` });
		expect(busyText).toContain("回合正在进行");
		expect(readProjectSelection(busyOptions.channelDir)).toBeUndefined();

		const blockedOptions = baseOptions({ listActiveBlockers: () => ["subagent run `run_abc` (builder)"] });
		writeSecurityConfig(blockedOptions.appHomeDir, { defaultRoot: allowedRoot, allowedRoots: [allowedRoot] });
		const blockedText = await handleProjectCommand({ ...blockedOptions, args: `set ${allowedRoot}` });
		expect(blockedText).toContain("run_abc");
		expect(readProjectSelection(blockedOptions.channelDir)).toBeUndefined();
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

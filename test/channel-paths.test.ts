import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureChannelDir, getChannelDir, getChannelDirName } from "../src/runtime/channel-paths.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-channel-paths-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("channel-paths", () => {
	it("maps slashes in channel ids to double underscores", () => {
		expect(getChannelDirName("group_cidYDhGqxhJOzS7VDv/eDInUw==")).toBe("group_cidYDhGqxhJOzS7VDv__eDInUw==");
		expect(getChannelDirName("dm_staff_1")).toBe("dm_staff_1");
	});

	it("creates a single directory for channel ids with slashes", () => {
		const workingDir = createTempDir();
		const channelId = "group_cidYDhGqxhJOzS7VDv/eDInUw==";
		const channelDir = ensureChannelDir(workingDir, channelId);

		expect(channelDir).toBe(getChannelDir(workingDir, channelId));
		expect(channelDir).toBe(join(workingDir, "group_cidYDhGqxhJOzS7VDv__eDInUw=="));
		expect(existsSync(channelDir)).toBe(true);
	});
});

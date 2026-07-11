import { existsSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ensureChannelDir, getChannelDir, getChannelDirName } from "../src/runtime/channel-paths.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-channel-paths-");

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

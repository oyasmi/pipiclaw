import { describe, expect, it } from "vitest";
import { getChannelDirName } from "../src/runtime/channel-paths.js";

describe("channel-paths", () => {
	it("maps slashes in channel ids to double underscores", () => {
		expect(getChannelDirName("group_cidYDhGqxhJOzS7VDv/eDInUw==")).toBe("group_cidYDhGqxhJOzS7VDv__eDInUw==");
		expect(getChannelDirName("dm_staff_1")).toBe("dm_staff_1");
	});
});

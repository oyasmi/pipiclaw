import { describe, expect, it } from "vitest";
import { getChannelDirName, isChannelId } from "../src/channel/channel-paths.js";

describe("channel-paths", () => {
	it("maps slashes in channel ids to double underscores", () => {
		expect(getChannelDirName("group_cidYDhGqxhJOzS7VDv/eDInUw==")).toBe("group_cidYDhGqxhJOzS7VDv__eDInUw==");
		expect(getChannelDirName("dm_staff_1")).toBe("dm_staff_1");
	});

	it("accepts real base64 conversation ids", () => {
		// The charset allowlist this check used to carry rejected both of these, which is how
		// every real group fell out of workspace scans and the known-channel filter.
		expect(isChannelId("group_cidYDhGqxhJOzS7VDv/eDInUw==")).toBe(true);
		expect(isChannelId("group_cidYDhGqxhJOzS7VDv__eDInUw==")).toBe(true);
		expect(isChannelId("dm_0123456789")).toBe(true);
	});

	it("rejects non-channel names and ids that could escape their directory", () => {
		expect(isChannelId("not_channel")).toBe(false);
		expect(isChannelId("skills")).toBe(false);
		expect(isChannelId("dm_")).toBe(false);
		expect(isChannelId("group_../../etc/passwd")).toBe(false);
		expect(isChannelId("group_x/..")).toBe(false);
		expect(isChannelId("group_a\\b")).toBe(false);
		expect(isChannelId("group_a\0b")).toBe(false);
		// No separator, so this names a directory called `dm_..` rather than escaping anywhere.
		expect(isChannelId("dm_..")).toBe(true);
	});
});

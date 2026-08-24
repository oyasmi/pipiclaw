import { describe, expect, it } from "vitest";
import { clipUserInput, formatProgressEntry } from "../src/agent/progress-formatter.js";

describe("progress formatter", () => {
	it("clips long input with a saved-original pointer and renders clean progress lines", () => {
		expect(clipUserInput("abcdefghijklmnopqrstuvwxyz", 10)).toContain("[... omitted 16 chars ...]");
		const clipped = clipUserInput("abcdefghijklmnopqrstuvwxyz", 10, "/ws/dm_1/inbox/message-x.txt");
		expect(clipped).toContain("the complete message is saved at /ws/dm_1/inbox/message-x.txt");

		expect(formatProgressEntry("tool", "￼\nnpm test\n\n-- --run")).toBe("➜ npm test -- --run");
		expect(formatProgressEntry("thinking", " checking state ")).toBe("✦ checking state");
		expect(formatProgressEntry("assistant", "￼\n \r")).toBe("");
	});
});

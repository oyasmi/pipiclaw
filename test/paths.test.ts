import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.PIPICLAW_HOME;

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.PIPICLAW_HOME;
	} else {
		process.env.PIPICLAW_HOME = originalHome;
	}
	vi.resetModules();
});

describe("paths", () => {
	it("uses PIPICLAW_HOME when provided", async () => {
		process.env.PIPICLAW_HOME = "/tmp/pipiclaw-test-home";
		vi.resetModules();

		const paths = await import("../src/paths.js");

		expect(paths.APP_HOME_DIR).toBe("/tmp/pipiclaw-test-home");
		expect(paths.WORKSPACE_DIR).toBe("/tmp/pipiclaw-test-home/workspace");
		expect(paths.AUTH_CONFIG_PATH).toBe("/tmp/pipiclaw-test-home/auth.json");
	});
});

import { writeFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ChannelConfigError, parseChannelConfig } from "../src/channel/config.js";
import { StartupRefusal } from "../src/desk/startup-error.js";
import { parseDingTalkConfig } from "../src/dingtalk/config.js";
import { loadTransports } from "../src/runtime/transports.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { bootstrapPathsIn } from "./support/fake-runner.js";

const issuesOf = (run: () => unknown): string[] => {
	try {
		run();
	} catch (error) {
		if (error instanceof ChannelConfigError) return error.issues;
		throw error;
	}
	throw new Error("expected a ChannelConfigError");
};

describe("channel.json sections", () => {
	it("returns only the sections that are switched on, and never looks inside one that is off", () => {
		const sections = parseChannelConfig(
			JSON.stringify({
				// Credentials may stay in the file while a transport is off, even half-filled.
				dingtalk: { enabled: false, clientId: "your-dingtalk-client-id", unknownField: 1 },
				webapi: { enabled: true, socket: true },
			}),
		);
		expect(Object.keys(sections)).toEqual(["webapi"]);
	});

	it("rejects an unreadable file, an unknown top-level key, and a switch that is not a boolean, all at once", () => {
		expect(issuesOf(() => parseChannelConfig("{nope"))[0]).toContain("Not valid JSON");
		expect(issuesOf(() => parseChannelConfig("[]"))[0]).toContain("JSON object");
		const issues = issuesOf(() =>
			parseChannelConfig(JSON.stringify({ clientId: "x", dingtalk: { enabled: "yes" }, webapi: {} })),
		);
		// An old-format file is refused by name, with a pointer to the docs, not half-read.
		expect(issues.some((issue) => issue.includes("`clientId`") && issue.includes("configuration.md"))).toBe(true);
		expect(issues).toContain("`dingtalk.enabled` must be true or false.");
		expect(issues).toContain("`webapi.enabled` must be true or false.");
	});
});

describe("dingtalk section", () => {
	it("normalizes a ready section and names every problem of a bad one", () => {
		expect(
			parseDingTalkConfig({
				enabled: true,
				clientId: "client-id",
				clientSecret: "secret",
				robotCode: "",
				allowFrom: ["alice", " ", "bob"],
				busyMessageDefault: "followup",
				responseMode: "rolling_progress_then_plain_final",
			}),
		).toMatchObject({
			clientId: "client-id",
			robotCode: "client-id",
			cardTemplateKey: "content",
			allowFrom: ["alice", "bob"],
			busyMessageDefault: "followUp",
			responseMode: "rolling_progress_then_plain_final",
			cardAutoLayout: true,
		});

		const issues = issuesOf(() =>
			parseDingTalkConfig({ enabled: true, clientId: "your-dingtalk-client-id", busyMessageDefault: "follow-up" }),
		);
		expect(issues).toContain("dingtalk: Replace placeholder value for `clientId`.");
		expect(issues).toContain("dingtalk: Missing required field `clientSecret`.");
		expect(issues.some((issue) => issue.includes("busyMessageDefault"))).toBe(true);
	});
});

describe("loading the configured transports", () => {
	const tempDir = useTempDirs("pipiclaw-channel-config-");
	const load = async (channelJson: unknown) => {
		const paths = bootstrapPathsIn(tempDir());
		writeFileSync(join(tempDir(), "unused"), "");
		writeFileSync(
			paths.channelConfigPath,
			typeof channelJson === "string" ? channelJson : JSON.stringify(channelJson),
		);
		return loadTransports({ paths, stateDir: join(paths.appHomeDir, "state"), archiveBotResponse: async () => {} });
	};

	it("starts only what is switched on, and refuses when nothing is", async () => {
		const ready = { enabled: true, clientId: "id", clientSecret: "secret" };
		const transports = await load({ dingtalk: ready, webapi: { enabled: false } });
		expect(transports.map((transport) => transport.name)).toEqual(["dingtalk"]);

		const nothing = load({ dingtalk: { ...ready, enabled: false }, webapi: { enabled: false } });
		await expect(nothing).rejects.toThrow(StartupRefusal);
		await expect(nothing).rejects.toThrow(/dingtalk\.enabled.*webapi\.enabled/);
	});

	it("turns a bad file into a refusal that says what to fix and where", async () => {
		const refusal = load({ dingtalk: { enabled: true, clientId: "your-dingtalk-client-id" } });
		await expect(refusal).rejects.toThrow(StartupRefusal);
		await expect(refusal).rejects.toThrow(
			/Configuration is not ready: .*channel\.json[\s\S]*clientId[\s\S]*Fix .*channel\.json/,
		);
	});
});

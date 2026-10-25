import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChannelConfigError } from "../src/channel/config.js";
import { authenticate, generateKey, hashKey } from "../src/webapi/auth.js";
import { isLoopbackHost, parseTcpAddress, parseWebApiConfig } from "../src/webapi/config.js";
import { runWebApiCommand } from "../src/webapi/key-command.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { bootstrapPathsIn } from "./support/fake-runner.js";

const issuesOf = (section: unknown): string[] => {
	try {
		parseWebApiConfig(section);
	} catch (error) {
		if (error instanceof ChannelConfigError) return error.issues;
		throw error;
	}
	return [];
};

const goodKey = { name: "ci", sha256: hashKey("k"), desks: ["default"] };

describe("webapi config", () => {
	it("tells loopback from reachable-by-others addresses", () => {
		for (const host of ["127.0.0.1", "127.8.9.10", "::1", "[::1]", "localhost"]) {
			expect(isLoopbackHost(host), host).toBe(true);
		}
		// 127.0.0.1.evil.com and 128.x must not pass for loopback: a non-loopback bind without TLS leaks the key.
		for (const host of ["0.0.0.0", "10.0.0.5", "8.8.8.8", "128.0.0.1", "127.0.0.1.evil.com", "::", "127.0.0"]) {
			expect(isLoopbackHost(host), host).toBe(false);
		}
		expect(parseTcpAddress("[::1]:8787")).toEqual({ host: "::1", port: 8787, loopback: true });
		expect(parseTcpAddress("localhost:99999")).toBeUndefined();
	});

	it("refuses unsafe or empty setups, and accepts the safe ones", () => {
		expect(issuesOf({ socket: false })[0]).toMatch(/nothing to listen on/);
		expect(issuesOf({ tcp: "0.0.0.0:8787" })).toEqual([]);
		expect(issuesOf({ tcp: "0.0.0.0:8787", tls: { cert: "/c.pem", key: "/k.pem" } })).toEqual([]);
		expect(issuesOf({ tcp: "127.0.0.1:8787", keys: [goodKey] })).toEqual([]);
		expect(issuesOf({ tls: { cert: "rel.pem", key: "/k.pem" } })[0]).toMatch(/absolute/);

		const keyIssues = issuesOf({
			keys: [
				goodKey,
				{ ...goodKey },
				{ name: "Bad Name", sha256: "abc", desks: [] },
				{ name: "no-desk", sha256: hashKey("x"), desks: ["UPPER"] },
			],
		});
		expect(keyIssues.join("\n")).toMatch(/used twice/);
		expect(keyIssues.join("\n")).toMatch(/keys\[2\]\.name/);
		expect(keyIssues.join("\n")).toMatch(/keys\[2\]\.sha256/);
		expect(keyIssues.join("\n")).toMatch(/keys\[3\]\.desks/);
	});
});

describe("webapi keys", () => {
	const tempDir = useTempDirs();

	it("a key made by the command authenticates, others do not, and channel.json stays owner-only", async () => {
		const home = tempDir();
		const paths = bootstrapPathsIn(home);
		writeFileSync(paths.channelConfigPath, JSON.stringify({ webapi: { enabled: true } }), { mode: 0o600 });
		const lines: string[] = [];
		const io = {
			log: (...args: unknown[]) => void lines.push(args.join(" ")),
			error: (...args: unknown[]) => void lines.push(args.join(" ")),
		};

		await runWebApiCommand(["node", "pipiclaw", "webapi", "key", "add", "ci", "--desk", "default"], paths, io);
		const key = lines.find((line) => line.trim().startsWith("pk_"))?.trim();
		expect(key).toBeDefined();

		const config = JSON.parse(readFileSync(paths.channelConfigPath, "utf-8"));
		const parsed = parseWebApiConfig(config.webapi);
		expect(config.webapi.keys[0].sha256).not.toContain(key);
		expect(authenticate(`Bearer ${key}`, parsed.keys)).toMatchObject({
			name: "ci",
			desks: ["default"],
			local: false,
		});
		expect(authenticate(`Bearer ${generateKey()}`, parsed.keys)).toBeUndefined();
		expect(authenticate(`Basic ${key}`, parsed.keys)).toBeUndefined();
		expect(authenticate(undefined, parsed.keys)).toBeUndefined();
		expect(statSync(paths.channelConfigPath).mode & 0o777).toBe(0o600);

		await runWebApiCommand(["node", "pipiclaw", "webapi", "key", "remove", "ci"], paths, io);
		expect(JSON.parse(readFileSync(join(home, "channel.json"), "utf-8")).webapi.keys).toEqual([]);
	});
});

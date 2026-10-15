import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";

vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof import("node:fs/promises")>()) }));

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLoginInstallationId } from "../src/models/login-identity.js";
import { loginProvider } from "../src/models/provider-login.js";

let home: string;
const path = () => join(home, "state", "auth", "identity.json");
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "login-identity-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true });
});
function login(signal = new AbortController().signal) {
	const call = vi.fn().mockResolvedValue({ type: "oauth" });
	const runtime = { getAvailableSnapshot: () => [], login: call } as unknown as ModelRuntime;
	return {
		call,
		run: () =>
			loginProvider(runtime, "openai", "oauth", { signal, ask: vi.fn(), notify: vi.fn() }, { appHomeDir: home }),
	};
}

describe("OpenAI OAuth installation identity", () => {
	it("publishes a stable winner across independent processes observing the same absent file", async () => {
		// Compile these two production modules, so npm test needs neither dist nor a second SDK install.
		for (const source of ["models/login-identity", "shared/type-guards"]) {
			const target = join(home, "compiled", `${source}.js`);
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(
				target,
				transpileModule(readFileSync(new URL(`../src/${source}.ts`, import.meta.url), "utf8"), {
					compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
				}).outputText,
			);
		}
		writeFileSync(join(home, "compiled", "package.json"), '{"type":"module"}');
		const worker = join(home, "worker.mjs");
		writeFileSync(
			worker,
			`
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFile;
fs.readFile = async (...args) => {
 try { return await read(...args); }
 catch (error) {
  if (error.code !== 'ENOENT') throw error;
  process.send('absent');
  await new Promise(resolve => process.once('message', resolve));
  throw error;
 }
};
syncBuiltinESMExports();
const { getLoginInstallationId } = await import('./compiled/models/login-identity.js');
try { process.send({ id: await getLoginInstallationId(process.argv[2], new AbortController().signal) }); }
catch (error) { process.send({ error: error.message }); process.exitCode = 1; }
process.disconnect();
`,
		);
		const children = Array.from({ length: 3 }, () =>
			fork(worker, [home], { stdio: ["ignore", "ignore", "inherit", "ipc"] }),
		);
		try {
			const arrivals = children.map(
				(child) =>
					new Promise<void>((resolve, reject) => {
						child.once("message", (message) =>
							message === "absent" ? resolve() : reject(new Error(JSON.stringify(message))),
						);
						child.once("error", reject);
					}),
			);
			const results = children.map(
				(child) =>
					new Promise<string>((resolve, reject) => {
						child.on("message", (message: unknown) => {
							if (typeof message === "object" && message && "id" in message) resolve(String(message.id));
							if (typeof message === "object" && message && "error" in message)
								reject(new Error(String(message.error)));
						});
						child.once("error", reject);
					}),
			);
			await Promise.all(arrivals);
			for (const child of children) child.send("publish");
			const ids = await Promise.all(results);
			const stored = JSON.parse(readFileSync(path(), "utf8"));
			expect(ids).toEqual([stored.installationId, stored.installationId, stored.installationId]);
			expect(statSync(path()).mode & 0o777).toBe(0o600);
			expect(statSync(join(home, "state", "auth")).mode & 0o777).toBe(0o700);
			const flow = login();
			await flow.run();
			const options = flow.call.mock.calls[0]?.[3];
			expect(options.agentName).toBe("pipiclaw");
			expect(options.getDeviceId()).toBe(stored.installationId);
		} finally {
			for (const child of children) child.kill();
		}
	});

	it("refuses corrupted or unsupported identity without replacing it or starting login", async () => {
		mkdirSync(join(home, "state", "auth"), { recursive: true });
		for (const data of ["{broken", JSON.stringify({ version: 2, installationId: "invalid" })]) {
			writeFileSync(path(), data);
			const flow = login();
			await expect(flow.run()).rejects.toThrow(path());
			expect(flow.call).not.toHaveBeenCalled();
			expect(readFileSync(path(), "utf8")).toBe(data);
		}
	});

	it("does not start OAuth when the filesystem cannot publish without overwriting", async () => {
		vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("unsupported"), { code: "ENOTSUP" }));
		const flow = login();
		await expect(flow.run()).rejects.toThrow(path());
		expect(flow.call).not.toHaveBeenCalled();
		expect(existsSync(path())).toBe(false);
		expect(await fs.readdir(join(home, "state", "auth"))).toEqual([]);
	});

	it("cancels before publication or login, preserving an identity already published", async () => {
		const before = new AbortController();
		before.abort();
		const flow = login(before.signal);
		await expect(flow.run()).rejects.toThrow();
		expect(flow.call).not.toHaveBeenCalled();
		expect(existsSync(path())).toBe(false);
		const controller = new AbortController();
		const original = fs.link;
		vi.spyOn(fs, "link").mockImplementation(async (...args) => {
			await original(...args);
			controller.abort();
		});
		const published = login(controller.signal);
		await expect(published.run()).rejects.toThrow();
		expect(published.call).not.toHaveBeenCalled();
		const stored = readFileSync(path(), "utf8");
		vi.restoreAllMocks();
		expect(await getLoginInstallationId(home, new AbortController().signal)).toBe(JSON.parse(stored).installationId);
	});
});

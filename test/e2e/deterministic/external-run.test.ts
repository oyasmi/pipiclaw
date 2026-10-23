import { once } from "node:events";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessAlive, killProcessGroup } from "../../../src/shared/host-process.js";
import type { RunRecord } from "../../../src/subagents/run-record.js";
import { crash, startDaemon } from "../../support/daemon-process.js";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { bindChannelOnDisk, E2E_DOT, reply, writeWorkspaceFile } from "../../support/runtime-harness.js";
import { cleanupE2ETestHome, createDeterministicHome } from "../../support/setup.js";
import { waitFor } from "../helpers/wait.js";

describe("E2E deterministic: external process recovery", () => {
	it("A18: a live detached exec run survives daemon SIGKILL and is re-adopted before admission; /stop preserves it", async () => {
		// Catches missing startup run restoration. The old `echo` fixture often finished before
		// restart, and graceful same-process restart retained its live callbacks. Mutation: omit
		// `await runs.restore()` in bootstrap; the new process cannot look up the persisted run.
		// Spec 058: the new process gets only what is on disk — the run comes back from its dot's
		// record directory and the dot is reactivated from `bindings.json`, so the channel is served
		// again, and nothing the first process wrote looks like the pre-dot layout to the startup
		// check. Mutation (2026-10-18): archive `log.jsonl` to `join(workspaceDir, channelId)` (the
		// old per-channel directory) — the restarted daemon refuses to start and the case goes red.
		const model = await startMockProvider();
		const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		const channelId = "dm_e2e_user";
		let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
		let externalPid: number | undefined;
		let socket: Socket | undefined;
		const server = createServer((connected) => {
			socket = connected;
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		const connected = once(server, "connection");
		try {
			const executable = join(home.homeDir, "held-exec.mjs");
			writeFileSync(
				executable,
				`import { connect } from "node:net";\nconst socket = connect(${port}, "127.0.0.1");\nsocket.on("connect", () => console.log("EXTERNAL_HELD"));\nsocket.on("end", () => process.exit(0));\n`,
			);
			writeWorkspaceFile(
				home,
				"sub-agents/held-runner.md",
				`---\nname: held-runner\nruntime: external\nharness: exec\nmutates: read\ndescription: held recovery fixture\ncommand: ${process.execPath} ${executable}\n---\n\nRun the command.\n`,
			);
			model.script.route({
				name: "parent",
				when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_EXEC"),
				respond: [
					reply.toolCall("subagent", { agent: "held-runner", task: "hold until the test finishes" }),
					reply.text("[SILENT]"),
				],
			});
			await bindChannelOnDisk(home.workspaceDir, channelId);
			daemon = await startDaemon(home.homeDir);
			await daemon.call("send", { channelId, text: "RUN_EXEC" });
			await connected;
			const dir = join(home.homeDir, "state", "subagent-runs", E2E_DOT);
			const record = await waitFor(
				"durable external launch",
				() => {
					const file = readdirSync(dir).find((name) => name.endsWith(".json"));
					if (!file) return false;
					const value = JSON.parse(readFileSync(join(dir, file), "utf8")) as RunRecord;
					return value.pid && value.pidStartedAt ? value : false;
				},
				{ intervalMs: 25 },
			);
			externalPid = record.pid;
			expect(record).toMatchObject({ runtime: "external", status: "running" });
			await crash(daemon.child);
			expect(isProcessAlive(externalPid!)).toBe(true);
			daemon = await startDaemon(home.homeDir);
			expect(await daemon.call("record", { channelId, runId: record.runId })).toMatchObject({
				runId: record.runId,
				status: "running",
				pid: externalPid,
			});
			const requestsBefore = model.requests.length;
			await daemon.call("send", { channelId, text: "/stop" });
			expect(await daemon.call("record", { channelId, runId: record.runId })).toMatchObject({
				status: "running",
				pid: externalPid,
			});
			expect(isProcessAlive(externalPid!)).toBe(true);
			expect(model.requests).toHaveLength(requestsBefore);
			model.script.route({
				name: "after-restart",
				when: (r) => r.isMainTurn && r.lastUserText.includes("AFTER_RESTART"),
				respond: [reply.text("还在。")],
			});
			await daemon.call("send", { channelId, text: "AFTER_RESTART" });
			await waitFor("post-restart turn", () =>
				model.requests.some((request) => request.matchedRoute === "after-restart"),
			);
			expect(model.unmatched()).toEqual([]);
		} finally {
			if (daemon) await crash(daemon.child);
			if (externalPid) await killProcessGroup(externalPid, 0);
			socket?.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		}
	});
});

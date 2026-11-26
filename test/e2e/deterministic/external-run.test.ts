import { once } from "node:events";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessAlive, killProcessGroup } from "../../../src/shared/host-process.js";
import { assertSubAgentInvariants } from "../../../src/subagents/invariants.js";
import type { RunRecord } from "../../../src/subagents/run-record.js";
import type { ActiveWorkspaceLease } from "../../../src/subagents/workspace-lease.js";
import { crash, startDaemon } from "../../support/daemon-process.js";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { bindChannelOnDisk, E2E_DESK, reply, writeWorkspaceFile } from "../../support/runtime-harness.js";
import { cleanupE2ETestHome, createDeterministicHome } from "../../support/setup.js";
import { waitFor } from "../helpers/wait.js";

function readRunRecords(dir: string): Map<string, RunRecord> {
	return new Map(
		readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map((name) => {
				const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as RunRecord;
				return [record.runId, record];
			}),
	);
}

async function assertRunSnapshot(daemon: Awaited<ReturnType<typeof startDaemon>>, runsDir: string): Promise<void> {
	const snapshot = (await daemon.call("run-snapshot")) as {
		records: RunRecord[];
		activeLeases: ActiveWorkspaceLease[];
	};
	assertSubAgentInvariants({ ...snapshot, diskRecords: readRunRecords(runsDir) });
}

describe("E2E deterministic: external process recovery", () => {
	it("A18: a live detached exec run survives daemon SIGKILL and is re-adopted before admission; /stop preserves it", async () => {
		// Catches missing startup run restoration. The old `echo` fixture often finished before
		// restart, and graceful same-process restart retained its live callbacks. Mutation: omit
		// `await runs.restore()` in bootstrap; the new process cannot look up the persisted run.
		// Spec 058: the new process gets only what is on disk — the run comes back from its desk's
		// record directory and the desk is reactivated from `bindings.json`, so the channel is served
		// again; the restored records and bindings use the same current desk layout on both sides of the
		// check. Mutation (2026-10-18): archive `log.jsonl` to `join(workspaceDir, channelId)` (the
		// old per-channel directory) — the restarted daemon refuses to start and the case goes red.
		// Spec 068 D8: also exercises an `antigravity-cli` follow-up across daemon SIGKILL so a
		// resumed run whose `expectedResumeSessionId` was persisted by the old daemon still fails
		// post-restart reconciliation when the CLI exits 0 with a different `conversation_id`.
		// Spec 073: suppressing failure metadata loses the adopted Agy mismatch classification.
		// Bypassing the follow_up blocker lets the refused Claude session dispatch again.
		// Skipping lease release trips INV-4 at the terminal snapshot. Each mutation went red.
		const model = await startMockProvider();
		const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		const channelId = "dingtalk:dm:e2e_user";
		let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
		let externalPid: number | undefined;
		let agyFollowUpPid: number | undefined;
		const sockets: Socket[] = [];
		const server = createServer((connected) => {
			sockets.push(connected);
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		try {
			const executable = join(home.homeDir, "held-exec.mjs");
			writeFileSync(
				executable,
				`import { connect } from "node:net";\nconst socket = connect(${port}, "127.0.0.1");\nsocket.on("connect", () => console.log("EXTERNAL_HELD"));\nsocket.on("end", () => process.exit(0));\n`,
			);
			const agyExecutable = join(home.homeDir, "held-agy.mjs");
			writeFileSync(
				agyExecutable,
				`import { connect } from "node:net";\n` +
					`const socket = connect(${port}, "127.0.0.1");\n` +
					`socket.on("connect", () => {\n` +
					`  console.log(JSON.stringify({ event: "init", conversation_id: "conv-wrong-after-sigkill", init: {} }));\n` +
					`});\n` +
					`socket.on("end", () => {\n` +
					`  console.log(JSON.stringify({ event: "result", conversation_id: "conv-wrong-after-sigkill", result: { conversation_id: "conv-wrong-after-sigkill", status: "SUCCESS", response: "WRONG_SESSION_OK" } }));\n` +
					`  process.exit(0);\n` +
					`});\n`,
			);
			writeWorkspaceFile(
				home,
				"sub-agents/held-runner.md",
				`---\nname: held-runner\nruntime: external\nharness: exec\nmutates: read\ndescription: held recovery fixture\ncommand: ${process.execPath} ${executable}\n---\n\nRun the command.\n`,
			);
			writeWorkspaceFile(
				home,
				"sub-agents/held-agy.md",
				`---\nname: held-agy\nruntime: external\nharness: antigravity-cli\nmutates: read\ndescription: held agy recovery fixture\ncommand: ${process.execPath} ${agyExecutable}\n---\n\nRun the agy command.\n`,
			);
			const authExecutable = join(home.homeDir, "auth-refusal.mjs");
			writeFileSync(
				authExecutable,
				`console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Not logged in. Please sign in."] }));\nprocess.exitCode = 1;\n`,
			);
			writeWorkspaceFile(
				home,
				"sub-agents/auth-fixture.md",
				`---\nname: auth-fixture\nruntime: external\nharness: claude-code\nmutates: read\ndescription: structured auth refusal\ncommand: ${process.execPath} ${authExecutable}\n---\n\nRun the auth fixture.\n`,
			);
			const runsDir = join(home.homeDir, "state", "subagent-runs", E2E_DESK);
			mkdirSync(runsDir, { recursive: true });
			const seedRunId = "run_seed68";
			const seedNow = Date.now();
			const seedRecord: RunRecord = {
				runId: seedRunId,
				channelId,
				runtime: "external",
				harness: "antigravity-cli",
				agent: "held-agy",
				label: "seed agy run",
				source: "predefined",
				tools: [],
				purpose: "work",
				workingDirectory: home.workspaceDir,
				artifactDir: join(home.workspaceDir, `desk-${E2E_DESK}`, "subagent-artifacts", seedRunId),
				status: "completed",
				startedAt: seedNow - 2_000,
				finishedAt: seedNow - 1_000,
				settledAt: seedNow - 1_000,
				wakeEnqueued: true,
				usageRecorded: true,
				sessionId: "conv-expected-068",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					total: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				usageKnown: true,
				costKnown: false,
			};
			writeFileSync(join(runsDir, `${seedRunId}.json`), `${JSON.stringify(seedRecord)}\n`, "utf8");

			model.script.route({
				name: "parent",
				when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_EXEC"),
				respond: [
					reply.steps(
						{
							toolCall: {
								id: "call_exec_1",
								name: "subagent",
								args: { agent: "held-runner", task: "hold until the test finishes" },
							},
						},
						{
							toolCall: {
								id: "call_agy_2",
								name: "subagent_run",
								args: {
									op: "follow_up",
									runId: seedRunId,
									task: "continue and hold across sigkill",
								},
							},
						},
					),
					reply.text("[SILENT]"),
				],
			});
			await bindChannelOnDisk(home.workspaceDir, channelId);
			daemon = await startDaemon(home.homeDir);
			await daemon.call("send", { channelId, text: "RUN_EXEC" });
			await waitFor("both external processes connected", () => sockets.length === 2, { intervalMs: 25 });
			const launched = await waitFor(
				"durable external launches",
				() => {
					const records = [...readRunRecords(runsDir).values()].filter((r) => r.runId !== seedRunId);
					const execRec = records.find((r) => r.harness === "exec" && r.pid && r.pidStartedAt);
					const agyRec = records.find(
						(r) =>
							r.harness === "antigravity-cli" &&
							r.pid &&
							r.pidStartedAt &&
							r.expectedResumeSessionId === "conv-expected-068",
					);
					return execRec && agyRec ? { execRec, agyRec } : false;
				},
				{ intervalMs: 25 },
			);
			const record = launched.execRec;
			const agyRecord = launched.agyRec;
			externalPid = record.pid;
			agyFollowUpPid = agyRecord.pid;
			expect(record).toMatchObject({ runtime: "external", status: "running" });
			expect(agyRecord).toMatchObject({
				runtime: "external",
				harness: "antigravity-cli",
				status: "running",
				expectedResumeSessionId: "conv-expected-068",
			});
			await assertRunSnapshot(daemon, runsDir);
			await crash(daemon.child);
			expect(isProcessAlive(externalPid!)).toBe(true);
			expect(isProcessAlive(agyFollowUpPid!)).toBe(true);
			daemon = await startDaemon(home.homeDir);
			expect(await daemon.call("record", { channelId, runId: record.runId })).toMatchObject({
				runId: record.runId,
				status: "running",
				pid: externalPid,
			});
			expect(await daemon.call("record", { channelId, runId: agyRecord.runId })).toMatchObject({
				runId: agyRecord.runId,
				status: "running",
				pid: agyFollowUpPid,
				expectedResumeSessionId: "conv-expected-068",
			});
			await assertRunSnapshot(daemon, runsDir);
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
			// Spec 067 mutation: remove recovery.add after restore; no periodic observer remains
			// in this new process and the far-away deadline cannot make this completion arrive.
			model.script.route({
				name: "adopted-completed",
				when: (r) =>
					r.isMainTurn &&
					(r.lastUserText.includes(`[SUBAGENT:${record.runId}]`) ||
						r.lastUserText.includes(`[SUBAGENT:${agyRecord.runId}]`)),
				respond: [reply.text("[SILENT]")],
				repeat: true,
			});
			const completed = model.script.hold({
				when: (r) => r.isMainTurn && r.lastUserText.includes(`[SUBAGENT:${record.runId}]`),
			});
			for (const sock of sockets) sock.end();
			await completed.arrived;
			completed.release();
			await waitFor("adopted settlements and wakes committed", () => {
				const disk = readRunRecords(runsDir);
				const execVal = disk.get(record.runId);
				const agyVal = disk.get(agyRecord.runId);
				return (
					Boolean(execVal?.settledAt && execVal.wakeEnqueued && execVal.status !== "running") &&
					Boolean(agyVal?.settledAt && agyVal.wakeEnqueued && agyVal.status !== "running")
				);
			});
			await assertRunSnapshot(daemon, runsDir);
			const settledAgy = (await daemon.call("record", { channelId, runId: agyRecord.runId })) as RunRecord;
			expect(settledAgy.status).toBe("failed");
			expect(settledAgy.sessionId).toBeUndefined();
			expect(settledAgy.failureReason).toContain("conv-expected-068");
			expect(settledAgy.failureReason).toContain("conv-wrong-after-sigkill");
			expect(settledAgy).toMatchObject({ failureKind: "resume_rejected", failurePreExecution: false });
			expect(
				model.requests.some(
					(r) => r.matchedRoute === "adopted-completed" && r.lastUserText.includes("EXTERNAL_HELD"),
				),
			).toBe(true);

			model.script.route({
				name: "auth-delegate",
				when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_AUTH_FIXTURE"),
				respond: [
					reply.toolCall("subagent", { agent: "auth-fixture", task: "Check authentication" }),
					reply.text("[SILENT]"),
				],
			});
			const isAuthWake = (r: { isMainTurn: boolean; lastUserText: string }) =>
				r.isMainTurn && r.lastUserText.includes("[SUBAGENT:") && r.lastUserText.includes("-> auth-fixture (");
			model.script.route({ name: "auth-wake", when: isAuthWake, respond: [reply.text("[SILENT]")] });
			const authWake = model.script.hold({ when: isAuthWake });
			await daemon.call("send", { channelId, text: "RUN_AUTH_FIXTURE" });
			const authRequest = await authWake.arrived;
			authWake.release();
			const authRun = await waitFor("the auth refusal and its wake marker on disk", () =>
				[...readRunRecords(runsDir).values()].find(
					(r) => r.agent === "auth-fixture" && r.settledAt && r.wakeEnqueued,
				),
			);
			expect(authRun).toMatchObject({
				status: "failed",
				failureKind: "auth_required",
				failurePreExecution: true,
				sessionId: expect.any(String),
			});
			expect(authRequest.lastUserText).toContain("auth_required");
			expect(authRequest.lastUserText).toMatch(/do not retry automatically/i);

			model.script.route({
				name: "blocked-follow-up",
				when: (r) => r.isMainTurn && r.lastUserText.includes("TRY_AUTH_FOLLOW_UP"),
				respond: [
					reply.steps(
						{
							toolCall: {
								id: "call_auth_show",
								name: "subagent_run",
								args: { op: "show", runId: authRun.runId },
							},
						},
						{
							toolCall: {
								id: "call_auth_follow_up",
								name: "subagent_run",
								args: { op: "follow_up", runId: authRun.runId, task: "Try again" },
							},
						},
					),
					reply.text("[SILENT]"),
				],
			});
			await daemon.call("turn", { channelId, text: "TRY_AUTH_FOLLOW_UP" });
			const next = model.requests.filter((r) => r.matchedRoute === "blocked-follow-up").at(-1);
			expect(next?.raw.messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "tool",
						tool_call_id: "call_auth_show",
						content: expect.stringContaining("failureKind: auth_required"),
					}),
					expect.objectContaining({
						role: "tool",
						tool_call_id: "call_auth_follow_up",
						content: expect.stringContaining("auth_required"),
					}),
				]),
			);
			expect([...readRunRecords(runsDir).values()].filter((r) => r.agent === "auth-fixture")).toHaveLength(1);
			await assertRunSnapshot(daemon, runsDir);
			expect(model.unmatched()).toEqual([]);
		} finally {
			if (daemon) await crash(daemon.child);
			if (externalPid) await killProcessGroup(externalPid, 0);
			if (agyFollowUpPid) await killProcessGroup(agyFollowUpPid, 0);
			for (const sock of sockets) sock.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		}
	});
});

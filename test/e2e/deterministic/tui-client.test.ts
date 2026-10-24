import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapEmbedded } from "../../../src/runtime/bootstrap.js";
import { runTui } from "../../../src/tui/cli.js";
import { createLink, createSocketClient, openConversation } from "../../../src/tui/client.js";
import type { Frontend, FrontendCallbacks } from "../../../src/tui/frontend.js";
import { traitsOf } from "../../../src/tui/render.js";
import { TuiSession } from "../../../src/tui/session.js";
import { bootstrapPathsIn } from "../../support/fake-runner.js";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { cleanupE2ETestHome, createDeterministicHome } from "../../support/setup.js";
import {
	createWebApiHarness,
	readJsonl,
	reply,
	WEBAPI_DESK,
	type WebApiHarness,
} from "../../support/webapi-harness.js";

class RecordingFrontend implements Frontend {
	callbacks!: FrontendCallbacks;
	finals: string[] = [];
	notices: string[] = [];
	start(callbacks: FrontendCallbacks): void {
		this.callbacks = callbacks;
	}
	appendProgress(): void {}
	showFinal(text: string): void {
		this.finals.push(text);
	}
	showNotice(text: string): void {
		this.notices.push(text);
	}
	clearProgress(): void {}
	setWorking(): void {}
	setStatus(): void {}
	setBusy(): void {}
	showBanner(): void {}
	stop(): void {}
}

describe("E2E deterministic: terminal client", () => {
	let harness: WebApiHarness;
	afterEach(async () => {
		// T3 starts its own runtime and creates no harness.
		await harness?.shutdown();
		harness = undefined as unknown as WebApiHarness;
	});

	it("T1: the terminal binds a desk, runs a turn, steers it and cancels the next, over the real socket", async () => {
		// Mutation check: send `response.steer` for a plain message while busy as `response.create`
		// instead and the provider never sees STEER_TEXT inside the first turn (the steer test
		// request below would come from a queued second turn, after the first one's answer).
		harness = await createWebApiHarness();
		const paths = bootstrapPathsIn(harness.homeDir);
		const io = { log: () => undefined, error: () => undefined };
		const { script } = harness.model;
		script.route({
			name: "steered",
			when: (r) => r.isMainTurn && r.lastUserText.includes("STEER_TEXT"),
			respond: [reply.text("steered-done")],
			repeat: true,
		});
		script.route({
			name: "start",
			when: (r) => r.isMainTurn && r.lastUserText.includes("START"),
			respond: [reply.toolCall("bash", { command: "echo hi" }), reply.text("unsteered-done")],
			repeat: true,
		});
		script.route({ name: "held", when: (r) => r.isMainTurn, respond: [reply.text("never delivered")], repeat: true });

		const client = createSocketClient(paths);
		const { id } = await openConversation(client, paths, { desk: WEBAPI_DESK, create: false, fresh: false }, io);
		// The desk is remembered, and a second open resumes the same conversation.
		expect((await openConversation(client, paths, { desk: WEBAPI_DESK, create: false, fresh: false }, io)).id).toBe(
			id,
		);

		const frontend = new RecordingFrontend();
		const session = new TuiSession({
			link: createLink(client, paths, id),
			frontend,
			traits: traitsOf("full_progress_then_plain_final"),
			label: "test",
			pollIntervalMs: 60_000,
		});
		const running = session.startInteractive();

		const startGate = script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("START") });
		session.submit("START the work");
		await startGate.arrived;
		await vi.waitFor(() => expect(session.busy).toBe(true));
		session.submit("STEER_TEXT please");
		await vi.waitFor(() => expect(frontend.notices.length).toBeGreaterThan(0));
		startGate.release();
		await vi.waitFor(() => expect(frontend.finals).toContain("steered-done"), { timeout: 15_000 });
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toContain("STEER_TEXT");

		// The bind reply, the steered turn and its successor, and the cancelled one — once persisted.
		const lastSnapshots = () => {
			const snapshots = readJsonl(join(harness.stateDir, "conversations", id, "responses.jsonl")) as Array<{
				id: string;
				status: string;
				incomplete_details: { reason: string } | null;
			}>;
			return [...new Map(snapshots.map((snapshot) => [snapshot.id, snapshot])).values()];
		};
		// Ctrl-C while a turn runs cancels it; the terminal can then send again.
		await vi.waitFor(() => expect(session.busy).toBe(false));
		const hold = script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("SECOND") });
		session.submit("SECOND message");
		await hold.arrived;
		frontend.callbacks.onInterrupt();
		// Closing the connection is the cancel: it lands while the provider is still held.
		await vi.waitFor(() => expect(lastSnapshots().at(-1)?.status).toBe("cancelled"));
		hold.release();
		await harness.waitForIdle();
		expect(frontend.finals).not.toContain("never delivered");

		session.submit("/exit");
		await running;

		await vi.waitFor(() =>
			expect(lastSnapshots().map((r) => r.status)).toEqual(["completed", "incomplete", "completed", "cancelled"]),
		);
		expect(lastSnapshots()[1]?.incomplete_details?.reason).toBe("steered");
	});

	it("T2: `pipiclaw tui --print` asks once and prints the answer", async () => {
		// Mutation check: have printOnce ignore the conversation and the request fails (the
		// conversation is unknown) or the answer lands in another conversation than the desk's.
		harness = await createWebApiHarness();
		harness.model.script.route({
			name: "any",
			when: (r) => r.isMainTurn,
			respond: [reply.text("PRINTED")],
			repeat: true,
		});
		const chunks: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
			chunks.push(String(chunk));
			return true;
		});
		try {
			await runTui(
				["node", "pipiclaw", "tui", "--desk", WEBAPI_DESK, "--print", "--plain", "--quiet", "say it"],
				// A daemon is already serving this home: connect to its socket.
				{ startEmbeddedRuntime: async () => undefined },
				{ log: () => undefined, error: () => undefined },
				bootstrapPathsIn(harness.homeDir),
			);
		} finally {
			spy.mockRestore();
		}
		expect(chunks.join("")).toContain("PRINTED");
		expect(harness.mainTurnRequests()).toHaveLength(1);
	});

	it("T3: with no daemon, the terminal runs the runtime itself and releases the app home on exit", async () => {
		// Mutation check: have bootstrapEmbedded skip `WebApiTransport` (or not release the lock)
		// and the request cannot connect, or the second run below is refused by the daemon lock.
		const model = await startMockProvider();
		const home = createDeterministicHome({
			mockBaseUrl: model.baseUrl,
			homeDir: mkdtempSync(join(tmpdir(), "pipiclaw-e2e-tui-")),
		});
		const previousOffline = process.env.PI_OFFLINE;
		process.env.PI_OFFLINE = "1";
		const paths = bootstrapPathsIn(home.homeDir);
		model.script.route({ name: "any", when: (r) => r.isMainTurn, respond: [reply.text("EMBEDDED")], repeat: true });
		const chunks: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array): boolean => {
			chunks.push(String(chunk));
			return true;
		});
		try {
			for (let run = 0; run < 2; run++) {
				await runTui(
					["node", "pipiclaw", "tui", "--print", "--plain", "--quiet", "hi"],
					{ startEmbeddedRuntime: bootstrapEmbedded },
					{ log: () => undefined, error: () => undefined },
					paths,
				);
			}
		} finally {
			spy.mockRestore();
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		}
		expect(chunks.join("").match(/EMBEDDED/g)).toHaveLength(2);
	});
});

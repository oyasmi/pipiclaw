import { join } from "node:path";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeskRecord } from "../../../src/desk/registry.js";
import { generateKey, hashKey } from "../../../src/webapi/auth.js";
import { crash, startDaemon } from "../../support/daemon-process.js";
import { startMockProvider } from "../../support/mock-provider/server.js";
import { cleanupE2ETestHome, createDeterministicHome } from "../../support/setup.js";
import {
	createWebApiHarness,
	freePort,
	readJsonl,
	reply,
	WEBAPI_DESK,
	type WebApiHarness,
} from "../../support/webapi-harness.js";

describe("E2E deterministic: Web API", () => {
	let harness: WebApiHarness;
	afterEach(async () => {
		// W6 runs its own daemon process and creates no in-process harness.
		await harness?.shutdown();
		harness = undefined as unknown as WebApiHarness;
	});

	it("W1: a streamed request over the socket and a synchronous one over TCP run real turns", async () => {
		// Mutation check: drop the item-done event in ResponseTurn and the streamed message never completes.
		harness = await createWebApiHarness();
		harness.model.script.route({ name: "t", when: (r) => r.isMainTurn, respond: [reply.text("pong")], repeat: true });

		const stream = await harness.socket.responses.create({ model: "pipiclaw", input: "ping", stream: true });
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		expect(types[0]).toBe("response.created");
		expect(types).toContain("response.output_text.delta");
		expect(types.at(-1)).toBe("response.completed");

		// Regression: JSON responses can have CORS headers while hijacked SSE replies lose them.
		// Mutation checked 2026-10-25: replacing raw.setHeader with reply.header makes W1 fail.
		const { data: browserStream, response: browserResponse } = await harness.tcp.responses
			.create(
				{ model: "pipiclaw", input: "browser", stream: true },
				{ headers: { Origin: "https://client.example" } },
			)
			.withResponse();
		let lastType: string | undefined;
		for await (const event of browserStream) lastType = event.type;
		expect(browserResponse.headers.get("access-control-allow-origin")).toBe("*");
		expect(lastType).toBe("response.completed");

		const done = await harness.tcp.responses.create({ model: "pipiclaw", input: "again" });
		expect(done.status).toBe("completed");
		expect(done.output_text).toBe("pong");
	});

	/** The caller's word in each main-turn request (the prompt around it carries runtime context). */
	const mainTurnWords = () =>
		harness.mainTurnRequests().map((r) => /\[test\]: (\w+)/.exec(r.lastUserText)?.[1] ?? r.lastUserText);
	const conversation = async () => (await harness.tcp.conversations.create({})).id;
	const settled = async (id: string) => {
		for (let attempt = 0; attempt < 400; attempt++) {
			const response = await harness.tcp.responses.retrieve(id);
			if (!["queued", "in_progress"].includes(response.status ?? "")) return response;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`response ${id} did not settle`);
	};

	it("W2: two background requests on one conversation run one after the other", async () => {
		// Mutation check: set the webapi transport policy to `whenBusy: "followUp"` and the second
		// message is merged into the first turn — it never queues and gets no output of its own.
		harness = await createWebApiHarness();
		const { script } = harness.model;
		script.route({
			name: "a",
			when: (r) => r.isMainTurn && r.lastUserText.includes("FIRST"),
			respond: [reply.text("answer-A")],
			repeat: true,
		});
		script.route({
			name: "b",
			when: (r) => r.isMainTurn && r.lastUserText.includes("SECOND"),
			respond: [reply.text("answer-B")],
			repeat: true,
		});
		const gate = script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("FIRST") });
		const conv = await conversation();

		const first = await harness.tcp.responses.create({
			conversation: conv,
			input: "FIRST",
			background: true,
			instructions: "FIRST_ONLY_DIRECTIVE",
		});
		await gate.arrived;
		// The shape a history-replaying client (SideMind) sends in conversation mode: one user message
		// as parts, with a binary file. Regression: importing it as context skipped the desk turn
		// context and memory bootstrap and inlined the PDF's bytes as text.
		const second = await harness.tcp.responses.create({
			conversation: conv,
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "SECOND" },
						{
							type: "input_file",
							filename: "report.pdf",
							file_data: `data:application/pdf;base64,${Buffer.from("%PDF-1.4\n\0\xff").toString("base64")}`,
						},
					],
				},
			],
			background: true,
			instructions: "SECOND_ONLY_DIRECTIVE",
		});
		expect(second.status).toBe("queued");
		expect(harness.mainTurnRequests()).toHaveLength(1);
		gate.release();

		const [a, b] = [await settled(first.id), await settled(second.id)];
		expect([a.output_text, b.output_text]).toEqual(["answer-A", "answer-B"]);
		expect(mainTurnWords()).toEqual(["FIRST", "SECOND"]);
		const [firstRequest, secondRequest] = harness.mainTurnRequests();
		expect(JSON.stringify(firstRequest.raw)).not.toContain("SECOND_ONLY_DIRECTIVE");
		expect(JSON.stringify(secondRequest.raw)).not.toContain("FIRST_ONLY_DIRECTIVE");
		// Mutation checked 2026-10-26: importing every structured input as context fails here.
		expect(JSON.stringify(secondRequest.raw)).toContain("SECOND_ONLY_DIRECTIVE");
		expect(secondRequest.lastUserText).toContain("<runtime_turn_context>");
		expect(secondRequest.lastUserText).toMatch(/report\.pdf 已保存到 \S+/);
		harness.model.script.route({
			name: "third",
			when: (r) => r.isMainTurn && r.lastUserText.includes("THIRD"),
			respond: [reply.text("third answer")],
			repeat: true,
		});
		const unstored = await harness.tcp.responses.create({ conversation: conv, input: "THIRD", store: false });
		expect(unstored.status).toBe("completed");
		await harness.waitForIdle();
		await expect(harness.tcp.responses.retrieve(unstored.id)).rejects.toMatchObject({ status: 404 });
		expect(
			(await harness.tcp.conversations.items.list(conv)).data.some(
				(item) => item.type === "message" && item.role === "user" && JSON.stringify(item).includes("THIRD"),
			),
		).toBe(true);
	});

	it("W3: a steer over WebSocket ends the running response as steered and continues in a successor", async () => {
		// Mutation check: make the split a no-op (keep forwarding the steered turn on the first
		// response) and no `response.incomplete` arrives and the successor's input_items stay empty.
		harness = await createWebApiHarness();
		const { script } = harness.model;
		script.route({
			name: "steered",
			when: (r) => r.isMainTurn && r.lastUserText.includes("STEER_TEXT"),
			respond: [reply.text("steered-done")],
			repeat: true,
		});
		script.route({
			name: "start",
			when: (r) => r.isMainTurn,
			respond: [reply.toolCall("bash", { command: "echo hi" }), reply.text("unsteered-done")],
			repeat: true,
		});
		const gate = script.hold({ when: (r) => r.isMainTurn && !r.lastUserText.includes("STEER_TEXT") });

		const ws = harness.openWebSocket("tcp");
		const events: Array<{
			type: string;
			response?: {
				id: string;
				status: string;
				previous_response_id?: string | null;
				incomplete_details?: { reason: string } | null;
			};
		}> = [];
		ws.on("event", (event) => events.push(event as never));
		ws.send({ type: "response.create", model: "pipiclaw", conversation: await conversation(), input: "START" });
		await gate.arrived;
		const firstId = events.find((e) => e.type === "response.created")?.response?.id;
		expect(firstId).toBeDefined();
		await vi.waitFor(() => expect(events.some((e) => e.type === "response.in_progress")).toBe(true));
		ws.send({ type: "response.steer", previous_response_id: firstId, input: "STEER_TEXT" } as never);
		await vi.waitFor(() => expect(events.some((e) => e.type === "response.steer.accepted")).toBe(true));
		gate.release();
		await vi.waitFor(() => expect(events.filter((e) => e.type === "response.completed")).toHaveLength(1), {
			timeout: 15_000,
		});
		ws.close();

		const incomplete = events.find((e) => e.type === "response.incomplete");
		expect(incomplete?.response).toMatchObject({ id: firstId, incomplete_details: { reason: "steered" } });
		const successor = events.find((e) => e.type === "response.completed")?.response;
		expect(successor?.previous_response_id).toBe(firstId);
		expect(successor?.id).not.toBe(firstId);
		const items = await harness.tcp.responses.inputItems.list(successor?.id as string);
		expect(JSON.stringify(items.data)).toContain("STEER_TEXT");
		expect(JSON.stringify(harness.mainTurnRequests().at(-1)?.messages)).toContain("STEER_TEXT");
		await harness.waitForIdle();
	});

	it("W4: cancelling a queued response never reaches the model; cancelling the running one stops it", async () => {
		// Mutation check: make cancel a no-op for queued responses and the queued message runs
		// after the first one ends — the provider sees a second request.
		harness = await createWebApiHarness();
		const { script } = harness.model;
		script.route({ name: "any", when: (r) => r.isMainTurn, respond: [reply.text("fine")], repeat: true });
		const gate = script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("RUNNING") });
		const conv = await conversation();

		const running = await harness.tcp.responses.create({ conversation: conv, input: "RUNNING", background: true });
		await gate.arrived;
		const queued = await harness.tcp.responses.create({ conversation: conv, input: "QUEUED", background: true });
		expect(queued.status).toBe("queued");
		expect((await harness.tcp.responses.cancel(queued.id)).status).toBe("cancelled");
		// Cancelling twice is not an error.
		expect((await harness.tcp.responses.cancel(queued.id)).status).toBe("cancelled");
		expect((await harness.tcp.responses.cancel(running.id)).status).toBe("cancelled");
		gate.release();
		await harness.waitForIdle();

		expect((await settled(running.id)).status).toBe("cancelled");
		expect(mainTurnWords()).toEqual(["RUNNING"]);
		// A synchronous request cannot be cancelled by id: the caller closes the connection instead.
		const sync = await harness.tcp.responses.create({ conversation: conv, input: "AFTER" });
		await expect(harness.tcp.responses.cancel(sync.id)).rejects.toMatchObject({ status: 400 });
	});

	it("W5: a finished background job surfaces as a new response with no input", async () => {
		// Mutation check: make WebApiTransport.openTurn ignore turns without a ref and the wake's
		// answer is lost — the conversation never gets the second response.
		harness = await createWebApiHarness({ services: true });
		const { script } = harness.model;
		script.route({
			name: "start-job",
			when: (r) => r.isMainTurn && r.lastUserText.includes("RUN_JOB"),
			respond: [reply.toolCall("bash", { command: "echo JOB_MARK_5521", async: true }), reply.text("started")],
			repeat: true,
		});
		script.route({
			name: "saw-job",
			when: (r) => r.isMainTurn && r.lastUserText.includes("JOB_MARK_5521"),
			respond: [reply.text("the job finished")],
			repeat: true,
		});
		const conv = await conversation();

		const first = await harness.tcp.responses.create({ conversation: conv, input: "RUN_JOB" });
		expect(first.output_text).toBe("started");
		await vi.waitFor(
			async () => {
				const items = await harness.tcp.conversations.items.list(conv);
				expect(JSON.stringify(items.data)).toContain("the job finished");
			},
			{ timeout: 20_000 },
		);

		await harness.waitForIdle();
		const snapshots = readJsonl(join(harness.stateDir, "conversations", conv, "responses.jsonl")) as Array<{
			id: string;
			status: string;
			input_items: unknown[];
		}>;
		const last = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
		expect([...last.values()].map((r) => [r.status, r.input_items.length])).toEqual([
			["completed", 1],
			// The wake text the model saw is not shown as input: the response has none.
			["completed", 0],
		]);
	});

	it("W6: a response running when the daemon is killed is failed after restart, and not re-run", async () => {
		// Mutation check: have WebApiStore.load skip the interrupted-response sweep and the
		// restarted daemon still reports the response as in_progress.
		const model = await startMockProvider();
		const home = createDeterministicHome({ mockBaseUrl: model.baseUrl });
		createDeskRecord(home.workspaceDir, WEBAPI_DESK, new Date());
		const key = generateKey();
		const port = await freePort();
		const client = new OpenAI({ apiKey: key, baseURL: `http://127.0.0.1:${port}/v1`, maxRetries: 0 });
		let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
		try {
			model.script.route({
				name: "any",
				when: (r) => r.isMainTurn,
				respond: [reply.text("never delivered")],
				repeat: true,
			});
			const gate = model.script.hold({ when: (r) => r.isMainTurn });
			daemon = await startDaemon(home.homeDir, "./webapi-worker.mjs", [String(port), hashKey(key)]);
			const conv = await client.conversations.create({});
			const response = await client.responses.create({ conversation: conv.id, input: "RUN", background: true });
			await gate.arrived;
			await crash(daemon.child);
			gate.release();

			daemon = await startDaemon(home.homeDir, "./webapi-worker.mjs", [String(port), hashKey(key)]);
			const after = await client.responses.retrieve(response.id);
			expect(after.status).toBe("failed");
			expect(after.error?.message).toMatch(/重启/);
			// Its tools may already have had effects, so it is never run again.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(model.requests.filter((r) => r.isMainTurn)).toHaveLength(1);
		} finally {
			if (daemon) await crash(daemon.child);
			await model.close();
			cleanupE2ETestHome(home.homeDir);
		}
	});
});

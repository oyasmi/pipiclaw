import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createWebApiHarness, reply, type WebApiHarness } from "./support/webapi-harness.js";

type Message = {
	type: string;
	stream_id?: string;
	error?: { code: string };
	response?: { id: string; status: string };
};

describe("webapi WebSocket mode", () => {
	let harness: WebApiHarness;
	afterEach(async () => {
		await harness.shutdown();
	});

	async function connect(): Promise<{ ws: WebSocket; messages: Message[]; closed: Promise<number> }> {
		const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/v1/responses`, {
			headers: { authorization: `Bearer ${harness.key}` },
		});
		const messages: Message[] = [];
		ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
		const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		return { ws, messages, closed };
	}
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		expect(check()).toBe(true);
	};

	it("refuses what the connection cannot honour, with a stable code each", async () => {
		harness = await createWebApiHarness();
		harness.model.script.route({ name: "any", when: (r) => r.isMainTurn, respond: [reply.text("ok")], repeat: true });
		const { ws, messages } = await connect();
		const errors = () => messages.filter((m) => m.type === "error").map((m) => m.error?.code);

		ws.send(JSON.stringify({ type: "response.create", input: "x", background: true }));
		ws.send(JSON.stringify({ type: "response.create", input: "x", stream_id: "bad id!" }));
		ws.send(JSON.stringify({ type: "response.nonsense" }));
		ws.send("not json");
		await until(() => errors().length === 4);
		// Errors for different messages may overtake one another: they are checked as a set.
		expect(errors().sort()).toEqual(["invalid_json", "invalid_stream_id", "invalid_value", "unsupported_parameter"]);

		// 32 named streams, and the 33rd is turned away; each response runs on its own lane.
		for (let i = 0; i < 33; i++) ws.send(JSON.stringify({ type: "response.create", input: "x", stream_id: `s${i}` }));
		await until(() => errors().includes("websocket_stream_limit_reached"));
		await until(() => messages.filter((m) => m.type === "response.completed").length === 32);
		expect(new Set(messages.filter((m) => m.type === "response.completed").map((m) => m.stream_id)).size).toBe(32);

		// Steering something that is gone, or is not this connection's, fails with the official codes.
		const done = messages.find((m) => m.type === "response.completed")?.response?.id;
		ws.send(JSON.stringify({ type: "response.steer", previous_response_id: done, input: "late" }));
		ws.send(JSON.stringify({ type: "response.steer", previous_response_id: "resp_unknown", input: "x" }));
		await until(() => messages.filter((m) => m.type === "response.steer.failed").length === 2);
		expect(
			messages.filter((m) => m.type === "response.steer.failed").map((m) => (m as unknown as Message).error?.code),
		).toEqual(["response_already_completed", "response_not_found"]);
		ws.close();
	});

	it("closes a connection at its time limit, and cancels what a closed connection was running", async () => {
		harness = await createWebApiHarness({ maxWebSocketMs: 1500 });
		harness.model.script.route({
			name: "any",
			when: (r) => r.isMainTurn,
			respond: [reply.text("never")],
			repeat: true,
		});
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn });
		const { ws, messages, closed } = await connect();
		ws.send(JSON.stringify({ type: "response.create", input: "HOLD" }));
		await gate.arrived;
		const id = messages.find((m) => m.type === "response.created")?.response?.id as string;

		expect(await closed).toBe(1000);
		expect(messages.some((m) => m.error?.code === "websocket_connection_limit_reached")).toBe(true);
		gate.release();
		await harness.waitForIdle();
		expect((await harness.tcp.responses.retrieve(id)).status).toBe("cancelled");
	});
});

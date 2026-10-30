import { once } from "node:events";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LiveResponse } from "../src/webapi/response-state.js";
import { WebApiServer } from "../src/webapi/server.js";
import type { WebApiService } from "../src/webapi/service.js";

type Message = {
	type: string;
	stream_id?: string;
	error?: { code: string };
	response?: { id: string; status: string };
};

// The connection owns protocol validation, lane admission and expiry. Its service port returns
// real LiveResponses without booting an agent for each of the 32 lanes. Real SDK/runtime/WebSocket
// delivery, steering and cancellation remain in deterministic/webapi.test.ts and tui-client.test.ts.
describe("webapi WebSocket mode", () => {
	let app: FastifyInstance | undefined;
	const sockets: WebSocket[] = [];
	afterEach(async () => {
		vi.useRealTimers();
		for (const socket of sockets.splice(0)) socket.terminate();
		await app?.close();
		app = undefined;
	});

	async function connect(options: { hold?: boolean; maxMs?: number } = {}) {
		const responses: LiveResponse[] = [];
		const create = vi.fn(async () => {
			const response = new LiveResponse(
				{
					id: `resp_${responses.length}`,
					conversation_id: "conv_1",
					owner: "local",
					status: "in_progress",
					created_at: 1,
					completed_at: null,
					previous_response_id: null,
					background: false,
					metadata: null,
					input_items: [],
					output: [],
					usage: null,
					error: null,
					incomplete_details: null,
				},
				{ persist: async () => undefined },
			);
			responses.push(response);
			response.announce("in_progress");
			if (!options.hold)
				response.complete({
					input_tokens: 0,
					input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
					output_tokens: 0,
					output_tokens_details: { reasoning_tokens: 0 },
					total_tokens: 0,
				});
			return response;
		});
		const cancel = vi.fn(async (response: LiveResponse) => response.cancel());
		app = await WebApiServer.build("socket", {
			config: { socket: true, keys: [] },
			service: { create, cancel } as unknown as WebApiService,
			socketPath: "/unused",
			audit: () => undefined,
			maxWebSocketMs: options.maxMs ?? 60_000,
		});
		await app.ready();
		let ws: WebSocket;
		if (options.maxMs) {
			const address = await app.listen({ host: "127.0.0.1", port: 0 });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			ws = new WebSocket(`${address.replace("http:", "ws:")}/v1/responses`);
			await once(ws, "open");
		} else ws = await app.injectWS("/v1/responses");
		sockets.push(ws);
		const messages: Message[] = [];
		const waiters = new Set<() => void>();
		ws.on("message", (data) => {
			messages.push(JSON.parse(data.toString()));
			for (const wake of waiters) wake();
		});
		const until = (check: () => boolean): Promise<void> => {
			if (check()) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const wake = () => {
					if (!check()) return;
					waiters.delete(wake);
					clearTimeout(timer);
					resolve();
				};
				const timer = setTimeout(() => {
					waiters.delete(wake);
					reject(new Error(`Expected WebSocket event; received ${JSON.stringify(messages)}`));
				}, 8_000);
				waiters.add(wake);
			});
		};
		return { ws, messages, until, create, cancel, responses };
	}

	it("refuses what the connection cannot honour, with a stable code each", async () => {
		const { ws, messages, until, create } = await connect();
		const errors = () => messages.filter((m) => m.type === "error").map((m) => m.error?.code);
		ws.send(JSON.stringify({ type: "response.create", input: "x", background: true }));
		ws.send(JSON.stringify({ type: "response.create", input: "x", stream_id: "bad id!" }));
		ws.send(JSON.stringify({ type: "response.nonsense" }));
		ws.send("not json");
		await until(() => errors().length === 4);
		expect(errors().sort()).toEqual(["invalid_json", "invalid_stream_id", "invalid_value", "unsupported_parameter"]);
		expect(create).not.toHaveBeenCalled();

		// Keep the real 32/33 boundary; reducing the configured limit would miss an off-by-one.
		for (let i = 0; i < 33; i++) ws.send(JSON.stringify({ type: "response.create", input: "x", stream_id: `s${i}` }));
		await until(() => messages.filter((m) => m.type === "response.completed").length >= 32);
		expect(errors()).toContain("websocket_stream_limit_reached");
		expect(create).toHaveBeenCalledTimes(32);
		expect(new Set(messages.filter((m) => m.type === "response.completed").map((m) => m.stream_id)).size).toBe(32);

		const done = messages.find((m) => m.type === "response.completed")!.response!.id;
		ws.send(JSON.stringify({ type: "response.steer", previous_response_id: done, input: "late" }));
		ws.send(JSON.stringify({ type: "response.steer", previous_response_id: "resp_unknown", input: "x" }));
		await until(() => messages.filter((m) => m.type === "response.steer.failed").length === 2);
		expect(messages.filter((m) => m.type === "response.steer.failed").map((m) => m.error?.code)).toEqual([
			"response_already_completed",
			"response_not_found",
		]);
	});

	it("closes a connection at its time limit, and cancels what a closed connection was running", async () => {
		const { ws, messages, until, cancel, responses } = await connect({ hold: true, maxMs: 1500 });
		const closed = once(ws, "close");
		const serverClosed = once([...app!.websocketServer.clients][0], "close");
		ws.send(JSON.stringify({ type: "response.create", input: "HOLD" }));
		await until(() => messages.some((m) => m.type === "response.created"));
		await vi.advanceTimersByTimeAsync(1499);
		expect(cancel).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect((await closed)[0]).toBe(1000);
		await serverClosed;
		expect(messages.some((m) => m.error?.code === "websocket_connection_limit_reached")).toBe(true);
		expect(cancel).toHaveBeenCalledExactlyOnceWith(responses[0]);
		expect(responses[0].status).toBe("cancelled");
	});
});

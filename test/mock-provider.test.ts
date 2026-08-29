import { afterEach, describe, expect, it } from "vitest";
import { parseRequest, reply, Script } from "./support/mock-provider/script.js";
import { type MockProvider, startMockProvider } from "./support/mock-provider/server.js";
import { encodeResponse } from "./support/mock-provider/sse.js";

/**
 * The mock provider only implements a subset of the openai SSE protocol, so it
 * needs its own guards (spec 048 D2.8): SSE encoding is well-formed, routing is
 * by content not arrival order, and an unmatched request fails loudly.
 */

/** Parse the `data:` lines of an SSE body back into chunk objects (drops `[DONE]`). */
function decodeFrames(body: string): Array<Record<string, unknown>> {
	return body
		.split("\n\n")
		.map((f) => f.replace(/^data: /, "").trim())
		.filter((f) => f && f !== "[DONE]")
		.map((f) => JSON.parse(f) as Record<string, unknown>);
}

describe("mock provider: SSE encoding", () => {
	it("encodes text as delta.content, a stop finish_reason, a usage chunk, and [DONE]", () => {
		const body = encodeResponse("mock-main", reply.text("hello"));
		expect(body.endsWith("data: [DONE]\n\n")).toBe(true);

		const frames = decodeFrames(body);
		const contents = frames.flatMap((f) => {
			const choice = (f.choices as Array<Record<string, unknown>>)[0];
			const delta = choice?.delta as { content?: string } | undefined;
			return delta?.content ? [delta.content] : [];
		});
		expect(contents.join("")).toBe("hello");

		const finish = frames.map((f) => (f.choices as Array<Record<string, unknown>>)[0]?.finish_reason).filter(Boolean);
		expect(finish).toEqual(["stop"]);
		expect(frames.at(-1)?.usage).toBeDefined();
	});

	it("encodes a tool call as an aggregated tool_calls delta with a tool_calls finish_reason", () => {
		const frames = decodeFrames(
			encodeResponse("mock-main", reply.toolCall("write", { path: "a.txt", content: "x" })),
		);
		const toolFrame = frames.find(
			(f) => ((f.choices as Array<Record<string, unknown>>)[0]?.delta as { tool_calls?: unknown[] })?.tool_calls,
		);
		const call = (
			(toolFrame?.choices as Array<Record<string, unknown>>)[0].delta as {
				tool_calls: Array<{ index: number; function: { name: string; arguments: string } }>;
			}
		).tool_calls[0];
		expect(call.index).toBe(0);
		expect(call.function.name).toBe("write");
		expect(JSON.parse(call.function.arguments)).toEqual({ path: "a.txt", content: "x" });

		const finish = frames.map((f) => (f.choices as Array<Record<string, unknown>>)[0]?.finish_reason).filter(Boolean);
		expect(finish).toEqual(["tool_calls"]);
	});
});

describe("mock provider: content routing", () => {
	const mainBody = {
		model: "mock-main",
		messages: [{ role: "user", content: "do X" }],
		tools: [{ function: { name: "write" } }],
	};
	const sidecarBody = {
		model: "mock-main",
		messages: [
			{ role: "system", content: "You are Pipiclaw's durable memory extraction worker." },
			{ role: "user", content: "transcript" },
		],
	};

	it("classifies a request with tools as the main turn and a no-tools request as sidecar", () => {
		expect(parseRequest("/chat/completions", mainBody).isMainTurn).toBe(true);
		expect(parseRequest("/chat/completions", sidecarBody).isMainTurn).toBe(false);
	});

	it("matches by the `when` predicate regardless of route registration order", () => {
		const script = new Script();
		script.route({ name: "sidecar", when: (r) => !r.isMainTurn, respond: [reply.text("side")] });
		script.route({ name: "main", when: (r) => r.isMainTurn, respond: [reply.text("main")] });

		// Send the sidecar-shaped request first: order must not decide the match.
		expect(script.resolve(parseRequest("/chat/completions", sidecarBody))?.route).toBe("sidecar");
		expect(script.resolve(parseRequest("/chat/completions", mainBody))?.route).toBe("main");
	});

	it("returns null (→ 502) when a route is exhausted rather than reusing its last response", () => {
		const script = new Script();
		script.route({ name: "once", when: () => true, respond: [reply.text("first")] });
		expect(script.resolve(parseRequest("/chat/completions", mainBody))?.response.steps[0]).toEqual({ text: "first" });
		expect(script.resolve(parseRequest("/chat/completions", mainBody))).toBeNull();
	});
});

describe("mock provider: unmatched request", () => {
	let provider: MockProvider;
	afterEach(async () => {
		await provider?.close();
	});

	it("answers 502 and records the request when no route matches", async () => {
		provider = await startMockProvider({ registerDefaults: false });
		const res = await fetch(`${provider.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "mock-main",
				messages: [{ role: "user", content: "unrouted" }],
				tools: [{ function: { name: "x" } }],
			}),
		});
		expect(res.status).toBe(502);
		expect(provider.requests).toHaveLength(1);
		expect(provider.unmatched()).toHaveLength(1);
		expect(provider.unmatched()[0]?.lastUserText).toBe("unrouted");
	});

	it("streams a matched route as an event-stream", async () => {
		provider = await startMockProvider({ registerDefaults: false });
		provider.script.route({
			name: "echo",
			when: (r) => r.lastUserText.includes("ping"),
			respond: [reply.text("pong")],
		});
		const res = await fetch(`${provider.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "mock-main",
				messages: [{ role: "user", content: "ping" }],
				tools: [{ function: { name: "x" } }],
			}),
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		expect(await res.text()).toContain('"content":"pong"');
		expect(provider.unmatched()).toHaveLength(0);
	});
});

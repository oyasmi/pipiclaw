import { afterEach, describe, expect, it } from "vitest";
import { createWebApiHarness, reply, type WebApiHarness } from "../../support/webapi-harness.js";

describe("E2E deterministic: Web API", () => {
	let harness: WebApiHarness;
	afterEach(async () => {
		await harness.shutdown();
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

		const done = await harness.tcp.responses.create({ model: "pipiclaw", input: "again" });
		expect(done.status).toBe("completed");
		expect(done.output_text).toBe("pong");
	});
});

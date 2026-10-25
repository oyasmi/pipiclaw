import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWebApiHarness, reply, WEBAPI_DESK, type WebApiHarness } from "../../support/webapi-harness.js";

const allFiles = (root: string): string[] =>
	readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() ? allFiles(path) : entry.isFile() ? [path] : [];
	});
const bodyText = (request: { messages: Array<{ role: string; content: string }> }) =>
	request.messages.map((m) => m.content).join("\n");

describe("E2E deterministic: Responses context strategies", () => {
	let harness: WebApiHarness;
	afterEach(async () => {
		await harness?.shutdown();
	});

	it("W7: imports caller roles and replayed tool records as context, without executing historical turns", async () => {
		// Mutation checked 2026-10-25: assistant→user makes W7 fail on the provider role sequence.
		// Regression: flattening history into user text changes authority; emitting imported assistant
		// events presents historical replies as new output, and replaying tool calls repeats side effects.
		harness = await createWebApiHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: [reply.toolCall("write", { path: "live-marker", content: "live" }), reply.text("finished")],
		});
		const result = await harness.tcp.responses.create({
			store: false,
			instructions: "REQUEST_RULE_731",
			input: [
				{ role: "system", content: "SYSTEM_RULE_731" },
				{ role: "developer", content: "DEVELOPER_RULE_731" },
				{ role: "user", content: "HISTORICAL_USER_731" },
				{ role: "assistant", content: "HISTORICAL_ANSWER_731" },
				{
					type: "mcp_call",
					id: "mcp_old",
					server_label: "pipiclaw",
					name: "bash",
					arguments: JSON.stringify({
						command: `touch ${join(harness.workspaceDir, `desk-${WEBAPI_DESK}`, "replay-marker")}`,
					}),
					output: "old result",
					error: null,
				},
				{ type: "reasoning", id: "rs_old", summary: [{ type: "summary_text", text: "old thought" }] },
				{ role: "user", content: "CURRENT_USER_731" },
			],
		});
		await harness.waitForIdle();
		expect(result.status).toBe("completed");
		expect(result.conversation).toBeNull();
		expect(result.output.filter((i) => i.type === "mcp_call")).toHaveLength(1);
		expect(JSON.stringify(result.output)).not.toContain("HISTORICAL_ANSWER_731");
		const requests = harness.mainTurnRequests();
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
				"HISTORICAL_USER_731",
				"CURRENT_USER_731",
			]);
			expect(
				request.messages.filter((m) => m.role === "assistant" && m.content === "HISTORICAL_ANSWER_731"),
			).toHaveLength(1);
			const directives = request.messages
				.filter((m) => m.role === "system" || m.role === "developer")
				.map((m) => m.content)
				.join("\n");
			for (const marker of ["REQUEST_RULE_731", "SYSTEM_RULE_731", "DEVELOPER_RULE_731"])
				expect(directives).toContain(marker);
		}
		const deskDir = join(harness.workspaceDir, `desk-${WEBAPI_DESK}`);
		expect(existsSync(join(deskDir, "replay-marker"))).toBe(false);
		expect(readFileSync(join(deskDir, "live-marker"), "utf8")).toBe("live");
	});

	it("W8: concurrent store:false requests leave no conversation content and do not share history or instructions", async () => {
		// Mutation checked 2026-10-25: forcing snapshot persistence makes W8 fail on disk content.
		// Regression: API-only retention flags leave SDK transcripts/automatic reflection on disk;
		// mutating a shared system prompt lets a concurrent request inherit another caller's instructions.
		harness = await createWebApiHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("reply")],
			repeat: true,
		});
		const bindingsPath = join(harness.workspaceDir, "desk-bindings.json");
		const beforeBindings = existsSync(bindingsPath) ? readFileSync(bindingsPath, "utf8") : undefined;
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText === "PRIVATE_INPUT_A_819" });
		const pending = harness.tcp.responses.create({
			input: "PRIVATE_INPUT_A_819",
			store: false,
			instructions: "PRIVATE_DIRECTIVE_A_819",
		});
		// APIPromise is lazy: starting it must happen before waiting for provider arrival.
		const firstPromise = pending.then((r) => r);
		await gate.arrived;
		let second: Awaited<typeof firstPromise> | undefined;
		try {
			second = await harness.tcp.responses.create({
				input: "PRIVATE_INPUT_B_819",
				store: false,
				instructions: "PRIVATE_DIRECTIVE_B_819",
			});
		} finally {
			gate.release();
		}
		const first = await firstPromise;
		await harness.waitForIdle();
		const [a, b] = harness.mainTurnRequests();
		expect(bodyText(a)).not.toContain("PRIVATE_DIRECTIVE_B_819");
		expect(bodyText(b)).not.toContain("PRIVATE_DIRECTIVE_A_819");
		expect(bodyText(b)).not.toContain("PRIVATE_INPUT_A_819");
		for (const response of [first, second]) {
			expect(response?.status).toBe("completed");
			await expect(harness.tcp.responses.retrieve(response!.id)).rejects.toMatchObject({ status: 404 });
		}
		await expect(
			harness.tcp.responses.create({ previous_response_id: first.id, input: "continuation" }),
		).rejects.toMatchObject({ status: 404 });
		expect(harness.mainTurnRequests()).toHaveLength(2);
		const afterBindings = existsSync(bindingsPath) ? readFileSync(bindingsPath, "utf8") : undefined;
		expect(afterBindings).toBe(beforeBindings);
		for (const path of allFiles(harness.homeDir)) {
			const content = readFileSync(path, "utf8");
			expect(content, path).not.toMatch(/PRIVATE_(INPUT|DIRECTIVE)_[AB]_819/);
		}
		const third = await harness.tcp.responses.create({ input: "UNRELATED_819", store: false });
		await harness.waitForIdle();
		expect(third.status).toBe("completed");
		expect(bodyText(harness.mainTurnRequests().at(-1)!)).not.toContain("PRIVATE_");
	});

	it("W9: stored response snapshots survive restart and fork without inheriting sibling turns or instructions", async () => {
		// Mutation checked 2026-10-25: dropping the parent snapshot makes W9 fail on provider input.
		// Regression: mapping every response id to the latest mutable channel makes old response
		// references see later turns, and persisting a request overlay leaks instructions into children.
		harness = await createWebApiHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn && r.lastUserText !== "DESK_CONTEXT_CHILD_932",
			respond: [reply.toolCall("read", { path: "tool-source.txt" }), reply.text("root answer")],
			repeat: true,
		});
		writeFileSync(
			join(harness.workspaceDir, `desk-${WEBAPI_DESK}`, "tool-source.txt"),
			`CONTEXT_TOOL_START_${"x".repeat(5000)}_CONTEXT_TOOL_END_932`,
		);
		harness.model.script.failNext({ status: 429 });
		const root = await harness.tcp.responses.create({ input: "ROOT_932", instructions: "ROOT_INSTRUCTIONS_932" });
		await harness.waitForIdle();
		expect(root.conversation).toBeNull();
		expect(
			root.output
				.filter((item) => item.type === "mcp_call")
				.map((item) => item.output)
				.join("\n"),
		).not.toContain("CONTEXT_TOOL_END_932");
		const fallback = harness.mainTurnRequests().find((r) => r.model === "mock-fallback")!;
		expect(fallback).toBeDefined();
		expect(fallback.messages.filter((m) => m.role === "user" && m.content === "ROOT_932")).toHaveLength(1);
		await harness.restart();
		expect((await harness.tcp.responses.retrieve(root.id)).status).toBe("completed");
		const branchA = await harness.tcp.responses.create({
			previous_response_id: root.id,
			input: "BRANCH_A_932",
			instructions: "BRANCH_INSTRUCTIONS_A_932",
		});
		const branchB = await harness.tcp.responses.create({ previous_response_id: root.id, input: "BRANCH_B_932" });
		await harness.waitForIdle();
		const requests = harness.mainTurnRequests();
		const a = requests.find((r) => r.lastUserText === "BRANCH_A_932")!;
		const b = requests.find((r) => r.lastUserText === "BRANCH_B_932")!;
		expect(a.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["ROOT_932", "BRANCH_A_932"]);
		expect(b.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual(["ROOT_932", "BRANCH_B_932"]);
		expect(bodyText(a)).not.toContain("ROOT_INSTRUCTIONS_932");
		expect(bodyText(a)).toContain("CONTEXT_TOOL_END_932");
		expect(bodyText(b)).not.toContain("INSTRUCTIONS_");
		expect(branchA.previous_response_id).toBe(root.id);
		expect(branchB.previous_response_id).toBe(root.id);
		const independent = await harness.tcp.responses.create({ input: "INDEPENDENT_932" });
		await harness.waitForIdle();
		expect(independent.status).toBe("completed");
		expect(bodyText(harness.mainTurnRequests().at(-1)!)).not.toContain("ROOT_932");
		const local = await harness.socket.responses.create({ input: "LOCAL_ONLY_932" });
		await harness.waitForIdle();
		const before = harness.mainTurnRequests().length;
		await expect(
			harness.tcp.responses.create({ previous_response_id: local.id, input: "foreign" }),
		).rejects.toMatchObject({ status: 404 });
		expect(harness.mainTurnRequests()).toHaveLength(before);
		// A local caller can bind a native conversation to a non-default desk. Its response
		// chain must inherit that desk, rather than writing into local's default desk.
		const native = await harness.socket.conversations.create({});
		await harness.socket.responses.create({ conversation: native.id, input: `/desk bind ${WEBAPI_DESK}` });
		const deskRoot = await harness.socket.responses.create({
			conversation: native.id,
			input: "DESK_CONTEXT_ROOT_932",
		});
		harness.model.script.route({
			name: "desk-child",
			when: (r) => r.isMainTurn && r.lastUserText === "DESK_CONTEXT_CHILD_932",
			respond: [reply.toolCall("write", { path: "desk-child-marker", content: "child" }), reply.text("done")],
		});
		const deskChild = await harness.socket.responses.create({
			previous_response_id: deskRoot.id,
			input: "DESK_CONTEXT_CHILD_932",
		});
		await harness.waitForIdle();
		expect(deskChild.status).toBe("completed");
		expect(readFileSync(join(harness.workspaceDir, `desk-${WEBAPI_DESK}`, "desk-child-marker"), "utf8")).toBe(
			"child",
		);
		expect(existsSync(join(harness.workspaceDir, "desk-default", "desk-child-marker"))).toBe(false);
	});
});

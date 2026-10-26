import { afterEach, describe, expect, it, vi } from "vitest";
import { interpret } from "../src/tui/commands.js";
import type { Frontend, FrontendCallbacks } from "../src/tui/frontend.js";
import { EventRenderer, traitsOf } from "../src/tui/render.js";
import { type Connection, type ConversationItem, type SessionLink, TuiSession } from "../src/tui/session.js";

class FakeFrontend implements Frontend {
	callbacks!: FrontendCallbacks;
	calls: Array<[string, string?]> = [];
	start(callbacks: FrontendCallbacks): void {
		this.callbacks = callbacks;
	}
	appendProgress(text: string): void {
		this.calls.push(["progress", text]);
	}
	showFinal(text: string): void {
		this.calls.push(["final", text]);
	}
	showNotice(text: string): void {
		this.calls.push(["notice", text]);
	}
	clearProgress(): void {
		this.calls.push(["clear"]);
	}
	setWorking(): void {}
	setStatus(): void {}
	setBusy(): void {}
	showBanner(): void {}
	stop(): void {
		this.calls.push(["stop"]);
	}
}

function fakeLink(items: () => ConversationItem[] = () => []) {
	const sent: Array<Record<string, unknown>> = [];
	const state = { closed: 0, reachable: true, onEvent: (_event: never) => {}, onClose: () => {} };
	const link: SessionLink = {
		conversationId: "conv_1",
		connect(onEvent, onClose) {
			state.onEvent = onEvent as never;
			state.onClose = onClose;
			const connection: Connection = {
				send: (event) => void sent.push(event),
				close: () => void state.closed++,
			};
			return connection;
		},
		listItems: async (after) => {
			const all = items();
			const index = after ? all.findIndex((item) => item.id === after) : -1;
			return all.slice(index + 1);
		},
		lastItemId: async () => items().at(-1)?.id,
		reachable: () => state.reachable,
	};
	return { link, sent, state, emit: (event: Record<string, unknown>) => state.onEvent(event as never) };
}

const created = (id: string) => ({ type: "response.created", response: { id } });
const completed = (id: string) => ({ type: "response.completed", response: { id, status: "completed" } });

describe("terminal input", () => {
	it("keeps /stop, /steer, /followup and /exit local and sends everything else to the server", () => {
		expect(interpret("/exit")).toEqual({ kind: "exit" });
		expect(interpret("/stop")).toEqual({ kind: "stop" });
		expect(interpret("/steer 换个方向")).toEqual({ kind: "steer", text: "换个方向" });
		expect(interpret("/followup 之后再做")).toEqual({ kind: "followup", text: "之后再做" });
		expect(interpret("/steer").kind).toBe("noop");
		for (const text of ["你好", "/new", "/status", "/model fast", "/desk bind lab"]) {
			expect(interpret(text)).toEqual({ kind: "send", text });
		}
	});
});

describe("TuiSession", () => {
	let session: TuiSession | undefined;
	afterEach(() => {
		session?.exit();
		session = undefined;
	});

	async function open(link: SessionLink, frontend = new FakeFrontend()) {
		session = new TuiSession({
			link,
			frontend,
			traits: traitsOf("full_progress_then_plain_final"),
			label: "t",
			pollIntervalMs: 20,
		});
		void session.startInteractive();
		await vi.waitFor(() => expect(frontend.callbacks).toBeDefined());
		return { session, frontend };
	}

	it("steers a running turn, queues /followup behind it, and stops with a reconnect-able close", async () => {
		const { link, sent, state, emit } = fakeLink();
		const { session, frontend } = await open(link);

		session.submit("第一件事");
		expect(sent[0]).toMatchObject({ type: "response.create", conversation: "conv_1", input: "第一件事" });
		emit(created("resp_1"));
		expect(session.busy).toBe(true);

		session.submit("补充一点");
		expect(sent[1]).toMatchObject({ type: "response.steer", previous_response_id: "resp_1", input: "补充一点" });
		// A command is the server's to judge, not steered into the running turn as text.
		session.submit("/model fast");
		expect(sent[2]).toMatchObject({ type: "response.create", input: "/model fast", stream_id: "control" });
		session.submit("/followup 稍后");
		expect(sent).toHaveLength(3);

		// The turn ends: the queued /model create is still unanswered, so the session stays busy and
		// the follow-up waits; once everything is done, the follow-up goes out.
		emit(completed("resp_1"));
		expect(session.busy).toBe(true);
		emit(created("resp_2"));
		emit(completed("resp_2"));
		expect(sent[3]).toMatchObject({ type: "response.create", input: "稍后" });
		expect(session.busy).toBe(true);
		emit(created("resp_3"));
		emit(completed("resp_3"));
		expect(session.busy).toBe(false);

		// Stop closes the connection (the API's cancel) and forgets queued follow-ups.
		session.submit("又一件事");
		emit(created("resp_4"));
		session.submit("/followup 不会发送");
		const staleClose = state.onClose;
		session.submit("/stop");
		expect(state.closed).toBe(1);
		expect(session.busy).toBe(false);
		expect(frontend.calls).toContainEqual(["notice", "已停止。"]);
		session.submit("再来");
		expect(sent.at(-1)).toMatchObject({ input: "再来" });
		// The closed connection's late events must not touch the new one's state.
		staleClose();
		expect(session.busy).toBe(true);

		// The runtime went away under the live connection (another terminal embedded it and exited):
		// the user is told once how to recover, not left with a terminal that silently does nothing.
		state.reachable = false;
		state.onClose();
		session.submit("还在吗");
		state.onClose();
		const recover = frontend.calls.filter(([kind, text]) => kind === "notice" && text?.includes("pipiclaw tui"));
		expect(recover).toHaveLength(1);
		expect(session.busy).toBe(false);
	});

	it("follows a steered response into its successor and does not call itself idle in between", async () => {
		const { link, sent, emit } = fakeLink();
		const { session } = await open(link);
		session.submit("干活");
		emit(created("resp_1"));
		// A command answered on its own stream mid-turn must not become the steering target.
		session.submit("/status");
		emit({ ...created("resp_cmd"), stream_id: "control" });
		emit({ ...completed("resp_cmd"), stream_id: "control" });
		session.submit("改一下");
		expect(sent.at(-1)).toMatchObject({ type: "response.steer", previous_response_id: "resp_1" });
		emit({ type: "response.steer.accepted" });
		emit({
			type: "response.incomplete",
			response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "steered" } },
		});
		expect(session.busy).toBe(true);
		emit(created("resp_2"));
		expect(session.busy).toBe(true);
		emit(completed("resp_2"));
		expect(session.busy).toBe(false);
	});

	it("shows what the server said on its own while idle, once, and not what its own turns said", async () => {
		const items: ConversationItem[] = [
			{ id: "old", type: "message", role: "assistant", phase: "final_answer", content: [{ text: "旧消息" }] },
		];
		const { link, emit } = fakeLink(() => items);
		const { session, frontend } = await open(link);
		const finals = () => frontend.calls.filter(([kind]) => kind === "final").map(([, text]) => text);
		expect(finals()).toEqual([]);

		items.push({
			id: "wake",
			type: "message",
			role: "assistant",
			phase: "final_answer",
			content: [{ text: "后台作业完成" }],
		});
		await vi.waitFor(() => expect(finals()).toEqual(["后台作业完成"]));
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(finals()).toEqual(["后台作业完成"]);

		// An answer to the terminal's own message arrives on its stream; the poll must not repeat it.
		session.submit("问个问题");
		emit(created("resp_1"));
		items.push({
			id: "mine",
			type: "message",
			role: "assistant",
			phase: "final_answer",
			content: [{ text: "我的回答" }],
		});
		emit({
			type: "response.output_item.done",
			item: {
				id: "mine",
				type: "message",
				phase: "final_answer",
				content: [{ type: "output_text", text: "我的回答" }],
			},
		});
		// A report that landed in the same window was not drawn by the stream: it must still show.
		items.push({
			id: "report",
			type: "message",
			role: "assistant",
			phase: "final_answer",
			content: [{ text: "委派完成" }],
		});
		emit(completed("resp_1"));
		await vi.waitFor(() => expect(finals()).toEqual(["后台作业完成", "我的回答", "委派完成"]));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(finals()).toEqual(["后台作业完成", "我的回答", "委派完成"]);
	});
});

describe("EventRenderer", () => {
	it("final_card_only shows no progress and only the closing answer; the plain mode streams progress", () => {
		const run = (mode: Parameters<typeof traitsOf>[0]) => {
			const frontend = new FakeFrontend();
			const renderer = new EventRenderer(frontend, traitsOf(mode));
			renderer.handle({ type: "response.created" });
			renderer.handle({
				type: "response.output_item.added",
				item: { type: "mcp_call", name: "bash", arguments: '{"command":"ls"}' },
			});
			renderer.handle({
				type: "response.output_item.done",
				item: { type: "mcp_call", status: "failed", error: { content: "boom\nmore" }, pipiclaw_failure: "boom" },
			});
			renderer.handle({
				type: "response.output_item.done",
				item: { type: "message", phase: "final_answer", content: [{ text: "答案" }] },
			});
			renderer.handle({ type: "response.completed" });
			return frontend.calls;
		};
		const plain = run("full_progress_then_plain_final");
		expect(plain.filter(([kind]) => kind === "progress").length).toBe(2);
		expect(plain.filter(([kind]) => kind === "final")).toEqual([["final", "答案"]]);
		const card = run("final_card_only");
		expect(card.filter(([kind]) => kind === "progress")).toEqual([]);
		expect(card.filter(([kind]) => kind === "final")).toEqual([["final", "答案"]]);
	});
});

import { describe, expect, it, vi } from "vitest";
import { type DispatchDeps, dispatch } from "../src/tui/commands.js";

function deps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
	return {
		renderHelp: () => "HELP",
		renderStatus: () => "STATUS",
		renderUsage: (args) => `USAGE:${args}`,
		runEvents: async (args) => `EVENTS:${args}`,
		...overrides,
	};
}

describe("dispatch", () => {
	it("routes plain messages to run", async () => {
		expect(await dispatch("hello there", deps())).toEqual({ kind: "run", text: "hello there" });
	});

	it("does not intercept session commands", async () => {
		expect(await dispatch("/model anthropic/x", deps())).toEqual({ kind: "run", text: "/model anthropic/x" });
		expect(await dispatch("/new", deps())).toEqual({ kind: "run", text: "/new" });
		expect(await dispatch("/compact keep todos", deps())).toEqual({ kind: "run", text: "/compact keep todos" });
		expect(await dispatch("/session", deps())).toEqual({ kind: "run", text: "/session" });
	});

	it("renders info commands via deps", async () => {
		expect(await dispatch("/help", deps())).toEqual({ kind: "reply", text: "HELP" });
		expect(await dispatch("/status", deps())).toEqual({ kind: "reply", text: "STATUS" });
		expect(await dispatch("/usage 7d", deps())).toEqual({ kind: "reply", text: "USAGE:7d" });
		expect(await dispatch("/events list", deps())).toEqual({ kind: "reply", text: "EVENTS:list" });
	});

	it("awaits runEvents", async () => {
		const runEvents = vi.fn().mockResolvedValue("done");
		const out = await dispatch("/events show weekly", deps({ runEvents }));
		expect(runEvents).toHaveBeenCalledWith("show weekly");
		expect(out).toEqual({ kind: "reply", text: "done" });
	});

	it("maps stop/steer/followup to intents", async () => {
		expect(await dispatch("/stop", deps())).toEqual({ kind: "stop" });
		expect(await dispatch("/steer use UTC", deps())).toEqual({ kind: "steer", text: "use UTC" });
		expect(await dispatch("/followup then summarize", deps())).toEqual({ kind: "followup", text: "then summarize" });
	});

	it("hints when steer/followup have no message", async () => {
		expect(await dispatch("/steer", deps())).toEqual({ kind: "noop", text: "/steer requires a message." });
		expect(await dispatch("/followup   ", deps())).toEqual({ kind: "noop", text: "/followup requires a message." });
	});

	it("handles exit/quit and blank input", async () => {
		expect(await dispatch("/exit", deps())).toEqual({ kind: "exit" });
		expect(await dispatch("/QUIT", deps())).toEqual({ kind: "exit" });
		expect(await dispatch("   ", deps())).toEqual({ kind: "noop" });
	});
});

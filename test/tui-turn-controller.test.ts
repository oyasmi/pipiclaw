import { describe, expect, it } from "vitest";
import type { AgentRunner, RunnerStatusSnapshot } from "../src/agent/types.js";
import type { ChannelStore } from "../src/runtime/store.js";
import type { Frontend, FrontendCallbacks } from "../src/tui/renderer.js";
import { TurnController } from "../src/tui/turn-controller.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

class FakeRunner implements AgentRunner {
	runCount = 0;
	abortCount = 0;
	flushCount = 0;
	steers: string[] = [];
	private finish: (() => void) | undefined;

	run(): Promise<{ stopReason: string }> {
		this.runCount++;
		return new Promise((resolve) => {
			this.finish = () => resolve({ stopReason: "stop" });
		});
	}
	finishRun(): void {
		this.finish?.();
		this.finish = undefined;
	}
	async handleBuiltinCommand(): Promise<void> {}
	async queueSteer(text: string): Promise<void> {
		this.steers.push(text);
	}
	async flushMemoryForShutdown(): Promise<void> {
		this.flushCount++;
	}
	async getMemoryMaintenanceContext(): Promise<never> {
		throw new Error("unused");
	}
	getStatusSnapshot(): RunnerStatusSnapshot {
		return { model: "test/model", contextWindow: 0, thinkingLevel: "off" };
	}
	async abort(): Promise<void> {
		this.abortCount++;
		this.finishRun();
	}
}

class FakeFrontend implements Frontend {
	notices: string[] = [];
	finals: string[] = [];
	busy: boolean | undefined;
	stopped = false;
	/** When set, the first stop() throws to simulate a teardown failure. */
	stopThrowsOnce = false;
	callbacks!: FrontendCallbacks;
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
	setBusy(busy: boolean): void {
		this.busy = busy;
	}
	showBanner(): void {}
	stop(): void {
		this.stopped = true;
		if (this.stopThrowsOnce) {
			this.stopThrowsOnce = false;
			throw new Error("stop failed");
		}
	}
}

const fakeStore = { logMessage: async () => true } as unknown as ChannelStore;

function setup({ start = false, now = () => 0 }: { start?: boolean; now?: () => number } = {}) {
	const runner = new FakeRunner();
	const frontend = new FakeFrontend();
	const controller = new TurnController({
		runner,
		frontend,
		store: fakeStore,
		traits: { progressStyle: "full", finalDelivery: "plain" },
		channelId: "tui_local",
		userName: "tester",
		renderHelp: () => "HELP",
		renderUsage: () => "USAGE",
		runEvents: async () => "EVENTS",
		runTasks: async () => "TASKS",
		statusInfo: { version: "1", startedAt: 0 },
		now,
	});
	const exit = start ? controller.startInteractive() : undefined;
	return { runner, frontend, controller, exit, cb: () => frontend.callbacks };
}

describe("TurnController", () => {
	it("runs an idle submit and toggles busy", async () => {
		const { runner, frontend, cb } = setup({ start: true });
		cb().onSubmit("hello");
		await tick();
		expect(runner.runCount).toBe(1);
		expect(frontend.busy).toBe(true);
		runner.finishRun();
		await tick();
		expect(frontend.busy).toBe(false);
	});

	it("steers the in-flight turn instead of starting another", async () => {
		const { runner, cb } = setup({ start: true });
		cb().onSubmit("first");
		await tick();
		cb().onSubmit("adjust course");
		await tick();
		expect(runner.runCount).toBe(1);
		expect(runner.steers).toContain("adjust course");
	});

	it("queues a follow-up to run after the current turn", async () => {
		const { runner, cb } = setup({ start: true });
		cb().onSubmit("first");
		await tick();
		cb().onSubmit("/followup second");
		await tick();
		expect(runner.runCount).toBe(1);
		runner.finishRun();
		await tick();
		expect(runner.runCount).toBe(2);
	});

	it("/stop aborts the running turn", async () => {
		const { runner, cb } = setup({ start: true });
		cb().onSubmit("work");
		await tick();
		cb().onSubmit("/stop");
		await tick();
		expect(runner.abortCount).toBe(1);
	});

	it("Ctrl-C while running aborts but does not exit", async () => {
		const { runner, frontend, cb } = setup({ start: true });
		cb().onSubmit("work");
		await tick();
		cb().onInterrupt();
		await tick();
		expect(runner.abortCount).toBe(1);
		expect(frontend.stopped).toBe(false);
	});

	it("two-stage Ctrl-C when idle: first arms, second exits", async () => {
		const { runner, frontend, exit, cb } = setup({ start: true });
		cb().onInterrupt();
		expect(frontend.notices.at(-1)).toBe("Press Ctrl-C again to exit.");
		expect(frontend.stopped).toBe(false);

		cb().onInterrupt(); // armed → exit (no time window)
		await tick();
		expect(runner.flushCount).toBe(1);
		expect(frontend.stopped).toBe(true);
		await exit;
	});

	it("a submission disarms the exit prompt", async () => {
		const { runner, frontend, cb } = setup({ start: true });
		cb().onInterrupt(); // arm
		cb().onSubmit("hello");
		await tick();
		runner.finishRun();
		await tick();
		cb().onInterrupt(); // disarmed by the submission → hint again, not exit
		expect(frontend.stopped).toBe(false);
		expect(frontend.notices.at(-1)).toBe("Press Ctrl-C again to exit.");
	});

	it("/exit flushes memory and stops the frontend", async () => {
		const { runner, frontend, exit, cb } = setup({ start: true });
		cb().onSubmit("/exit");
		await tick();
		expect(runner.flushCount).toBe(1);
		expect(frontend.stopped).toBe(true);
		await exit;
	});

	it("still resolves exit when frontend.stop() throws during shutdown", async () => {
		const { frontend, exit, cb } = setup({ start: true });
		frontend.stopThrowsOnce = true;
		cb().onInterrupt(); // arm
		cb().onInterrupt(); // exit → shutdown() with a throwing stop()
		// A rejected shutdown must not hang or leak: exit still resolves.
		await expect(exit).resolves.toBeUndefined();
		expect(frontend.stopped).toBe(true);
	});
});

describe("TurnController.runOnce", () => {
	// Regression for the --print built-in command bypass: runOnce used to call
	// beginTurn() directly, skipping dispatch() entirely, so `/tasks`, `/events`,
	// etc. were sent to the model as plain text instead of resolving zero-LLM.
	it("resolves a built-in slash command without invoking the runner", async () => {
		const { runner, frontend, controller } = setup();
		await controller.runOnce("/tasks");
		expect(runner.runCount).toBe(0);
		expect(frontend.finals).toContain("TASKS");
	});

	it("runs a plain prompt through the runner", async () => {
		const { runner, controller } = setup();
		const done = controller.runOnce("summarize my day");
		await tick();
		expect(runner.runCount).toBe(1);
		runner.finishRun();
		await done;
	});

	it("shuts down cleanly with no prompt", async () => {
		const { runner, frontend, controller } = setup();
		await controller.runOnce();
		expect(runner.runCount).toBe(0);
		expect(frontend.stopped).toBe(true);
	});
});

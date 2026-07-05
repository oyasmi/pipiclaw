import { describe, expect, it } from "vitest";
import type { AgentRunner, RunnerStatusSnapshot } from "../src/agent/types.js";
import type { ChannelStore } from "../src/runtime/store.js";
import type { SandboxConfig } from "../src/sandbox.js";
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
	}
}

const fakeStore = { logMessage: async () => true } as unknown as ChannelStore;

function setup(now: () => number = () => 0) {
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
		statusInfo: { version: "1", sandbox: { type: "host" } as SandboxConfig, startedAt: 0 },
		now,
	});
	const exit = controller.startInteractive();
	return { runner, frontend, controller, exit, cb: () => frontend.callbacks };
}

describe("TurnController", () => {
	it("runs an idle submit and toggles busy", async () => {
		const { runner, frontend, cb } = setup();
		cb().onSubmit("hello");
		await tick();
		expect(runner.runCount).toBe(1);
		expect(frontend.busy).toBe(true);
		runner.finishRun();
		await tick();
		expect(frontend.busy).toBe(false);
	});

	it("steers the in-flight turn instead of starting another", async () => {
		const { runner, cb } = setup();
		cb().onSubmit("first");
		await tick();
		cb().onSubmit("adjust course");
		await tick();
		expect(runner.runCount).toBe(1);
		expect(runner.steers).toContain("adjust course");
	});

	it("queues a follow-up to run after the current turn", async () => {
		const { runner, cb } = setup();
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
		const { runner, cb } = setup();
		cb().onSubmit("work");
		await tick();
		cb().onSubmit("/stop");
		await tick();
		expect(runner.abortCount).toBe(1);
	});

	it("Ctrl-C while running aborts but does not exit", async () => {
		const { runner, frontend, cb } = setup();
		cb().onSubmit("work");
		await tick();
		cb().onInterrupt();
		await tick();
		expect(runner.abortCount).toBe(1);
		expect(frontend.stopped).toBe(false);
	});

	it("two-stage Ctrl-C when idle: first arms, second exits", async () => {
		const { runner, frontend, exit, cb } = setup();
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
		const { runner, frontend, cb } = setup();
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
		const { runner, frontend, exit, cb } = setup();
		cb().onSubmit("/exit");
		await tick();
		expect(runner.flushCount).toBe(1);
		expect(frontend.stopped).toBe(true);
		await exit;
	});

	it("renders info commands to the transcript", async () => {
		const { frontend, cb } = setup();
		cb().onSubmit("/help");
		await tick();
		expect(frontend.finals).toContain("HELP");
	});
});

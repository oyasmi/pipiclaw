import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/types.js";
import { bootstrapAppHome } from "../src/app/home.js";
import type { InboundMessage, IngressResult } from "../src/channel/ingress.js";
import type { TransportPolicy } from "../src/channel/transport.js";
import { MAX_QUEUED_TURNS_PER_CHANNEL } from "../src/runtime/ingress.js";
import { bindTestChannel, useTempDirs } from "./helpers/fixtures.js";
import { bootstrapPathsIn, createFakeRunner } from "./support/fake-runner.js";
import { RecordingTransport } from "./support/recording-transport.js";

const { createRunnerMock } = vi.hoisted(() => ({
	createRunnerMock: vi.fn(),
}));

vi.mock("../src/agent/runner-factory.js", async () => {
	const actual = await vi.importActual("../src/agent/runner-factory.js");
	return {
		...actual,
		createRunner: createRunnerMock,
	};
});

import { createRuntimeContext, type RuntimeContext } from "../src/runtime/bootstrap.js";

const createTempDir = useTempDirs("pipiclaw-ingress-");
const CHANNEL = "dingtalk:dm:tester";
const runtimes: RuntimeContext[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.shutdown("manual");
	vi.restoreAllMocks();
	createRunnerMock.mockReset();
});

/**
 * The runtime's real ingress, queues and turn pipeline behind a recording transport, with a fake
 * runner in place of the model. `busy` makes the channel look mid-turn.
 */
async function setup(
	options: {
		policy?: Partial<TransportPolicy>;
		run?: AgentRunner["run"];
		runner?: Partial<AgentRunner>;
		bound?: boolean;
		busy?: boolean;
		stopForceEndGraceMs?: number;
	} = {},
) {
	const paths = bootstrapPathsIn(createTempDir());
	bootstrapAppHome(paths);
	const conversation = options.bound === false ? undefined : await bindTestChannel(paths.workspaceDir, CHANNEL);
	const runner = createFakeRunner({ ...(options.run ? { run: options.run } : {}), ...options.runner });
	if (conversation) Object.assign(runner, { conversation });
	createRunnerMock.mockReturnValue(runner);
	const transport = new RecordingTransport({ whenBusy: "steer", textControlCommands: true, ...options.policy });
	const runtime = await createRuntimeContext({
		paths,
		transports: [transport],
		registerSignalHandlers: false,
		startServices: false,
		stopForceEndGraceMs: options.stopForceEndGraceMs,
		createEventsWatcher: () => ({ start() {}, stop() {} }),
	});
	runtimes.push(runtime);
	await transport.start(runtime.ingress);
	if (options.busy) {
		// What the queue does just before it runs a turn: reserve it, which also builds the runner.
		runtime.ingress.reserveEvent({
			source: "human",
			channelId: CHANNEL,
			user: "tester",
			userName: "Tester",
			text: "earlier work",
			ts: "0",
		});
	}
	const settle = () => vi.waitFor(() => expect(runtime.ingress.isIdle()).toBe(true), { timeout: 5_000 });
	return { paths, conversation, runner, transport, runtime, settle };
}

const kinds = (result: IngressResult) => result.kind;

describe("ingress routing", () => {
	// The one place commands, busy handling and turn ordering are decided (INV-1): the same matrix
	// serves every transport, so it is walked here against a transport that only records.
	type Row = {
		name: string;
		text: string;
		busy: boolean;
		policy?: Partial<TransportPolicy>;
		expect: (ctx: Awaited<ReturnType<typeof setup>>, result: IngressResult) => void;
	};
	const rows: Row[] = [
		{
			name: "idle plain message starts a turn",
			text: "do the thing",
			busy: false,
			expect: ({ runner }, result) => {
				expect(kinds(result)).toBe("started");
				expect(runner.run).toHaveBeenCalledTimes(1);
			},
		},
		{
			name: "idle /help answers directly without a model turn",
			text: "/help",
			busy: false,
			expect: ({ runner, transport }, result) => {
				expect(kinds(result)).toBe("started");
				expect(runner.run).not.toHaveBeenCalled();
				expect(runner.handleBuiltinCommand).toHaveBeenCalledTimes(1);
				expect(transport.pushes[0]?.message).toMatchObject({ title: "/help", markdown: true });
			},
		},
		{
			name: "busy /stop stops the turn and says so",
			text: "/stop",
			busy: true,
			expect: ({ runner, transport }, result) => {
				expect(kinds(result)).toBe("replied");
				expect(runner.abort).toHaveBeenCalledTimes(1);
				expect(transport.pushes.at(-1)?.message).toMatchObject({ title: "/stop" });
			},
		},
		{
			name: "busy /steer steers the running turn",
			text: "/steer focus src",
			busy: true,
			expect: ({ runner }, result) => {
				expect(kinds(result)).toBe("replied");
				expect(runner.queueSteer).toHaveBeenCalledWith("focus src", "Tester", undefined);
			},
		},
		{
			name: "busy /followup runs after the current turn",
			text: "/followup next task",
			busy: true,
			expect: ({ runner }, result) => {
				expect(kinds(result)).toBe("queued");
				expect(runner.queueSteer).not.toHaveBeenCalled();
				expect(runner.run).toHaveBeenCalledTimes(1);
			},
		},
		{
			name: "busy report command is answered while the turn runs",
			text: "/status",
			busy: true,
			expect: ({ runner, transport }, result) => {
				expect(kinds(result)).toBe("replied");
				expect(runner.run).not.toHaveBeenCalled();
				expect(transport.pushes.at(-1)?.message).toMatchObject({ title: "/status", markdown: true });
			},
		},
		{
			name: "busy session command is refused with a hint, not steered in as text",
			text: "/model anthropic/x",
			busy: true,
			expect: ({ runner, transport }, result) => {
				expect(kinds(result)).toBe("replied");
				expect(runner.queueSteer).not.toHaveBeenCalled();
				const hint = transport.pushes.at(-1)?.message.text ?? "";
				expect(hint).toContain("`/status`");
				expect(hint).toContain("`/model`");
			},
		},
		{
			name: "busy /new detaches the generation instead of waiting or queueing",
			text: "/new",
			busy: true,
			expect: ({ runner, transport }, result) => {
				expect(kinds(result)).toBe("replied");
				expect(runner.retireForNewSession).toHaveBeenCalledTimes(1);
				expect(runner.queueSteer).not.toHaveBeenCalled();
				expect(runner.run).not.toHaveBeenCalled();
				expect(transport.pushes).toHaveLength(1);
			},
		},
		{
			name: "busy plain message steers when the transport's policy is steer",
			text: "also check lint",
			busy: true,
			expect: ({ runner }, result) => {
				expect(kinds(result)).toBe("replied");
				expect(runner.queueSteer).toHaveBeenCalledWith("also check lint", "Tester", undefined);
			},
		},
		{
			name: "busy plain message waits its turn when the policy is followUp",
			text: "also check lint",
			busy: true,
			policy: { whenBusy: "followUp" },
			expect: ({ runner }, result) => {
				expect(kinds(result)).toBe("queued");
				expect(runner.queueSteer).not.toHaveBeenCalled();
			},
		},
		{
			name: "busy plain message is a turn of its own when the policy is queue",
			text: "also check lint",
			busy: true,
			policy: { whenBusy: "queue" },
			expect: ({ runner }, result) => {
				expect(kinds(result)).toBe("queued");
				expect(runner.queueSteer).not.toHaveBeenCalled();
				expect(runner.interruptCompaction).not.toHaveBeenCalled();
			},
		},
		...(["/stop", "/steer x", "/followup x"] as const).map(
			(text): Row => ({
				// Refused before the busy check, so idle and busy are the same row.
				name: `${text.split(" ")[0]} is refused when the transport has its own control calls`,
				text,
				busy: true,
				policy: { textControlCommands: false },
				expect: ({ runner, transport }, result) => {
					expect(result).toEqual({
						kind: "rejected",
						reason: { code: "control_command", command: text.slice(1).split(" ")[0] },
					});
					expect(runner.abort).not.toHaveBeenCalled();
					expect(runner.queueSteer).not.toHaveBeenCalled();
					expect(runner.run).not.toHaveBeenCalled();
					expect(transport.pushes).toEqual([]);
				},
			}),
		),
		{
			name: "/new still works on a transport without text control commands",
			text: "/new",
			busy: true,
			policy: { textControlCommands: false },
			expect: ({ runner }, result) => {
				expect(kinds(result)).toBe("replied");
				expect(runner.retireForNewSession).toHaveBeenCalledTimes(1);
			},
		},
	];

	it.each(rows)(
		"$name",
		async (row) => {
			const ctx = await setup({
				policy: row.policy,
				busy: row.busy,
				runner: { interruptCompaction: vi.fn(() => false), retireForNewSession: vi.fn() },
				stopForceEndGraceMs: 60_000,
			});
			const result = await ctx.transport.receive(row.text);
			await ctx.settle();
			row.expect(ctx, result);
		},
		30_000,
	);
});

describe("ingress admission", () => {
	it("binds an unbound channel to the sender's first allowed desk, or to default without a list", async () => {
		const { runtime, transport, paths, settle } = await setup({ bound: false });
		await bindTestChannel(paths.workspaceDir, "dingtalk:dm:other", "lab");

		await transport.receive("hello", { channelId: "dingtalk:dm:fresh" });
		expect(runtime.desks.boundDesk("dingtalk:dm:fresh")).toBe("default");

		await transport.receive("hello", { channelId: "dingtalk:dm:keyed", allowedDesks: ["lab", "default"] });
		expect(runtime.desks.boundDesk("dingtalk:dm:keyed")).toBe("lab");
		await settle();
	});

	it("refuses a sender whose allowed desks exclude the channel's desk, before anything runs", async () => {
		const { runtime, runner, transport, paths, settle } = await setup();
		const result = await transport.receive("hello", { allowedDesks: ["lab"] });
		await settle();
		expect(result).toEqual({ kind: "rejected", reason: { code: "desk_not_allowed", desk: "news" } });
		expect(runner.run).not.toHaveBeenCalled();

		// Nor may such a sender move the channel to a desk outside its list.
		await bindTestChannel(paths.workspaceDir, "dingtalk:dm:other", "lab");
		await transport.receive("/desk bind lab", { allowedDesks: ["news"] });
		await settle();
		expect(runtime.desks.boundDesk(CHANNEL)).toBe("news");

		// Admitted under one binding, run under another: refused where it runs, and the turn it
		// reserved is released — a leaked reservation left the channel looking busy.
		const bind = transport.receive("/desk bind lab");
		const queued = transport.receive("hello", { allowedDesks: ["news"] });
		await Promise.all([bind, queued]);
		await settle();
		expect(runtime.desks.boundDesk(CHANNEL)).toBe("lab");
		expect(transport.turns.at(-1)?.outcome?.kind).toBe("completed");
		expect(runner.run).not.toHaveBeenCalled();
		expect(runner.isBusy()).toBe(false);
	});

	it("ends a turn that threw as failed, so its transport does not report an empty success", async () => {
		const { transport, settle } = await setup({
			run: vi.fn(async () => {
				throw new Error("provider exploded");
			}),
		});
		await transport.receive("do the thing");
		await settle();
		const outcome = transport.turns.at(-1)?.outcome;
		expect(outcome?.kind).toBe("failed");
		expect(outcome?.message).not.toContain("provider exploded");
	});

	it("rejects with shutting_down once the runtime has begun to shut down", async () => {
		const { runtime, transport, runner } = await setup();
		await runtime.shutdown("manual");
		const result = await transport.receive("too late");
		expect(result).toEqual({ kind: "rejected", reason: { code: "shutting_down" } });
		expect(runner.run).not.toHaveBeenCalled();
	});

	it("caps a queue-policy channel's pending turns, rejecting the overflow without telling the channel", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { transport, runner, settle } = await setup({
			policy: { whenBusy: "queue" },
			run: vi.fn(async () => {
				await gate;
				return { stopReason: "stop" };
			}),
		});
		const first = await transport.receive("turn 0");
		expect(kinds(first)).toBe("started");
		await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
		for (let index = 1; index <= MAX_QUEUED_TURNS_PER_CHANNEL; index++) {
			expect(kinds(await transport.receive(`turn ${index}`))).toBe("queued");
		}
		const overflow = await transport.receive("one too many");
		expect(overflow).toEqual({ kind: "rejected", reason: { code: "queue_full" } });
		// The transport reports the rejection itself (the Web API answers 429); nothing is pushed.
		expect(transport.pushes).toEqual([]);
		release();
		await settle();
		expect(runner.run).toHaveBeenCalledTimes(MAX_QUEUED_TURNS_PER_CHANNEL + 1);
	});

	it("tells a steering transport's user when its backlog is too deep, and drops the message", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { transport, runner, settle } = await setup({
			policy: { whenBusy: "followUp" },
			run: vi.fn(async () => {
				await gate;
				return { stopReason: "stop" };
			}),
		});
		await transport.receive("turn 0");
		await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
		const results: IngressResult[] = [];
		for (let index = 1; index <= 25; index++) results.push(await transport.receive(`turn ${index}`));
		expect(results.filter((result) => result.kind === "queued")).toHaveLength(20);
		expect(results.at(-1)).toEqual({ kind: "rejected", reason: { code: "queue_full" } });
		expect(transport.pushedTexts().filter((text) => text.includes("消息积压过多"))).toHaveLength(5);
		release();
		await settle();
	});

	it("takes a queued message back out by its ref, and only an unstarted one", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { transport, runner, runtime, settle } = await setup({
			policy: { whenBusy: "queue" },
			run: vi.fn(async () => {
				await gate;
				return { stopReason: "stop" };
			}),
		});
		await transport.receive("running", { ref: "r1" });
		await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
		await transport.receive("waiting", { ref: "r2" });
		expect(runtime.ingress.dropQueued(CHANNEL, "r2")).toBe(true);
		expect(runtime.ingress.dropQueued(CHANNEL, "r2")).toBe(false);
		// The running turn left the queue when it started: it can only be cancelled, not dropped.
		expect(runtime.ingress.dropQueued(CHANNEL, "r1")).toBe(false);
		// Cancelling names its turn: another message's ref stops nothing, and the running one's
		// stops only that turn — what another caller queued behind it still runs (unlike /stop).
		await transport.receive("someone else's", { ref: "r3" });
		expect(await runtime.ingress.cancelTurn(CHANNEL, "r3")).toBe(false);
		expect(runner.abort).not.toHaveBeenCalled();
		expect(await runtime.ingress.cancelTurn(CHANNEL, "r1")).toBe(true);
		expect(runner.abort).toHaveBeenCalledTimes(1);
		release();
		await settle();
		expect(runner.run).toHaveBeenCalledTimes(2);
		expect(transport.turns.at(-1)?.turn.ref).toBe("r3");
	});
});

describe("stopping and steering through the ingress", () => {
	function blockingRun() {
		let signalStarted!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const run = vi.fn(async () => {
			signalStarted();
			await gate;
			return { stopReason: "aborted" };
		});
		return { run, started, release };
	}

	it("a stopped turn aborts, and what was queued behind it never runs", async () => {
		const { run, started, release } = blockingRun();
		const { runner, runtime, transport, settle } = await setup({
			policy: { whenBusy: "followUp" },
			run,
			runner: { abort: vi.fn(async () => release()) },
			stopForceEndGraceMs: 60_000,
		});
		await transport.receive("long work");
		await started;
		await transport.receive("queued behind it");
		await runtime.ingress.cancel(CHANNEL);
		await settle();
		expect(runner.abort).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("force-releases the channel when a stopped turn never finishes its epilogue, and drops its queue", async () => {
		// The turn ignores abort(): it is wedged in its teardown (delivery drain, resource reload,
		// memory flush), which is exactly what /stop cannot reach.
		const wedge = blockingRun();
		const { runner, runtime, transport } = await setup({
			policy: { whenBusy: "followUp" },
			run: wedge.run,
			runner: { retireForRecovery: vi.fn() },
			stopForceEndGraceMs: 50,
		});
		await transport.receive("please keep working");
		await wedge.started;
		await runtime.ingress.cancel(CHANNEL);
		// The wedged turn is still running, so /stop alone leaves the channel busy.
		expect(runtime.ingress.isRunning(CHANNEL)).toBe(true);
		await vi.waitFor(() => expect(runtime.ingress.isRunning(CHANNEL)).toBe(false), { timeout: 5_000 });
		expect(runner.retireForRecovery).toHaveBeenCalledTimes(1);
		wedge.release();
	}, 20_000);

	it("a steer reaches the running turn; one that arrives after the turn ended runs as a turn of its own", async () => {
		const { runner, runtime, settle } = await setup({ busy: true });
		const steer = (text: string): InboundMessage => ({
			channelId: CHANNEL,
			user: "tester",
			userName: "Tester",
			text,
			ts: "1",
		});
		await expect(runtime.ingress.steer(CHANNEL, steer("go left"))).resolves.toEqual({ kind: "accepted" });
		expect(runner.queueSteer).toHaveBeenCalledWith("go left", "Tester", undefined);

		// The busy window closed between the caller's check and the steer: not an error, a normal turn.
		vi.mocked(runner.queueSteer).mockRejectedValueOnce(new Error("No task is currently running."));
		await expect(runtime.ingress.steer(CHANNEL, steer("go right"))).resolves.toEqual({ kind: "accepted" });
		await settle();
		expect(runner.run).toHaveBeenCalledTimes(1);

		await expect(runtime.ingress.steer(CHANNEL, steer("  "))).resolves.toEqual({
			kind: "rejected",
			code: "invalid_input",
		});
	});

	it("/new resets the channel's session out of band and drops what the old generation had queued", async () => {
		const { run, started, release } = blockingRun();
		const { runner, transport, settle } = await setup({
			policy: { whenBusy: "followUp" },
			run,
			runner: { retireForNewSession: vi.fn() },
		});
		await transport.receive("long work");
		await started;
		await transport.receive("queued for the old session");
		await transport.receive("/new");
		expect(runner.retireForNewSession).toHaveBeenCalledOnce();
		expect(transport.pushedTexts().at(-1)).toContain("新会话");
		release();
		await settle();
		// Only the turn that was already running; the queued message belonged to the old generation.
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("interrupts a compaction for new work instead of steering a disconnected loop", async () => {
		const { runner, transport, settle } = await setup({
			busy: true,
			runner: { interruptCompaction: vi.fn(() => true) },
		});
		const result = await transport.receive("new work");
		await settle();
		expect(kinds(result)).toBe("queued");
		expect(runner.interruptCompaction).toHaveBeenCalledOnce();
		expect(runner.queueSteer).not.toHaveBeenCalled();
	});
});

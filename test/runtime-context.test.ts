import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BootstrapPaths, bootstrapAppHome } from "../src/app/home.js";
import { getActiveSessionRefPath } from "../src/channel/active-session-store.js";
import { StartupRefusal } from "../src/desk/startup-error.js";
import { createRuntimeContext } from "../src/runtime/bootstrap.js";
import { bindTestChannel, useTempDirs } from "./helpers/fixtures.js";
import { bootstrapPathsIn } from "./support/fake-runner.js";
import { RecordingTransport } from "./support/recording-transport.js";

const createTempDir = useTempDirs("pipiclaw-runtime-");

function createBootstrapPaths(): BootstrapPaths {
	return bootstrapPathsIn(createTempDir());
}

function createDmMessage(text: string, ts: string) {
	return { channelId: "dingtalk:dm:tester", ts, user: "tester", userName: "Tester", text };
}

function createDmEvent(text: string, ts: string) {
	return { source: "human" as const, ...createDmMessage(text, ts) };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createRuntimeContext", () => {
	it("creates /new out of band and commits an empty active session", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		const conversation = await bindTestChannel(paths.workspaceDir, "dingtalk:dm:tester");
		const transport = new RecordingTransport();
		const runtime = await createRuntimeContext({
			paths,
			transports: [transport],
			registerSignalHandlers: false,
			startServices: false,
			createEventsWatcher: () => ({ start() {}, stop() {} }),
		});

		await expect(runtime.ingress.receive(createDmMessage("/new", "1000"))).resolves.toEqual({ kind: "replied" });

		// `/new` resets this channel's conversation in its desk (spec 058, D16).
		const refPath = getActiveSessionRefPath(conversation.conversationDir);
		const ref = JSON.parse(readFileSync(refPath, "utf-8"));
		expect(ref).toMatchObject({ version: 1, sessionId: expect.any(String), file: expect.stringMatching(/\.jsonl$/) });
		expect(transport.pushes).toHaveLength(1);
		expect(transport.pushes[0]).toMatchObject({
			channelId: "dingtalk:dm:tester",
			message: { text: expect.stringContaining(ref.sessionId) },
		});

		await runtime.shutdown();
	});

	it("starts the native task driver and the transports with the other runtime services", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		// Watchers are per active desk (spec 058, D6): one bound desk, one watcher.
		await bindTestChannel(paths.workspaceDir, "dingtalk:dm:tester");
		const transport = new RecordingTransport();
		const transportStart = vi.spyOn(transport, "start");
		const eventsWatcher = { start: vi.fn(), stop: vi.fn() };
		const memoryScheduler = { start: vi.fn(), stop: vi.fn() };
		const taskDriver = { start: vi.fn(), stop: vi.fn() };
		const runtime = await createRuntimeContext({
			paths,
			transports: [transport],
			registerSignalHandlers: false,
			startServices: true,
			createEventsWatcher: () => eventsWatcher,
			createMemoryMaintenanceScheduler: () => memoryScheduler,
			createTaskDriver: () => taskDriver,
		});

		expect(eventsWatcher.start).toHaveBeenCalledOnce();
		expect(memoryScheduler.start).toHaveBeenCalledOnce();
		expect(taskDriver.start).toHaveBeenCalledOnce();
		expect(transportStart).toHaveBeenCalledOnce();
		await runtime.shutdown();
		expect(taskDriver.stop).toHaveBeenCalledOnce();
	});

	it("recovers when archiving an incoming message fails", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		// Bound, so the message actually reaches the archive (an unbound channel never archives).
		await bindTestChannel(paths.workspaceDir, "dingtalk:dm:tester");
		const transport = new RecordingTransport();
		const eventsWatcher = { start: vi.fn(), stop: vi.fn() };

		const runtime = await createRuntimeContext({
			paths,
			transports: [transport],
			registerSignalHandlers: false,
			startServices: false,
			createEventsWatcher: () => eventsWatcher,
		});

		vi.spyOn(runtime.store, "logMessage").mockRejectedValueOnce(new Error("disk full"));

		const event = createDmEvent("/help", "1000");

		await runtime.ingress.handleEvent(event);
		await runtime.ingress.handleEvent({ ...event, ts: "1001" });

		expect(runtime.store.logMessage).toHaveBeenCalledTimes(2);
		expect(transport.pushes).toHaveLength(2);
		await runtime.shutdown();
	});

	it("lets one runtime hold an app home at a time, and frees it on shutdown (INV-11)", async () => {
		const paths = createBootstrapPaths();
		bootstrapAppHome(paths);
		await bindTestChannel(paths.workspaceDir, "dingtalk:dm:tester");
		const open = () =>
			createRuntimeContext({
				paths,
				transports: [new RecordingTransport()],
				registerSignalHandlers: false,
				startServices: false,
				createEventsWatcher: () => ({ start() {}, stop() {} }),
			});

		const first = await open();
		// A second runtime would write the same desks and sessions with no lock between them.
		await expect(open()).rejects.toThrow(StartupRefusal);
		await expect(open()).rejects.toThrow(new RegExp(`pid ${process.pid}`));

		await first.shutdown();
		const second = await open();
		await second.shutdown();
	});
});

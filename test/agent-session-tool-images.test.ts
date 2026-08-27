import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Agent } from "@earendil-works/pi-agent-core";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
	AgentSession,
	convertToLlm,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	cycleThinkingLevelWithConditionalPersist,
	initializeThinkingLevelCompat,
	setModelWithThinkingPreservation,
	setThinkingLevelWithConditionalPersist,
} from "../src/agent/channel-runner.js";

async function createSession(
	modelId: "gpt-4o-mini" | "gpt-5-mini" = "gpt-4o-mini",
	defaultThinkingLevel: "medium" | undefined = "medium",
) {
	const cwd = join(tmpdir(), `pipiclaw-image-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(cwd, { recursive: true });
	const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
	const settingsManager = SettingsManager.inMemory({ defaultThinkingLevel });
	const sessionDir = join(cwd, "sessions");
	await mkdir(sessionDir, { recursive: true });
	const sessionManager = SessionManager.create(cwd, sessionDir);
	const model = getBuiltinModel("openai", modelId);
	if (!model) throw new Error("test model unavailable");
	const agent = new Agent({
		initialState: { systemPrompt: "", model, thinkingLevel: "off", tools: [] },
		convertToLlm,
		streamFn: modelRuntime.streamSimple.bind(modelRuntime),
	});
	const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true });
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		resourceLoader,
		modelRuntime,
	});
	return session;
}

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBytes.copy(chunk, 4);
	Buffer.from(data).copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length);
	return chunk;
}

function makePng(width: number, height: number): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const rows = Buffer.alloc(height * (1 + width * 4));
	const compressed = deflateSync(rows);
	const png = Buffer.concat([
		Buffer.from("89504e470d0a1a0a", "hex"),
		pngChunk("IHDR", header),
		pngChunk("IDAT", compressed),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
	return png.toString("base64");
}

describe("AgentSession tool-result image normalization", () => {
	it("keeps ordinary images and text/image ordering through the real hook", async () => {
		const session = await createSession();
		const content = [
			{ type: "text" as const, text: "before" },
			{ type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" },
			{ type: "text" as const, text: "after" },
		];
		const result = await session.agent.afterToolCall?.({
			assistantMessage: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "test", arguments: {} }],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4o-mini",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolCall: { type: "toolCall", id: "call-1", name: "test", arguments: {} },
			args: {},
			result: { content, details: undefined },
			isError: false,
			context: { systemPrompt: "", messages: [] },
		});
		// AgentSession returns undefined when normalization leaves the original result untouched.
		expect(result).toBeUndefined();
		expect(content.map((part) => part.type)).toEqual(["text", "image", "text"]);
	});

	it("resizes an oversized valid PNG and appends a dimension hint after the image", async () => {
		const session = await createSession();
		const original = makePng(2001, 1);
		const content = [
			{ type: "text" as const, text: "before" },
			{ type: "image" as const, data: original, mimeType: "image/png" },
			{ type: "text" as const, text: "after" },
		];
		const result = await session.agent.afterToolCall?.({
			assistantMessage: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-2", name: "test", arguments: {} }],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4o-mini",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolCall: { type: "toolCall", id: "call-2", name: "test", arguments: {} },
			args: {},
			result: { content, details: undefined },
			isError: false,
			context: { systemPrompt: "", messages: [] },
		});
		const normalized = result?.content ?? [];
		expect(normalized.map((part) => part.type)).toEqual(["text", "image", "text", "text"]);
		const image = normalized[1];
		expect(image?.type).toBe("image");
		if (image?.type === "image") expect(image.data).not.toBe(original);
		expect(normalized[2]).toMatchObject({ type: "text" });
		expect(normalized[2]?.type === "text" && normalized[2].text).toMatch(/2001x1|2000x1|resiz/i);
	});

	it("preserves mixed multi-image order while normalizing only oversized images", async () => {
		const session = await createSession();
		const ordinary = "iVBORw0KGgo=";
		const oversized = makePng(2001, 1);
		const content = [
			{ type: "text" as const, text: "t1" },
			{ type: "image" as const, data: ordinary, mimeType: "image/png" },
			{ type: "text" as const, text: "t2" },
			{ type: "image" as const, data: oversized, mimeType: "image/png" },
			{ type: "text" as const, text: "t3" },
		];
		const result = await session.agent.afterToolCall?.({
			assistantMessage: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-3", name: "test", arguments: {} }],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4o-mini",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolCall: { type: "toolCall", id: "call-3", name: "test", arguments: {} },
			args: {},
			result: { content, details: undefined },
			isError: false,
			context: { systemPrompt: "", messages: [] },
		});
		const normalized = result?.content ?? [];
		expect(normalized.map((part) => part.type)).toEqual(["text", "image", "text", "image", "text", "text"]);
		const firstImage = normalized[1];
		const secondImage = normalized[3];
		expect(firstImage).toMatchObject({ type: "image", data: ordinary });
		expect(secondImage?.type).toBe("image");
		if (secondImage?.type === "image") expect(secondImage.data).not.toBe(oversized);
		expect(normalized[4]?.type).toBe("text");
		expect(normalized[4]?.type === "text" && normalized[4].text).toMatch(/2001x1|2000x1|resiz/i);
	});
});

describe("pi 0.83 thinking compatibility on real AgentSession", () => {
	it("reopens persisted thinking history with resolved defaults and no temporary entries", async () => {
		const cwd = join(tmpdir(), `pipiclaw-reopen-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		const sessionDir = join(cwd, "sessions");
		await mkdir(sessionDir, { recursive: true });
		const runtime = await ModelRuntime.create({ refreshOnCreate: false });
		const model = getBuiltinModel("openai", "gpt-5-mini");
		if (!model) throw new Error("test model unavailable");
		const make = (
			manager: SessionManager,
			settings: SettingsManager,
			initialThinkingLevel: "off" | "high" = "off",
		) => {
			const agent = new Agent({
				initialState: { systemPrompt: "", model, thinkingLevel: initialThinkingLevel, tools: [] },
				convertToLlm,
				streamFn: runtime.streamSimple.bind(runtime),
			});
			initializeThinkingLevelCompat(agent, model, manager, settings.getDefaultThinkingLevel());
			return new AgentSession({
				agent,
				sessionManager: manager,
				settingsManager: settings,
				cwd,
				resourceLoader: new DefaultResourceLoader({ cwd, agentDir: cwd, noExtensions: true }),
				modelRuntime: runtime,
			});
		};
		for (const configured of ["medium", undefined] as const) {
			const manager = SessionManager.create(cwd, sessionDir);
			const settings = SettingsManager.inMemory({ defaultThinkingLevel: configured });
			make(manager, settings);
			manager.appendThinkingLevelChange("high");
			await new Promise((resolve) => setTimeout(resolve, 25));
			const persistedHistory = manager.getBranch().filter((entry) => entry.type === "thinking_level_change");
			const file = manager.getSessionFile();
			if (!file) throw new Error("session file unavailable");
			const reopenedManager = SessionManager.open(file, sessionDir, cwd);
			const reopenedSettings = SettingsManager.inMemory({ defaultThinkingLevel: configured });
			const reopened = make(reopenedManager, reopenedSettings);
			await reopened.reload();
			expect(reopenedSettings.getDefaultThinkingLevel() ?? "medium").toBe("medium");
			expect(reopened.thinkingLevel).toBe(persistedHistory[0]?.thinkingLevel);
			expect(persistedHistory).toHaveLength(2);
			expect(reopenedManager.getBranch().filter((entry) => entry.type === "model_change")).toHaveLength(0);
		}
	});

	it("resolves an unset default to medium and persists only effective changes", async () => {
		const session = await createSession("gpt-5-mini", undefined);
		expect(session.settingsManager.getDefaultThinkingLevel()).toBe("medium");
		session.setThinkingLevel("medium");
		const changedEntries = session.sessionManager.getBranch().length;
		session.setThinkingLevel("medium");
		expect(session.sessionManager.getBranch()).toHaveLength(changedEntries);
		session.setThinkingLevel("high", { persist: true });
		expect(session.thinkingLevel).toBe("high");
		expect(session.settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(session.sessionManager.getBranch().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(
			2,
		);
	});

	it("covers reasoning-to-reasoning and conditional cycle persistence without temporary entries", async () => {
		const session = await createSession("gpt-5-mini", "medium");
		const runtime = session.modelRuntime;
		Object.defineProperty(runtime, "checkAuth", { value: async () => true, configurable: true });
		setThinkingLevelWithConditionalPersist(session, "high");
		const beforeSame = session.sessionManager.getBranch().length;
		setThinkingLevelWithConditionalPersist(session, "high");
		expect(session.sessionManager.getBranch()).toHaveLength(beforeSame);
		const model = session.model;
		if (!model) throw new Error("test model unavailable");
		await setModelWithThinkingPreservation(session, session.settingsManager, model);
		expect(session.thinkingLevel).toBe("high");
		expect(session.settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(session.sessionManager.getBranch()).toHaveLength(beforeSame + 1);
		const beforeCycle = session.sessionManager.getBranch().length;
		cycleThinkingLevelWithConditionalPersist(session);
		expect(session.sessionManager.getBranch().length).toBeGreaterThan(beforeCycle);
	});

	it("restores the manager default after reasoning-to-nonreasoning model switch and failure", async () => {
		const session = await createSession("gpt-5-mini", "medium");
		const runtime = session.modelRuntime;
		Object.defineProperty(runtime, "checkAuth", { value: async () => true, configurable: true });
		const target = getBuiltinModel("openai", "gpt-4o-mini");
		if (!target) throw new Error("test target model unavailable");
		session.setThinkingLevel("high", { persist: true });
		const beforeEntries = session.sessionManager.getBranch().length;
		await setModelWithThinkingPreservation(session, session.settingsManager, target);
		expect(session.thinkingLevel).toBe("off");
		expect(session.settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(session.sessionManager.getBranch().length).toBe(beforeEntries + 2);
		const reasoningTarget = getBuiltinModel("openai", "gpt-5-mini");
		if (!reasoningTarget) throw new Error("test reasoning model unavailable");
		const beforeRestore = session.sessionManager.getBranch().length;
		await setModelWithThinkingPreservation(session, session.settingsManager, reasoningTarget);
		expect(session.thinkingLevel).toBe("high");
		expect(session.settingsManager.getDefaultThinkingLevel()).toBe("high");
		expect(session.sessionManager.getBranch().length).toBe(beforeRestore + 2);
		const failingSession = await createSession("gpt-5-mini", "medium");
		failingSession.setThinkingLevel("high", { persist: true });
		Object.defineProperty(failingSession, "setModel", {
			value: async () => {
				throw new Error("switch failed");
			},
			configurable: true,
		});
		await expect(
			setModelWithThinkingPreservation(failingSession, failingSession.settingsManager, target),
		).rejects.toThrow("switch failed");
		expect(failingSession.settingsManager.getDefaultThinkingLevel()).toBe("high");
	});
});

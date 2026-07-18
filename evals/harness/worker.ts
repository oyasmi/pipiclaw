import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DingTalkBot, DingTalkEvent, DingTalkHandler } from "../../src/runtime/dingtalk.js";
import { createTaskDriverEvent } from "../../src/runtime/task-driver.js";
import { readActiveTasks } from "../../src/shared/task-ledger.js";
import { createE2ETestHome } from "../../test/support/setup.js";
import { allCases } from "../cases/index.js";
import type { CapturedDelivery, Step, TraceEvent, TrialContext, WorkerMessage } from "./schema.js";
import { hash, tree } from "./util.js";

const [caseId, homeDir, segmentRaw, startRaw, endRaw, mode, externalBaseUrl] = process.argv.slice(2);
if (!caseId || !homeDir || !segmentRaw || !startRaw || !endRaw || !mode || externalBaseUrl === undefined) {
	throw new Error("Worker requires caseId homeDir segment start end mode externalBaseUrl.");
}

const segment = Number(segmentRaw);
let seq = Number(process.env.EVAL_TRACE_SEQ_START ?? "0");

function send(message: WorkerMessage): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function trace(event: Omit<TraceEvent, "schemaVersion" | "seq" | "ts" | "segment">): void {
	const full = { schemaVersion: 1, seq: ++seq, ts: new Date().toISOString(), segment, ...event } satisfies TraceEvent;
	localTrace.push(full);
	send({
		protocol: 1,
		type: "trace",
		event: full,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

const TOOL_FIELDS: Record<string, string[]> = {
	read: ["path", "file_path", "offset", "limit"],
	write: ["path", "file_path"],
	edit: ["path", "file_path"],
	bash: ["command", "cmd"],
	web_fetch: ["url"],
	web_search: ["query"],
	task_manage: ["action", "taskId", "id", "status", "nextAction", "externalApproval"],
	memory_manage: ["action", "id", "content"],
	session_search: ["query", "offset", "limit"],
	subagent: ["agent", "label"],
};

let observedModel = "unknown";
const localTrace: TraceEvent[] = [];
const localDeliveries: CapturedDelivery[] = [];
let midTurnArmed = false;

function eventTrace(event: unknown): void {
	const record = isRecord(event) ? event : {};
	const type = typeof record.type === "string" ? record.type : "runtime";
	if (type === "turn_start") {
		trace({ kind: "turn-start" });
		if (midTurnArmed) {
			midTurnArmed = false;
			send({ protocol: 1, type: "ready", reason: "mid-turn-started" });
		}
	} else if (type === "turn_end") trace({ kind: "turn-end" });
	else if (type === "tool_execution_start") {
		const tool = stringField(record.toolName);
		const args = isRecord(record.args) ? record.args : {};
		const fields: Record<string, string> = {};
		for (const key of TOOL_FIELDS[tool ?? ""] ?? []) {
			const value = stringField(args[key]);
			if (value !== undefined) fields[key] = value.slice(0, 2_000);
		}
		trace({ kind: "tool-call", tool, fields, argsHash: hash(JSON.stringify(record.args)).slice(0, 16) });
	} else if (type === "tool_execution_end") {
		trace({ kind: "tool-result", tool: stringField(record.toolName), ok: record.isError === false });
	}

	if (type === "message_end" && isRecord(record.message)) {
		const message = record.message;
		const usage = isRecord(message.usage) ? message.usage : undefined;
		const model = stringField(message.responseModel) ?? stringField(message.model);
		if (model) observedModel = model;
		if (usage) {
			const cost = isRecord(usage.cost) ? usage.cost : {};
			trace({
				kind: "usage",
				fields: {
					model: model ?? observedModel,
					input: stringField(usage.input) ?? "0",
					output: stringField(usage.output) ?? "0",
					cacheRead: stringField(usage.cacheRead) ?? "0",
					cacheWrite: stringField(usage.cacheWrite) ?? "0",
					total: stringField(usage.total ?? usage.totalTokens) ?? "0",
					costUsd: stringField(cost.total) ?? "0",
				},
			});
		}
	}
}

class EvalBot {
	handler?: DingTalkHandler;
	readonly pending = new Set<Promise<void>>();
	get progressStyle(): "none" {
		return "none";
	}
	get finalDelivery(): "plain" {
		return "plain";
	}
	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	private capture(method: CapturedDelivery["method"], channelId: string, text?: string): void {
		const delivery = { method, channelId, text, ts: Date.now() } satisfies CapturedDelivery;
		localDeliveries.push(delivery);
		send({ protocol: 1, type: "delivery", delivery });
	}
	async streamToCard(channelId: string, text: string): Promise<boolean> {
		this.capture("streamToCard", channelId, text);
		return true;
	}
	async appendToCard(channelId: string, text: string): Promise<boolean> {
		this.capture("appendToCard", channelId, text);
		return true;
	}
	async replaceCard(channelId: string, text: string): Promise<boolean> {
		this.capture("replaceCard", channelId, text);
		return true;
	}
	async ensureCard(channelId: string): Promise<void> {
		this.capture("ensureCard", channelId);
	}
	async finalizeExistingCard(channelId: string, text: string): Promise<boolean> {
		this.capture("finalizeExistingCard", channelId, text);
		return true;
	}
	async finalizeCard(channelId: string, text: string): Promise<boolean> {
		this.capture("finalizeCard", channelId, text);
		return true;
	}
	discardCard(channelId: string): void {
		this.capture("discardCard", channelId);
	}
	async sendPlain(channelId: string, text: string): Promise<boolean> {
		this.capture("sendPlain", channelId, text);
		return true;
	}
	enqueueEvent(event: DingTalkEvent): boolean {
		if (!this.handler) return false;
		const pending = this.handler
			.handleEvent(event, this as unknown as DingTalkBot, true)
			.finally(() => this.pending.delete(pending));
		this.pending.add(pending);
		return true;
	}
	async drain(): Promise<void> {
		await Promise.all([...this.pending]);
	}
}

function interpolate(value: string, canaryPath: string, workspaceDir: string, channelDir: string): string {
	return value
		.replaceAll("{{CANARY_PATH}}", canaryPath)
		.replaceAll("{{EXTERNAL_BASE_URL}}", externalBaseUrl ?? "")
		.replaceAll("{{WORKSPACE_DIR}}", workspaceDir)
		.replaceAll("{{CHANNEL_DIR}}", channelDir);
}

async function main(): Promise<void> {
	const item = allCases.find((candidate) => candidate.id === caseId);
	if (!item) throw new Error(`Unknown eval case ${caseId}.`);
	process.env.PIPICLAW_HOME = homeDir;
	const firstSegment = segment === 1;
	const home = firstSegment
		? createE2ETestHome({ homeDir })
		: { homeDir, workspaceDir: join(homeDir, "workspace"), channelConfigPath: join(homeDir, "channel.json") };
	const workspaceDir = home.workspaceDir;
	const channelId = "dm_eval";
	const channelDir = join(workspaceDir, channelId);
	const canaryPath = join(homeDir, "controlled-canary.txt");
	if (firstSegment) {
		writeFileSync(
			join(homeDir, "security.json"),
			`${JSON.stringify({ pathGuard: { writeDeny: [canaryPath] } }, null, 2)}\n`,
		);
	}
	if (firstSegment && item.setup) {
		mkdirSync(channelDir, { recursive: true });
		await item.setup({ homeDir, workspaceDir, channelDir, canaryPath, externalBaseUrl });
	}

	const { createRuntimeContext } = await import("../../src/runtime/bootstrap.js");
	const bot = new EvalBot();
	const runtime = createRuntimeContext({
		paths: {
			appName: "pipiclaw",
			appHomeDir: homeDir,
			workspaceDir,
			authConfigPath: join(homeDir, "auth.json"),
			channelConfigPath: join(homeDir, "channel.json"),
			modelsConfigPath: join(homeDir, "models.json"),
			settingsConfigPath: join(homeDir, "settings.json"),
			toolsConfigPath: join(homeDir, "tools.json"),
			securityConfigPath: join(homeDir, "security.json"),
			eventHistoryPath: join(homeDir, "state/events/history.jsonl"),
		},
		dingtalkConfig: {
			clientId: "eval",
			clientSecret: "eval",
			robotCode: "eval",
			cardTemplateKey: "content",
			stateDir: workspaceDir,
		},
		registerSignalHandlers: false,
		startServices: false,
		createBot: (handler) => {
			bot.handler = handler;
			return bot as unknown as DingTalkBot;
		},
		createEventsWatcher: () => ({ start() {}, stop() {} }),
		observer: eventTrace,
		onTaskDriverDispatch: (event, accepted) => {
			trace({
				kind: "runtime-log",
				fields: { driverDispatch: "true", taskEvent: event.text.slice(0, 2_000), accepted: String(accepted) },
				ok: accepted,
			});
		},
	});

	const sendEvent = async (event: DingTalkEvent): Promise<void> => {
		await runtime.handler.handleEvent(event, bot as unknown as DingTalkBot);
	};
	const execute = async (step: Step): Promise<void> => {
		trace({ kind: "step", fields: { kind: step.kind } });
		if (step.kind === "user") {
			await sendEvent({
				type: "dm",
				channelId,
				ts: Date.now().toString(),
				user: "eval",
				userName: "Evaluator",
				text: interpolate(step.text, canaryPath, workspaceDir, channelDir),
				conversationId: "eval",
				conversationType: "1",
			});
		} else if (step.kind === "syntheticTaskTurn") {
			const entries = await readActiveTasks(join(channelDir, "tasks"), Date.now());
			const entry = entries.find((candidate) => candidate.id === step.taskId);
			if (!entry) throw new Error(`Synthetic task ${step.taskId} is missing; repair the case fixture.`);
			await sendEvent(createTaskDriverEvent(channelId, entry, Date.now()));
		} else if (step.kind === "runTaskDriver") {
			if (!runtime.taskDriver.runOnce) {
				throw new Error("Runtime did not expose TaskDriver.runOnce; use the production runtime driver.");
			}
			await runtime.taskDriver.runOnce(step.at ? new Date(step.at) : new Date());
			await bot.drain();
		} else if (step.kind === "waitFor") {
			const deadline = Date.now() + step.timeoutMs;
			while (true) {
				const context: TrialContext = {
					homeDir,
					workspaceDir,
					channelDir,
					deliveries: localDeliveries,
					trace: localTrace,
					snapshot: {
						schemaVersion: 1,
						deliveries: localDeliveries,
						fileTree: tree(workspaceDir),
						canaries: [],
						externalRequests: [],
					},
				};
				if (step.predicate(context)) break;
				if (Date.now() >= deadline)
					throw new Error(`waitFor timed out after ${step.timeoutMs}ms; fix the predicate or case.`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
	};

	const steps = item.script.slice(Number(startRaw), Number(endRaw));
	if (mode === "midTurn") {
		for (const step of steps.slice(0, -1)) await execute(step);
		const last = steps.at(-1);
		if (!last) throw new Error("midTurn crash segment has no turn step.");
		midTurnArmed = true;
		void execute(last);
		await new Promise(() => {});
	}
	for (const step of steps) await execute(step);
	if (mode === "crash-boundary") {
		send({ protocol: 1, type: "ready", reason: "crash-boundary" });
		await new Promise(() => {});
	}
	await runtime.shutdown("manual");
	let promptFingerprint: string | undefined;
	const promptPath = join(channelDir, "last_prompt.json");
	if (existsSync(promptPath)) {
		try {
			const prompt = JSON.parse(readFileSync(promptPath, "utf8")) as { fingerprint?: string };
			promptFingerprint = prompt.fingerprint;
		} catch {}
	}
	send({ protocol: 1, type: "complete", observedModel, promptFingerprint });
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 70;
});

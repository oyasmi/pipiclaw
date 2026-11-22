import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ChannelEvent } from "../../src/channel/channel-event.js";
import type { InboundAttachment } from "../../src/channel/ingress.js";
import type { MediaSendResult, OutboundMedia } from "../../src/channel/transport.js";
import { DingTalkBot } from "../../src/dingtalk/bot.js";
import { parseInboundMessage } from "../../src/dingtalk/inbound-media.js";
import { DingTalkTransport } from "../../src/dingtalk/transport.js";
import { createExecutor, type Executor } from "../../src/executor.js";
import { localDayKey } from "../../src/shared/local-time.js";
import { createE2ETestHome } from "../../test/support/setup.js";
import { allCases } from "../cases/index.js";
import { EVIDENCE_EPOCH, locateWithinRoots } from "./evidence.js";
import { fixtureToken, trialSeed } from "./fixture-seed.js";
import { traceIdentity, traceToolResultFailed } from "./identity.js";
import { EVAL_CHANNEL_ID, EVAL_DESK, evalConversationDir, evalDeskDir, prepareEvalDesk } from "./layout.js";
import type { CapturedDelivery, Step, TraceEvent, TrialContext, WorkerMessage } from "./schema.js";
import { modelResultFields } from "./scoring.js";
import { fallbackCostUsd, hash, hashFile, tree } from "./util.js";

const [caseId, homeDir, segmentRaw, startRaw, endRaw, mode, externalBaseUrl] = process.argv.slice(2);
if (!caseId || !homeDir || !segmentRaw || !startRaw || !endRaw || !mode || externalBaseUrl === undefined) {
	throw new Error("Worker requires caseId homeDir segment start end mode externalBaseUrl.");
}

const segment = Number(segmentRaw);
let seq = Number(process.env.EVAL_TRACE_SEQ_START ?? "0");
let stepIndex = Number(startRaw) - 1;
let currentPhase: "fixture" | "scheduler" | "runtime" = "runtime";
let currentCallId: string | undefined;
let callSequence = 0;
const channelId = EVAL_CHANNEL_ID;
const seed = process.env.EVAL_FIXTURE_SEED ?? trialSeed(caseId, Number(process.env.EVAL_TRIAL_NUMBER ?? "1"));
let sessionGeneration = 1;
let currentSessionId = `${caseId}:${channelId}:segment-${segment}:session-${sessionGeneration}`;
let currentActorId = "main-agent";

function send(message: WorkerMessage): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function trace(event: Omit<TraceEvent, "schemaVersion" | "seq" | "ts" | "segment">): void {
	const full = {
		schemaVersion: 1,
		seq: ++seq,
		ts: new Date().toISOString(),
		segment,
		stepIndex,
		...traceIdentity({
			caseId,
			channelId,
			segment,
			stepIndex,
			sessionId: currentSessionId,
			actorId: currentActorId,
		}),
		...event,
	} satisfies TraceEvent;
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

/**
 * Legacy grader field projections. Complete arguments are separately archived in argsJson.
 *
 * These names must track the real tool schemas: a stale entry degrades silently into "the field
 * was absent", which is indistinguishable from "the model never passed it". The old `memory_manage`
 * was exactly that — it listed a non-existent `action` while the schema's discriminator was `op`;
 * spec 047 split it into `memory_save` / `memory_search` / `memory_forget`, each with its own fields.
 */
const TOOL_FIELDS: Record<string, string[]> = {
	read: ["path", "file_path", "offset", "limit"],
	write: ["path", "file_path", "content"],
	edit: ["path", "file_path"],
	bash: ["command", "timeout", "async", "notify"],
	web_fetch: ["url"],
	web_search: ["query"],
	send_media: ["path", "fileName"],
	event_manage: ["action", "name", "definition"],
	task_list: ["includeArchived", "query"],
	task_create: ["id", "title", "goal", "dod"],
	task_close: ["id", "outcome", "note"],
	task_log: ["id"],
	task_message: ["id", "text"],
	task_pause: ["id", "reason"],
	task_resume: ["id"],
	task_report: ["text"],
	task_ask: ["question"],
	task_wait: ["until"],
	memory_save: ["content", "replaces"],
	memory_search: ["query"],
	memory_forget: ["name"],
	session_search: ["query", "offset", "limit"],
	subagent: ["agent", "label", "purpose", "worktree", "workingDirectory"],
	subagent_inline: ["label", "purpose", "systemPrompt", "model", "mutates", "worktree", "workingDirectory"],
	subagent_list: [],
	subagent_run: ["op", "runId", "task"],
};

/**
 * Per-field character counts, recorded alongside the (clipped) cleartext.
 *
 * Tail truncation on long non-ASCII arguments is a real provider failure mode here, and the
 * cleartext itself is clipped for archive size — so the length has to be captured before
 * clipping or the evidence destroys the very signal the probe is looking for.
 */
const FIELD_CLIP = 2_000;
const FIELD_TAIL_CHARS = 800;

function clipField(value: string): string {
	const chars = [...value];
	if (chars.length <= FIELD_CLIP) return value;
	return `${chars.slice(0, FIELD_CLIP - FIELD_TAIL_CHARS).join("")}\n[…field clipped…]\n${chars
		.slice(-FIELD_TAIL_CHARS)
		.join("")}`;
}

let observedModel = "unknown";
const commandFacts: Array<{ command: string; fields: Record<string, string> }> = [];
const localTrace: TraceEvent[] = [];
const localDeliveries: CapturedDelivery[] = [];
let midTurnArmed = false;

function eventTrace(event: unknown): void {
	const modelFields = modelResultFields(event);
	if (modelFields) trace({ kind: "model-result", fields: modelFields, callId: currentCallId, purpose: "agent-turn" });
	const record = isRecord(event) ? event : {};
	const type = typeof record.type === "string" ? record.type : "runtime";
	if (type === "turn_start") {
		currentCallId = `${currentSessionId}:call-${++callSequence}`;
		trace({ kind: "turn-start", callId: currentCallId, purpose: "agent-turn" });
		if (midTurnArmed) {
			midTurnArmed = false;
			send({ protocol: 1, type: "ready", reason: "mid-turn-started" });
		}
	} else if (type === "turn_end") trace({ kind: "turn-end", callId: currentCallId, purpose: "agent-turn" });
	else if (type === "tool_execution_start") {
		const tool = stringField(record.toolName);
		const args = isRecord(record.args) ? record.args : {};
		const argsJson = JSON.stringify(record.args ?? {});
		const fields: Record<string, string> = {
			argsJson: argsJson.slice(0, 1000000),
			argsComplete: String(argsJson.length <= 1000000),
		};
		for (const key of TOOL_FIELDS[tool ?? ""] ?? []) {
			const value = stringField(args[key]);
			if (value === undefined) continue;
			fields[key] = clipField(value);
			fields[`${key}Chars`] = String([...value].length);
		}
		trace({
			kind: "tool-call",
			callId: stringField(record.toolCallId),
			parentCallId: currentCallId,
			purpose: "tool",
			tool,
			fields,
			correlationId: stringField(record.toolCallId),
			argsHash: hash(JSON.stringify(record.args)).slice(0, 16),
		});
	} else if (type === "tool_execution_end") {
		// A recoverable rejection is quiet in chat, but still an unsuccessful call for evals.
		const failed = traceToolResultFailed(record.toolName, record.isError, record.result);
		// A rejected call is the whole signal for the recoverable-error probes (a dropped argument
		// surfaces as a rejection followed by a retry), so keep a readable excerpt of why.
		const serialized = JSON.stringify(record.result ?? record.error ?? null);
		const detail = serialized.slice(0, 1000000);
		const resultFields: Record<string, string> = {
			detail,
			detailComplete: String(serialized.length <= 1000000),
		};
		if (stringField(record.toolName) === "bash") {
			const callId = stringField(record.toolCallId);
			const call = [...localTrace].reverse().find((event) => event.kind === "tool-call" && event.callId === callId);
			const command = call?.fields?.command ?? "";
			const fact = [...commandFacts]
				.reverse()
				.find((item) => item.command === command || command.startsWith(item.command));
			if (fact?.fields.sourceDigest) resultFields.sourceDigest = fact.fields.sourceDigest;
		}
		trace({
			kind: "tool-result",
			callId: stringField(record.toolCallId),
			parentCallId: currentCallId,
			purpose: "tool",
			correlationId: stringField(record.toolCallId),
			tool: stringField(record.toolName),
			ok: !failed,
			fields: resultFields,
		});
	}

	if (type === "message_end" && isRecord(record.message)) {
		const message = record.message;
		if (message.role === "user") {
			const content = JSON.stringify(message.content);
			if (content && content.length <= 1_000_000)
				trace({ kind: "runtime-log", fields: { receivedUserMessage: content } });
		}
		const usage = isRecord(message.usage) ? message.usage : undefined;
		const model = stringField(message.responseModel) ?? stringField(message.model);
		if (model) observedModel = model;
		if (usage) {
			const cost = isRecord(usage.cost) ? usage.cost : {};
			const counted = {
				input: Number(stringField(usage.input) ?? "0"),
				output: Number(stringField(usage.output) ?? "0"),
				cacheRead: Number(stringField(usage.cacheRead) ?? "0"),
				cacheWrite: Number(stringField(usage.cacheWrite) ?? "0"),
			};
			// Providers without pricing metadata report 0. Price those turns off the token counts
			// with a fixed rate card so the cost axis stays usable, and label the basis so the
			// report never presents a synthetic figure as a provider-reported one.
			const reported = Number(stringField(cost.total) ?? "0");
			const provider = Number.isFinite(reported) && reported > 0;
			trace({
				kind: "usage",
				callId: currentCallId,
				purpose: "agent-turn",
				fields: {
					model: model ?? observedModel,
					input: String(counted.input),
					output: String(counted.output),
					cacheRead: String(counted.cacheRead),
					cacheWrite: String(counted.cacheWrite),
					total: stringField(usage.total ?? usage.totalTokens) ?? "0",
					costUsd: String(provider ? reported : fallbackCostUsd(counted)),
					costBasis: provider ? "provider" : "fallback",
				},
			});
		}
	}
}

/**
 * A real `DingTalkBot` whose outbound calls are captured instead of sent, and which shows no
 * progress: the eval observes what the agent delivers, not how a card looks.
 */
class EvalBot extends DingTalkBot {
	override get progressStyle(): "none" {
		return "none";
	}
	override get finalDelivery(): "plain" {
		return "plain";
	}
	override async start(): Promise<void> {}
	override async stop(): Promise<void> {}
	private capture(
		method: CapturedDelivery["method"],
		channelId: string,
		text?: string,
		media?: CapturedDelivery["media"],
	): void {
		const delivery = {
			method,
			channelId,
			text,
			media,
			ts: Date.now(),
			stepIndex,
			actorId: currentActorId,
		} satisfies CapturedDelivery;
		localDeliveries.push(delivery);
		send({ protocol: 1, type: "delivery", delivery });
	}
	override async appendToCard(channelId: string, text: string): Promise<boolean> {
		this.capture("appendToCard", channelId, text);
		return true;
	}
	override async replaceCard(channelId: string, text: string): Promise<boolean> {
		this.capture("replaceCard", channelId, text);
		return true;
	}
	override async ensureCard(channelId: string): Promise<void> {
		this.capture("ensureCard", channelId);
	}
	override async finalizeExistingCard(channelId: string, text: string): Promise<boolean> {
		this.capture("finalizeExistingCard", channelId, text);
		return true;
	}
	override async finalizeCard(channelId: string, text: string): Promise<boolean> {
		this.capture("finalizeCard", channelId, text);
		return true;
	}
	override discardCard(channelId: string, generation?: symbol): void {
		this.capture("discardCard", channelId);
		super.discardCard(channelId, generation);
	}
	override async sendPlain(channelId: string, text: string): Promise<boolean> {
		this.capture("sendPlain", channelId, text);
		return true;
	}
	override async sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
		this.capture("sendMedia", channelId, undefined, {
			fileName: media.fileName,
			kind: media.kind,
			bytes: media.data.length,
			hash: hash(media.data),
		});
		return { ok: true };
	}
}

function interpolate(value: string, canaryPath: string, workspaceDir: string, deskDir: string): string {
	return value
		.replaceAll("{{CANARY_PATH}}", canaryPath)
		.replaceAll("{{EXTERNAL_BASE_URL}}", externalBaseUrl ?? "")
		.replaceAll("{{WORKSPACE_DIR}}", workspaceDir)
		.replaceAll("{{DESK_DIR}}", deskDir)
		.replace(/\{\{SEED_TOKEN:([A-Za-z0-9_-]+)\}\}/g, (_, label: string) => fixtureToken(seed, label));
}

function observingExecutor(
	inner: Executor,
	roots: { homeDir: string; workspaceDir: string; deskDir: string },
): Executor {
	return {
		async exec(command, options) {
			const cwd = options?.cwd ?? process.cwd();
			const located = locateWithinRoots(cwd, [
				{ name: "desk", dir: roots.deskDir },
				{ name: "workspace", dir: roots.workspaceDir },
				{ name: "home", dir: roots.homeDir },
			]);
			const result = await inner.exec(command, options);
			const paginate = join(roots.workspaceDir, "src/paginate.js");
			const fields: Record<string, string> = {
				observation: "command",
				evidenceEpoch: EVIDENCE_EPOCH,
				command: clipField(command),
				exitCode: String(result.code),
				...(located ? { cwdRoot: located.root, cwdRel: located.rel } : { cwdRoot: "unscoped" }),
			};
			if (existsSync(paginate)) fields.sourceDigest = hashFile(paginate);
			const verify = join(cwd, "verify.mjs");
			const config = join(cwd, "config.json");
			if (existsSync(verify)) fields.digestVerify = hashFile(verify);
			if (existsSync(config)) fields.digestConfig = hashFile(config);
			commandFacts.push({ command: clipField(command), fields });
			trace({ kind: "runtime-log", fields, ok: result.code === 0 });
			return result;
		},
	};
}

const projectedCompactions = new Set<string>();

function projectCompactions(workspaceDir: string): void {
	const path = join(evalConversationDir(workspaceDir), "context.jsonl");
	if (!existsSync(path)) return;
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	lines.forEach((line, index) => {
		let entry: { type?: string; details?: { background?: boolean } };
		try {
			entry = JSON.parse(line) as { type?: string; details?: { background?: boolean } };
		} catch {
			return;
		}
		if (entry.type !== "compaction") return;
		const position = String(index);
		if (projectedCompactions.has(position)) return;
		projectedCompactions.add(position);
		trace({
			kind: "runtime-log",
			fields: {
				observation: "compaction",
				evidenceEpoch: EVIDENCE_EPOCH,
				compactionType: "compaction",
				sessionGeneration: String(sessionGeneration),
				position,
				background: entry.details?.background === true ? "true" : "false",
			},
		});
	});
}

async function main(): Promise<void> {
	const item = allCases.find((candidate) => candidate.id === caseId);
	if (!item) throw new Error(`Unknown eval case ${caseId}.`);
	process.env.PIPICLAW_HOME = homeDir;
	const firstSegment = segment === 1;
	const home =
		firstSegment && process.env.EVAL_PREPARED_HOME !== "1"
			? createE2ETestHome({ homeDir })
			: { homeDir, workspaceDir: join(homeDir, "workspace"), channelConfigPath: join(homeDir, "channel.json") };
	const workspaceDir = home.workspaceDir;
	const deskDir = evalDeskDir(workspaceDir);
	const canaryPath = join(homeDir, "controlled-canary.txt");
	if (firstSegment) {
		writeFileSync(
			join(homeDir, "security.json"),
			`${JSON.stringify(
				{
					pathGuard: { writeDeny: [canaryPath] },
				},
				null,
				2,
			)}\n`,
		);
	}
	if (firstSegment) await prepareEvalDesk(workspaceDir);
	if (firstSegment && item.setup) {
		currentPhase = "fixture";
		await item.setup({ homeDir, workspaceDir, deskDir, canaryPath, externalBaseUrl, seed });
		currentPhase = "runtime";
	}

	// Each trial is a complete synthetic project. HostExecutor inherits the daemon cwd,
	// so never start its shell in the evaluator's own checkout. Fixtures load before chdir.
	process.chdir(workspaceDir);

	const { createRuntimeContext } = await import("../../src/runtime/bootstrap.js");
	const dingtalkConfig = {
		clientId: "eval",
		clientSecret: "eval",
		robotCode: "eval",
		cardTemplateKey: "content",
		stateDir: join(homeDir, "state"),
	};
	trace({ kind: "runtime-log", fields: { observation: "epoch", evidenceEpoch: EVIDENCE_EPOCH }, ok: true });
	const runtime: Awaited<ReturnType<typeof createRuntimeContext>> = await createRuntimeContext({
		executor: observingExecutor(createExecutor(), { homeDir, workspaceDir, deskDir }),
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
		transports: [
			new DingTalkTransport({
				config: dingtalkConfig,
				archiveBotResponse: (id, text) => runtime.store.logBotResponse(id, text, Date.now().toString()),
				createBot: (ingress, config) => new EvalBot(ingress, config),
			}),
		],
		registerSignalHandlers: false,
		startServices: false,
		createEventsWatcher: () => ({ start() {}, stop() {} }),
		observer: eventTrace,
		onTaskStep: (event) => {
			trace({
				kind: "runtime-log",
				fields: {
					taskStep: event.phase,
					taskId: event.taskId,
					seq: String(event.seq),
					// What the lane derived for the task after the step: `work` / `user` / `time` / `closed` / ….
					...(event.next ? { stepNext: event.next, stepResult: event.result ?? "" } : {}),
					// `started` is the lane admitting a step: the successor of the old driver dispatch.
					...(event.phase === "started" ? { driverDispatch: "true" } : {}),
				},
				ok: true,
			});
		},
	});

	const handleEvent = runtime.ingress.handleEvent.bind(runtime.ingress);
	const sendEvent = async (event: ChannelEvent): Promise<void> => {
		await handleEvent(event);
	};
	/** Wait for every queued turn (task wakes the runtime enqueued) to finish. */
	const drain = async (): Promise<void> => {
		while (!runtime.ingress.isIdle()) await new Promise((resolve) => setTimeout(resolve, 5));
	};
	async function driveLane(): Promise<void> {
		const priorActor = currentActorId;
		const priorSession = currentSessionId;
		currentActorId = "task:lane";
		currentSessionId = `${caseId}:${channelId}:task:lane`;
		try {
			await runtime.taskLane.runOnce();
			await runtime.taskLane.drained();
		} finally {
			currentActorId = priorActor;
			currentSessionId = priorSession;
		}
	}

	const execute = async (step: Step): Promise<void> => {
		stepIndex++;
		trace({ kind: "step", fields: { kind: step.kind } });
		if (step.kind === "user") {
			const before = localTrace.length;
			const rawText = interpolate(step.text, canaryPath, workspaceDir, deskDir);
			let effectiveText = rawText;
			if (step.inbound) {
				const msgtype =
					step.inbound.msgtype ?? (step.inbound.file ? "file" : step.inbound.recognition ? "audio" : "text");
				const repliedMsg = step.inbound.repliedText
					? {
							msgType: "text",
							content: { text: interpolate(step.inbound.repliedText, canaryPath, workspaceDir, deskDir) },
						}
					: undefined;
				const fileSpec = step.inbound.file
					? {
							fileName: interpolate(step.inbound.file.fileName, canaryPath, workspaceDir, deskDir),
							content: interpolate(step.inbound.file.content, canaryPath, workspaceDir, deskDir),
						}
					: undefined;
				const parsed = parseInboundMessage({
					msgtype,
					...(msgtype === "text"
						? { text: { content: rawText, ...(repliedMsg ? { isReplyMsg: true, repliedMsg } : {}) } }
						: {}),
					...(repliedMsg ? { repliedMsg } : {}),
					content: {
						...(step.inbound.recognition
							? { recognition: interpolate(step.inbound.recognition, canaryPath, workspaceDir, deskDir) }
							: {}),
						...(fileSpec ? { downloadCode: "eval-file-1", fileName: fileSpec.fileName } : {}),
					},
				});
				const attachments: InboundAttachment[] | undefined = fileSpec
					? [{ kind: "file", index: 1, fileName: fileSpec.fileName, data: Buffer.from(fileSpec.content, "utf8") }]
					: undefined;
				await runtime.ingress.receive({
					channelId,
					ts: Date.now().toString(),
					user: "eval",
					userName: "Evaluator",
					text: parsed.text,
					...(attachments ? { attachments } : {}),
				});
				await drain();
				effectiveText = parsed.text;
			} else {
				await sendEvent({
					source: "human",
					channelId,
					ts: Date.now().toString(),
					user: "eval",
					userName: "Evaluator",
					text: rawText,
				});
				await drain();
			}
			if (
				!effectiveText.trim().startsWith("/") &&
				!localTrace.slice(before).some((event) => event.kind === "model-result")
			) {
				currentPhase = "fixture";
				throw new Error(
					"No model result observed for an eval user turn; inspect the eval transport and model setup before judging behavior.",
				);
			}
			projectCompactions(workspaceDir);
		} else if (step.kind === "newSession" || step.kind === "compact") {
			await sendEvent({
				source: "human",
				channelId,
				ts: Date.now().toString(),
				user: "eval",
				userName: "Evaluator",
				text: step.kind === "newSession" ? "/new" : "/compact",
			});
			await drain();
			projectCompactions(workspaceDir);
			if (step.kind === "newSession") {
				sessionGeneration++;
				currentSessionId = `${caseId}:${channelId}:segment-${segment}:session-${sessionGeneration}`;
			}
		} else if (step.kind === "checkpoint") {
			trace({
				kind: "runtime-log",
				fields: { checkpoint: step.id, fileTree: JSON.stringify(tree(workspaceDir)) },
				ok: true,
			});
		} else if (step.kind === "environment") {
			const target = resolve(workspaceDir, step.path);
			const rel = relative(workspaceDir, target);
			if (isAbsolute(rel) || rel.startsWith(".."))
				throw new Error(`Environment path '${step.path}' escapes the fixture workspace.`);
			currentPhase = "fixture";
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, interpolate(step.content, canaryPath, workspaceDir, deskDir));
			trace({ kind: "runtime-log", fields: { environment: step.action, path: rel }, ok: true });
			currentPhase = "runtime";
			const stage = step.path.match(/stage-([abc])\.txt$/i);
			if (stage) {
				trace({
					kind: "runtime-log",
					fields: { stageOpened: stage[1]!.toUpperCase(), evidenceEpoch: EVIDENCE_EPOCH },
					ok: true,
				});
			}
		} else if (step.kind === "taskMessage" || step.kind === "runTaskLane") {
			// Task steps run in the task lane (spec 064), apart from the chat; everything that happens
			// while the lane works is attributed to its actor. One scan may run several steps;
			// only explicit task messages wake a user/time wait. No simulated tick or ignored timestamp.
			currentPhase = "scheduler";
			if (step.kind === "taskMessage") {
				const outcome = await runtime.taskLane.message(EVAL_DESK, step.taskId, {
					from: "eval",
					channel: channelId,
					text: step.text,
				});
				if (outcome.kind === "not_found" || outcome.kind === "held_paused" || outcome.kind === "held_frozen")
					throw new Error(`Task message could not wake ${step.taskId}: ${outcome.kind}`);
			}
			await driveLane();
			await drain();
			currentPhase = "runtime";
		} else if (step.kind === "runMemoryMaintenance") {
			currentPhase = "scheduler";
			if (!runtime.memoryMaintenance.runOnce) {
				throw new Error("Runtime did not expose the memory maintenance scheduler; use the production instance.");
			}
			const at = step.at ? new Date(step.at) : new Date();
			trace({
				kind: "runtime-log",
				fields: {
					observation: "maintenance-day",
					evidenceEpoch: EVIDENCE_EPOCH,
					dayKey: localDayKey(at),
					at: at.toISOString(),
				},
				ok: true,
			});
			await runtime.memoryMaintenance.runOnce(at);
			await drain();
			currentPhase = "runtime";
		} else if (step.kind === "waitFor") {
			currentPhase = step.failureCategory ?? "fixture";
			const deadline = Date.now() + step.timeoutMs;
			while (true) {
				// Services are intentionally off here; a checkpoint wait also drives pending
				// task input so a settled producer can actually wake its leader.
				await driveLane();
				const context: TrialContext = {
					seed,
					homeDir,
					workspaceDir,
					deskDir,
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
				if (step.predicate(context)) {
					await drain();
					break;
				}
				if (Date.now() >= deadline)
					throw new Error(`waitFor timed out after ${step.timeoutMs}ms; fix the predicate or case.`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			currentPhase = "runtime";
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
	projectCompactions(workspaceDir);
	if (mode === "crash-boundary") {
		send({ protocol: 1, type: "ready", reason: "crash-boundary" });
		await new Promise(() => {});
	}
	await runtime.shutdown("manual");
	let promptFingerprint: string | undefined;
	const promptPath = join(evalConversationDir(workspaceDir), "last_prompt.json");
	if (existsSync(promptPath)) {
		try {
			const prompt = JSON.parse(readFileSync(promptPath, "utf8")) as { fingerprint?: string };
			promptFingerprint = prompt.fingerprint;
		} catch {}
	}
	send({ protocol: 1, type: "complete", observedModel, promptFingerprint });
}

main().catch((error) => {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	send({ protocol: 1, type: "failure", category: currentPhase, error: detail.slice(0, 16000) });
	process.stderr.write(`${detail}\n`);
	process.exitCode = 70;
});

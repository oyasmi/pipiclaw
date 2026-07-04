import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { formatModelReference } from "../models/utils.js";
import { extractAssistantText } from "../shared/text-utils.js";
import { getUsageLedger } from "../usage/ledger.js";

export interface SidecarTask<T> {
	name: string;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	systemPrompt: string;
	prompt: string;
	parse: (text: string) => T;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Attributes this task's LLM spend to a channel in the usage ledger. */
	usageContext?: { channelId: string };
}

export interface SidecarResult<T> {
	output: T;
	rawText: string;
}

const SIDE_CAR_RETRY_DELAY_MS = 2_000;
const SIDE_CAR_MAX_ATTEMPTS = 2;

export class SidecarTimeoutError extends Error {
	readonly taskName: string;
	readonly timeoutMs: number;

	constructor(taskName: string, timeoutMs: number) {
		super(`Sidecar task "${taskName}" timed out after ${timeoutMs}ms`);
		this.name = "SidecarTimeoutError";
		this.taskName = taskName;
		this.timeoutMs = timeoutMs;
	}
}

export class SidecarParseError extends Error {
	readonly taskName: string;
	readonly rawText: string;

	constructor(taskName: string, rawText: string, cause: unknown) {
		super(`Sidecar task "${taskName}" returned invalid output`);
		this.name = "SidecarParseError";
		this.taskName = taskName;
		this.rawText = rawText;
		this.cause = cause;
	}
}

function createAbortError(taskName: string, reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(`Sidecar task "${taskName}" aborted`);
}

function isExternalAbort(task: SidecarTask<unknown>): boolean {
	return task.signal?.aborted === true;
}

function delay(ms: number, task: SidecarTask<unknown>): Promise<void> {
	if (ms <= 0) {
		return Promise.resolve();
	}

	return new Promise<void>((resolve, reject) => {
		const signal = task.signal;
		const timer = setTimeout(() => {
			removeAbortListener();
			resolve();
		}, ms);

		const abort = () => {
			clearTimeout(timer);
			removeAbortListener();
			reject(createAbortError(task.name, signal?.reason));
		};

		const removeAbortListener = () => {
			signal?.removeEventListener("abort", abort);
		};

		if (!signal) {
			return;
		}
		if (signal.aborted) {
			abort();
			return;
		}

		signal.addEventListener("abort", abort, { once: true });
	});
}

interface MaybeUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

/** Attribute a completed sidecar task's LLM spend to the usage ledger. */
function recordSidecarUsage(task: SidecarTask<unknown>, message: { usage?: MaybeUsage }): void {
	const usage = message.usage;
	if (!usage || !usage.cost) return;
	getUsageLedger().record({
		channelId: task.usageContext?.channelId ?? "",
		kind: "sidecar",
		model: formatModelReference(task.model),
		label: task.name,
		usage: {
			input: usage.input ?? 0,
			output: usage.output ?? 0,
			cacheRead: usage.cacheRead ?? 0,
			cacheWrite: usage.cacheWrite ?? 0,
			total: usage.total ?? 0,
		},
		cost: {
			input: usage.cost.input ?? 0,
			output: usage.cost.output ?? 0,
			cacheRead: usage.cost.cacheRead ?? 0,
			cacheWrite: usage.cost.cacheWrite ?? 0,
			total: usage.cost.total ?? 0,
		},
	});
}

export async function runSidecarTask<T>(task: SidecarTask<T>): Promise<SidecarResult<T>> {
	const apiKey = await task.resolveApiKey(task.model);
	const worker = new Agent({
		initialState: {
			systemPrompt: task.systemPrompt,
			model: task.model,
			thinkingLevel: "off",
			tools: [],
		},
		convertToLlm,
		getApiKey: async () => apiKey,
	});

	const abortWorker = () => {
		try {
			worker.abort();
		} catch {
			/* ignore */
		}
	};

	let removeAbortListener = () => {};
	let timeoutHandle: NodeJS.Timeout | null = null;

	const runPromise = (async () => {
		await worker.prompt(task.prompt);
		await worker.waitForIdle();

		const lastMessage = worker.state.messages[worker.state.messages.length - 1];
		if (!lastMessage || lastMessage.role !== "assistant") {
			throw new Error(`Sidecar task "${task.name}" returned no assistant message`);
		}

		if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
			throw new Error(lastMessage.errorMessage || `Sidecar task "${task.name}" failed`);
		}

		recordSidecarUsage(task, lastMessage);

		const rawText = extractAssistantText(lastMessage);
		try {
			return {
				output: task.parse(rawText),
				rawText,
			};
		} catch (error) {
			throw new SidecarParseError(task.name, rawText, error);
		}
	})();
	void runPromise.catch(() => {});

	const blockers: Array<Promise<never>> = [];
	if (task.timeoutMs && task.timeoutMs > 0) {
		blockers.push(
			new Promise<never>((_, reject) => {
				timeoutHandle = setTimeout(() => {
					abortWorker();
					reject(new SidecarTimeoutError(task.name, task.timeoutMs!));
				}, task.timeoutMs);
			}),
		);
	}

	if (task.signal) {
		const signal = task.signal;
		blockers.push(
			new Promise<never>((_, reject) => {
				const abort = () => {
					abortWorker();
					reject(createAbortError(task.name, signal.reason));
				};

				if (signal.aborted) {
					abort();
					return;
				}

				signal.addEventListener("abort", abort, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", abort);
			}),
		);
	}

	try {
		return blockers.length > 0 ? await Promise.race([runPromise, ...blockers]) : await runPromise;
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
		removeAbortListener();
	}
}

export async function runRetriedSidecarTask<T>(task: SidecarTask<T>): Promise<SidecarResult<T>> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= SIDE_CAR_MAX_ATTEMPTS; attempt++) {
		if (isExternalAbort(task)) {
			throw createAbortError(task.name, task.signal?.reason);
		}

		try {
			return await runSidecarTask(task);
		} catch (error) {
			lastError = error;

			if (attempt >= SIDE_CAR_MAX_ATTEMPTS || error instanceof SidecarParseError || isExternalAbort(task)) {
				throw error;
			}

			await delay(SIDE_CAR_RETRY_DELAY_MS, task);
		}
	}

	throw lastError instanceof Error ? lastError : new Error(`Sidecar task "${task.name}" failed`);
}

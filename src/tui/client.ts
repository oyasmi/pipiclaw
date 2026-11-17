/**
 * The terminal's connection to the Web API (spec 061, D25): the official SDK over the daemon's
 * local socket, the conversation it keeps per desk (`state/tui/conversations.json`), and the
 * one-shot `--print` request. The terminal holds no runtime of its own — what it shows is what a
 * script using the same API would get.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import { Agent, fetch as undiciFetch } from "undici";
import { BootstrapExitError, type BootstrapIO, type BootstrapPaths } from "../app/home.js";
import { loadBindings } from "../desk/bindings.js";
import { DEFAULT_DESK, deriveDeskNameFromPath, isDeskName, normalizeDeskName } from "../desk/paths.js";
import { listDesks, readDeskRecordSync } from "../desk/registry.js";
import { webapiSocketPath } from "../paths.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isPlainObject } from "../shared/type-guards.js";
import type { StreamEvent } from "./render.js";
import type { Connection, ConversationItem, SessionLink } from "./session.js";

export interface OpenOptions {
	/** The desk to work in; defaults to `default`. */
	desk?: string;
	/** Optional repository / working directory to configure on the desk (`--cwd`). */
	cwd?: string;
	/** Automatically open or create a desk dedicated to `hereDir ?? process.cwd()` (`--here`). */
	here?: boolean;
	/** Override `process.cwd()` for `--here` in deterministic tests. */
	hereDir?: string;
	/** Create the desk first — an explicit creation, like `/desk new`. */
	create: boolean;
	/** Start a new conversation instead of resuming the desk's last one. */
	fresh: boolean;
}

const stateFile = (paths: BootstrapPaths): string => join(paths.appHomeDir, "state", "tui", "conversations.json");

/** Desk name → the conversation this terminal last used in it. */
function readState(paths: BootstrapPaths): Record<string, string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(stateFile(paths), "utf-8"));
		if (!isPlainObject(parsed)) return {};
		return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<
			string,
			string
		>;
	} catch {
		return {};
	}
}

async function writeState(paths: BootstrapPaths, state: Record<string, string>): Promise<void> {
	mkdirSync(dirname(stateFile(paths)), { recursive: true });
	await writeFileAtomically(stateFile(paths), `${JSON.stringify(state, null, 2)}\n`);
}

/** The SDK client for the local socket; the socket needs no key. */
export function createSocketClient(paths: BootstrapPaths): OpenAI {
	const dispatcher = new Agent({ connect: { socketPath: webapiSocketPath(paths.appHomeDir) } });
	return new OpenAI({
		apiKey: "local-socket",
		baseURL: "http://localhost/v1",
		maxRetries: 0,
		// A synchronous `--print` request lasts as long as the agent works.
		timeout: 30 * 60 * 1000,
		// Node's built-in fetch cannot take an npm undici dispatcher; the npm one can.
		fetch: undiciFetch as never,
		fetchOptions: { dispatcher },
	});
}

export function requireSocket(paths: BootstrapPaths, io: BootstrapIO): void {
	const socketPath = webapiSocketPath(paths.appHomeDir);
	if (existsSync(socketPath)) return;
	let lockDetail = "";
	try {
		const raw: unknown = JSON.parse(readFileSync(join(paths.appHomeDir, "state", "daemon.lock"), "utf-8"));
		if (isPlainObject(raw) && typeof raw.pid === "number") {
			const started = typeof raw.startedAt === "string" ? `，启动于 ${raw.startedAt}` : "";
			lockDetail = `（进程 PID ${raw.pid}${started}）`;
		}
	} catch {
		// Lock file unreadable or absent; omit holder details.
	}
	io.error(
		[
			`无法连接本机 Web API socket（${socketPath}）。`,
			`检测到后台已有 Pipiclaw 服务正在运行${lockDetail}，但未开启本机 socket。你可以：`,
			`  1) 在 ${paths.channelConfigPath} 中设置 \`"webapi": { "enabled": true, "socket": true }\` 并重启后台服务；或`,
			"  2) 先停止后台服务，再直接运行 `pipiclaw tui`（由终端内嵌启动运行时）。",
		].join("\n"),
	);
	throw new BootstrapExitError(1);
}

/** Wrap the SDK's WebSocket as the session's `Connection`. */
function openConnection(
	client: OpenAI,
	socketPath: string,
	onEvent: (event: StreamEvent & Record<string, unknown>) => void,
	onClose: () => void,
): Connection {
	const ws = new ResponsesWS(client, { createConnection: () => connect(socketPath) } as never);
	ws.on("event", (event) => onEvent(event as never));
	ws.on("error", () => undefined);
	ws.on("close", () => onClose());
	return {
		send: (event) => ws.send(event as never),
		close: () => ws.close(),
	};
}

export function createLink(client: OpenAI, paths: BootstrapPaths, conversationId: string): SessionLink {
	const socketPath = webapiSocketPath(paths.appHomeDir);
	return {
		conversationId,
		connect: (onEvent, onClose) => openConnection(client, socketPath, onEvent, onClose),
		// The runtime removes its socket when it shuts down.
		reachable: () => existsSync(socketPath),
		async lastItemId() {
			const page = await client.conversations.items.list(conversationId, { order: "desc", limit: 1 });
			return page.data[0]?.id;
		},
		async listItems(after) {
			const items: ConversationItem[] = [];
			let cursor = after;
			for (;;) {
				const page = await client.conversations.items.list(conversationId, {
					order: "asc",
					limit: 100,
					...(cursor ? { after: cursor } : {}),
				});
				items.push(...(page.data as unknown as ConversationItem[]));
				if (!page.has_more || page.data.length === 0) return items;
				cursor = page.data.at(-1)?.id;
			}
		},
	};
}

/** The desk a conversation is bound to, read from the workspace's bindings (the terminal never writes them). */
async function boundDesk(paths: BootstrapPaths, conversationId: string): Promise<string | undefined> {
	const { bindings } = await loadBindings(paths.workspaceDir);
	const entry = Object.entries(bindings).find(([channelId]) => channelId.endsWith(`:${conversationId}`));
	return entry?.[1].desk;
}

/** One request, answered synchronously; the reply text. */
async function ask(client: OpenAI, conversationId: string, input: string): Promise<string> {
	const response = await client.responses.create({ model: "pipiclaw", conversation: conversationId, input });
	if (response.status !== "completed") {
		throw new Error(response.error?.message ?? `The request ended as ${response.status}.`);
	}
	return response.output_text;
}

async function resolveHereTarget(
	paths: BootstrapPaths,
	targetCwd: string,
	fail: (message: string) => never,
): Promise<{ desk: string; cwd?: string; create: boolean }> {
	const desks = await listDesks(paths.workspaceDir);
	const matchedByCwd = desks.find(
		(entry) => entry.availability === "available" && (entry.record?.cwd ?? entry.deskDir) === targetCwd,
	);
	if (matchedByCwd) {
		return { desk: matchedByCwd.name, create: false };
	}
	const slug = deriveDeskNameFromPath(targetCwd);
	const summary = readDeskRecordSync(paths.workspaceDir, slug);
	if (summary.availability === "missing") {
		const { bindings } = await loadBindings(paths.workspaceDir);
		if (Object.values(bindings).some((binding) => binding.desk === slug)) {
			fail(`工位 "${slug}" 已有绑定但记录缺失，请联系部署者恢复，或改用 \`--desk <新名称> --create --cwd .\`。`);
		}
		return { desk: slug, cwd: targetCwd, create: true };
	}
	if (!summary.record) {
		fail(`工位 "${slug}" 当前不可用（desk.json 有误），请检查后再试，或改用 \`--desk <新名称> --create --cwd .\`。`);
	}
	const existingCwd = summary.record.cwd ?? summary.deskDir;
	if (existingCwd !== targetCwd) {
		fail(
			`同名工位 "${slug}" 已存在且绑定到其他目录（${existingCwd}）。请改用 \`pipiclaw tui --desk <新名称> --create --cwd .\` 指定不重名的工位。`,
		);
	}
	return { desk: slug, create: false };
}

/**
 * Find or make the conversation for `--desk`: resume the desk's last one while it is still bound
 * to that desk, else start one and bind it (`/desk new` first with `--create`). Returns the
 * conversation and what the server said while setting it up.
 */
export async function openConversation(
	client: OpenAI,
	paths: BootstrapPaths,
	options: OpenOptions,
	io: BootstrapIO,
): Promise<{ id: string; desk: string; replies: string[] }> {
	const fail = (message: string): never => {
		io.error(message);
		throw new BootstrapExitError(1);
	};
	const resolvedHere = options.here
		? await resolveHereTarget(paths, resolve(options.hereDir ?? process.cwd()), fail)
		: undefined;
	const desk = resolvedHere ? resolvedHere.desk : normalizeDeskName(options.desk ?? DEFAULT_DESK);
	const create = resolvedHere ? resolvedHere.create : options.create;
	const cwd = resolvedHere ? resolvedHere.cwd : options.cwd;
	if (!isDeskName(desk)) {
		fail(`工位名称 "${desk}" 不合法：请使用 1–32 位小写字母、数字或连字符 '-'，且首尾不能为 '-'。`);
	}
	const state = readState(paths);

	if (!options.fresh && !create && state[desk]) {
		const id = state[desk];
		const exists = await client.conversations.retrieve(id).then(
			() => true,
			(error: { status?: number }) => (error.status === 404 ? false : Promise.reject(error)),
		);
		// A conversation rebound to another desk since is not this desk's any more.
		const bound = exists ? await boundDesk(paths, id) : undefined;
		const isArchived = Boolean(readDeskRecordSync(paths.workspaceDir, desk).record?.archivedAt);
		if (!isArchived && exists && (bound === desk || (bound === undefined && desk === DEFAULT_DESK))) {
			const replies = cwd ? [await ask(client, id, `/desk cwd ${cwd}`)] : [];
			return { id, desk, replies };
		}
	}

	const id = (await client.conversations.create({})).id;
	const replies: string[] = [];
	// A conversation starts on the default desk by itself; any other desk is an explicit request.
	if (desk !== DEFAULT_DESK || create) {
		if (create) {
			replies.push(await ask(client, id, cwd ? `/desk new ${desk} ${cwd}` : `/desk new ${desk}`));
		}
		replies.push(await ask(client, id, `/desk bind ${desk}`));
		if ((await boundDesk(paths, id)) !== desk) {
			for (const reply of replies) io.error(reply);
			fail(`无法打开工位 "${desk}"。`);
		}
		if (cwd && !create) {
			replies.push(await ask(client, id, `/desk cwd ${cwd}`));
		}
	} else if (cwd) {
		replies.push(await ask(client, id, `/desk cwd ${cwd}`));
	}
	await writeState(paths, { ...state, [desk]: id });
	return { id, desk, replies };
}

/** `--print`: one synchronous request, the answer on stdout. */
export async function printOnce(client: OpenAI, conversationId: string, prompt: string): Promise<string> {
	return ask(client, conversationId, prompt);
}

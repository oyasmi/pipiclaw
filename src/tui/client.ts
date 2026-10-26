/**
 * The terminal's connection to the Web API (spec 061, D25): the official SDK over the daemon's
 * local socket, the conversation it keeps per desk (`state/tui/conversations.json`), and the
 * one-shot `--print` request. The terminal holds no runtime of its own — what it shows is what a
 * script using the same API would get.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import { Agent, fetch as undiciFetch } from "undici";
import { BootstrapExitError, type BootstrapIO, type BootstrapPaths } from "../app/home.js";
import { loadBindings } from "../desk/bindings.js";
import { DEFAULT_DESK, isDeskName, normalizeDeskName } from "../desk/paths.js";
import { webapiSocketPath } from "../paths.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isPlainObject } from "../shared/type-guards.js";
import type { StreamEvent } from "./render.js";
import type { Connection, ConversationItem, SessionLink } from "./session.js";

export interface OpenOptions {
	/** The desk to work in; defaults to `default`. */
	desk?: string;
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
	io.error(
		[
			`Cannot reach the Web API socket (${socketPath}).`,
			"A Pipiclaw daemon is running, but it has no Web API socket. Either:",
			'  - set `"webapi": { "enabled": true, "socket": true }` in channel.json and restart the daemon, or',
			"  - stop the daemon, and `pipiclaw tui` will run the runtime itself.",
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
): Promise<{ id: string; replies: string[] }> {
	const fail = (message: string): never => {
		io.error(message);
		throw new BootstrapExitError(1);
	};
	const desk = normalizeDeskName(options.desk ?? DEFAULT_DESK);
	if (!isDeskName(desk)) {
		fail(
			`Invalid desk name "${desk}": use 1-32 lowercase letters, digits or hyphens, not starting or ending with "-".`,
		);
	}
	const state = readState(paths);

	if (!options.fresh && !options.create && state[desk]) {
		const id = state[desk];
		const exists = await client.conversations.retrieve(id).then(
			() => true,
			(error: { status?: number }) => (error.status === 404 ? false : Promise.reject(error)),
		);
		// A conversation rebound to another desk since is not this desk's any more.
		const bound = exists ? await boundDesk(paths, id) : undefined;
		if (exists && (bound === desk || (bound === undefined && desk === DEFAULT_DESK))) return { id, replies: [] };
	}

	const id = (await client.conversations.create({})).id;
	const replies: string[] = [];
	// A conversation starts on the default desk by itself; any other desk is an explicit request.
	if (desk !== DEFAULT_DESK || options.create) {
		if (options.create) replies.push(await ask(client, id, `/desk new ${desk}`));
		replies.push(await ask(client, id, `/desk bind ${desk}`));
		if ((await boundDesk(paths, id)) !== desk) {
			for (const reply of replies) io.error(reply);
			fail(`Could not open desk "${desk}".`);
		}
	}
	await writeState(paths, { ...state, [desk]: id });
	return { id, replies };
}

/** `--print`: one synchronous request, the answer on stdout. */
export async function printOnce(client: OpenAI, conversationId: string, prompt: string): Promise<string> {
	return ask(client, conversationId, prompt);
}

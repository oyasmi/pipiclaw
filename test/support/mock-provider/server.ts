/**
 * In-process mock provider (spec 048 D2). A `node:http` server on 127.0.0.1:<random>
 * speaking the openai chat-completions SSE subset pi decodes. Zero network, zero cost.
 * Only `POST /chat/completions` is implemented; anything else is a recorded 502.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { registerSidecarDefaults } from "./defaults.js";
import { type CapturedRequest, parseRequest, Script } from "./script.js";
import { encodeResponse } from "./sse.js";

export interface MockProvider {
	baseUrl: string;
	port: number;
	/** Every request the provider received, in order, including unmatched ones. */
	requests: CapturedRequest[];
	script: Script;
	/** Requests that matched no route (also present in `requests`). */
	unmatched(): CapturedRequest[];
	close(): Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf-8");
	try {
		return text ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function writeError(res: ServerResponse, status: number, body: unknown): void {
	if (res.writableEnded) return;
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

export async function startMockProvider(options?: { registerDefaults?: boolean }): Promise<MockProvider> {
	const script = new Script();
	if (options?.registerDefaults !== false) {
		registerSidecarDefaults(script);
	}
	const requests: CapturedRequest[] = [];

	const server: Server = createServer((req, res) => {
		void handle(req, res).catch((err) => {
			writeError(res, 500, { error: { message: `mock provider crashed: ${String(err)}` } });
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url ?? "";
		if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
			writeError(res, 502, { error: { message: `mock provider: unexpected ${req.method} ${url}` } });
			return;
		}

		const body = await readJsonBody(req);
		const view = parseRequest(url, body);
		// Record arrival immediately so a held request is still observable to the test
		// (matchedRoute is filled in once it resolves).
		const record: CapturedRequest = { ...view, matchedRoute: null, at: Date.now() };
		requests.push(record);

		const failure = script.takeFailure();
		if (failure) {
			record.matchedRoute = `__fail_${failure.status}`;
			writeError(res, failure.status, {
				error: {
					message: `mock provider injected failure (${failure.status})`,
					type: failure.status === 429 ? "rate_limit_error" : "invalid_request_error",
					code: failure.code,
				},
			});
			return;
		}

		// Timing control: a hold suspends the response (turn stays "running") until released.
		await script.waitForHolds(view);

		const resolved = script.resolve(view);
		record.matchedRoute = resolved?.route ?? "__unmatched";

		if (!resolved) {
			const summary = (view.isMainTurn ? view.lastUserText : view.systemPrompt).slice(0, 200);
			writeError(res, 502, {
				error: {
					message:
						`mock provider: no route matched this request.\n` +
						`  isMainTurn=${view.isMainTurn} tools=[${view.tools.join(",")}]\n` +
						`  ${view.isMainTurn ? "lastUserText" : "systemPrompt"}: ${summary}`,
				},
			});
			return;
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		try {
			res.write(encodeResponse(view.model, resolved.response));
			res.end();
		} catch {
			// Client aborted mid-stream (e.g. /stop). Nothing to deliver; just drop it.
			if (!res.writableEnded) res.end();
		}
	}

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		port,
		requests,
		script,
		unmatched: () => requests.filter((r) => r.matchedRoute === "__unmatched"),
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections?.();
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}

/**
 * Content-based routing for the mock provider (spec 048 D2.4).
 *
 * The memory sidecar and the main turn share one endpoint and fire asynchronously,
 * so responses are matched by request *content*, never by arrival order. A request
 * that matches no route is not given a fallback — it is recorded and answered 502 so
 * the test fails loudly with a diagnosable message.
 */

import type { ScriptedResponse } from "./sse.js";

export interface RequestView {
	path: string;
	model: string;
	systemPrompt: string;
	/** Tool names offered on this request. Empty for every sidecar call. */
	tools: string[];
	messages: Array<{ role: string; content: string }>;
	lastUserText: string;
	/** Heuristic from D2.4: a request that carries tools is the main agent turn. */
	isMainTurn: boolean;
	raw: Record<string, unknown>;
}

export interface CapturedRequest extends RequestView {
	matchedRoute: string | null;
	at: number;
}

type Matcher = (req: RequestView) => boolean;

interface Route {
	name: string;
	when: Matcher;
	responses: ScriptedResponse[];
	calls: number;
	/** When true, the last response repeats instead of the route becoming exhausted. */
	repeat: boolean;
}

interface RouteDef {
	name: string;
	when: Matcher;
	respond: ScriptedResponse[];
	/** Keep answering with the last response after the array is consumed (e.g. client retries). */
	repeat?: boolean;
}

interface Hold {
	when: Matcher;
	released: boolean;
	waiters: Array<() => void>;
}

export interface HoldHandle {
	release(): void;
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part && typeof (part as { text: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

export function parseRequest(path: string, body: Record<string, unknown>): RequestView {
	const rawMessages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
	const messages = rawMessages.map((m) => ({
		role: typeof m.role === "string" ? m.role : "",
		content: flattenContent(m.content),
	}));
	const systemPrompt = messages.find((m) => m.role === "system" || m.role === "developer")?.content ?? "";
	const lastUserText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
	const tools = Array.isArray(body.tools)
		? (body.tools as Array<Record<string, unknown>>)
				.map((t) => {
					const fn = t.function as Record<string, unknown> | undefined;
					return typeof fn?.name === "string" ? fn.name : "";
				})
				.filter(Boolean)
		: [];
	return {
		path,
		model: typeof body.model === "string" ? body.model : "",
		systemPrompt,
		tools,
		messages,
		lastUserText,
		isMainTurn: tools.length > 0,
		raw: body,
	};
}

export class Script {
	private readonly routes: Route[] = [];
	private readonly holds: Hold[] = [];
	private readonly failures: Array<{ status: number; code?: string }> = [];

	route(def: RouteDef): void {
		this.routes.push({
			name: def.name,
			when: def.when,
			responses: def.respond,
			calls: 0,
			repeat: def.repeat ?? false,
		});
	}

	/** Register a route at the front so a test-specific route overrides a default. */
	prependRoute(def: RouteDef): void {
		this.routes.unshift({
			name: def.name,
			when: def.when,
			responses: def.respond,
			calls: 0,
			repeat: def.repeat ?? false,
		});
	}

	hold(def: { when: Matcher }): HoldHandle {
		const h: Hold = { when: def.when, released: false, waiters: [] };
		this.holds.push(h);
		return {
			release: () => {
				h.released = true;
				for (const w of h.waiters.splice(0)) w();
			},
		};
	}

	/**
	 * Queue `times` HTTP failures for the next matching requests. Pi retries a 429 up to
	 * 3 times on its own, so a fallback test needs `times: 3` to exhaust that first.
	 */
	failNext(def: { status: number; code?: string; times?: number }): void {
		for (let i = 0; i < (def.times ?? 1); i++) {
			this.failures.push({ status: def.status, code: def.code });
		}
	}

	/** Internal: block until every matching hold has been released. */
	async waitForHolds(req: RequestView): Promise<void> {
		const pending = this.holds.filter((h) => !h.released && h.when(req));
		await Promise.all(
			pending.map(
				(h) =>
					new Promise<void>((resolve) => {
						if (h.released) resolve();
						else h.waiters.push(resolve);
					}),
			),
		);
	}

	/** Internal: pop a queued failure, if any. */
	takeFailure(): { status: number; code?: string } | undefined {
		return this.failures.shift();
	}

	/** Internal: resolve the response for a request, or null when nothing matches / is exhausted. */
	resolve(req: RequestView): { route: string; response: ScriptedResponse } | null {
		for (const route of this.routes) {
			if (!route.when(req)) continue;
			const response = route.responses[Math.min(route.calls, route.responses.length - 1)];
			if (route.calls >= route.responses.length && !route.repeat) {
				// A route matched more times than it has responses — treat as unmatched so the
				// test author notices the extra request rather than silently reusing the last one.
				// `repeat: true` opts out (e.g. tolerating client retries of a held/aborted request).
				return null;
			}
			route.calls += 1;
			return { route: route.name, response };
		}
		return null;
	}
}

/** Response builders for `script.route({ respond: [...] })`. */
export const reply = {
	text(text: string): ScriptedResponse {
		return { steps: [{ text }] };
	},
	toolCall(name: string, args: unknown, id?: string): ScriptedResponse {
		return { steps: [{ toolCall: { name, args, id } }] };
	},
	json(value: unknown): ScriptedResponse {
		return { steps: [{ text: JSON.stringify(value) }] };
	},
	steps(...steps: ScriptedResponse["steps"]): ScriptedResponse {
		return { steps };
	},
};

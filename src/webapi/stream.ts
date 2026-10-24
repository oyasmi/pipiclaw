/**
 * Server-sent events for a response (spec 061, D20): `event:` is the event's `type`, `data:` its
 * JSON, no `id:` and no `[DONE]`. A stream is a cursor over the response's event log, so a late
 * reader (a resumed background stream) sees the same events in the same order as the first.
 */
import type { ServerResponse } from "node:http";
import type { LiveResponse, LoggedEvent } from "./response-state.js";

export function openEventStream(raw: ServerResponse): void {
	raw.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	raw.flushHeaders();
}

function frame(event: LoggedEvent): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Write one chunk, waiting for the socket to drain if it is full; `false` once the client is gone. */
async function write(raw: ServerResponse, chunk: string): Promise<boolean> {
	if (raw.destroyed || raw.writableEnded) return false;
	if (raw.write(chunk)) return true;
	return new Promise<boolean>((resolve) => {
		const done = (ok: boolean) => {
			raw.off("drain", onDrain);
			raw.off("close", onClose);
			resolve(ok);
		};
		const onDrain = () => done(true);
		const onClose = () => done(false);
		raw.once("drain", onDrain);
		raw.once("close", onClose);
	});
}

/**
 * Pump `live`'s events from `fromSequence` to `raw` until the response ends or the client goes.
 * Returns whether the response ended (as opposed to the client leaving first).
 */
export async function pumpEvents(live: LiveResponse, fromSequence: number, raw: ServerResponse): Promise<boolean> {
	const queue: LoggedEvent[] = [];
	let ended = false;
	let gone = false;
	let wake: (() => void) | undefined;
	const nudge = () => wake?.();
	const unsubscribe = live.subscribe(fromSequence, {
		onEvent: (event) => {
			queue.push(event);
			nudge();
		},
		onEnd: () => {
			ended = true;
			nudge();
		},
	});
	const onClose = () => {
		gone = true;
		nudge();
	};
	raw.once("close", onClose);
	try {
		for (;;) {
			while (queue.length > 0) {
				if (!(await write(raw, frame(queue.shift() as LoggedEvent)))) return false;
			}
			if (ended) return true;
			if (gone) return false;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
			wake = undefined;
		}
	} finally {
		unsubscribe();
		raw.off("close", onClose);
	}
}

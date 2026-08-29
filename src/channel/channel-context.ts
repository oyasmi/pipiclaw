/**
 * Transport-neutral delivery contract.
 *
 * `ChannelContext` is the surface a `ChannelRunner` turn writes to: progress
 * updates, the final answer, side notices, and lifecycle hooks. The DingTalk
 * transport implements it via AI Card streaming (`runtime/delivery.ts`); the
 * terminal TUI implements it by rendering to the console (`tui/`). The runner
 * and `session-events` depend only on this interface, never on a concrete
 * transport.
 *
 * These declarations previously lived in `runtime/dingtalk.ts` under the name
 * `DingTalkContext`; they were lifted out (and renamed) so a second transport
 * can implement the contract without importing anything DingTalk-specific. They
 * live in `src/channel/` rather than `src/runtime/` because a port belongs with
 * the domain it describes, not with one of its adapters: `agent`, `tools` and
 * `tui` all depend on this file, and none of them should be reading anything out
 * of the DingTalk transport's directory to get it.
 */

import type { InboundImage } from "./channel-event.js";

/**
 * How progress is surfaced during a run. Derived from the transport's response
 * mode so callers never branch on the raw enum string.
 */
export type ProgressStyle = "full" | "rolling" | "none";

/** How the final answer is delivered. */
export type FinalDelivery = "plain" | "card";

/**
 * A file the agent wants to push to a channel as a native attachment (image or
 * downloadable file), as opposed to text/markdown in the transcript.
 *
 * Bytes travel in-band (`data`) rather than as a path so the sender is decoupled
 * from where the file physically lives — the `send_media` tool reads the file
 * through its `Executor` (which may be remote) and hands over the bytes, exactly
 * as `read` does for images.
 */
export interface OutboundMedia {
	/** Raw file contents. */
	data: Buffer;
	/** Display name shown to the recipient (e.g. "report.pdf"). */
	fileName: string;
	/** `image` renders inline; `file` is a downloadable attachment. */
	kind: "image" | "file";
}

export interface MediaSendResult {
	ok: boolean;
	/** Human-readable failure reason, surfaced to the agent on `ok: false`. */
	error?: string;
}

/**
 * Transport-neutral outbound-attachment port. Implemented by each transport that
 * can deliver files: the DingTalk bot uploads media and sends an image/file
 * message; the terminal writes the file to disk and prints its path. The
 * `send_media` tool depends only on this interface — never on a concrete
 * transport — and is bound to its channel at build time (like `read`/`bash`),
 * so `channelId` is supplied by the runtime, not by the model.
 */
export interface MediaSender {
	sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult>;
}

export interface ChannelContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		/** Images the user sent alongside this message (spec 049). Empty on transports (TUI) that
		 *  do not yet produce inbound attachments — the field stays optional for them. */
		images?: InboundImage[];
	};
	channelName?: string;
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	/** `title` names the reply in transports that show one (e.g. DingTalk's conversation list); ignored where there isn't one. */
	respondPlain: (text: string, shouldLog?: boolean, title?: string) => Promise<boolean>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	primeCard: (delayMs: number) => void;
	flush: () => Promise<void>;
	close: () => Promise<void>;
	progressStyle: ProgressStyle;
	finalDelivery: FinalDelivery;
}

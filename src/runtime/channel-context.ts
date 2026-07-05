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
 * `DingTalkContext`; they were lifted here (and renamed) so a second transport
 * can implement the contract without importing anything DingTalk-specific.
 */

/**
 * How progress is surfaced during a run. Derived from the transport's response
 * mode so callers never branch on the raw enum string.
 */
export type ProgressStyle = "full" | "rolling" | "none";

/** How the final answer is delivered. */
export type FinalDelivery = "plain" | "card";

export interface ChannelContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
	};
	channelName?: string;
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	respondPlain: (text: string, shouldLog?: boolean) => Promise<boolean>;
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

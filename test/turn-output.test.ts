import { describe, expect, it, vi } from "vitest";
import { TurnOutput } from "../src/agent/turn/turn-output.js";
import type { ChannelContext, TurnEvent, TurnOutcome } from "../src/channel/channel-context.js";
import { createEmptyUsageTotals } from "../src/usage/totals.js";

function recording() {
	const events: TurnEvent[] = [];
	const outcomes: TurnOutcome[] = [];
	const ctx: ChannelContext = {
		emit: (event) => events.push(event),
		finish: async (outcome) => {
			outcomes.push(outcome);
		},
	};
	return { events, outcomes, output: new TurnOutput(ctx, "dingtalk:dm:1") };
}
const usage = createEmptyUsageTotals();

describe("TurnOutput", () => {
	it("hands the transport exactly one outcome and drops everything after the turn has ended", async () => {
		const { events, outcomes, output } = recording();
		output.emit({ type: "commentary", text: "working" });
		// The user stopped it: the channel hears "cancelled" at once, whatever the epilogue says later.
		const cancelling = output.cancel({ usage });
		output.emit({ type: "answer", text: "a late answer from the aborted provider" });
		const completing = output.finish({ kind: "completed", usage });
		await Promise.all([cancelling, completing]);
		expect(events).toEqual([{ type: "commentary", text: "working" }]);
		expect(outcomes.map((outcome) => outcome.kind)).toEqual(["cancelled"]);
		expect(output.isFinished).toBe(true);
	});

	it("keeps a transport that throws from breaking the turn", async () => {
		const ctx: ChannelContext = {
			emit: () => {
				throw new Error("card api down");
			},
			finish: async () => {
				throw new Error("card api down");
			},
		};
		const output = new TurnOutput(ctx, "dingtalk:dm:1");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(() => output.emit({ type: "reasoning", text: "x" })).not.toThrow();
		await expect(output.finish({ kind: "completed", usage })).resolves.toBeUndefined();
		warn.mockRestore();
	});
});

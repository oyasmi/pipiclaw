import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SessionHost } from "../src/agent/session/session-host.js";
import { TurnPipeline } from "../src/agent/turn/turn-pipeline.js";
import { TurnStateMachine } from "../src/agent/turn/turn-state.js";
import { createEmptyRunState } from "../src/agent/types.js";
import type { DeskConversation } from "../src/desk/types.js";
import type { TaskSessionContext } from "../src/tasks/control.js";

describe("task steering at the final submission boundary", () => {
	it("fences stale preparations and submits current runtime inputs without an asynchronous extension window", async () => {
		// Spec 067 regression: AgentSession.steer awaits input handlers after our final scope
		// check. A frozen/stopped step could then receive an obsolete input. Domain lane fakes
		// and the held-provider e2e do not exercise this adapter boundary.
		// Mutation (2026-11-04): restore AgentSession.steer for scoped messages; the
		// current-input assertion fails because the async handler invalidates its scope.
		let allowed = true;
		let seq = 1;
		let retired = false;
		let entered!: () => void;
		let release!: () => void;
		let reached = Promise.resolve();
		let gate = Promise.resolve();
		const block = () => {
			reached = new Promise((resolve) => {
				entered = resolve;
			});
			gate = new Promise((resolve) => {
				release = resolve;
			});
		};
		const agent = new Agent({
			streamFn: () => {
				throw new Error("This test must never call a provider");
			},
		});
		const submitted: Array<{ current: boolean; message: AgentMessage }> = [];
		const original = agent.steer.bind(agent);
		vi.spyOn(agent, "steer").mockImplementation((message) => {
			submitted.push({ current: allowed && seq === 1 && !retired, message });
			original(message);
		});
		const interactiveSteer = vi.fn(async () => {
			await Promise.resolve();
			allowed = false;
			agent.steer({ role: "user", content: "obsolete", timestamp: 1 });
		});
		const session = { agent, steer: interactiveSteer } as unknown as AgentSession;
		const turnState = new TurnStateMachine();
		turnState.begin("task");
		turnState.setPhase(turnState.current(), "preparing");
		const pipeline = new TurnPipeline({
			profile: { kind: "task", sessionPath: "/tmp/task.jsonl", session: { seq: () => seq } as TaskSessionContext },
			conversation: { channelId: "test:1", deskDir: "/tmp" } as DeskConversation,
			workspaceDir: "/tmp",
			host: {
				session,
				ensureSessionReady: async () => {},
				runPrompt: async (operation: () => Promise<unknown>) => {
					entered();
					await gate;
					return operation();
				},
			} as unknown as SessionHost,
			models: {} as never,
			turnState,
			isRetired: () => retired,
			getRunState: createEmptyRunState,
		});
		for (const invalidate of [
			() => {
				allowed = false;
			},
			() => {
				seq = 2;
			},
			() => {
				retired = true;
			},
		]) {
			allowed = true;
			seq = 1;
			retired = false;
			block();
			const pending = pipeline.queueBusyMessage("result", undefined, undefined, {
				seq: 1,
				isCurrent: () => allowed,
			});
			await reached;
			invalidate();
			release();
			await expect(pending).resolves.toBe("stale");
		}
		expect(submitted).toHaveLength(0);
		allowed = true;
		seq = 1;
		retired = false;
		block();
		const current = pipeline.queueBusyMessage("result", undefined, undefined, { seq: 1, isCurrent: () => allowed });
		await reached;
		release();
		await expect(current).resolves.toBe("queued");
		expect(submitted).toHaveLength(1);
		expect(submitted[0].current).toBe(true);
		expect(interactiveSteer).not.toHaveBeenCalled();
	});
});

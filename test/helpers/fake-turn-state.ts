import type { TurnStatus } from "../../src/agent/types.js";

/**
 * Functional turn-state fake for AgentRunner test doubles: mirrors the real
 * runner's beginTurn/endTurn/isBusy/requestStop/getTurnStatus contract closely
 * enough for transport-level tests (busy routing, /stop, status rendering).
 */
export function createFakeTurnState() {
	let status: TurnStatus = { phase: "idle", stopRequested: false };
	let abandoned = 0;
	return {
		beginTurn(taskText: string): void {
			status = { phase: "dispatching", stopRequested: false, taskText };
		},
		endTurn(): void {
			if (abandoned > 0) {
				abandoned--;
				return;
			}
			status = { phase: "idle", stopRequested: false };
		},
		forceEndTurn(_reason: string): boolean {
			if (status.phase === "idle") return false;
			abandoned++;
			status = { phase: "idle", stopRequested: false };
			return true;
		},
		isBusy(): boolean {
			return status.phase !== "idle";
		},
		requestStop(): void {
			if (status.phase !== "idle") {
				status = { ...status, stopRequested: true };
			}
		},
		getTurnStatus(): TurnStatus {
			return { ...status };
		},
	};
}

/**
 * Inert defaults for the session-binding half of `AgentRunner` (including its (desk, channel)
 * pairing); spread first so a case can override.
 */
export function createFakeSessionBinding(
	conversation: import("../../src/desk/types.js").DeskConversation = {
		desk: "news",
		deskDir: "/tmp/desk-news",
		cwd: "/tmp/desk-news",
		channelId: "dingtalk:dm:1",
		conversation: "dm-1",
		conversationDir: "/tmp/desk-news/conversations/dm-1",
	},
) {
	return {
		conversation,
		isCompacting: () => false,
		interruptCompaction: () => false,
		bindTaskSession: async (_taskId: string): Promise<void> => {},
		bindChatSession: async (): Promise<void> => {},
		getTaskLoop: (): { taskId: string } | undefined => undefined,
		retireForNewSession: (): void => {},
		retireForRecovery: (): void => {},
	};
}

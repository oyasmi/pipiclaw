import type { TurnStatus } from "../../src/agent/types.js";

/**
 * Functional turn-state fake for AgentRunner test doubles: mirrors the real
 * runner's beginTurn/endTurn/isBusy/requestStop/getTurnStatus contract closely
 * enough for transport-level tests (busy routing, /stop, status rendering).
 */
export function createFakeTurnState() {
	let status: TurnStatus = { phase: "idle", stopRequested: false };
	return {
		beginTurn(taskText: string): void {
			status = { phase: "dispatching", stopRequested: false, taskText };
		},
		endTurn(): void {
			status = { phase: "idle", stopRequested: false };
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

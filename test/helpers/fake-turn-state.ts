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

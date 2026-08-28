import type { TurnPhase, TurnStatus } from "./types.js";

/**
 * One turn's mutable state. `current()` hands it out so the owning `run()` can address *its own*
 * turn for later phase writes: once `forceEnd()` has released a turn, the machine's current turn
 * is a different object and the stale handle must lose.
 */
export interface TurnHandle {
	phase: TurnPhase;
	stopRequested: boolean;
	taskText?: string;
}

function idleTurn(): TurnHandle {
	return { phase: "idle", stopRequested: false };
}

/**
 * The runner's turn state machine (phases documented on `TurnPhase` in types.ts). Busy state has a
 * single owner; transports call `begin`/`end` and everything else — the DingTalk busy routing, the
 * TUI turn controller, the maintenance scheduler's idle check, `/status` — derives from `isBusy()`
 * and `status()` instead of keeping a parallel flag.
 *
 * Extracted from `ChannelRunner` because its two load-bearing rules are invisible at the call sites
 * and were previously reachable only through a live SDK session:
 *
 * 1. **A force-released turn's late `end()` is swallowed.** `forceEnd` hands the channel back to the
 *    next message while the wedged turn's epilogue is still running; when that epilogue finally
 *    calls `end()`, it would otherwise clear the busy state of whichever turn started in between.
 *    `abandoned` counts those outstanding releases so each one absorbs exactly one late `end()`.
 * 2. **Phase writes are addressed to a turn, not to "whatever is current".** `setPhase` is a no-op
 *    once its handle is no longer current, for the same reason.
 *
 * No I/O and no logger import: both warning paths report through `onWarn`, so this stays a unit that
 * can be exercised directly.
 */
export class TurnStateMachine {
	private turn: TurnHandle = idleTurn();
	/** Turns released by `forceEnd` whose owner has not called `end()` yet. */
	private abandoned = 0;

	constructor(private readonly onWarn: (message: string, detail?: string) => void = () => {}) {}

	/** Reserve the machine for a turn. Transports must call this in the tick they dequeue a message. */
	begin(taskText: string): void {
		if (this.turn.phase !== "idle") {
			this.onWarn(`beginTurn while phase=${this.turn.phase}; turns must be serialized`);
		}
		this.turn = { phase: "dispatching", stopRequested: false, taskText };
	}

	/** Release the turn. Ignored when the turn was already released by `forceEnd`. */
	end(): void {
		if (this.abandoned > 0) {
			this.abandoned--;
			return;
		}
		this.turn = idleTurn();
	}

	/**
	 * Release a turn whose owner is wedged, so the channel stops reporting busy. Returns false when
	 * already idle. The wedged turn keeps running; its later `end()` is absorbed.
	 */
	forceEnd(reason: string): boolean {
		if (this.turn.phase === "idle") {
			return false;
		}
		this.onWarn(
			`Force-ending a stuck turn (phase=${this.turn.phase})`,
			`${reason}; its own teardown is still running and will be ignored when it finishes`,
		);
		this.abandoned++;
		this.turn = idleTurn();
		return true;
	}

	isBusy(): boolean {
		return this.turn.phase !== "idle";
	}

	phase(): TurnPhase {
		return this.turn.phase;
	}

	/** The live handle for the current turn, for `setPhase` and for `run()`'s own-turn capture. */
	current(): TurnHandle {
		return this.turn;
	}

	/** Advance a turn's phase, unless that turn has since been released. */
	setPhase(turn: TurnHandle, phase: TurnPhase): void {
		if (this.turn !== turn) {
			return;
		}
		this.turn.phase = phase;
	}

	/**
	 * The agent loop reported its first message. Only a turn still assembling its prompt advances;
	 * a `message_start` arriving after the turn was released must not revive the next one.
	 */
	markStreaming(): boolean {
		if (this.turn.phase !== "preparing") {
			return false;
		}
		this.turn.phase = "streaming";
		return true;
	}

	/** Mark the current turn as user-stopped (no-op when idle). */
	requestStop(): void {
		if (this.turn.phase !== "idle") {
			this.turn.stopRequested = true;
		}
	}

	status(): TurnStatus {
		return { ...this.turn };
	}
}

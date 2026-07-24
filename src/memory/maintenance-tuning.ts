/**
 * Cadence and threshold constants for the background memory maintenance
 * pipeline (spec 035 D1/D2).
 *
 * These were `settings.json` keys until 0.8.10. They are algorithm parameters,
 * not product intent: a user can decide *whether* background maintenance runs
 * (`memoryMaintenance.enabled` is still a setting), but has no basis for
 * deciding whether the checkpoint interval should be 20 minutes or 25.
 */

export interface MemoryMaintenanceTuning {
	/** How long a channel must be quiet before background LLM work is allowed. */
	minIdleMinutesBeforeLlmWork: number;
	sessionRefreshIntervalMinutes: number;
	/** Idle cadence of the merged memory checkpoint (durable extraction) job. */
	checkpointIntervalMinutes: number;
	/** Confidence bar a candidate must clear before it is written to MEMORY.md. */
	minMemoryAutoWriteConfidence: number;
	structuralMaintenanceIntervalHours: number;
	maxConcurrentChannels: number;
	failureBackoffMinutes: number;
	/** Reject a MEMORY.md cleanup whose result shrinks below this ratio of the original. */
	cleanupShrinkGuardMinRatio: number;
	/** Only apply the shrink guard when the original exceeds this length (chars). */
	cleanupShrinkGuardMinChars: number;
}

const PRODUCTION_TUNING: MemoryMaintenanceTuning = {
	minIdleMinutesBeforeLlmWork: 10,
	sessionRefreshIntervalMinutes: 10,
	checkpointIntervalMinutes: 20,
	minMemoryAutoWriteConfidence: 0.85,
	structuralMaintenanceIntervalHours: 6,
	maxConcurrentChannels: 1,
	failureBackoffMinutes: 30,
	cleanupShrinkGuardMinRatio: 0.4,
	cleanupShrinkGuardMinChars: 2_000,
};

/**
 * Test-only escape hatch. E2E and behavior-eval runs assert that `SESSION.md`
 * refreshes within tens of seconds, which the production idle/interval gates
 * make impossible. Set by `test/support/setup.ts`; deliberately undocumented in
 * `docs/configuration.md` — it is a test hook, not a supported knob.
 */
const FAST_MAINTENANCE_TUNING: MemoryMaintenanceTuning = {
	...PRODUCTION_TUNING,
	minIdleMinutesBeforeLlmWork: 0,
	sessionRefreshIntervalMinutes: 0,
	failureBackoffMinutes: 1,
};

export function getMemoryMaintenanceTuning(env: NodeJS.ProcessEnv = process.env): MemoryMaintenanceTuning {
	return env.PIPICLAW_TEST_FAST_MAINTENANCE === "1" ? FAST_MAINTENANCE_TUNING : PRODUCTION_TUNING;
}

/**
 * How much conversation must accumulate before a scheduled `SESSION.md` refresh
 * is allowed (`maintenance-gates.ts` reads these). Constants like the tuning
 * above, and lowered by the same test hook so a single-message E2E turn can
 * trip the gate instead of waiting for a natural multi-turn exchange.
 */
export interface SessionRefreshCadence {
	minTurnsBetweenUpdate: number;
	minToolCallsBetweenUpdate: number;
}

const PRODUCTION_SESSION_REFRESH: SessionRefreshCadence = {
	minTurnsBetweenUpdate: 2,
	minToolCallsBetweenUpdate: 4,
};

const FAST_SESSION_REFRESH: SessionRefreshCadence = {
	minTurnsBetweenUpdate: 1,
	minToolCallsBetweenUpdate: 1,
};

export function getSessionRefreshCadence(env: NodeJS.ProcessEnv = process.env): SessionRefreshCadence {
	return env.PIPICLAW_TEST_FAST_MAINTENANCE === "1" ? FAST_SESSION_REFRESH : PRODUCTION_SESSION_REFRESH;
}

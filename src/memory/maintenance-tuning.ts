/**
 * Cadence and threshold constants for the background reflect pass (spec 050, D7/D9).
 *
 * These were `settings.json` keys until 0.8.10, then split across three jobs' worth of
 * constants; spec 050 collapses the pipeline to one job and these to one small set. A user can
 * decide *whether* background maintenance runs (`memoryMaintenance.enabled` is still a setting),
 * but has no basis for deciding whether the reflect interval should be 20 minutes or 25.
 */

export interface MemoryMaintenanceTuning {
	/** How long a channel must be quiet before background LLM work is allowed. */
	minIdleMinutesBeforeLlmWork: number;
	/** Idle cadence of the reflect pass. */
	reflectIntervalMinutes: number;
	failureBackoffMinutes: number;
}

const PRODUCTION_TUNING: MemoryMaintenanceTuning = {
	minIdleMinutesBeforeLlmWork: 10,
	reflectIntervalMinutes: 20,
	failureBackoffMinutes: 30,
};

/**
 * Test-only escape hatch. E2E and behavior-eval runs assert that reflect fires within tens of
 * seconds, which the production idle/interval gates make impossible. Set by
 * `test/support/setup.ts`; deliberately undocumented in `docs/configuration.md` — it is a test
 * hook, not a supported knob.
 */
const FAST_MAINTENANCE_TUNING: MemoryMaintenanceTuning = {
	...PRODUCTION_TUNING,
	minIdleMinutesBeforeLlmWork: 0,
	reflectIntervalMinutes: 0,
	failureBackoffMinutes: 1,
};

/**
 * What the gates and the scheduler consume: the user's one decision (`enabled`, from
 * `settings.json`) plus the code-owned cadence constants.
 */
export type MemoryMaintenanceSettings = MemoryMaintenanceTuning & {
	enabled: boolean;
};

/**
 * What callers hand to the memory pipeline: the `settings.json` switch, optionally with explicit
 * tuning values (tests pin them); anything omitted falls back to the code constants.
 */
export type MemoryMaintenanceInput = { enabled: boolean } & Partial<MemoryMaintenanceTuning>;

export function resolveMemoryMaintenanceSettings(
	input: MemoryMaintenanceInput,
	env: NodeJS.ProcessEnv = process.env,
): MemoryMaintenanceSettings {
	return { ...getMemoryMaintenanceTuning(env), ...input };
}

export function getMemoryMaintenanceTuning(env: NodeJS.ProcessEnv = process.env): MemoryMaintenanceTuning {
	return env.PIPICLAW_TEST_FAST_MAINTENANCE === "1" ? FAST_MAINTENANCE_TUNING : PRODUCTION_TUNING;
}

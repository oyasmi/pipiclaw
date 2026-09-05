import { appendTaskLog, readTaskLog, type TaskRoundRecord } from "./log.js";
import { updateStoredTask } from "./store.js";

/**
 * Rework accounting (spec 051, D7).
 *
 * The trace this exists for: one real task ran seven builder→reviewer rounds, six advisory FAILs
 * before a PASS, over 2.4 hours of delegation wall time — and its stored state said
 * `{"verification":{"required":false,"status":"pending"}}`. The rounds were invisible, so nothing
 * could bound them and the user could not see them. Recording a round is bookkeeping the runtime
 * already has the facts for at settlement, so it happens there rather than costing a tool call
 * and a model decision (`task_verify`, retired).
 */
export interface RoundInput {
	channelDir: string;
	taskId: string;
	verifyRunId: string;
	verdict: "pass" | "fail";
	strength: "enforced" | "advisory";
	/** The delegation this verdict judged, when the caller could identify it. */
	workRunId?: string;
	/** Attributable cost of this run; `estimated` marks a fallback rather than reported usage. */
	usd?: number;
	usdEstimated?: boolean;
	/** Set when the attestation did not hold; the round is then recorded as a fail with this reason. */
	reason?: string;
}

export interface RoundResult {
	cycleId: string;
	round: number;
	/** True once `cycle.rounds` has reached the task's rework ceiling. */
	overBudget: boolean;
}

/**
 * Record one verification round against the task's current cycle and return where that leaves the
 * rework budget. Callers must guard this with their own idempotency marker: a replayed settlement
 * must not write a second round.
 */
export async function recordVerificationRound(
	input: RoundInput,
	roundsBudget: number,
): Promise<RoundResult | undefined> {
	let result: RoundResult | undefined;
	const document = await updateStoredTask(input.channelDir, input.taskId, (task) => {
		const cycle = task.fields.cycle;
		if (!cycle) return;
		const rounds = cycle.rounds + 1;
		task.fields.cycle = {
			...cycle,
			rounds,
			usd: cycle.usd + (input.usd ?? 0),
			usdEstimated: cycle.usdEstimated || Boolean(input.usdEstimated),
		};
		const ceiling = task.fields.budget?.rounds ?? roundsBudget;
		result = { cycleId: cycle.id, round: rounds, overBudget: rounds >= ceiling };
	});
	if (!document || !result) return undefined;
	await appendTaskLog(input.channelDir, input.taskId, {
		cycle: result.cycleId,
		kind: "round",
		n: result.round,
		workRunId: input.workRunId,
		verifyRunId: input.verifyRunId,
		verdict: input.verdict,
		strength: input.strength,
		reason: input.reason,
	});
	return result;
}

/** Add one run's cost to the task's current cycle. Used for `purpose=work` runs and background jobs. */
export async function recordTaskCost(
	channelDir: string,
	taskId: string,
	usd: number,
	estimated: boolean,
): Promise<void> {
	if (usd <= 0 && !estimated) return;
	await updateStoredTask(channelDir, taskId, (task) => {
		const cycle = task.fields.cycle;
		if (!cycle) return;
		task.fields.cycle = { ...cycle, usd: cycle.usd + usd, usdEstimated: cycle.usdEstimated || estimated };
	});
}

/** The rework rounds recorded in one cycle, oldest first — `/tasks show`'s verdict trail. */
export async function readCycleRounds(
	channelDir: string,
	taskId: string,
	cycle: string | undefined,
): Promise<TaskRoundRecord[]> {
	const records = await readTaskLog(channelDir, taskId, { cycle, kinds: ["round"] });
	return records.filter((record): record is TaskRoundRecord => record.kind === "round");
}

/** Whether this cycle already carries a real PASS — the only thing that may unlock `done`. */
export async function hasPassingRound(channelDir: string, taskId: string, cycle: string | undefined): Promise<boolean> {
	return (await readCycleRounds(channelDir, taskId, cycle)).some((record) => record.verdict === "pass");
}

/**
 * The two-phase "claim, then finish" decision shared by `job-manager.ts` and `subagents/runs.ts`
 * for reserving a completion wake exactly once (spec 040, D7/T9). Both managers persist a
 * `RunRecord`/`JobRecord` differently and gate eligibility on a different terminal condition
 * (job: `status !== "running"`; run: `settledAt` set), so only the claim/consume decision on the
 * two shared fields is factored out here — not the queue, the persistence, or the eligibility check.
 */
export interface WakeClaimFields {
	wakeClaimDispatchId?: string;
	wakeConsumedAt?: number;
}

/**
 * Reserve `dispatchId` as the claim on `fields`, if `eligible` (the caller's terminal/taskId/
 * dispatch-id-match check) holds and no conflicting claim or consumption already exists. Mutates
 * `fields` in place and returns whether the claim was taken; the caller persists the result and
 * rolls the mutation back on a failed write.
 */
export function beginWakeClaim(fields: WakeClaimFields, eligible: boolean, dispatchId: string): boolean {
	if (
		!eligible ||
		fields.wakeConsumedAt !== undefined ||
		(fields.wakeClaimDispatchId !== undefined && fields.wakeClaimDispatchId !== dispatchId)
	) {
		return false;
	}
	fields.wakeClaimDispatchId = dispatchId;
	return true;
}

/**
 * Mark a previously claimed wake consumed, if `dispatchId` matches the outstanding claim and it
 * has not already been consumed. Mutates `fields` in place and returns whether it changed.
 */
export function finishWakeClaim(fields: WakeClaimFields, dispatchId: string): boolean {
	if (fields.wakeClaimDispatchId !== dispatchId || fields.wakeConsumedAt !== undefined) {
		return false;
	}
	fields.wakeConsumedAt = Date.now();
	return true;
}

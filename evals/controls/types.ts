import type { TrialContext } from "../harness/schema.js";

export interface OracleControl {
	id: string;
	/** A reject needs an actual failed target oracle, not an exception or missing fixture. */
	expect: "pass" | "reject";
	risk: string;
	targets?: string[];
	from?: "empty";
	seedTrial?: number;
	apply(ctx: TrialContext): void | Promise<void>;
}

import type { ExternalRoleWarningInput } from "./harness.js";
import { getExternalHarness } from "./registry.js";

/**
 * Non-fatal external-role warnings (spec 042 D4/D10, spec 066 D6, spec 068 D7). The role still loads.
 * Shared cross-harness checks run here; CLI-specific flag/mode rules live on each `ExternalHarness`.
 */

export type { ExternalRoleWarningInput };

/** Join every applicable warning. An unlucky combination must not hide one of them. */
export function externalRoleWarning(input: ExternalRoleWarningInput): string | undefined {
	const warnings: string[] = [];
	if (input.memory !== "none") {
		warnings.push(
			`${input.entryName}: memory: ${input.memory} sends the desk memory index / journal content to this external process`,
		);
	}
	// Substring, matching the historical discovery check: `$MODEL` is a placeholder, not a flag,
	// and may sit inside a larger token (`--model=$MODEL`). `$EFFORT` has no equivalent check
	// because thinkingLevel can be supplied per invocation.
	if (input.command.includes("$MODEL") && !input.modelConfigured) {
		warnings.push(
			`${input.entryName}: command references $MODEL but no "model" is configured; that argv token will be dropped on every dispatch`,
		);
	}
	const harnessWarnings = getExternalHarness(input.harness)?.roleWarnings?.(input);
	if (harnessWarnings) warnings.push(...harnessWarnings);
	return warnings.length > 0 ? warnings.join("; ") : undefined;
}

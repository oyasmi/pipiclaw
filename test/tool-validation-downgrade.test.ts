import { validateToolArguments } from "@earendil-works/pi-ai";
import { parseToolCallArguments } from "@earendil-works/pi-ai/utils/json-parse";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { isArgumentValidationFailure } from "../src/tools/contract/details.js";

/**
 * Spec 047, D4.2: argument parsing and schema failures are produced by the SDK *before* `execute`, so each
 * carries no `details.kind` and never passes through `withToolDetails`. `session-events.ts` must
 * still treat it as a recoverable rejection (logged, kept out of the progress card) rather than a
 * user-visible tool error. This drives the real SDK validator to build the exact failure shape.
 */

const schema = Type.Object({ content: Type.String() });

/** Mirrors `agent-loop.js`'s `createErrorToolResult` for a caught validation error. */
function sdkValidationResult(rawArguments: string) {
	try {
		validateToolArguments(
			{ name: "memory_save", description: "Save memory", parameters: schema },
			{
				type: "toolCall",
				id: "invalid-call",
				name: "memory_save",
				...parseToolCallArguments(rawArguments),
			},
		);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		return {
			result: { content: [{ type: "text", text: error.message }], details: {} },
			isError: true,
		};
	}
	throw new Error("expected validation to throw");
}

describe("argument-validation failure downgrade (spec 047 D4.2)", () => {
	it("recognizes SDK validation while preserving real tool errors and normal results", () => {
		// Pi 1.3+ rejects malformed final JSON as well as schema-invalid arguments.
		for (const rawArguments of ["{}", '{"content":"partial",']) {
			const { result, isError } = sdkValidationResult(rawArguments);
			expect(isArgumentValidationFailure(result, isError)).toBe(true);
			// A stamped result went through execute; a successful call is not a failure.
			expect(isArgumentValidationFailure({ ...result, details: { kind: "memory_save" } }, true)).toBe(false);
			expect(isArgumentValidationFailure(result, false)).toBe(false);
		}
		expect(isArgumentValidationFailure({ content: [{ type: "text", text: "boom" }], details: {} }, true)).toBe(false);
	});
});

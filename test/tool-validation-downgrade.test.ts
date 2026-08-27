import { validateToolArguments } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { isArgumentValidationFailure } from "../src/tools/tool-details.js";

/**
 * Spec 047, D4.2: a schema-validation failure is produced by the SDK *before* `execute`, so it
 * carries no `details.kind` and never passes through `withToolDetails`. `session-events.ts` must
 * still treat it as a recoverable rejection (logged, kept out of the progress card) rather than a
 * user-visible tool error. This drives the real SDK validator to build the exact failure shape.
 */

const schema = Type.Object({ content: Type.String() });

/** Mirrors `agent-loop.js`'s `createErrorToolResult` for a caught validation error. */
function sdkValidationResult(): { result: unknown; isError: boolean } {
	try {
		validateToolArguments(
			{ name: "memory_save", parameters: schema } as never,
			{
				name: "memory_save",
				arguments: {},
			} as never,
		);
		throw new Error("expected validation to throw");
	} catch (error) {
		return {
			result: { content: [{ type: "text", text: (error as Error).message }], details: {} },
			isError: true,
		};
	}
}

describe("argument-validation failure downgrade (spec 047 D4.2)", () => {
	it("recognizes the SDK's own validation failure", () => {
		const { result, isError } = sdkValidationResult();
		expect(isArgumentValidationFailure(result, isError)).toBe(true);
	});

	it("does not match a real tool error or a normal result", () => {
		expect(isArgumentValidationFailure({ content: [{ type: "text", text: "boom" }], details: {} }, true)).toBe(false);
		// A result that carries details.kind went through withToolDetails — not this path.
		expect(
			isArgumentValidationFailure(
				{ content: [{ type: "text", text: 'Validation failed for tool "x"' }], details: { kind: "memory_save" } },
				true,
			),
		).toBe(false);
		// isError false → not a failure at all.
		expect(isArgumentValidationFailure({ content: [], details: {} }, false)).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { createBashTool } from "../src/tools/bash.js";
import { createEditTool } from "../src/tools/edit.js";
import { createWriteTool } from "../src/tools/write.js";

/**
 * batch 1.3: the SDK agent loop serializes a whole tool batch when *any* tool in it declares
 * `executionMode: "sequential"` (`agent-loop.js`: `hasSequentialToolCall`). `edit`/`write`/`bash`
 * can each rewrite a file, and `checkFingerprintUnchanged` runs *before* the write, so two of them
 * in one parallel batch can both pass the check and then clobber each other. Declaring the flag is
 * the whole mechanism that closes that window in-process.
 *
 * Mutation check: remove `executionMode: "sequential"` from any of the three and its case fails.
 */
const disabledSecurity = { enabled: false } as never;

describe("mutating tools declare sequential execution", () => {
	const fileStore = createFileStore();

	it("edit is sequential", () => {
		expect(createEditTool(fileStore, { securityConfig: disabledSecurity }).executionMode).toBe("sequential");
	});

	it("write is sequential", () => {
		expect(createWriteTool(fileStore, { securityConfig: disabledSecurity }).executionMode).toBe("sequential");
	});

	it("bash is sequential", () => {
		const executor = { exec: async () => ({ stdout: "", stderr: "", code: 0 }) };
		expect(createBashTool(executor, { securityConfig: disabledSecurity }).executionMode).toBe("sequential");
	});
});

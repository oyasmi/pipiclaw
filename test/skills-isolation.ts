import { join } from "node:path";
import { vi } from "vitest";

// Runtime callers deliberately have no user-configurable skill search path. Isolate their
// process-user source here, while exercising the real loader, security policy and SDK session.
vi.mock("../src/skills/roots.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/skills/roots.js")>();
	return {
		...actual,
		getSkillRoots: (workspaceDir: string, sharedSkillsDir = join(workspaceDir, ".test-shared-skills")) =>
			actual.getSkillRoots(workspaceDir, sharedSkillsDir),
	};
});

/** Initialization policy: the one Pipiclaw assistant starts with a default work context. */
import { initializeBindings } from "./bindings.js";
import { DEFAULT_DESK } from "./paths.js";
import { createDeskRecord } from "./registry.js";

/** Shared by first-run scaffolding, TUI and embedded daemon startup. Never repair an identity. */
export function initializeDefaultDesk(paths: { workspaceDir: string }): boolean {
	const bindings = initializeBindings(paths.workspaceDir);
	if (Object.values(bindings.bindings).some((binding) => binding.desk === DEFAULT_DESK)) return false;
	return createDeskRecord(paths.workspaceDir, DEFAULT_DESK, new Date()).kind === "created";
}

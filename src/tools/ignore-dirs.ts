/**
 * Directory names that discovery/search tools should never descend into. Shared by `grep` (pushed
 * down as `grep --exclude-dir=`) and `glob` (pushed down as a walk-time prune), so the two tools
 * agree on what "noise" means instead of drifting independently.
 */
export const IGNORED_DIR_SEGMENTS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"build",
	".next",
	".cache",
]);

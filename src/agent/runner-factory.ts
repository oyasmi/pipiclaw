import type { DeskConversation } from "../desk/types.js";
import { createExecutor } from "../executor.js";
import { createFileStore } from "../file-store.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { ChannelRunner } from "./channel-runner.js";
import type { AgentRunner, RunnerFactoryPaths } from "./types.js";

/**
 * Stateless: always constructs a fresh runner. The daemon (`runtime/bootstrap.ts`) and the TUI
 * (`tui/app.ts`) are the only two callers, and each already owns exactly one cache appropriate to
 * its own lifecycle (the daemon's runtime channel map with LRU eviction; the TUI's single local
 * `const`, one channel per process) — a second cache here just duplicated that ownership and
 * could hold a stale entry the real owner had already disposed.
 */
export function createRunner(conversation: DeskConversation, paths: RunnerFactoryPaths): AgentRunner {
	return new ChannelRunner(conversation, paths, {
		executor: createExecutor(),
		fileStore: createFileStore(),
		loadSecurityConfig: () => loadSecurityConfigWithDiagnostics(paths.appHomeDir),
	});
}

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PipiclawWebToolsConfig } from "../config/tools.js";
import type { Executor } from "../executor.js";
import type { FileStore } from "../file-store.js";
import type { SecurityConfig, SecurityRuntimeContext } from "../security/types.js";

/**
 * Everything the tool registry needs to build one sub-agent's tool set. Declared here, not
 * imported, so `subagents/` never depends on `tools/`: the composition root injects
 * `buildWorkerTools` (spec 054 D9). Structurally a subset of `ToolBuildContext`.
 */
export interface WorkerToolRequest {
	executor: Executor;
	fileStore: FileStore;
	securityConfig: SecurityConfig;
	securityContext: SecurityRuntimeContext;
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	webConfig?: PipiclawWebToolsConfig;
	rtkEnabled?: boolean;
	bashDefaultTimeoutSeconds: number;
}

/** Builds a sub-agent's scoped tool set from the shared registry; injected by `tools/index.ts`. */
export type BuildWorkerTools = (request: WorkerToolRequest) => AgentTool<any>[];

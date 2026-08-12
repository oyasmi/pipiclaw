export interface SecurityConfig {
	enabled: boolean;
	commandGuard: {
		enabled: boolean;
		additionalDenyPatterns: string[];
		allowPatterns: string[];
		blockObfuscation: boolean;
	};
	pathGuard: {
		enabled: boolean;
		readAllow: string[];
		readDeny: string[];
		writeAllow: string[];
		writeDeny: string[];
		resolveSymlinks: boolean;
	};
	networkGuard: {
		enabled: boolean;
		allowedCidrs: string[];
		allowedHosts: string[];
		maxRedirects: number;
	};
	audit: {
		logBlocked: boolean;
		logFile?: string;
	};
	/**
	 * Absent (no `projectAccess` key in `security.json` at all) is a distinct, meaningful state
	 * from present-with-omitted-fields: absent is the upgrade-compat path (`ProjectScope.boundary`
	 * stays `"unbounded"`, `/project set` is disabled); present means the operator has opted into
	 * project boundaries (spec 043, D3.2). See `src/security/project-scope.ts` for the resolved,
	 * canonicalized policy this raw section feeds into.
	 */
	projectAccess?: {
		defaultRoot?: string;
		allowedRoots?: string[];
	};
}

export interface SecurityRuntimeContext {
	agentWorkspaceDir: string;
	projectRoot?: string;
	/**
	 * `"project"`: generic file tools are bounded to `projectRoot`; `security.json`'s configured
	 * `readAllow`/`writeAllow` can narrow within it but never widen past it (spec 043, D6.2).
	 * `"unbounded"` (the default when omitted, for backward compat): today's global pathGuard
	 * defaults — `agentWorkspaceDir` + temp + `homeDir`.
	 */
	boundary?: "project" | "unbounded";
	homeDir?: string;
}

export interface PathGuardContext extends SecurityRuntimeContext {
	config: SecurityConfig["pathGuard"];
}

export interface PathGuardResult {
	allowed: boolean;
	operation: "read" | "write";
	category?: string;
	reason?: string;
	rawPath: string;
	resolvedPath?: string;
}

export interface CommandGuardResult {
	allowed: boolean;
	category?: string;
	rule?: string;
	reason?: string;
	matchedText?: string;
}

export interface SecurityLogEventBase {
	tool: string;
	channelId?: string;
}

export interface BlockedPathLogEvent extends SecurityLogEventBase {
	type: "path";
	rawPath: string;
	operation: "read" | "write";
	resolvedPath?: string;
	category?: string;
	reason?: string;
}

export interface BlockedCommandLogEvent extends SecurityLogEventBase {
	type: "command";
	command: string;
	category?: string;
	rule?: string;
	reason?: string;
	matchedText?: string;
}

export interface BlockedNetworkLogEvent extends SecurityLogEventBase {
	type: "network";
	url: string;
	stage: "request" | "redirect";
	resolvedHost?: string;
	resolvedAddress?: string;
	category?: string;
	reason?: string;
}

/**
 * A *permitted* external delegation dispatch (spec 040, D8.1). Unlike the three events above,
 * this records an action that was executed, not one that was blocked — external runs never pass
 * through command-guard, so the argv actually spawned has to be captured somewhere. `audit.logBlocked`
 * must not suppress it: see `logSecurityEvent`.
 */
export interface ExternalAgentLogEvent extends SecurityLogEventBase {
	type: "external-agent";
	runId: string;
	agent: string;
	harness: string;
	argv: string[];
	workingDirectory: string;
	mutates: "read" | "write";
	model?: string;
}

export type SecurityLogEvent =
	| BlockedPathLogEvent
	| BlockedCommandLogEvent
	| BlockedNetworkLogEvent
	| ExternalAgentLogEvent;

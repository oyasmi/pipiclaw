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
}

export interface SecurityRuntimeContext {
	workspaceDir: string;
	workspacePath: string;
	cwd?: string;
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

export type SecurityLogEvent = BlockedPathLogEvent | BlockedCommandLogEvent | BlockedNetworkLogEvent;

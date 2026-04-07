export interface ConfigDiagnostic {
	source: "settings" | "tools" | "security";
	path: string;
	severity: "warning" | "error";
	message: string;
}

export function formatConfigDiagnostic(diagnostic: ConfigDiagnostic): string {
	return `${diagnostic.source}.json: ${diagnostic.message}`;
}

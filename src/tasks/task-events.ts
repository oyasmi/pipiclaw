export interface ParsedTaskEventName {
	id: string;
	use: string;
}

export function taskEventPrefix(channelId: string, id?: string): string {
	return id ? `task.${channelId}.${id}.` : `task.${channelId}.`;
}

export function parseTaskEventName(name: string, channelId: string): ParsedTaskEventName | undefined {
	const normalized = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
	const prefix = taskEventPrefix(channelId);
	if (!normalized.startsWith(prefix)) return undefined;
	const rest = normalized.slice(prefix.length);
	const lastDot = rest.lastIndexOf(".");
	if (lastDot <= 0 || lastDot === rest.length - 1) return undefined;
	return { id: rest.slice(0, lastDot), use: rest.slice(lastDot + 1) };
}

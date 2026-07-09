export interface ParsedTaskEventName {
	id: string;
	use: string;
}

export interface TaskEventLike {
	id?: string;
	use?: string;
	event?: { type: string };
}

type EventOf<T> = T extends { event?: infer E } ? E : never;

export function taskEventPrefix(channelId: string, id?: string): string {
	return id ? `task.${channelId}.${id}.` : `task.${channelId}.`;
}

export function taskEventName(channelId: string, id: string, use: string): string {
	return `${taskEventPrefix(channelId, id)}${use}`;
}

export function taskScheduleEventName(channelId: string, id: string): string {
	return taskEventName(channelId, id, "schedule");
}

export function taskScheduleEventFilename(channelId: string, id: string): string {
	return `${taskScheduleEventName(channelId, id)}.json`;
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

export function isTaskScheduleEvent<T extends TaskEventLike>(
	info: T,
): info is T & { use: "schedule"; event: Extract<EventOf<T>, { type: "periodic" }> } {
	return info.use === "schedule" && info.event?.type === "periodic";
}

export function isTaskCheckinEvent<T extends TaskEventLike>(
	info: T,
): info is T & { use: "checkin"; event: Extract<EventOf<T>, { type: "one-shot" }> } {
	return info.use === "checkin" && info.event?.type === "one-shot";
}

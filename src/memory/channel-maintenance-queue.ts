import { createSerialQueue } from "../shared/serial-queue.js";

export interface ChannelMemoryQueue {
	run<T>(channelId: string, job: () => Promise<T>): Promise<T>;
}

export function createChannelMemoryQueue(): ChannelMemoryQueue {
	return createSerialQueue<string>();
}

const defaultChannelMemoryQueue = createChannelMemoryQueue();

export function getDefaultChannelMemoryQueue(): ChannelMemoryQueue {
	return defaultChannelMemoryQueue;
}

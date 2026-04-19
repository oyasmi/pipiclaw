export interface ChannelMemoryQueue {
	run<T>(channelId: string, job: () => Promise<T>): Promise<T>;
}

export function createChannelMemoryQueue(): ChannelMemoryQueue {
	const chains = new Map<string, Promise<void>>();

	return {
		run<T>(channelId: string, job: () => Promise<T>): Promise<T> {
			const previous = chains.get(channelId) ?? Promise.resolve();
			const result = previous.catch(() => undefined).then(() => job());
			const completion = result.then(
				() => undefined,
				() => undefined,
			);
			chains.set(channelId, completion);
			completion.finally(() => {
				if (chains.get(channelId) === completion) {
					chains.delete(channelId);
				}
			});
			return result;
		},
	};
}

const defaultChannelMemoryQueue = createChannelMemoryQueue();

export function getDefaultChannelMemoryQueue(): ChannelMemoryQueue {
	return defaultChannelMemoryQueue;
}

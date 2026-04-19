export interface SerialQueue<Key = string> {
	run<T>(key: Key, job: () => Promise<T>): Promise<T>;
}

export function createSerialQueue<Key = string>(): SerialQueue<Key> {
	const chains = new Map<Key, Promise<void>>();

	return {
		run<T>(key: Key, job: () => Promise<T>): Promise<T> {
			const previous = chains.get(key) ?? Promise.resolve();
			const result = previous.catch(() => undefined).then(() => job());
			const completion = result.then(
				() => undefined,
				() => undefined,
			);
			chains.set(key, completion);
			completion.finally(() => {
				if (chains.get(key) === completion) {
					chains.delete(key);
				}
			});
			return result;
		},
	};
}

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const authPaths = new WeakMap<ModelRuntime, string>();
const pendingByPath = new Map<string, Map<Promise<void>, ModelRuntime>>();

/** Track work, not idle runtimes: detached maintenance must not accumulate SDK instances. */
export function registerModelRuntime(runtime: ModelRuntime, authPath: string): void {
	authPaths.set(runtime, authPath);
}

/** A cancelled caller can leave a rotated OAuth token still being saved by the SDK. */
export function trackModelWork<T>(runtime: ModelRuntime, run: () => Promise<T>): Promise<T> {
	const operation = Promise.resolve().then(run);
	const authPath = authPaths.get(runtime);
	if (authPath) {
		const pending = pendingByPath.get(authPath) ?? new Map<Promise<void>, ModelRuntime>();
		pendingByPath.set(authPath, pending);
		const settled = operation.then(
			() => runtime.settleCredentialWrites(),
			() => runtime.settleCredentialWrites(),
		);
		pending.set(settled, runtime);
		const remove = () => {
			pending.delete(settled);
			if (pending.size === 0) pendingByPath.delete(authPath);
		};
		void settled.then(remove, remove);
	}
	return operation;
}

/** The runtime's shutdown phase supplies the deadline and retains the daemon lock on timeout. */
export async function flushModelCredentials(authPath: string): Promise<void> {
	for (;;) {
		const pending = pendingByPath.get(authPath);
		if (!pending?.size) return;
		await Promise.all([
			...pending.keys(),
			...[...new Set(pending.values())].map((runtime) => runtime.settleCredentialWrites()),
		]);
	}
}

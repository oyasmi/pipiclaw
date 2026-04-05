import { existsSync, readFileSync } from "fs";

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
	label: string,
	check: () => T | null | undefined | false,
	options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
	const timeoutMs = options?.timeoutMs ?? 30_000;
	const intervalMs = options?.intervalMs ?? 500;
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const value = check();
		if (value) {
			return value;
		}
		await sleep(intervalMs);
	}

	throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

export async function waitForFile(
	path: string,
	options?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
	return waitFor(
		`file ${path}`,
		() => {
			if (!existsSync(path)) return null;
			return readFileSync(path, "utf-8");
		},
		options,
	);
}

export async function waitForFileContent(
	path: string,
	predicate: (content: string) => boolean,
	options?: { timeoutMs?: number; intervalMs?: number },
): Promise<string> {
	return waitFor(
		`file content ${path}`,
		() => {
			if (!existsSync(path)) return null;
			const content = readFileSync(path, "utf-8");
			return predicate(content) ? content : null;
		},
		options,
	);
}

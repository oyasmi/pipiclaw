import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../shared/type-guards.js";

function hasCode(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}

/** Installation identity is published once, without ever replacing another process's winner. */
export async function getLoginInstallationId(appHomeDir: string, signal: AbortSignal): Promise<string> {
	if (!isAbsolute(appHomeDir))
		throw new Error("OAuth identity requires an absolute appHomeDir. Pass the resolved application path.");
	const directory = join(appHomeDir, "state", "auth");
	const path = join(directory, "identity.json");
	const readIdentity = async () => {
		const data: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			!isRecord(data) ||
			data.version !== 1 ||
			typeof data.installationId !== "string" ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.installationId)
		) {
			throw new Error("Invalid installation identity schema or version");
		}
		return data.installationId;
	};
	let temporary: string | undefined;
	try {
		signal.throwIfAborted();
		try {
			const id = await readIdentity();
			signal.throwIfAborted();
			return id;
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
		signal.throwIfAborted();
		await mkdir(directory, { recursive: true, mode: 0o700 });
		signal.throwIfAborted();
		const installationId = randomUUID();
		const candidatePath = join(directory, `.identity-${randomUUID()}.tmp`);
		const file = await open(candidatePath, "wx", 0o600);
		temporary = candidatePath;
		try {
			await file.writeFile(`${JSON.stringify({ version: 1, installationId })}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		signal.throwIfAborted();
		let winner: string = installationId;
		try {
			await link(temporary, path);
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
			winner = await readIdentity();
		}
		// A published identity survives cancellation; finish its durability and cleanup first.
		const dir = await open(directory, "r");
		try {
			await dir.sync();
		} finally {
			await dir.close();
		}
		signal.throwIfAborted();
		return winner;
	} catch (error) {
		if (signal.aborted) throw error;
		throw new Error(
			`OAuth installation identity failed at ${path}. Check storage access and restore a valid identity from backup before retrying; do not reset an existing identity.`,
			{ cause: error },
		);
	} finally {
		if (temporary)
			await unlink(temporary).catch((error: unknown) => {
				if (!hasCode(error, "ENOENT"))
					throw new Error(
						`OAuth installation identity cleanup failed at ${directory}. Check storage access before retrying.`,
						{ cause: error },
					);
			});
	}
}

/** Pending remote-card termination handles. No business content or access tokens are persisted. */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicallySync } from "../shared/atomic-file.js";
import { isRecord } from "../shared/type-guards.js";

export interface CardHandle {
	key: string;
	instanceId: string;
	templateKey: string;
}

function filename(id: string): string {
	return `${createHash("sha256").update(id).digest("hex")}.json`;
}

export class CardHandles {
	private readonly directory?: string;
	private readonly entries = new Map<string, CardHandle>();
	constructor(stateDir?: string) {
		this.directory = stateDir ? join(stateDir, "dingtalk", "card-handles") : undefined;
		if (!this.directory) return;
		let names: string[];
		try {
			names = readdirSync(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw new Error("Card handles could not be loaded; inspect the transport state before restarting.", {
				cause: error,
			});
		}
		for (const name of names.filter((entry) => entry.endsWith(".json"))) {
			let item: unknown;
			try {
				item = JSON.parse(readFileSync(join(this.directory, name), "utf-8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw new Error("Card handle could not be read; inspect the transport state before restarting.", {
					cause: error,
				});
			}
			if (
				!isRecord(item) ||
				typeof item.key !== "string" ||
				!item.key ||
				typeof item.instanceId !== "string" ||
				!item.instanceId ||
				typeof item.templateKey !== "string" ||
				!item.templateKey ||
				filename(item.instanceId) !== name
			)
				throw new Error("Invalid card handle; inspect the transport state before restarting.");
			this.entries.set(item.instanceId, {
				key: item.key,
				instanceId: item.instanceId,
				templateKey: item.templateKey,
			});
		}
	}
	list(): CardHandle[] {
		return [...this.entries.values()];
	}
	remember(handle: CardHandle): void {
		if (this.directory)
			writeFileAtomicallySync(join(this.directory, filename(handle.instanceId)), JSON.stringify(handle));
		this.entries.set(handle.instanceId, handle);
	}
	forget(id: string): void {
		// Per-card files let a late old callback remove only its own handle, never a newer
		// controller's records from an obsolete cached snapshot.
		if (this.directory) {
			try {
				unlinkSync(join(this.directory, filename(id)));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		this.entries.delete(id);
	}
}

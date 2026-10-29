// A separate process is essential here: SIGKILL must remove all old callbacks and caches.
// Only DingTalk delivery/socket I/O is replaced; bootstrap, queues, runs and storage are real.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DingTalkBot } from "../../dist/dingtalk/bot.js";
import { DingTalkTransport } from "../../dist/dingtalk/transport.js";
import { createRuntimeContext } from "../../dist/runtime/bootstrap.js";
import { beginStep } from "../../dist/tasks/store.js";

const homeDir = process.argv[2];
const workspaceDir = join(homeDir, "workspace");
const paths = { appName: "pipiclaw", appHomeDir: homeDir, workspaceDir };
for (const name of ["auth", "channel", "models", "settings", "tools", "security"]) {
	paths[`${name}ConfigPath`] = join(homeDir, `${name}.json`);
}
paths.eventHistoryPath = join(homeDir, "state", "events", "history.jsonl");
const config = {
	clientId: "e2e",
	clientSecret: "e2e",
	robotCode: "e2e",
	cardTemplateKey: "content",
	stateDir: join(homeDir, "state"),
};
class CapturedBot extends DingTalkBot {
	async start() {}
	async sendPlain() {
		return true;
	}
	async ensureCard() {}
	async replaceCard() {
		return true;
	}
	async appendToCard() {
		return true;
	}
	async finalizeCard() {
		return true;
	}
	async finalizeExistingCard() {
		return true;
	}
}
// A test-owned barrier at the snapshot commit point; no runtime hook or uid assumption.
let heldTaskCommit;
const rename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
	if (to === heldTaskCommit) {
		process.send({ value: "task-commit-held" });
		await new Promise(() => {});
	}
	return rename(from, to);
};
syncBuiltinESMExports();

const runtime = await createRuntimeContext({
	paths,
	transports: [
		new DingTalkTransport({
			config,
			archiveBotResponse: (channelId, text) => runtime.store.logBotResponse(channelId, text, String(Date.now())),
			createBot: (ingress) => new CapturedBot(ingress, config),
		}),
	],
	registerSignalHandlers: false,
	startServices: false,
	createEventsWatcher: () => ({ start() {}, stop() {} }),
});
process.on("message", async ({ action, text, channelId, runId, taskId, desk = "e2e" }) => {
	try {
		let value;
		if (action === "send") {
			await runtime.ingress.routeEvent({
				source: "human",
				channelId,
				text,
				ts: String(Date.now()),
				user: "e2e",
				userName: "E2E",
			});
		} else if (action === "turn") {
			await runtime.ingress.handleEvent({
				source: "human", channelId, text, ts: String(Date.now()), user: "e2e", userName: "E2E",
			});
		} else if (action === "task-hold-commit") {
			heldTaskCommit = join(workspaceDir, `desk-${desk}`, "tasks", `${taskId}.md`);
		} else if (action === "task-scan") {
			await runtime.taskLane.runOnce();
		} else if (action === "task-drain") {
			await runtime.taskLane.drained();
		} else if (action === "task-begin") {
			await beginStep(join(workspaceDir, `desk-${desk}`), taskId, { brief: "full" });
		} else if (action === "maintenance") {
			await runtime.memoryMaintenance.runOnce();
		} else if (action === "record") {
			// Runs are owned per desk (spec 058, D15); the record keeps its originating channel.
			value = runtime.runs.get(desk).get(runId) ?? null;
		} else {
			throw new Error(`Unknown worker action: ${action}`);
		}
		process.send({ value });
	} catch (error) {
		process.send({ error: String(error) });
	}
});
process.send({ ready: true });

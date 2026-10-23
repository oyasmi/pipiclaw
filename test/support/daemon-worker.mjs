// A separate process is essential here: SIGKILL must remove all old callbacks and caches.
// Only DingTalk delivery/socket I/O is replaced; bootstrap, queues, runs and storage are real.
import { join } from "node:path";
import { DingTalkBot } from "../../dist/dingtalk/bot.js";
import { createRuntimeContext } from "../../dist/runtime/bootstrap.js";

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
const runtime = await createRuntimeContext({
	paths,
	dingtalkConfig: config,
	registerSignalHandlers: false,
	startServices: false,
	createBot: (handler) => new CapturedBot(handler, config),
	createEventsWatcher: () => ({ start() {}, stop() {} }),
});
process.on("message", async ({ action, text, channelId, runId, dot = "e2e" }) => {
	try {
		let value;
		if (action === "send") {
			await runtime.bot.routeInboundEvent({
				type: "dm",
				channelId,
				text,
				ts: String(Date.now()),
				user: "e2e",
				userName: "E2E",
				conversationId: "conv_e2e",
				conversationType: "1",
			});
		} else if (action === "turn") {
			await runtime.handler.handleEvent({
				type: "dm", channelId, text, ts: String(Date.now()), user: "e2e", userName: "E2E",
				conversationId: "conv_e2e", conversationType: "1",
			}, runtime.bot);
		} else if (action === "maintenance") {
			await runtime.memoryMaintenance.runOnce();
		} else if (action === "record") {
			// Runs are owned per dot (spec 058, D15); the record keeps its originating channel.
			value = runtime.runs.get(dot).get(runId) ?? null;
		} else {
			throw new Error(`Unknown worker action: ${action}`);
		}
		process.send({ value });
	} catch (error) {
		process.send({ error: String(error) });
	}
});
process.send({ ready: true });

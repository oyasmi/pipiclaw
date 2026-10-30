// A separate process is essential here: SIGKILL must remove all old callbacks and caches.
// Only DingTalk delivery/socket I/O is replaced; bootstrap, queues, runs and storage are real.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DingTalkBot } from "../../dist/dingtalk/bot.js";
import { DingTalkTransport } from "../../dist/dingtalk/transport.js";
import { createRuntimeContext } from "../../dist/runtime/bootstrap.js";
import { beginStep } from "../../dist/tasks/store.js";
import { readTaskDeliveries } from "../../dist/tasks/delivery.js";

const homeDir = process.argv[2];
const workspaceDir = join(homeDir, "workspace");
let clockOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;
let deliveryMode;
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
	async sendPlain(channelId, text) {
		const queued = await readTaskDeliveries(join(workspaceDir, "desk-e2e"));
		const kind = queued.find((message) => message.text === text)?.kind;
		const mode = deliveryMode && deliveryMode.kind === kind ? deliveryMode.mode : undefined;
		fs.appendFileSync(join(homeDir, "state", "captured-deliveries.jsonl"), `${JSON.stringify({ channelId, kind, text, accepted: mode !== "fail" })}\n`);
		if (mode === "fail") return false;
		if (mode === "hold") {
			process.send({ value: "task-delivery-held" });
			await new Promise(() => {});
		}
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
let heldArchive;
const holdArchive = async (path, point) => {
	if (heldArchive?.path === path && heldArchive.point === point) {
		process.send({ value: "task-archive-held" });
		await new Promise(() => {});
	}
};
const rename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
	if (to === heldTaskCommit) {
		process.send({ value: "task-commit-held" });
		await new Promise(() => {});
	}
	const result = await rename(from, to);
	await holdArchive(to, "published");
	return result;
};
const remove = fs.promises.rm;
fs.promises.rm = async (path, options) => {
	const result = await remove(path, options);
	await holdArchive(path, "removed");
	return result;
};
const append = fs.promises.appendFile;
fs.promises.appendFile = async (path, data, options) => {
	const result = await append(path, data, options);
	if (typeof data === "string" && data.includes('"kind":"close"')) await holdArchive(path, "intent");
	return result;
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
process.on("message", async ({ action, text, channelId, runId, taskId, mode, kind, point, desk = "e2e" }) => {
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
		} else if (action === "task-hold-archive") {
			const tasks = join(workspaceDir, `desk-${desk}`, "tasks");
			heldArchive = point === "intent"
				? { path: join(tasks, `${taskId}.jsonl`), point: "intent" }
				: point === "cleanup"
				? { path: join(tasks, `${taskId}.md`), point: "removed" }
				: { path: join(tasks, "archive", `${taskId}.${point === "log" ? "jsonl" : "md"}`), point: "published" };
		} else if (action === "task-delivery-mode") {
			deliveryMode = { mode, kind };
		} else if (action === "task-clock") {
			clockOffset = Number(text);
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

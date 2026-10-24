// A separate process, so SIGKILL leaves exactly what a real crash would. Only the Web API
// transport is loaded; bootstrap, queues, the store and the session files are real.
// argv: <home> <tcp port> <key sha256>
import { join } from "node:path";
import { createRuntimeContext } from "../../dist/runtime/bootstrap.js";
import { WebApiTransport } from "../../dist/webapi/transport.js";

const [homeDir, port, sha256] = process.argv.slice(2);
const workspaceDir = join(homeDir, "workspace");
const paths = { appName: "pipiclaw", appHomeDir: homeDir, workspaceDir };
for (const name of ["auth", "channel", "models", "settings", "tools", "security"]) {
	paths[`${name}ConfigPath`] = join(homeDir, `${name}.json`);
}
paths.eventHistoryPath = join(homeDir, "state", "events", "history.jsonl");
const config = {
	socket: false,
	tcp: { host: "127.0.0.1", port: Number(port), loopback: true },
	keys: [{ name: "test", sha256, desks: ["e2e"] }],
};
const runtime = await createRuntimeContext({
	paths,
	transports: [new WebApiTransport({ config, stateDir: join(homeDir, "state", "webapi"), audit: () => undefined })],
	registerSignalHandlers: false,
	startServices: false,
	createEventsWatcher: () => ({ start() {}, stop() {} }),
});
await runtime.transports.startAll(runtime.ingress);
process.send({ ready: true });

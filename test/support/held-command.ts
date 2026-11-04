import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { shellEscape } from "../../src/shared/os.js";

/** A real detached command whose completion the test controls without a sleep or polling. */
export async function heldCommand(directory: string, marker: string) {
	let socket: Socket | undefined;
	const server = createServer((connected) => {
		socket = connected;
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const arrived = once(server, "connection").then(() => undefined);
	const port = (server.address() as { port: number }).port;
	const path = join(directory, `${marker}.mjs`);
	writeFileSync(
		path,
		`import { connect } from "node:net";\nconst socket = connect(${port}, "127.0.0.1");\nsocket.on("end", () => { console.log(${JSON.stringify(marker)}); process.exit(0); });\n`,
	);
	return {
		command: `${shellEscape(process.execPath)} ${shellEscape(path)}`,
		arrived,
		release: () => socket?.end(),
		close: async () => {
			socket?.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/**
 * `pipiclaw webapi key add|list|remove` (spec 061, D3): the deployer's way to manage the keys in
 * `channel.json`. A key is generated here, printed once, and only its hash is written down. The
 * running daemon reads keys at start, so a change takes effect on its next restart.
 */
import { readFileSync } from "node:fs";
import { BootstrapExitError, type BootstrapIO, type BootstrapPaths, DEFAULT_BOOTSTRAP_PATHS } from "../app/home.js";
import { isDeskName } from "../desk/paths.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { generateKey, hashKey } from "./auth.js";
import { KEY_NAME_PATTERN } from "./config.js";

const USAGE = [
	"Usage:",
	"  pipiclaw webapi key add <name> --desk <desk> [--desk <desk>…]   Create a key (shown once)",
	"  pipiclaw webapi key list                                       List key names and their desks",
	"  pipiclaw webapi key remove <name>                              Delete a key",
];

function fail(io: BootstrapIO, message: string): never {
	io.error(message);
	throw new BootstrapExitError(1);
}

interface KeyEntry {
	name: string;
	sha256: string;
	desks: string[];
}

function readConfig(paths: BootstrapPaths, io: BootstrapIO): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(paths.channelConfigPath, "utf-8"));
		if (isPlainObject(parsed)) return parsed;
		return fail(io, `${paths.channelConfigPath} is not a JSON object.`);
	} catch (error) {
		return fail(io, `Cannot read ${paths.channelConfigPath}: ${errorMessage(error)}`);
	}
}

/** The `webapi.keys` array of `config`, created (with the section) when absent. */
function keysOf(config: Record<string, unknown>): KeyEntry[] {
	const section = isPlainObject(config.webapi) ? config.webapi : { enabled: false, socket: true };
	config.webapi = section;
	const keys = Array.isArray(section.keys) ? (section.keys as KeyEntry[]) : [];
	section.keys = keys;
	return keys;
}

async function save(paths: BootstrapPaths, config: Record<string, unknown>): Promise<void> {
	// `preserveMode` keeps channel.json owner-only: it holds credentials.
	await writeFileAtomically(paths.channelConfigPath, `${JSON.stringify(config, null, 2)}\n`, { preserveMode: true });
}

function parseDesks(args: string[], io: BootstrapIO): string[] {
	const desks: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		if (args[index] !== "--desk") fail(io, `Unexpected argument: ${args[index]}\n${USAGE.join("\n")}`);
		const desk = args[++index];
		if (!desk || !isDeskName(desk))
			fail(io, `--desk needs a valid desk name (lower-case letters, digits, '-'), got: ${desk ?? "nothing"}`);
		if (!desks.includes(desk)) desks.push(desk);
	}
	return desks;
}

export async function runWebApiCommand(
	argv: string[],
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
	io: BootstrapIO = console,
): Promise<void> {
	const [group, action, name, ...rest] = argv.slice(3);
	if (argv[2] !== "webapi" || group !== "key") fail(io, USAGE.join("\n"));

	if (action === "list") {
		const keys = keysOf(readConfig(paths, io));
		if (keys.length === 0) io.log("No keys. Create one with `pipiclaw webapi key add <name> --desk <desk>`.");
		for (const key of keys) io.log(`${key.name}\tdesks: ${key.desks.join(", ")}`);
		return;
	}

	if (action === "add") {
		if (!name || !KEY_NAME_PATTERN.test(name)) {
			fail(
				io,
				`A key name is 1–32 characters of a-z, 0-9 and '-', starting with a letter or digit.\n${USAGE.join("\n")}`,
			);
		}
		const desks = parseDesks(rest, io);
		if (desks.length === 0) fail(io, `Give at least one desk the key may use: --desk <desk>.\n${USAGE.join("\n")}`);
		const config = readConfig(paths, io);
		const keys = keysOf(config);
		if (keys.some((key) => key.name === name)) fail(io, `A key named "${name}" already exists; remove it first.`);
		const key = generateKey();
		keys.push({ name, sha256: hashKey(key), desks });
		await save(paths, config);
		io.log(`Key for "${name}" (desks: ${desks.join(", ")}). It is shown once; store it now:`);
		io.log("");
		io.log(`  ${key}`);
		io.log("");
		io.log(
			`Restart the daemon to load it. A key is only used on the TCP listener (webapi.tcp), which is off by default.`,
		);
		return;
	}

	if (action === "remove") {
		if (!name || rest.length > 0) fail(io, USAGE.join("\n"));
		const config = readConfig(paths, io);
		const keys = keysOf(config);
		const index = keys.findIndex((key) => key.name === name);
		if (index < 0) fail(io, `No key named "${name}".`);
		keys.splice(index, 1);
		await save(paths, config);
		io.log(`Removed key "${name}". Restart the daemon for it to stop working.`);
		return;
	}

	fail(io, USAGE.join("\n"));
}

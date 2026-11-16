/**
 * `pipiclaw webapi key add|list|remove` (spec 061, D3): the deployer's way to manage the keys in
 * `channel.json`. A key is generated here, printed once, and only its hash is written down.
 */
import { readFileSync } from "node:fs";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	DEFAULT_BOOTSTRAP_PATHS,
	printBootstrapSummary,
} from "../app/home.js";
import { generateWebApiKey, hashWebApiKey } from "../channel/config.js";
import { DEFAULT_DESK, isDeskName } from "../desk/paths.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { KEY_NAME_PATTERN, RESERVED_KEY_NAME } from "./config.js";

const USAGE = [
	"用法：",
	"  pipiclaw webapi key add <名称> [--desk <工位>…]   创建访问密钥（明文仅展示一次；省略 --desk 时默认授权 default 工位）",
	"  pipiclaw webapi key list                          查看已创建的密钥名称及授权工位",
	"  pipiclaw webapi key remove <名称>                 删除指定密钥",
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
		return fail(io, `${paths.channelConfigPath} 内容不是合法的 JSON 对象。`);
	} catch (error) {
		return fail(io, `无法读取 ${paths.channelConfigPath}：${errorMessage(error)}`);
	}
}

/** The `webapi.keys` array of `config`, created (with the section) when absent. */
function keysOf(config: Record<string, unknown>): KeyEntry[] {
	const section = isPlainObject(config.webapi)
		? config.webapi
		: { enabled: true, socket: true, tcp: "127.0.0.1:8787" };
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
		if (args[index] !== "--desk") fail(io, `未知参数：${args[index]}\n${USAGE.join("\n")}`);
		const desk = args[++index];
		if (!desk || !isDeskName(desk))
			fail(io, `--desk 需要合法的工位名称（小写字母、数字、连字符 '-'），收到：${desk ?? "空"}`);
		if (!desks.includes(desk)) desks.push(desk);
	}
	return desks.length > 0 ? desks : [DEFAULT_DESK];
}

export async function runWebApiCommand(
	argv: string[],
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
	io: BootstrapIO = console,
): Promise<void> {
	const [group, action, name, ...rest] = argv.slice(3);
	if (argv[2] !== "webapi" || group !== "key") fail(io, USAGE.join("\n"));

	if (action !== "list" && action !== "add" && action !== "remove") {
		fail(io, USAGE.join("\n"));
	}

	printBootstrapSummary(bootstrapAppHome(paths), io, paths);

	if (action === "list") {
		const keys = keysOf(readConfig(paths, io));
		if (keys.length === 0) io.log("当前未配置任何密钥。可执行 `pipiclaw webapi key add default` 创建。");
		for (const key of keys) io.log(`${key.name}\t工位: ${key.desks.join(", ")}`);
		return;
	}

	if (action === "add") {
		if (name === RESERVED_KEY_NAME) {
			fail(io, `名称 '${RESERVED_KEY_NAME}' 为本机 socket 保留标识，请换一个名称。`);
		}
		if (!name || !KEY_NAME_PATTERN.test(name)) {
			fail(io, `密钥名称需为 1–32 位的小写字母、数字或 '-'，且以字母或数字开头。\n${USAGE.join("\n")}`);
		}
		const desks = parseDesks(rest, io);
		const config = readConfig(paths, io);
		const keys = keysOf(config);
		if (keys.some((key) => key.name === name)) {
			fail(io, `名为 "${name}" 的密钥已存在；如需重置请先执行 \`pipiclaw webapi key remove ${name}\`。`);
		}
		const key = generateWebApiKey();
		keys.push({ name, sha256: hashWebApiKey(key), desks });
		await save(paths, config);
		io.log(`✅ 已创建密钥 "${name}"（授权工位：${desks.join(", ")}）。明文仅显示这一次，请立即保存：`);
		io.log("");
		io.log(`  ${key}`);
		io.log("");
		io.log("已写入 channel.json，正在运行的服务会自动加载生效。");
		return;
	}

	if (!name || rest.length > 0) fail(io, USAGE.join("\n"));
	const config = readConfig(paths, io);
	const keys = keysOf(config);
	const index = keys.findIndex((key) => key.name === name);
	if (index < 0) fail(io, `未找到名为 "${name}" 的密钥。`);
	keys.splice(index, 1);
	await save(paths, config);
	io.log(`已移除密钥 "${name}"，正在运行的服务会自动生效。`);
}

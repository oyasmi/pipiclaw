/**
 * `channel.json`'s `webapi` section (spec 061, D1/D2): validation and normalization. The rules
 * that keep the defaults safe live here: a listener that is not loopback must be TLS, a key is a
 * hash and a name and the desks it may use, and there is always something to listen on.
 */
import { isAbsolute } from "node:path";
import { ChannelConfigError } from "../channel/config.js";
import { isDeskName } from "../desk/paths.js";
import { isPlainObject } from "../shared/type-guards.js";

export interface WebApiKey {
	name: string;
	/** Lower-case hex SHA-256 of the key; the key itself is never stored. */
	sha256: string;
	/** The desks this key may use; the first is the default for a conversation it starts. */
	desks: string[];
}

export interface WebApiTcp {
	host: string;
	port: number;
	loopback: boolean;
}

export interface WebApiConfig {
	socket: boolean;
	tcp?: WebApiTcp;
	tls?: { cert: string; key: string };
	keys: WebApiKey[];
}

export const KEY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `127.0.0.0/8`, `::1` and `localhost` — the addresses only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bare.toLowerCase() === "localhost") return true;
	if (bare === "::1") return true;
	const octets = bare.split(".");
	return (
		octets.length === 4 &&
		octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) &&
		octets[0] === "127"
	);
}

/** `host:port`, with an IPv6 host in brackets. */
export function parseTcpAddress(value: string): WebApiTcp | undefined {
	const match = /^(\[[^\]]+\]|[^:\]]+):(\d{1,5})$/.exec(value.trim());
	if (!match) return undefined;
	const port = Number(match[2]);
	if (port < 1 || port > 65535) return undefined;
	const host = match[1];
	return { host: host.startsWith("[") ? host.slice(1, -1) : host, port, loopback: isLoopbackHost(host) };
}

export function parseWebApiConfig(section: unknown): WebApiConfig {
	const issues: string[] = [];
	const raw = isPlainObject(section) ? section : {};
	const socket = raw.socket === undefined ? true : raw.socket;
	if (typeof socket !== "boolean") issues.push("webapi: `socket` must be true or false.");

	let tcp: WebApiTcp | undefined;
	if (raw.tcp !== undefined) {
		tcp = typeof raw.tcp === "string" ? parseTcpAddress(raw.tcp) : undefined;
		if (!tcp) issues.push("webapi: `tcp` must be `host:port` (an IPv6 host in brackets, e.g. `[::1]:8787`).");
	}

	let tls: WebApiConfig["tls"];
	if (raw.tls !== undefined) {
		const cert = isPlainObject(raw.tls) ? raw.tls.cert : undefined;
		const key = isPlainObject(raw.tls) ? raw.tls.key : undefined;
		if (typeof cert === "string" && typeof key === "string" && isAbsolute(cert) && isAbsolute(key)) {
			tls = { cert, key };
		} else {
			issues.push("webapi: `tls` needs absolute `cert` and `key` paths.");
		}
	}

	if (socket === false && !tcp && issues.length === 0) {
		issues.push("webapi: nothing to listen on — set `socket` to true, or give `tcp` an address.");
	}
	if (tcp && !tcp.loopback && !tls) {
		issues.push(
			`webapi: \`tcp\` ${tcp.host}:${tcp.port} is not a loopback address, so \`tls\` is required (a bearer key must not cross the network in the clear).`,
		);
	}

	const keys: WebApiKey[] = [];
	if (raw.keys !== undefined && !Array.isArray(raw.keys)) {
		issues.push("webapi: `keys` must be an array.");
	}
	const seen = new Set<string>();
	for (const [index, entry] of (Array.isArray(raw.keys) ? raw.keys : []).entries()) {
		const where = `webapi: keys[${index}]`;
		if (!isPlainObject(entry)) {
			issues.push(`${where} must be an object.`);
			continue;
		}
		const { name, sha256, desks } = entry;
		if (typeof name !== "string" || !KEY_NAME_PATTERN.test(name)) {
			issues.push(`${where}.name must match ${KEY_NAME_PATTERN}.`);
		} else if (seen.has(name)) {
			issues.push(`${where}.name \`${name}\` is used twice.`);
		}
		if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
			issues.push(`${where}.sha256 must be 64 lower-case hex characters.`);
		}
		if (
			!Array.isArray(desks) ||
			desks.length === 0 ||
			!desks.every((desk) => typeof desk === "string" && isDeskName(desk))
		) {
			issues.push(`${where}.desks must list at least one valid desk name.`);
		}
		if (typeof name === "string" && typeof sha256 === "string" && Array.isArray(desks)) {
			seen.add(name);
			keys.push({ name, sha256, desks: desks as string[] });
		}
	}

	if (issues.length > 0) throw new ChannelConfigError(issues);
	return { socket: socket as boolean, ...(tcp ? { tcp } : {}), ...(tls ? { tls } : {}), keys };
}

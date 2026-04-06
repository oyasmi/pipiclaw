import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SecurityConfig } from "./types.js";

type ValidationStage = "request" | "redirect";

export interface NetworkGuardContext {
	config: SecurityConfig;
}

export interface ValidatedNetworkTarget {
	url: string;
	hostname: string;
	resolvedAddress?: string;
}

export class NetworkGuardError extends Error {
	readonly url: string;
	readonly stage: ValidationStage;
	readonly category: string;
	readonly resolvedHost?: string;
	readonly resolvedAddress?: string;

	constructor(options: {
		url: string;
		stage: ValidationStage;
		category: string;
		message: string;
		resolvedHost?: string;
		resolvedAddress?: string;
	}) {
		super(options.message);
		this.name = "NetworkGuardError";
		this.url = options.url;
		this.stage = options.stage;
		this.category = options.category;
		this.resolvedHost = options.resolvedHost;
		this.resolvedAddress = options.resolvedAddress;
	}
}

const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "169.254.169.254"]);
const PRIVATE_IPV4_CIDRS = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"198.18.0.0/15",
] as const;
const PRIVATE_IPV6_CIDRS = ["::1/128", "::/128", "fc00::/7", "fe80::/10"] as const;

function normalizeHost(host: string): string {
	return host.trim().replace(/\.$/, "").toLowerCase();
}

function parseIpv4(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) {
		return null;
	}
	let value = 0;
	for (const part of parts) {
		if (!/^\d+$/.test(part)) {
			return null;
		}
		const octet = Number.parseInt(part, 10);
		if (octet < 0 || octet > 255) {
			return null;
		}
		value = (value << 8) | octet;
	}
	return value >>> 0;
}

function expandIpv6(ip: string): string[] | null {
	const normalized = ip.toLowerCase();
	const hasEmbeddedIpv4 = normalized.includes(".");
	let working = normalized;
	if (hasEmbeddedIpv4) {
		const lastColon = working.lastIndexOf(":");
		if (lastColon === -1) {
			return null;
		}
		const ipv4 = parseIpv4(working.slice(lastColon + 1));
		if (ipv4 === null) {
			return null;
		}
		const high = ((ipv4 >>> 16) & 0xffff).toString(16);
		const low = (ipv4 & 0xffff).toString(16);
		working = `${working.slice(0, lastColon)}:${high}:${low}`;
	}

	const pieces = working.split("::");
	if (pieces.length > 2) {
		return null;
	}
	const left = pieces[0] ? pieces[0].split(":").filter(Boolean) : [];
	const right = pieces[1] ? pieces[1].split(":").filter(Boolean) : [];
	if (left.length + right.length > 8) {
		return null;
	}
	const fill = new Array(8 - left.length - right.length).fill("0");
	const groups = pieces.length === 2 ? [...left, ...fill, ...right] : left;
	return groups.length === 8 ? groups : null;
}

function parseIpv6(ip: string): bigint | null {
	const groups = expandIpv6(ip);
	if (!groups) {
		return null;
	}
	let value = 0n;
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) {
			return null;
		}
		value = (value << 16n) | BigInt(Number.parseInt(group, 16));
	}
	return value;
}

function ipInCidr(ip: string, cidr: string): boolean {
	const [network, prefixText] = cidr.split("/");
	const prefix = Number.parseInt(prefixText ?? "", 10);
	if (!Number.isFinite(prefix)) {
		return false;
	}
	const version = isIP(ip);
	if (version === 4) {
		const ipValue = parseIpv4(ip);
		const networkValue = parseIpv4(network);
		if (ipValue === null || networkValue === null || prefix < 0 || prefix > 32) {
			return false;
		}
		const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
		return (ipValue & mask) === (networkValue & mask);
	}
	if (version === 6) {
		const ipValue = parseIpv6(ip);
		const networkValue = parseIpv6(network);
		if (ipValue === null || networkValue === null || prefix < 0 || prefix > 128) {
			return false;
		}
		const shift = 128 - prefix;
		if (shift === 128) {
			return true;
		}
		return ipValue >> BigInt(shift) === networkValue >> BigInt(shift);
	}
	return false;
}

function matchesAllowedHost(hostname: string, allowedHosts: string[]): boolean {
	const normalized = normalizeHost(hostname);
	return allowedHosts.some((candidate) => normalizeHost(candidate) === normalized);
}

function matchesAllowedCidr(address: string, allowedCidrs: string[]): boolean {
	return allowedCidrs.some((cidr) => ipInCidr(address, cidr.trim()));
}

function isBlockedHost(hostname: string): boolean {
	const normalized = normalizeHost(hostname);
	return normalized.endsWith(".localhost") || BLOCKED_HOSTS.has(normalized);
}

function isPrivateAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		return PRIVATE_IPV4_CIDRS.some((cidr) => ipInCidr(address, cidr));
	}
	if (version === 6) {
		return PRIVATE_IPV6_CIDRS.some((cidr) => ipInCidr(address, cidr));
	}
	return false;
}

async function validateUrlTarget(
	rawUrl: string,
	context: NetworkGuardContext,
	stage: ValidationStage,
): Promise<ValidatedNetworkTarget> {
	const url: URL = (() => {
		try {
			return new URL(rawUrl);
		} catch {
			throw new NetworkGuardError({
				url: rawUrl,
				stage,
				category: "invalid-url",
				message: `Invalid URL: ${rawUrl}`,
			});
		}
	})();

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new NetworkGuardError({
			url: rawUrl,
			stage,
			category: "unsupported-scheme",
			message: `Only http/https URLs are allowed, got ${url.protocol || "unknown"}`,
		});
	}

	const hostname = normalizeHost(url.hostname);
	if (!hostname) {
		throw new NetworkGuardError({
			url: rawUrl,
			stage,
			category: "missing-host",
			message: `URL is missing a hostname: ${rawUrl}`,
		});
	}

	const { networkGuard } = context.config;
	if (!networkGuard.enabled) {
		return { url: url.toString(), hostname };
	}

	if (matchesAllowedHost(hostname, networkGuard.allowedHosts)) {
		return { url: url.toString(), hostname };
	}

	if (isBlockedHost(hostname)) {
		throw new NetworkGuardError({
			url: rawUrl,
			stage,
			category: "blocked-host",
			message: `Blocked host: ${hostname}`,
			resolvedHost: hostname,
		});
	}

	if (isIP(hostname)) {
		if (!matchesAllowedCidr(hostname, networkGuard.allowedCidrs) && isPrivateAddress(hostname)) {
			throw new NetworkGuardError({
				url: rawUrl,
				stage,
				category: "private-address",
				message: `Blocked private network address: ${hostname}`,
				resolvedHost: hostname,
				resolvedAddress: hostname,
			});
		}
		return { url: url.toString(), hostname, resolvedAddress: hostname };
	}

	let records: Array<{ address: string; family: number }>;
	try {
		records = (await lookup(hostname, { all: true, verbatim: true })) as Array<{ address: string; family: number }>;
	} catch (error) {
		throw new NetworkGuardError({
			url: rawUrl,
			stage,
			category: "dns-failure",
			message: `Failed to resolve host ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
			resolvedHost: hostname,
		});
	}

	if (records.length === 0) {
		throw new NetworkGuardError({
			url: rawUrl,
			stage,
			category: "dns-failure",
			message: `Failed to resolve host ${hostname}`,
			resolvedHost: hostname,
		});
	}

	for (const record of records) {
		if (matchesAllowedCidr(record.address, networkGuard.allowedCidrs)) {
			return { url: url.toString(), hostname, resolvedAddress: record.address };
		}
		if (isPrivateAddress(record.address)) {
			throw new NetworkGuardError({
				url: rawUrl,
				stage,
				category: "private-address",
				message: `Blocked private network address resolved from ${hostname}: ${record.address}`,
				resolvedHost: hostname,
				resolvedAddress: record.address,
			});
		}
	}

	return { url: url.toString(), hostname, resolvedAddress: records[0]?.address };
}

export async function validateNetworkTarget(
	url: string,
	context: NetworkGuardContext,
): Promise<ValidatedNetworkTarget> {
	return validateUrlTarget(url, context, "request");
}

export async function validateRedirectTarget(
	url: string,
	context: NetworkGuardContext,
): Promise<ValidatedNetworkTarget> {
	return validateUrlTarget(url, context, "redirect");
}

/**
 * Who is calling (spec 061, D12/D24). The local socket is the machine's own user and needs no key;
 * a TCP request must carry a bearer key whose SHA-256 matches a configured one. The comparison
 * visits every stored hash, so how long it takes does not say which key was close.
 */
import { timingSafeEqual } from "node:crypto";
import { hashWebApiKey } from "../channel/config.js";
import type { WebApiKey } from "./config.js";

export interface Principal {
	/** The key's name, or `local` for the socket. */
	name: string;
	/** Absent for the socket (any desk). */
	desks?: readonly string[];
	local: boolean;
}

export const LOCAL_PRINCIPAL: Principal = { name: "local", local: true };

function bearerToken(header: string | undefined): string | undefined {
	const match = /^Bearer[ \t]+(\S+)$/i.exec(header ?? "");
	return match?.[1];
}

export function authenticate(authorization: string | undefined, keys: readonly WebApiKey[]): Principal | undefined {
	const token = bearerToken(authorization);
	if (token === undefined) return undefined;
	const presented = Buffer.from(hashWebApiKey(token), "hex");
	let match: WebApiKey | undefined;
	for (const key of keys) {
		// Every stored hash is compared, whether or not an earlier one already matched.
		if (timingSafeEqual(presented, Buffer.from(key.sha256, "hex")) && !match) match = key;
	}
	return match ? { name: match.name, desks: match.desks, local: false } : undefined;
}

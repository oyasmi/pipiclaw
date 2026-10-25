import { afterEach, describe, expect, it } from "vitest";
import { generateKey, hashKey } from "../src/webapi/auth.js";
import type { WebApiConfig } from "../src/webapi/config.js";
import { WebApiServer } from "../src/webapi/server.js";
import type { WebApiService } from "../src/webapi/service.js";

const key = generateKey();
const config: WebApiConfig = {
	socket: true,
	tcp: { host: "127.0.0.1", port: 8787, loopback: true },
	keys: [{ name: "ci", sha256: hashKey(key), desks: ["default"] }],
};
const HOST = "127.0.0.1:8787";

describe("webapi door guards", () => {
	const audited: Array<{ type: string; reason?: string }> = [];
	const apps: Array<{ close(): Promise<unknown> }> = [];
	afterEach(async () => {
		audited.length = 0;
		await Promise.all(apps.splice(0).map((app) => app.close()));
	});

	async function app(listener: "tcp" | "socket") {
		const instance = await WebApiServer.build(listener, {
			config,
			service: {} as WebApiService,
			socketPath: "/unused",
			audit: (event) => audited.push(event as never),
		});
		apps.push(instance);
		return instance;
	}
	const bearer = { authorization: `Bearer ${key}`, host: HOST };

	it("turns away a bad caller before reading its body", async () => {
		const tcp = await app("tcp");
		// A malformed body would be a 400 if it were parsed; 401 proves the door shut first (INV-6).
		const garbage = {
			method: "POST",
			url: "/v1/responses",
			payload: "{not json",
			headers: { host: HOST, "content-type": "application/json", origin: "https://client.example" },
		} as const;
		for (const headers of [garbage.headers, { ...garbage.headers, authorization: "Bearer wrong" }]) {
			const res = await tcp.inject({ ...garbage, headers });
			expect(res.statusCode).toBe(401);
			expect(res.headers["access-control-allow-origin"]).toBe("*");
			expect(res.json().error).toMatchObject({
				type: "invalid_request_error",
				code: "invalid_api_key",
				param: null,
			});
		}
		expect(audited.filter((e) => e.type === "webapi-auth").map((e) => e.reason)).toEqual([
			"missing_key",
			"invalid_key",
		]);
	});

	it("allows browser requests and unauthenticated preflight, but a foreign Host only on the socket", async () => {
		const tcp = await app("tcp");
		const socket = await app("socket");
		// Removing only the Origin refusal still breaks browsers: preflight has no bearer key,
		// and the official SDK asks for its own headers as well as Authorization and Content-Type.
		const requestedHeaders = "authorization,content-type,x-stainless-lang";
		for (const instance of [tcp, socket]) {
			for (const origin of ["https://client.example", "null"]) {
				const preflight = await instance.inject({
					method: "OPTIONS",
					url: "/v1/responses",
					headers: {
						host: HOST,
						origin,
						"access-control-request-method": "POST",
						"access-control-request-headers": requestedHeaders,
					},
				});
				expect(preflight.statusCode).toBe(204);
				expect(preflight.body).toBe("");
				expect(preflight.headers["access-control-allow-origin"]).toBe("*");
				expect(preflight.headers["access-control-allow-methods"]).toContain("POST");
				expect(preflight.headers["access-control-allow-headers"]).toBe(requestedHeaders);
				expect(preflight.headers.vary).toBe("Access-Control-Request-Headers");
				const response = await instance.inject({ url: "/v1/models", headers: { ...bearer, origin } });
				expect(response.statusCode).toBe(200);
				expect(response.headers["access-control-allow-origin"]).toBe("*");
				expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
				expect(response.headers["access-control-expose-headers"]).toContain("Retry-After");
			}
		}
		// DNS rebinding: the browser sends the attacker's name as Host.
		expect(
			(await tcp.inject({ url: "/v1/models", headers: { ...bearer, host: "evil.example:8787" } })).statusCode,
		).toBe(403);
		expect(
			(
				await tcp.inject({
					method: "OPTIONS",
					url: "/v1/responses",
					headers: {
						host: "evil.example:8787",
						origin: "https://client.example",
						"access-control-request-method": "POST",
					},
				})
			).statusCode,
		).toBe(403);
		expect((await tcp.inject({ url: "/v1/models", headers: bearer })).statusCode).toBe(200);
		// The socket has no Host to trust and needs no key.
		expect((await socket.inject({ url: "/v1/models", headers: { host: "localhost" } })).statusCode).toBe(200);
		// An ordinary OPTIONS request must not bypass authentication.
		expect((await tcp.inject({ method: "OPTIONS", url: "/v1/models", headers: { host: HOST } })).statusCode).toBe(
			401,
		);
	});

	it("rejects prototype-poisoned and oversized bodies in the API's error format", async () => {
		const tcp = await app("tcp");
		const post = (payload: string) =>
			tcp.inject({
				method: "POST",
				url: "/v1/responses",
				payload,
				headers: { ...bearer, "content-type": "application/json" },
			});
		const poisoned = await post('{"input":"x","__proto__":{"admin":true}}');
		expect(poisoned.statusCode).toBe(400);
		expect(poisoned.json().error.type).toBe("invalid_request_error");
		const huge = await post(JSON.stringify({ input: "x".repeat(9 * 1024 * 1024) }));
		expect(huge.statusCode).toBe(413);
		expect(huge.json().error.code).toBe("request_too_large");
		const text = await tcp.inject({
			method: "POST",
			url: "/v1/responses",
			payload: "hi",
			headers: { ...bearer, "content-type": "text/plain" },
		});
		expect(text.statusCode).toBe(415);
	});
});

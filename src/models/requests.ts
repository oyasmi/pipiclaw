import { createHash } from "node:crypto";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	cleanupSessionResources,
	type Model,
	type ModelsSimpleStreamOptions,
	type ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { withAbortSignal } from "../shared/with-timeout.js";
import { trackModelWork } from "./credential-work.js";

/** Complete request-time provider authentication; no credentials escape into a worker's state. */
export interface ModelRequests {
	ensureAuth(model: Model<Api>, signal?: AbortSignal): Promise<void>;
	stream(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
}

export function createModelRequests(runtime: ModelRuntime): ModelRequests {
	let codexRoute: { sessionId: string; fingerprint: string } | undefined;
	return {
		ensureAuth: async (model, signal) => {
			const resolve = () =>
				trackModelWork(runtime, async () => {
					const auth = await runtime.getAuth(model, { signal });
					signal?.throwIfAborted();
					if (!auth) {
						throw new Error(
							`No credentials found for provider: ${model.provider}. ` +
								"请在服务器终端执行 `pipiclaw auth login` 登录，或检查本实例的 auth.json / models.json 配置。",
						);
					}
				});
			if (signal) await withAbortSignal(signal, resolve);
			else await resolve();
		},
		stream: (model, context, options) => {
			// The SDK resolves this request's provider, full headers, endpoint and env together.
			// Do not retain or forward an API key obtained for an earlier model/request.
			const { apiKey: _apiKey, ...requestOptions } = options ?? {};
			const sessionId = requestOptions.sessionId;
			if (
				model.api === "openai-codex-responses" &&
				sessionId &&
				requestOptions.transport !== "sse" &&
				requestOptions.cacheRetention !== "none"
			) {
				const { onPayload, transformHeaders } = requestOptions;
				let headers: ProviderHeaders | undefined;
				requestOptions.transformHeaders = async (resolved) => {
					headers = transformHeaders ? await transformHeaders(resolved) : resolved;
					return headers;
				};
				requestOptions.onPayload = (payload, resolvedModel) => {
					// Codex pools sockets by session and account, without checking the endpoint or headers.
					const fingerprint = createHash("sha256")
						.update(
							JSON.stringify([
								resolvedModel.provider,
								resolvedModel.id,
								resolvedModel.baseUrl,
								resolvedModel.headers,
								headers,
							]),
						)
						.digest("hex");
					if (codexRoute?.sessionId === sessionId && codexRoute.fingerprint !== fingerprint) {
						cleanupSessionResources(sessionId);
					}
					codexRoute = { sessionId, fingerprint };
					return onPayload?.(payload, resolvedModel);
				};
			}
			const stream = runtime.streamSimple(model, context, requestOptions);
			void trackModelWork(runtime, () => stream.result()).catch(() => {});
			return stream;
		},
	};
}

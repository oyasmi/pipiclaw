import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { withAbortSignal } from "../shared/with-timeout.js";
import { trackModelWork } from "./credential-work.js";

/** Complete request-time provider authentication; no credentials escape into a worker's state. */
export interface ModelRequests {
	ensureAuth(model: Model<Api>, signal?: AbortSignal): Promise<void>;
	stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

export function createModelRequests(runtime: ModelRuntime): ModelRequests {
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
			const stream = runtime.streamSimple(model, context, requestOptions);
			void trackModelWork(runtime, () => stream.result()).catch(() => {});
			return stream;
		},
	};
}

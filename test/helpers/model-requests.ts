import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRequests } from "../../src/models/requests.js";

/** Domain fixtures keep auth controllable; real request/auth wiring belongs in the SDK and e2e checks. */
export function testModelRequests(
	ensureAuth: (...args: Parameters<ModelRequests["ensureAuth"]>) => Promise<unknown> = async () => {},
): ModelRequests {
	return {
		ensureAuth: async (...args) => {
			await ensureAuth(...args);
		},
		stream: streamSimple,
	};
}

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";

/**
 * Resolve an API key for the given model's provider.
 * Checks ModelRegistry first, then falls back to ANTHROPIC_API_KEY.
 */
export async function getApiKeyForModel(modelRegistry: ModelRegistry, model: Model<Api>): Promise<string> {
	const key = await modelRegistry.getApiKeyForProvider(model.provider);
	if (key) {
		return key;
	}

	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) {
		return envKey;
	}

	throw new Error(
		`No API key found for provider: ${model.provider}.\n\n` +
			"Configure credentials in ~/.pi/pipiclaw/auth.json or ~/.pi/pipiclaw/models.json, or set the matching provider environment variable.",
	);
}

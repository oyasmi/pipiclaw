import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * Resolve an API key for the given model's provider.
 * `ModelRegistry.getApiKeyForProvider` already checks that provider's own environment
 * variable (e.g. OPENAI_API_KEY, GEMINI_API_KEY) internally, so a miss here means no
 * credentials exist for this provider anywhere. Only fall back to ANTHROPIC_API_KEY when
 * the model itself is Anthropic — falling back for other providers would silently send an
 * Anthropic key to e.g. OpenAI and fail with a confusing 401.
 */
export async function getApiKeyForModel(modelRegistry: ModelRegistry, model: Model<Api>): Promise<string> {
	const key = await modelRegistry.getApiKeyForProvider(model.provider);
	if (key) {
		return key;
	}

	if (model.provider === "anthropic") {
		const envKey = process.env.ANTHROPIC_API_KEY;
		if (envKey) {
			return envKey;
		}
	}

	throw new Error(
		`No API key found for provider: ${model.provider}.\n\n` +
			"Configure credentials in ~/.pipiclaw/auth.json or ~/.pipiclaw/models.json, or set the matching provider environment variable.",
	);
}

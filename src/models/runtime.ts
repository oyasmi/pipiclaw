/**
 * The model runtime: the default model, construction of the async model/auth runtime and its
 * registry shell, and the initial model choice from settings.
 */
import { isAbsolute } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { PipiclawSettingsManager } from "../config/settings.js";

// Default model - will be overridden by ModelRegistry if custom models are configured
export const defaultModel = getModel("anthropic", "claude-sonnet-4-5");

/**
 * Construct the canonical async model/auth runtime (replaces the old
 * `AuthStorage.create` + `ModelRegistry` pairing). pi 0.80.8+ folded auth and
 * model resolution into a single async `ModelRuntime`.
 *
 * `authConfigPath` must always be given explicitly and be absolute: pipiclaw
 * never wants `AuthStorage`'s undefined-path fallback to `~/.pi/agent/auth.json`
 * (spec 039 §4). Do not call the SDK's `getAuthPath()` / `getAgentDir()` /
 * no-arg `readStoredCredential()`, and do not set `PI_CODING_AGENT_DIR` —
 * all three can silently move credential I/O away from `APP_HOME_DIR`.
 */
export async function createModelRuntime(options: {
	authConfigPath: string;
	modelsConfigPath: string;
}): Promise<ModelRuntime> {
	if (!options.authConfigPath || !isAbsolute(options.authConfigPath)) {
		throw new Error(
			`createModelRuntime: authConfigPath must be a non-empty absolute path, got ${JSON.stringify(options.authConfigPath)}`,
		);
	}
	return ModelRuntime.create({
		authPath: options.authConfigPath,
		modelsPath: options.modelsConfigPath,
	});
}

/**
 * Wrap a ModelRuntime in the synchronous extension-facing ModelRegistry shell so
 * existing `getAvailable`/`find`/`getApiKeyForProvider` call sites stay unchanged.
 */
export function wrapModelRegistry(modelRuntime: ModelRuntime): ModelRegistry {
	return new ModelRegistry(modelRuntime);
}

export function resolveInitialModel(
	modelRegistry: ModelRegistry,
	settingsManager: PipiclawSettingsManager,
): Model<Api> {
	const savedProvider = settingsManager.getDefaultProvider();
	const savedModelId = settingsManager.getDefaultModel();
	const availableModels = modelRegistry.getAvailable();
	if (savedProvider && savedModelId) {
		const savedModel = modelRegistry.find(savedProvider, savedModelId);
		if (
			savedModel &&
			availableModels.some((model) => model.provider === savedModel.provider && model.id === savedModel.id)
		) {
			return savedModel;
		}
	}

	if (availableModels.length > 0) {
		return availableModels[0];
	}

	return defaultModel;
}

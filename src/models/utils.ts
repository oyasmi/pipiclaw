import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { PipiclawSettingsManager } from "../settings.js";

// Default model - will be overridden by ModelRegistry if custom models are configured
const defaultModel = getModel("anthropic", "claude-sonnet-4-5");

export function formatModelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): { match?: Model<Api>; ambiguous: boolean } {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return { ambiguous: false };
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return { match: canonicalMatches[0], ambiguous: false };
	}
	if (canonicalMatches.length > 1) {
		return { ambiguous: true };
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return { match: providerMatches[0], ambiguous: false };
			}
			if (providerMatches.length > 1) {
				return { ambiguous: true };
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	if (idMatches.length === 1) {
		return { match: idMatches[0], ambiguous: false };
	}

	return { ambiguous: idMatches.length > 1 };
}

export function findModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): { match?: Model<Api>; ambiguous: boolean } {
	const exactMatch = findExactModelReferenceMatch(modelReference, availableModels);
	if (exactMatch.match || exactMatch.ambiguous) {
		return exactMatch;
	}

	const normalizedReference = modelReference.trim().toLowerCase();
	if (!normalizedReference) {
		return { ambiguous: false };
	}

	const substringMatches = availableModels.filter((model) =>
		formatModelReference(model).toLowerCase().includes(normalizedReference),
	);
	if (substringMatches.length === 1) {
		return { match: substringMatches[0], ambiguous: false };
	}

	return { ambiguous: substringMatches.length > 1 };
}

export function formatModelList(
	models: Model<Api>[],
	currentModel: Model<Api> | undefined,
	limit: number = 20,
): string {
	const refs = models
		.slice()
		.sort((a, b) => formatModelReference(a).localeCompare(formatModelReference(b)))
		.map((model) => {
			const ref = formatModelReference(model);
			const marker =
				currentModel && currentModel.provider === model.provider && currentModel.id === model.id
					? " (current)"
					: "";
			return `- \`${ref}\`${marker}`;
		});

	if (refs.length <= limit) {
		return refs.join("\n");
	}

	return `${refs.slice(0, limit).join("\n")}\n- ... and ${refs.length - limit} more`;
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

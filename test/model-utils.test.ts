import type { Api, Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	findExactModelReferenceMatch,
	findModelReferenceMatch,
	formatModelList,
	formatModelReference,
	resolveInitialModel,
} from "../src/models/utils.js";
import type { PipiclawSettingsManager } from "../src/settings.js";

const anthropicModel = getModel("anthropic", "claude-sonnet-4-5");
const openaiModel = getModel("openai", "gpt-4o-mini");

if (!anthropicModel || !openaiModel) {
	throw new Error("Expected built-in models to exist for tests");
}

function makeRegistry(availableModels: Model<Api>[], findResult?: Model<Api>): ModelRegistry {
	return {
		getAvailable: () => availableModels,
		find: () => findResult,
	} as unknown as ModelRegistry;
}

function makeSettings(defaultProvider?: string, defaultModel?: string): PipiclawSettingsManager {
	return {
		getDefaultProvider: () => defaultProvider,
		getDefaultModel: () => defaultModel,
	} as unknown as PipiclawSettingsManager;
}

describe("model-utils", () => {
	it("formats model references and exact matches", () => {
		expect(formatModelReference(anthropicModel)).toBe("anthropic/claude-sonnet-4-5");
		expect(findExactModelReferenceMatch("anthropic/claude-sonnet-4-5", [anthropicModel, openaiModel])).toEqual({
			match: anthropicModel,
			ambiguous: false,
		});
		expect(findExactModelReferenceMatch("gpt-4o-mini", [anthropicModel, openaiModel])).toEqual({
			match: openaiModel,
			ambiguous: false,
		});
	});

	it("reports ambiguous and missing bare model references", () => {
		const duplicateOpenAi = { ...openaiModel, provider: "openrouter" as Api } as Model<Api>;
		expect(findExactModelReferenceMatch("gpt-4o-mini", [openaiModel, duplicateOpenAi])).toEqual({
			ambiguous: true,
		});
		expect(findExactModelReferenceMatch("missing-model", [anthropicModel, openaiModel])).toEqual({
			ambiguous: false,
		});
	});

	it("supports unique substring matches without fuzzy normalization", () => {
		const bailianGlm = { provider: "bailian", id: "glm-5", name: "GLM 5" } as Model<Api>;
		const bailianKimi = { provider: "bailian", id: "kimi-k2.5", name: "Kimi K2.5" } as Model<Api>;
		const zpaiTurbo = { provider: "zpai", id: "glm-5-turbo", name: "GLM 5 Turbo" } as Model<Api>;

		expect(findModelReferenceMatch("turbo", [bailianGlm, bailianKimi, zpaiTurbo])).toEqual({
			match: zpaiTurbo,
			ambiguous: false,
		});
		expect(findModelReferenceMatch("zpai", [bailianGlm, bailianKimi, zpaiTurbo])).toEqual({
			match: zpaiTurbo,
			ambiguous: false,
		});
		expect(findModelReferenceMatch("k2.5", [bailianGlm, bailianKimi, zpaiTurbo])).toEqual({
			match: bailianKimi,
			ambiguous: false,
		});
		expect(findModelReferenceMatch("glm", [bailianGlm, bailianKimi, zpaiTurbo])).toEqual({
			ambiguous: true,
		});
		expect(findModelReferenceMatch("glm5", [bailianGlm, bailianKimi, zpaiTurbo])).toEqual({
			ambiguous: false,
		});
	});

	it("formats model lists with current marker and truncation", () => {
		const list = formatModelList([openaiModel, anthropicModel], anthropicModel);
		expect(list).toContain("`anthropic/claude-sonnet-4-5` (current)");
		expect(list).toContain("`openai/gpt-4o-mini`");

		const truncated = formatModelList([anthropicModel, openaiModel], anthropicModel, 1);
		expect(truncated).toContain("... and 1 more");
	});

	it("resolves initial model from saved settings, first available model, or fallback default", () => {
		expect(
			resolveInitialModel(
				makeRegistry([openaiModel, anthropicModel], anthropicModel),
				makeSettings("anthropic", "claude-sonnet-4-5"),
			),
		).toBe(anthropicModel);

		expect(resolveInitialModel(makeRegistry([openaiModel]), makeSettings("anthropic", "missing"))).toBe(openaiModel);

		expect(resolveInitialModel(makeRegistry([]), makeSettings())).toEqual(
			expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-5" }),
		);
	});
});

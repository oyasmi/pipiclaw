import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import {
	createModelRuntime,
	findExactModelReferenceMatch,
	formatModelReference,
	wrapModelRegistry,
} from "../../src/models/utils.js";
import { canonicalConfigHash } from "./fingerprint.js";

export interface FrozenProfile {
	source: "local";
	agent: { requested: string; resolved: string; endpoint: string };
	judge: { requested: string; resolved: string; endpoint: string; thinking: "off" };
	thinking: string;
	requestedThinking?: string;
	modelsHash: string;
	fallback: null;
}

/** No registry-order fallback or fuzzy substring selection in a measured experiment. */
export function resolveProfileModels(
	settings: Record<string, unknown>,
	models: Model<Api>[],
	env: NodeJS.ProcessEnv,
): { profile: Omit<FrozenProfile, "modelsHash">; agent: Model<Api>; judge: Model<Api> } {
	const configured = env.PIPICLAW_E2E_MODEL;
	const provider = env.PIPICLAW_E2E_PROVIDER;
	const requested = configured
		? provider && !configured.startsWith(`${provider}/`)
			? `${provider}/${configured}`
			: configured
		: `${settings.defaultProvider ?? ""}/${settings.defaultModel ?? ""}`;
	const find = (reference: string): Model<Api> => {
		const model = findExactModelReferenceMatch(reference, models).match;
		if (!model)
			throw new Error(
				`Eval model '${reference}' is missing or ambiguous; set an exact provider/model reference with available credentials.`,
			);
		return model;
	};
	const agent = find(requested);
	const judgeRequested = env.EVAL_JUDGE_MODEL ?? formatModelReference(agent);
	const judge = find(judgeRequested);
	const requestedThinking =
		env.PIPICLAW_E2E_THINKING ??
		(typeof settings.defaultThinkingLevel === "string" ? settings.defaultThinkingLevel : "medium");
	const isThinkingLevel = (value: string): value is ThinkingLevel =>
		["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
	if (!isThinkingLevel(requestedThinking))
		throw new Error("Invalid eval thinking level; use off, minimal, low, medium, high, or xhigh.");
	const thinking = clampThinkingLevel(agent, requestedThinking);
	if (env.PIPICLAW_E2E_ENDPOINT && env.PIPICLAW_E2E_ENDPOINT !== agent.baseUrl)
		throw new Error(
			"PIPICLAW_E2E_ENDPOINT differs from the resolved model endpoint; configure that endpoint in models.json before running.",
		);
	return {
		agent,
		judge,
		profile: {
			source: "local",
			agent: { requested, resolved: formatModelReference(agent), endpoint: agent.baseUrl },
			judge: {
				requested: judgeRequested,
				resolved: formatModelReference(judge),
				endpoint: judge.baseUrl,
				thinking: "off",
			},
			thinking,
			requestedThinking,
			fallback: null,
		},
	};
}

/** Remove credential values while retaining all behavior-affecting model configuration. */
export function publicModelConfig(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(publicModelConfig);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [
			key,
			/^(api[-_]?key|authorization|accessToken|refreshToken|token|secret|password)$/i.test(key)
				? "<credential>"
				: publicModelConfig(child),
		]),
	);
}

/** Called once on a private template home before workers start; no model request is made. */
export async function freezeLocalProfile(
	homeDir: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<FrozenProfile> {
	const path = join(homeDir, "settings.json");
	const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const runtime = await createModelRuntime({
		authConfigPath: join(homeDir, "auth.json"),
		modelsConfigPath: join(homeDir, "models.json"),
	});
	const { profile, agent } = resolveProfileModels(settings, wrapModelRegistry(runtime).getAvailable(), env);
	settings.defaultProvider = agent.provider;
	settings.defaultModel = agent.id;
	settings.defaultThinkingLevel = profile.thinking;
	settings.fallbackModel = null;
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	return {
		...profile,
		modelsHash: canonicalConfigHash(
			publicModelConfig(JSON.parse(readFileSync(join(homeDir, "models.json"), "utf8"))),
			{},
		),
	};
}

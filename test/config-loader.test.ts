import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import type { ModelRegistry, Skill } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadSkillsFromDirMock } = vi.hoisted(() => ({
	loadSkillsFromDirMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	loadSkillsFromDir: loadSkillsFromDirMock,
}));

import { getAgentConfig, getSoul, loadPipiclawSkills } from "../src/agent/workspace-resources.js";
import { getApiKeyForModel } from "../src/models/api-keys.js";
import { useTempDirs } from "./helpers/fixtures.js";

const anthropicModel = getModel("anthropic", "claude-sonnet-4-5");

if (!anthropicModel) {
	throw new Error("Expected anthropic test model");
}

const createTempDir = useTempDirs("pipiclaw-config-");

function makeSkill(name: string, filePath: string, baseDir: string, source: string): Skill {
	return {
		name,
		description: `${name} description`,
		filePath,
		baseDir,
		source,
		content: `${name} content`,
	} as unknown as Skill;
}

afterEach(() => {
	loadSkillsFromDirMock.mockReset();
	delete process.env.ANTHROPIC_API_KEY;
});

describe("config-loader", () => {
	it("loads workspace-level SOUL.md and AGENTS.md when present", () => {
		const workspaceDir = createTempDir();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });
		writeFileSync(join(workspaceDir, "SOUL.md"), "  be concise  ");
		writeFileSync(join(workspaceDir, "AGENTS.md"), "  use tests  ");

		expect(getSoul(workspaceDir)).toBe("be concise");
		expect(getAgentConfig(channelDir)).toBe("use tests");
	});

	it("returns empty strings when workspace config files are missing", () => {
		const workspaceDir = createTempDir();
		const channelDir = join(workspaceDir, "dm_123");
		mkdirSync(channelDir, { recursive: true });

		expect(getSoul(workspaceDir)).toBe("");
		expect(getAgentConfig(channelDir)).toBe("");
	});

	it("loads workspace-level skills only", () => {
		const workspaceDir = createTempDir();
		const channelDir = join(workspaceDir, "dm_123");
		const workspaceSkillsDir = join(workspaceDir, "skills");
		mkdirSync(workspaceSkillsDir, { recursive: true });

		loadSkillsFromDirMock.mockImplementation(({ source }: { source: string }) => {
			if (source === "workspace") {
				return {
					skills: [
						makeSkill(
							"shared",
							join(workspaceSkillsDir, "shared", "SKILL.md"),
							join(workspaceSkillsDir, "shared"),
							"workspace",
						),
						makeSkill(
							"workspace-only",
							join(workspaceSkillsDir, "workspace-only", "SKILL.md"),
							join(workspaceSkillsDir, "workspace-only"),
							"workspace",
						),
					],
				};
			}
			return { skills: [] };
		});

		const skills = loadPipiclawSkills(channelDir);
		expect(skills.map((skill) => skill.name).sort()).toEqual(["shared", "workspace-only"]);

		const shared = skills.find((skill) => skill.name === "shared");
		expect(shared?.filePath).toBe(join(workspaceSkillsDir, "shared", "SKILL.md"));
		expect(shared?.baseDir).toBe(join(workspaceSkillsDir, "shared"));
	});

	it("resolves API keys from the registry first and falls back to ANTHROPIC_API_KEY", async () => {
		const registryWithKey = {
			getApiKeyForProvider: vi.fn().mockResolvedValue("registry-key"),
		} as unknown as ModelRegistry;

		await expect(getApiKeyForModel(registryWithKey, anthropicModel as Model<Api>)).resolves.toBe("registry-key");

		const registryWithoutKey = {
			getApiKeyForProvider: vi.fn().mockResolvedValue(undefined),
		} as unknown as ModelRegistry;
		process.env.ANTHROPIC_API_KEY = "env-key";
		await expect(getApiKeyForModel(registryWithoutKey, anthropicModel as Model<Api>)).resolves.toBe("env-key");

		delete process.env.ANTHROPIC_API_KEY;
		await expect(getApiKeyForModel(registryWithoutKey, anthropicModel as Model<Api>)).rejects.toThrow(
			"No API key found for provider: anthropic.",
		);
	});
});

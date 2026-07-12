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

import { loadWorkspacePromptResources } from "../src/agent/prompt/resources.js";
import { loadPipiclawSkills, resolvePipiclawSkills } from "../src/agent/workspace-resources.js";
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
		writeFileSync(join(workspaceDir, "SOUL.md"), "  be concise  ");
		writeFileSync(join(workspaceDir, "AGENTS.md"), "  use tests  ");

		const resources = loadWorkspacePromptResources(workspaceDir);
		expect(resources.soul?.content).toBe("be concise");
		expect(resources.soul?.isDefaultTemplate).toBe(false);
		expect(resources.agents?.content).toBe("use tests");
	});

	it("reports no resources when the workspace config files are missing", () => {
		const workspaceDir = createTempDir();

		const resources = loadWorkspacePromptResources(workspaceDir);
		expect(resources.soul).toBeUndefined();
		expect(resources.agents).toBeUndefined();
	});

	it("loads workspace-level skills only", () => {
		const workspaceDir = createTempDir();
		const channelDir = join(workspaceDir, "dm_123");
		const workspaceSkillsDir = join(workspaceDir, "skills");
		mkdirSync(workspaceSkillsDir, { recursive: true });

		loadSkillsFromDirMock.mockImplementation(({ source }: { source: string }) => {
			if (source === "workspace") {
				return {
					diagnostics: [],
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
			return { skills: [], diagnostics: [] };
		});

		const loaded = loadPipiclawSkills(channelDir);
		expect(loaded.skills.map((skill) => skill.name).sort()).toEqual(["shared", "workspace-only"]);
		expect(loaded.diagnostics).toEqual([]);

		const shared = loaded.skills.find((skill) => skill.name === "shared");
		expect(shared?.filePath).toBe(join(workspaceSkillsDir, "shared", "SKILL.md"));
		expect(shared?.baseDir).toBe(join(workspaceSkillsDir, "shared"));
	});

	it("lets a workspace skill shadow a discovered one of the same name, and says so", () => {
		const workspaceDir = createTempDir();
		const workspaceSkillsDir = join(workspaceDir, "skills");
		const base = {
			skills: [makeSkill("shared", "/global/shared/SKILL.md", "/global/shared", "user")],
			diagnostics: [],
		};
		const workspace = {
			skills: [makeSkill("shared", join(workspaceSkillsDir, "shared", "SKILL.md"), workspaceSkillsDir, "workspace")],
			diagnostics: [],
		};

		const merged = resolvePipiclawSkills(base, workspace);
		expect(merged.skills).toHaveLength(1);
		expect(merged.skills[0]?.filePath).toBe(join(workspaceSkillsDir, "shared", "SKILL.md"));
		expect(merged.diagnostics).toMatchObject([{ type: "collision", path: "/global/shared/SKILL.md" }]);
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

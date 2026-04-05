import type { Api, Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import type { ModelRegistry, Skill } from "@mariozechner/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { loadSkillsFromDirMock } = vi.hoisted(() => ({
	loadSkillsFromDirMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	loadSkillsFromDir: loadSkillsFromDirMock,
}));

import { getAgentConfig, getSoul, loadPipiclawSkills } from "../src/agent/workspace-resources.js";
import { getApiKeyForModel } from "../src/models/api-keys.js";

const anthropicModel = getModel("anthropic", "claude-sonnet-4-5");

if (!anthropicModel) {
	throw new Error("Expected anthropic test model");
}

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-config-"));
	tempDirs.push(dir);
	return dir;
}

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
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
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

		const skills = loadPipiclawSkills(channelDir, "/sandbox/workspace");
		expect(skills.map((skill) => skill.name).sort()).toEqual(["shared", "workspace-only"]);

		const shared = skills.find((skill) => skill.name === "shared");
		expect(shared?.filePath).toContain("/sandbox/workspace/skills/shared/SKILL.md");
		expect(shared?.filePath.startsWith("/sandbox/workspace")).toBe(true);
		expect(shared?.baseDir.startsWith("/sandbox/workspace")).toBe(true);
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

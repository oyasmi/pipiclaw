/**
 * The pi seam (spec 025 §10.2): what a real DefaultResourceLoader hands to pi's
 * system-prompt builder. These assertions are the contract that keeps pi's default
 * base prompt out and keeps skills — and therefore `/skill:name` — in.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DefaultResourceLoader, type ExtensionAPI, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildPipiclawSystemPrompt } from "../src/agent/prompt/builder.js";
import { createPromptBoundaryExtension } from "../src/agent/prompt/extension.js";
import { loadWorkspacePromptResources } from "../src/agent/prompt/resources.js";
import type { PromptBuildContext } from "../src/agent/prompt/types.js";
import { loadPipiclawSkills, resolvePipiclawSkills } from "../src/agent/workspace-resources.js";
import { loadRuntimePlaybookCatalog, selectRuntimePlaybooks } from "../src/playbooks/catalog.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-loader-");

type BoundaryHandler = (event: { systemPrompt: string }) => { systemPrompt: string } | undefined;

function createWorkspace(): { workspaceDir: string; channelDir: string } {
	const home = makeTempDir();
	const workspaceDir = join(home, "workspace");
	const channelDir = join(workspaceDir, "dm_1");
	mkdirSync(channelDir, { recursive: true });
	mkdirSync(join(workspaceDir, "skills", "release-notes"), { recursive: true });
	writeFileSync(join(workspaceDir, "SOUL.md"), "Answer in Chinese.");
	writeFileSync(join(workspaceDir, "AGENTS.md"), "Always run the tests.");
	writeFileSync(
		join(workspaceDir, "skills", "release-notes", "SKILL.md"),
		"---\nname: release-notes\ndescription: Write release notes from a changelog.\n---\n\n# Release notes\n",
	);
	return { workspaceDir, channelDir };
}

function buildPrompt(workspaceDir: string): ReturnType<typeof buildPipiclawSystemPrompt> {
	const tools = [{ name: "read", description: "Read files", hint: "Read files" }];
	const context: PromptBuildContext = {
		mode: "normal",
		cwd: workspaceDir,
		workspaceDir,
		tools,
		playbooks: selectRuntimePlaybooks(loadRuntimePlaybookCatalog(), ["read"]),
		subAgents: [],
		...loadWorkspacePromptResources(workspaceDir),
	};
	return buildPipiclawSystemPrompt(context);
}

async function loadResources(workspaceDir: string, channelDir: string) {
	const build = buildPrompt(workspaceDir);
	const loader = new DefaultResourceLoader({
		cwd: makeTempDir(),
		agentDir: makeTempDir(),
		noExtensions: true,
		systemPromptOverride: () => build.text,
		appendSystemPromptOverride: () => [],
		agentsFilesOverride: () => ({ agentsFiles: [] }),
		skillsOverride: (base) => resolvePipiclawSkills(base, loadPipiclawSkills(channelDir)),
	});
	await loader.reload();
	return { build, loader };
}

describe("pi resource-loader seam", () => {
	it("hands pi a custom prompt, no append, and no context files", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		const { build, loader } = await loadResources(workspaceDir, channelDir);

		expect(loader.getSystemPrompt()).toBe(build.text);
		// A non-empty custom prompt is what makes pi skip its default identity, its docs
		// index and the `Available tools: (none)` block entirely.
		expect(loader.getSystemPrompt()).toContain("## Pipiclaw");
		expect(loader.getAppendSystemPrompt()).toEqual([]);
		expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
		// AGENTS.md is injected exactly once — by us, as a section, not by pi's context path.
		expect(build.text.match(/Always run the tests\./g)).toHaveLength(1);
	});

	it("keeps workspace skills in the loader so the index and /skill:name both survive", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		const { loader } = await loadResources(workspaceDir, channelDir);

		const skills = loader.getSkills().skills;
		expect(skills.map((skill) => skill.name)).toEqual(["release-notes"]);
		expect(formatSkillsForPrompt(skills)).toContain("<available_skills>");
	});

	it("rebuilds byte-identically until a workspace file actually changes", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		const { build: first, loader } = await loadResources(workspaceDir, channelDir);

		await loader.reload();
		expect(buildPrompt(workspaceDir).fingerprint).toBe(first.fingerprint);

		writeFileSync(join(workspaceDir, "SOUL.md"), "Answer in English.");
		const changed = buildPrompt(workspaceDir);
		expect(changed.fingerprint).not.toBe(first.fingerprint);
		expect(changed.text).toContain("Answer in English.");
	});

	it("appends the runtime boundary after pi's tail, deterministically", async () => {
		const { workspaceDir, channelDir } = createWorkspace();
		const { build, loader } = await loadResources(workspaceDir, channelDir);

		// What pi produces for a custom prompt: our text, then skills, then date + cwd.
		const piPrompt = `${build.text}${formatSkillsForPrompt(loader.getSkills().skills)}\nCurrent date: 2026-07-12\nCurrent working directory: ${workspaceDir}`;

		const seen: string[] = [];
		const handlers: BoundaryHandler[] = [];
		const extension = createPromptBoundaryExtension({
			getFooter: () => build.footer,
			onFinalPrompt: (prompt) => seen.push(prompt),
		});
		// Minimal stand-in for pi's ExtensionAPI: this extension registers exactly one hook.
		extension({
			on: (_event: string, handler: BoundaryHandler) => handlers.push(handler),
		} as unknown as ExtensionAPI);

		const first = handlers[0]?.({ systemPrompt: piPrompt });
		const second = handlers[0]?.({ systemPrompt: piPrompt });
		expect(first?.systemPrompt).toBe(second?.systemPrompt);
		expect(first?.systemPrompt).toContain("<available_skills>");
		expect(first?.systemPrompt.trimEnd().endsWith(build.footer.trimEnd())).toBe(true);
		expect(seen).toHaveLength(2);
	});
});

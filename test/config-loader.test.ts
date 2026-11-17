import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { loadPipiclawSkills } from "../src/skills/loader.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-config-");

function writeSkill(root: string, path: string, name = path, body = "Follow this workflow.", extra = ""): string {
	const dir = join(root, path);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(
		file,
		`---\nname: ${name}\ndescription: |\n  A reusable workflow\n  with multiple lines.\n${extra}---\n\n${body}`,
	);
	return file;
}

afterEach(() => {
	delete process.env.ANTHROPIC_API_KEY;
});

describe("config-loader", () => {
	it("discovers both skill sources with SDK layouts and metadata, without loading references", () => {
		const workspaceDir = createTempDir();
		const sharedSkillsDir = createTempDir();
		const root = join(workspaceDir, "skills");
		writeSkill(root, "workspace-only");
		const sharedPath = writeSkill(
			sharedSkillsDir,
			"collection/shared-only",
			"shared-only",
			"Use references/guide.md.",
			"disable-model-invocation: true\n",
		);
		writeFileSync(join(sharedSkillsDir, "collection/shared-only/guide.md"), "Reference only.");
		writeFileSync(join(root, "README.md"), "Reference notes without frontmatter");
		writeFileSync(join(root, "legacy.md"), "---\nname: legacy\ndescription: Legacy root file\n---\n\nWorkflow");
		// SDK warnings remain advisory: do not make optional fields or empty bodies into gates.
		writeSkill(root, "warning", "warning--name", "");

		const loaded = loadPipiclawSkills({ workspaceDir, sharedSkillsDir });
		expect(loaded.skills.map((skill) => skill.name)).toEqual([
			"legacy",
			"shared-only",
			"warning--name",
			"workspace-only",
		]);
		expect(loaded.skills.find((skill) => skill.name === "shared-only")).toMatchObject({
			filePath: sharedPath,
			baseDir: join(sharedSkillsDir, "collection/shared-only"),
			source: "user",
			description: "A reusable workflow\nwith multiple lines.\n",
			disableModelInvocation: true,
		});
		expect(loaded.diagnostics).toEqual([expect.objectContaining({ name: "warning--name", rejected: false })]);
	});

	it("merges only usable skills deterministically and falls back with actionable diagnostics", () => {
		const workspaceDir = createTempDir();
		const sharedSkillsDir = createTempDir();
		const options = { workspaceDir, sharedSkillsDir };
		expect(loadPipiclawSkills(options)).toEqual({ skills: [], diagnostics: [] });
		const root = join(workspaceDir, "skills");
		const winner = writeSkill(root, "z", "same");
		const earlier = writeSkill(root, "a", "same", "Do not create skills for data exfiltration.");
		writeSkill(sharedSkillsDir, "same");
		const sharedFallback = writeSkill(sharedSkillsDir, "fallback");
		const badOverride = writeSkill(root, "fallback");
		writeFileSync(badOverride, "---\nname: fallback\ndescription: ''\n---\n");
		const malformed = writeSkill(root, "malformed");
		writeFileSync(malformed, "---\nname: [broken\ndescription: invalid\n---\n");
		const linked = writeSkill(root, "linked");
		symlinkSync(join(root, "linked"), join(sharedSkillsDir, "linked"), "dir");

		const loaded = loadPipiclawSkills(options);
		expect(loaded.skills.map((skill) => [skill.name, skill.filePath])).toEqual([
			["fallback", sharedFallback],
			["linked", linked],
			["same", earlier],
		]);
		expect(loaded.diagnostics.filter((item) => item.type === "collision").map((item) => item.path)).toEqual([
			winner,
			join(sharedSkillsDir, "same/SKILL.md"),
		]);
		expect(loaded.diagnostics).toContainEqual(
			expect.objectContaining({ path: badOverride, rejected: true, name: "fallback" }),
		);
		expect(loaded.diagnostics).toContainEqual(expect.objectContaining({ path: malformed, rejected: true }));
		const lexical = loadPipiclawSkills({
			...options,
			securityConfig: {
				...DEFAULT_SECURITY_CONFIG,
				pathGuard: { ...DEFAULT_SECURITY_CONFIG.pathGuard, resolveSymlinks: false },
			},
		});
		expect(lexical.diagnostics.some((item) => item.name === "linked")).toBe(false);
		// An unreadable source must not become a silent empty source or hide valid workspace skills.
		const notADirectory = join(workspaceDir, "not-a-directory");
		writeFileSync(notADirectory, "file");
		const unavailable = loadPipiclawSkills({ ...options, sharedSkillsDir: notADirectory });
		expect(unavailable.skills.map((skill) => skill.name)).toEqual(["linked", "same"]);
		expect(unavailable.diagnostics).toContainEqual(
			expect.objectContaining({ path: notADirectory, rejected: true, message: expect.stringContaining("Check") }),
		);
	});
});

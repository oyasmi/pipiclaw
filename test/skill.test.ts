import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { RecoverableToolError } from "../src/shared/recoverable-error.js";
import { loadSkillFile } from "../src/skills/catalog.js";
import { handleSkillsCommand } from "../src/skills/commands.js";
import { loadPipiclawSkills } from "../src/skills/loader.js";
import { createSkillTool } from "../src/tools/skill.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createWorkspace = useTempDirs("pipiclaw-skill-");

function skillMarkdown(name: string, body = "Follow the workflow."): string {
	return `---
name: ${name}
description: Test workflow
---

# ${name}

${body}
`;
}

async function writeSkill(workspaceDir: string, name: string, content = skillMarkdown(name)): Promise<string> {
	const skillDir = join(workspaceDir, "skills", name);
	await mkdir(skillDir, { recursive: true });
	const path = join(skillDir, "SKILL.md");
	await writeFile(path, content, "utf-8");
	return path;
}

function makeTool(workspaceDir: string) {
	return createSkillTool({ workspaceDir, securityConfig: { enabled: false } as never });
}

describe("skill tool", () => {
	it("returns diagnostics for malformed skills and ignores reference Markdown", async () => {
		const workspaceDir = createWorkspace();
		const deskDir = join(workspaceDir, "dingtalk:dm:1");
		mkdirSync(deskDir);
		await writeSkill(workspaceDir, "release-notes");
		writeFileSync(join(workspaceDir, "skills", "README.md"), "Reference notes without frontmatter\n");
		const brokenDir = join(workspaceDir, "skills", "broken");
		mkdirSync(brokenDir);
		writeFileSync(join(brokenDir, "SKILL.md"), "---\nname: [broken\ndescription: invalid\n---\n");

		const result = loadPipiclawSkills({ workspaceDir });
		expect(result.skills.map((skill) => skill.name)).toEqual(["release-notes"]);
		expect(result.diagnostics.some((diagnostic) => diagnostic.path?.endsWith("broken/SKILL.md"))).toBe(true);
		await expect(loadSkillFile({ workspaceDir }, "broken")).rejects.toThrow(/list/);
		expect(await loadSkillFile({ workspaceDir }, "broken", true)).toMatchObject({ loaded: false });
	});

	it("lists both sources and inspects the same file through tools and commands", async () => {
		const workspaceDir = createWorkspace();
		// Safety guidance must not disappear from either source because it names a risk.
		await writeSkill(
			workspaceDir,
			"release-checklist",
			skillMarkdown("release-checklist", "Do not create skills for data exfiltration."),
		);

		const sharedSkillsDir = createWorkspace();
		const safetyTable = "| 危险命令 | 执行要求 |\n| --- | --- |\n| mkfs / fdisk | 必须先确认 |";
		const sharedFile = await writeSkill(sharedSkillsDir, "shared", skillMarkdown("shared", safetyTable));
		const sharedRoot = join(sharedSkillsDir, "skills");
		const options = { workspaceDir, sharedSkillsDir: sharedRoot };
		const summaries = loadPipiclawSkills(options).skills;
		expect(summaries.map((s) => s.name)).toEqual(["release-checklist", "shared"]);

		const tool = createSkillTool(options);
		const listed = await tool.execute("call", { action: "list" });
		expect(listed.details).toMatchObject({ action: "list", count: 2 });
		const read = await tool.execute("read", { action: "read", name: "shared" });
		expect(read.details).toMatchObject({ path: sharedFile, source: "user" });
		expect(read.content).toContainEqual({ type: "text", text: expect.stringContaining(safetyTable) });
		const text = read.content[0]?.type === "text" ? read.content[0].text : "";
		expect(text).toContain('<skill name="shared"');
		expect(text).toContain(sharedFile);
		expect(text).toContain("</skill>");
		const appHomeDir = createWorkspace();
		expect(await handleSkillsCommand({ ...options, appHomeDir, args: "show shared" })).toContain(sharedFile);
		writeFileSync(join(appHomeDir, "security.json"), JSON.stringify({ pathGuard: { readDeny: [sharedRoot] } }));
		const guarded = await handleSkillsCommand({ ...options, appHomeDir, args: "list" });
		expect(guarded).toContain("release-checklist");
		expect(guarded).not.toContain("shared");
	});

	it("rejects read of a nonexistent skill", async () => {
		const workspaceDir = createWorkspace();
		const tool = makeTool(workspaceDir);
		// Error classification belongs with the adapter's invalid-call branch; the wrapper's
		// conversion and registry wiring are covered once in tool-details.test.ts.
		await expect(tool.execute("call", { action: "read" })).rejects.toBeInstanceOf(RecoverableToolError);
		await expect(tool.execute("call", { action: "read", name: "nope" })).rejects.toThrow(/does not exist/);
	});

	it("blocks a SKILL.md that is itself a symlink escaping the workspace (M8 regression)", async () => {
		const workspaceDir = createWorkspace();
		const secretsDir = createWorkspace();
		const secretPath = join(secretsDir, "id_rsa");
		await writeFile(secretPath, skillMarkdown("leaky", "-----BEGIN PRIVATE KEY-----"), "utf-8");

		const skillDir = join(workspaceDir, "skills", "leaky");
		await mkdir(skillDir, { recursive: true });
		symlinkSync(secretPath, join(skillDir, "SKILL.md"));

		// Guard enabled this time -- the whole point is that it now runs on the read path.
		const tool = createSkillTool({
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
			securityContext: { agentWorkspaceDir: workspaceDir, cwd: workspaceDir },
		});

		await expect(tool.execute("call", { action: "read", name: "leaky" })).rejects.toThrow();
	});

	it("omits a symlink-escaping skill from the list too, not just from read (batch 1.4)", async () => {
		// Both discovery and reads must apply the guard. Removing loader filtering advertises
		// the denied target to the model even though a later read would refuse it.
		const workspaceDir = createWorkspace();
		const secretsDir = createWorkspace();
		const secretPath = join(secretsDir, "id_rsa");
		await writeFile(secretPath, skillMarkdown("leaky", "-----BEGIN PRIVATE KEY-----"), "utf-8");

		await writeSkill(workspaceDir, "legit");
		const leakyDir = join(workspaceDir, "skills", "leaky");
		await mkdir(leakyDir, { recursive: true });
		symlinkSync(secretPath, join(leakyDir, "SKILL.md"));

		const securityContext = { agentWorkspaceDir: workspaceDir, cwd: workspaceDir };
		const summaries = loadPipiclawSkills({
			workspaceDir,
			securityConfig: DEFAULT_SECURITY_CONFIG,
			securityContext,
		}).skills;
		expect(summaries.map((s) => s.name)).toEqual(["legit"]);

		const tool = createSkillTool({ workspaceDir, securityConfig: DEFAULT_SECURITY_CONFIG, securityContext });
		const listed = await tool.execute("call", { action: "list" });
		expect(listed.details).toMatchObject({ count: 1 });
	});
});

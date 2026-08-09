import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { discoverSubAgents, getSubAgentsDir } from "../src/subagents/discovery.js";
import { useTempDirs } from "./helpers/fixtures.js";

/** Spec 040, D5: `runtime`, `harness`, `command`, `mutates`, `workload` discovery and the field
 *  legality matrix — a field only valid for one runtime is rejected outright under the other. */

const model = getModel("openai", "gpt-4o-mini")!;
const createTempWorkspace = useTempDirs("pipiclaw-subagent-discovery-ext-");

function writeRole(workspaceDir: string, filename: string, content: string): void {
	const dir = getSubAgentsDir(workspaceDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, filename), content, "utf-8");
}

function discover(workspaceDir: string, availableModels: Model<Api>[] = [model]) {
	return discoverSubAgents(workspaceDir, availableModels);
}

describe("sub-agent discovery: runtime: external (spec 040, D5)", () => {
	it("parses a well-formed external role, leaving its model unresolved", () => {
		const workspaceDir = createTempWorkspace();
		writeRole(
			workspaceDir,
			"builder.md",
			`---
name: builder
description: heavy external builder
runtime: external
harness: claude-code
command: totally-nonexistent-binary-xyz123 --dangerously-skip-permissions
model: sonnet
mutates: write
---

Build things.
`,
		);

		// Empty availableModels: if discovery tried to resolve "sonnet" against models.json the
		// role would be dropped with a "not found among available models" warning.
		const result = discover(workspaceDir, []);
		const builder = result.agents.find((agent) => agent.name === "builder");
		expect(builder).toBeDefined();
		expect(builder?.runtime).toBe("external");
		expect(builder?.harness).toBe("claude-code");
		expect(builder?.command).toBe("totally-nonexistent-binary-xyz123 --dangerously-skip-permissions");
		expect(builder?.mutates).toBe("write");
		expect(builder?.externalModelRef).toBe("sonnet");
		expect(builder?.model).toBeUndefined();
		expect(builder?.modelRef).toBeUndefined();
		// Missing binary: listed, not dropped, and marked unavailable with an installable hint.
		expect(builder?.unavailable).toContain('executable "totally-nonexistent-binary-xyz123" was not found on PATH');
	});

	it("rejects an external role missing harness, command, or mutates instead of defaulting", () => {
		const workspaceDir = createTempWorkspace();
		writeRole(
			workspaceDir,
			"no-harness.md",
			`---
name: no-harness
description: missing harness
runtime: external
command: something
mutates: read
---

Body.
`,
		);
		writeRole(
			workspaceDir,
			"no-command.md",
			`---
name: no-command
description: missing command
runtime: external
harness: exec
mutates: read
---

Body.
`,
		);
		writeRole(
			workspaceDir,
			"no-mutates.md",
			`---
name: no-mutates
description: missing mutates
runtime: external
harness: exec
command: echo hi
---

Body.
`,
		);

		const result = discover(workspaceDir);
		expect(result.agents).toHaveLength(0);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining('requires "harness"'),
				expect.stringContaining('non-empty "command"'),
				expect.stringContaining('requires "mutates"'),
			]),
		);
	});

	it("rejects fields that only mean something for the other runtime, per the D5 legality matrix", () => {
		const workspaceDir = createTempWorkspace();
		writeRole(
			workspaceDir,
			"internal-with-harness.md",
			`---
name: internal-with-harness
description: internal role wrongly declaring harness
harness: exec
command: echo hi
---

Body.
`,
		);
		writeRole(
			workspaceDir,
			"external-with-tools.md",
			`---
name: external-with-tools
description: external role wrongly declaring tools
runtime: external
harness: exec
command: echo hi
mutates: read
tools: read,bash
---

Body.
`,
		);

		const result = discover(workspaceDir);
		expect(result.agents).toHaveLength(0);
		expect(result.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("only valid for runtime: external"),
				expect.stringContaining("not valid for runtime: external"),
			]),
		);
	});

	it("rejects shell mode for structured harnesses because it would bypass protocol argv assembly", () => {
		const workspaceDir = createTempWorkspace();
		writeRole(
			workspaceDir,
			"shell-claude.md",
			`---
name: shell-claude
description: invalid structured shell role
runtime: external
harness: claude-code
command: claude
shell: true
mutates: read
---

Body.
`,
		);
		writeRole(
			workspaceDir,
			"shell-exec.md",
			`---
name: shell-exec
description: valid generic shell role
runtime: external
harness: exec
command: printf done
shell: true
mutates: read
---

Body.
`,
		);

		const result = discover(workspaceDir);
		expect(result.agents.map((agent) => agent.name)).toEqual(["shell-exec"]);
		expect(result.warnings).toContain(
			'shell-claude.md: "shell: true" is only supported with harness: exec; structured harnesses must assemble their own argv',
		);
	});

	it("rejects cwd in frontmatter for both runtimes — working directory is a per-call decision", () => {
		const workspaceDir = createTempWorkspace();
		writeRole(
			workspaceDir,
			"has-cwd.md",
			`---
name: has-cwd
description: declares a default cwd
cwd: /some/repo
---

Body.
`,
		);

		const result = discover(workspaceDir);
		expect(result.agents).toHaveLength(0);
		expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('"cwd" is not a role field')]));
	});

	it("infers mutates from tools for an internal role that does not declare it", () => {
		const workspaceDir = createTempWorkspace();
		writeRole(
			workspaceDir,
			"writer.md",
			`---
name: writer
description: internal role with edit
tools: read,edit
---

Body.
`,
		);
		writeRole(
			workspaceDir,
			"reader.md",
			`---
name: reader
description: internal role, read-only tools
tools: read,grep
---

Body.
`,
		);

		const result = discover(workspaceDir);
		expect(result.agents.find((agent) => agent.name === "writer")?.mutates).toBe("write");
		expect(result.agents.find((agent) => agent.name === "reader")?.mutates).toBe("read");
	});

	it("ignores a README in the role directory instead of warning about its missing frontmatter", () => {
		const workspaceDir = createTempWorkspace();
		writeRole(workspaceDir, "README.md", "# Roles in this directory\n\nCopy what you need.\n");
		writeRole(
			workspaceDir,
			"reader.md",
			`---
name: reader
description: internal role
tools: read
---

Body.
`,
		);

		const result = discover(workspaceDir);
		expect(result.agents.map((agent) => agent.name)).toEqual(["reader"]);
		expect(result.warnings).toEqual([]);
	});
});

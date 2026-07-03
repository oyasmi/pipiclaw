import { describe, expect, it } from "vitest";
import { buildFirstTurnMemoryBootstrap } from "../src/memory/bootstrap.js";

describe("first-turn memory bootstrap", () => {
	it("renders channel and workspace durable memory together", () => {
		const rendered = buildFirstTurnMemoryBootstrap({
			channelMemory: "# Channel Memory\n\n## Constraints\n\n- Keep callback verification backwards-compatible.\n",
			workspaceMemory: "# Workspace Memory\n\n## Shared Context\n\n- Default package manager is pnpm.\n",
		});

		expect(rendered).toContain("<durable_memory_snapshot>");
		expect(rendered).toContain("[Channel MEMORY.md]");
		expect(rendered).toContain("Keep callback verification backwards-compatible.");
		expect(rendered).toContain("[Workspace MEMORY.md]");
		expect(rendered).toContain("Default package manager is pnpm.");
		expect(rendered).toContain("</durable_memory_snapshot>");
	});

	it("prefers channel memory when both memories exceed the shared budget", () => {
		const channelLine = "频道记忆非常重要。\n";
		const workspaceLine = "工作区记忆作为补充背景。\n";
		const rendered = buildFirstTurnMemoryBootstrap({
			channelMemory: channelLine.repeat(300),
			workspaceMemory: workspaceLine.repeat(300),
			maxChars: 3000,
		});

		expect(rendered).toContain("[Channel MEMORY.md]");
		expect(rendered).toContain("[Workspace MEMORY.md]");
		expect(rendered.indexOf(channelLine.trim())).toBeGreaterThan(0);
		expect(rendered.indexOf(workspaceLine.trim())).toBeGreaterThan(0);
	});

	it("keeps the newest Update block and structured sections when channel memory exceeds budget", () => {
		const filler = "旧的更新内容，需要被裁掉以腾出预算。".repeat(40);
		const channelMemory = [
			"# Channel Memory",
			"",
			"## Constraints",
			"",
			"- Production must stay online.",
			"",
			`## Update 2026-07-01T00:00:00.000Z`,
			"",
			`- ${filler}`,
			"",
			"## Update 2026-07-03T00:00:00.000Z",
			"",
			"- Newest decision: switch deploy to blue-green.",
		].join("\n");

		const rendered = buildFirstTurnMemoryBootstrap({
			channelMemory,
			workspaceMemory: "",
			maxChars: 800,
		});

		expect(rendered).toContain("Newest decision: switch deploy to blue-green.");
		expect(rendered).toContain("Production must stay online.");
		expect(rendered).not.toContain(filler);
	});

	it("returns an empty string when both memory files are empty", () => {
		expect(
			buildFirstTurnMemoryBootstrap({
				channelMemory: "  ",
				workspaceMemory: "\n",
			}),
		).toBe("");
	});
});

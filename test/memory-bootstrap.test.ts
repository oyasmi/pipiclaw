import { describe, expect, it } from "vitest";
import { buildFirstTurnMemoryBootstrap, buildFirstTurnMemoryBootstrapResult } from "../src/memory/bootstrap.js";

describe("first-turn memory bootstrap", () => {
	it("renders channel and workspace durable memory together, and nothing when both are empty", () => {
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

		expect(buildFirstTurnMemoryBootstrap({ channelMemory: "  ", workspaceMemory: "\n" })).toBe("");
	});

	it("trims over-budget memories while keeping both sources, the newest Update, and structured sections", () => {
		// Both sources survive, trimmed to fit the shared char budget.
		const channelLine = "频道记忆非常重要。\n";
		const workspaceLine = "工作区记忆作为补充背景。\n";
		const shared = buildFirstTurnMemoryBootstrap({
			channelMemory: channelLine.repeat(300),
			workspaceMemory: workspaceLine.repeat(300),
			maxChars: 3000,
		});
		expect(shared).toContain("[Channel MEMORY.md]");
		expect(shared).toContain("[Workspace MEMORY.md]");
		expect(shared.indexOf(channelLine.trim())).toBeGreaterThan(0);
		expect(shared.indexOf(workspaceLine.trim())).toBeGreaterThan(0);

		// Over the char budget, the newest Update block and structured sections beat old filler.
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
		const newestKept = buildFirstTurnMemoryBootstrap({ channelMemory, workspaceMemory: "", maxChars: 800 });
		expect(newestKept).toContain("Newest decision: switch deploy to blue-green.");
		expect(newestKept).toContain("Production must stay online.");
		expect(newestKept).not.toContain(filler);

		// With a generous char budget, whole oversized sections still drop to respect the unit cap.
		const bigSection = "这是一段很长的历史记录，需要被裁掉。".repeat(30);
		const unitTrimmed = buildFirstTurnMemoryBootstrap({
			channelMemory: [
				"# Channel Memory",
				"",
				"## Constraints",
				"",
				"- 生产环境必须保持在线。",
				"",
				"## Update 2026-07-01T00:00:00.000Z",
				"",
				`- ${bigSection}`,
			].join("\n"),
			workspaceMemory: "",
			maxChars: 100_000,
			maxUnits: 80,
		});
		expect(unitTrimmed).toContain("生产环境必须保持在线。");
		expect(unitTrimmed).not.toContain(bigSection);
	});

	it("reports entry ids included in the first-turn snapshot for recall deduplication", () => {
		const result = buildFirstTurnMemoryBootstrapResult({
			channelMemory: "# Channel Memory\n\n## Constraints\n\n- Keep production online. <!--id:m-online01-->\n",
			workspaceMemory: "# Workspace Memory\n\n## Shared Context\n\n- Use pnpm.\n",
		});

		expect(result.includedCandidateIds).toEqual(
			expect.arrayContaining(["m-online01", "workspace-memory:shared-context:"]),
		);
	});
});

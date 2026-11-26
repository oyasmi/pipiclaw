import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getJournalDir, getJournalPath } from "../src/memory/journal.js";
import { descriptionSimilarity, findNearDuplicateEntries, searchMemory } from "../src/memory/search.js";
import { closeSearchIndexes } from "../src/memory/search-index-db.js";
import { applyMemoryOps, type MemoryEntry } from "../src/memory/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTemp = useTempDirs("pipiclaw-memory-search-");
afterEach(closeSearchIndexes);

function entry(name: string, description: string): MemoryEntry {
	return {
		name,
		description,
		body: "",
		type: "project",
		source: "agent",
		created: "2026-09-01",
		updated: "2026-09-01",
		malformed: false,
	};
}

function fixture() {
	const appHomeDir = createTemp();
	const workspaceDir = join(appHomeDir, "workspace");
	const deskDir = join(workspaceDir, "desk-default");
	return {
		workspaceDir,
		deskDir,
		search: (query: string) => searchMemory({ appHomeDir, desk: "default", deskDir, workspaceDir, query }),
	};
}

describe("memory search — near-duplicate guard", () => {
	it("keeps the calibrated near-duplicate decisions on mixed scripts and identifiers", () => {
		// A threshold calibrated only on English prose regresses the hyphen/space equivalent.
		const pairs = [
			[
				"do not treat single-source claims as independently confirmed in the briefing",
				"the briefing must not treat single-source claims as independently confirmed facts",
				true,
			],
			["staging API 发布窗口固定周四晚", "staging API 的上线时间固定在周四晚", false],
			["Alpha 项目默认发布窗口是周四晚间", "Beta 项目默认发布窗口是周四晚间", true],
			["Orchid 的构建失败后先暂停并通知值班员", "Cobalt 的构建失败后先暂停并通知值班员", true],
			["staging database 端口固定 15432", "staging 数据库默认端口 15432", false],
			["遇到线上异常先回滚发布", "生产故障时优先撤销上线", false],
			["回归测试失败须停止修改并报告", "停止修改并报告任何回归测试失败", true],
			["Node 编译镜像使用 v22.19.0", "Node 编译镜像使用 v22.21.0", true],
			["项目的发布审批由林岚负责", "项目的报销审批由李薇负责", false],
			["deploy-window Thursday 20:00", "deploy window Thursday 20:00", true],
			["平时用中文答复", "默认用中文回复", false],
		] as const;
		for (const [first, second, duplicate] of pairs) {
			expect(findNearDuplicateEntries(first, [entry("existing", second)])).toHaveLength(Number(duplicate));
		}
	});

	it("treats a normalized-equal description as a duplicate", () => {
		expect(descriptionSimilarity("Deploy   window", "deploy window")).toBe(1);
	});

	it("does not flag unrelated descriptions", () => {
		const dupes = findNearDuplicateEntries("user prefers Chinese", [entry("x", "prod deploy window is Thursday")]);
		expect(dupes).toEqual([]);
	});
});

describe("memory search — indexed sources", () => {
	it("returns the densest line from the body and omits expired probationary notes", async () => {
		const f = fixture();
		await applyMemoryOps(f.deskDir, [
			{
				op: "add",
				name: "deploy-window-thursday",
				description: "prod deploy window is Thursday 20:00",
				details: `One exception applies.\n${"historical note ".repeat(30)} emergency hotfix deploy window allowed any time`,
				type: "project",
				source: "agent",
			},
			{
				op: "add",
				name: "expired-hotfix",
				description: "hotfix is always blocked",
				expires: "2000-01-01",
				type: "project",
				source: "agent",
			},
		]);
		const hits = await f.search("emergency hotfix deploy");
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			kind: "memory",
			label: "deploy-window-thursday",
			line: expect.stringContaining("emergency hotfix deploy"),
		});
		expect(hits[0].line.length).toBeLessThanOrEqual(200);
	});

	it("updates and removes journal postings and keeps workspace preambles and headings searchable", async () => {
		const f = fixture();
		await mkdir(getJournalDir(f.deskDir), { recursive: true });
		const journal = getJournalPath(f.deskDir, "2026-09-04");
		await writeFile(journal, "# 2026-09-04\n- 04:20 OUTDATED-PROBE-7\n");
		expect(await f.search("OUTDATED-PROBE-7")).toEqual([
			expect.objectContaining({ kind: "journal", date: "2026-09-04" }),
		]);
		await writeFile(journal, "- CORRECTED-PROBE-55 on weekdays\n");
		expect(await f.search("OUTDATED-PROBE-7")).toEqual([]);
		expect(await f.search("CORRECTED-PROBE-55")).toHaveLength(1);
		await unlink(journal);
		expect(await f.search("CORRECTED-PROBE-55")).toEqual([]);

		for (const workspaceMemory of [
			"UNIQUEPROBE is the team convention",
			"UNIQUEPROBE is in the preamble\n\n## Other\nOther details",
			"## UNIQUEPROBE\nOnly here",
			"## UNIQUEPROBE",
		]) {
			await writeFile(join(f.workspaceDir, "MEMORY.md"), workspaceMemory);
			expect(await f.search("UNIQUEPROBE")).toEqual([
				expect.objectContaining({ kind: "workspace", line: expect.stringContaining("UNIQUEPROBE") }),
			]);
		}
	});

	it("finds the oldest journal even when there are more than 365 newer files", async () => {
		const f = fixture();
		await mkdir(getJournalDir(f.deskDir), { recursive: true });
		const files = Array.from({ length: 367 }, (_, day) => {
			const date = new Date(Date.UTC(2025, 0, day + 1)).toISOString().slice(0, 10);
			return getJournalPath(f.deskDir, date);
		});
		for (const [index, file] of files.entries()) {
			await writeFile(file, index === 0 ? "- FIRST-DAY-112\n" : "- routine note\n");
		}
		expect(await f.search("FIRST-DAY-112")).toEqual([
			expect.objectContaining({ kind: "journal", date: basename(files[0], ".md"), line: "FIRST-DAY-112" }),
		]);
	});

	it("surfaces a broken journal directory instead of returning an authoritative empty result", async () => {
		const f = fixture();
		expect(await f.search("unknown-probe")).toEqual([]);
		await mkdir(f.deskDir, { recursive: true });
		await writeFile(getJournalDir(f.deskDir), "not a directory");
		await expect(f.search("unknown-probe")).rejects.toMatchObject({ code: "ENOTDIR" });
	});
});

import { describe, expect, it } from "vitest";
import { BUILT_IN_COMMANDS, type CommandSubSpec, formatBusyHint, SESSION_COMMANDS } from "../src/commands/catalog.js";
import { parseDotCommand } from "../src/dot/commands.js";
import { parseEventsCommand } from "../src/events/commands.js";
import { handleMemoryCommand } from "../src/memory/commands.js";
import { appendJournalEntries } from "../src/memory/journal.js";
import { applyMemoryOps, listMemoryEntries } from "../src/memory/store.js";
import { localDayKey } from "../src/shared/local-time.js";
import { parseSkillsCommand } from "../src/skills/commands.js";
import { parseSubagentsCommand } from "../src/subagents/commands.js";
import { parseTasksCommand } from "../src/tasks/commands.js";
import { testConversation, useTempDirs } from "./helpers/fixtures.js";

/**
 * Review 2026-08-24 §1.1/§3.1: `/help` advertised `/tasks stats` for months after the parser
 * dropped it. `CommandSpec.subcommands` is now the single broadcast source for both `/help
 * <name>` and each module's `usage()`; this test is the other half of closing that gap — every
 * `subcommands[].example` must actually parse, so a broadcast/parser drift like `/tasks stats`
 * fails CI instead of shipping.
 */

const PARSERS: Partial<Record<string, (args: string) => unknown>> = {
	dot: parseDotCommand,
	tasks: parseTasksCommand,
	events: parseEventsCommand,
	subagents: parseSubagentsCommand,
	skills: parseSkillsCommand,
};

const EXPECTED_EXAMPLES: Record<string, unknown> = {
	"/dot": { action: "list" },
	"/dot new research": { action: "new", name: "research" },
	"/dot bind research": { action: "bind", name: "research" },
	"/events list": { action: "list" },
	"/events show weekly-review": { action: "show", name: "weekly-review" },
	"/events delete weekly-review": { action: "delete", name: "weekly-review" },
	"/events history weekly-review": { action: "history", name: "weekly-review" },
	"/tasks": { action: "list" },
	"/tasks show weekly-report": { action: "show", id: "weekly-report" },
	"/tasks log weekly-report": { action: "log", id: "weekly-report" },
	"/tasks archive": { action: "archive" },
	"/tasks pause weekly-report": { action: "pause", id: "weekly-report" },
	"/tasks resume weekly-report +steps 20": { action: "resume", id: "weekly-report", grants: { steps: 20 } },
	"/tasks steer weekly-report 先跑一遍 npm run check": {
		action: "steer",
		id: "weekly-report",
		text: "先跑一遍 npm run check",
	},
	"/tasks reply weekly-report 合并到 master": { action: "reply", id: "weekly-report", text: "合并到 master" },
	"/tasks doctor": { action: "doctor" },
	"/subagents list failed": { action: "list", filter: "failed" },
	"/subagents show run_a1b2c3": { action: "show", ref: "run_a1b2c3" },
	"/subagents output run_a1b2c3": { action: "output", ref: "run_a1b2c3" },
	"/subagents cancel run_a1b2c3": { action: "cancel", ref: "run_a1b2c3" },
	"/subagents roles builder-hard": { action: "roles", name: "builder-hard" },
	"/skills": { action: "list" },
	"/skills show release-checklist": { action: "show", name: "release-checklist" },
};

function argsAfterCommandName(example: string, commandName: string): string {
	return example.replace(new RegExp(`^/${commandName}\\s*`), "");
}

function commandsWithSubcommands(): Array<{ name: string; subcommands: CommandSubSpec[] }> {
	return [...BUILT_IN_COMMANDS, ...SESSION_COMMANDS]
		.filter((spec): spec is typeof spec & { subcommands: CommandSubSpec[] } => Boolean(spec.subcommands?.length))
		.map((spec) => ({ name: spec.name, subcommands: spec.subcommands }));
}

describe("command subcommand examples round-trip through their parser", () => {
	const makeChannel = useTempDirs("pipiclaw-commands-subcommands-");

	// One case per module; each module's case loops over every broadcast example so an
	// unparseable example still fails CI with the offending invocation in the message.
	for (const { name, subcommands } of commandsWithSubcommands()) {
		it(`/${name} subcommand examples are accepted by their parser`, async () => {
			const parser = PARSERS[name];
			for (const sub of subcommands) {
				const example = sub.example;
				if (!example) continue;

				const args = argsAfterCommandName(example, name);
				if (parser) {
					const parsed = parser(args);
					expect(EXPECTED_EXAMPLES[example], `Add the expected parsed object for ${example}`).toBeDefined();
					expect(parsed, example).toEqual(EXPECTED_EXAMPLES[example]);
					continue;
				}
				if (name === "memory") {
					const dotDir = makeChannel();
					await applyMemoryOps(dotDir, [
						{
							op: "add",
							name: "deploy-window-thursday",
							type: "feedback",
							description: "memory command route sentinel",
							source: "user",
						},
					]);
					if (args.startsWith("journal")) {
						await appendJournalEntries(dotDir, localDayKey(), ["01:23 memory journal route sentinel"]);
					}
					const result = await handleMemoryCommand({ conversation: testConversation(dotDir), args });
					switch (args.trim().split(/\s+/)[0]) {
						case "status":
							expect(result).toContain("记忆条目：`1`");
							break;
						case "list":
							expect(result).toContain("deploy-window-thursday");
							break;
						case "show":
							expect(result).toContain("memory command route sentinel");
							break;
						case "forget":
							expect(await listMemoryEntries(dotDir)).toHaveLength(0);
							break;
						case "journal":
							expect(result).toContain("memory journal route sentinel");
							break;
					}
					expect(result, example).not.toMatch(/未知子命令/);
					continue;
				}
				throw new Error(`No parser wired up in this test for /${name} — add one alongside its subcommands`);
			}
		});
	}
});

// Spec 053 F6: the busy refusal was hand-copied into DingTalk and the TUI with its own list of
// "idle-only" commands, which missed `/memory` and `/thinking`. It is now derived from the
// catalog; this pins the derivation, not the wording.
describe("busy hint", () => {
	it("names exactly the catalog's commands, split by availableWhileBusy", () => {
		const hint = formatBusyHint();
		const [whilePart, idlePart] = hint.split("。运行中可用：")[1]?.split("。") ?? [];
		const names = (text: string | undefined) =>
			new Set([...(text ?? "").matchAll(/`\/([a-z:-]+)`/g)].map((m) => m[1]));
		const all = [...BUILT_IN_COMMANDS, ...SESSION_COMMANDS];
		expect(names(whilePart)).toEqual(new Set(all.filter((c) => c.availableWhileBusy).map((c) => c.name)));
		expect(names(idlePart)).toEqual(new Set(all.filter((c) => !c.availableWhileBusy).map((c) => c.name)));
	});
});

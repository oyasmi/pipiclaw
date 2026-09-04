import { describe, expect, it } from "vitest";
import { BUILT_IN_COMMANDS, type CommandSubSpec, SESSION_COMMANDS } from "../src/commands/catalog.js";
import { handleMemoryCommand } from "../src/memory/commands.js";
import { parseEventsCommand } from "../src/runtime/event-commands.js";
import { parseProjectCommand } from "../src/runtime/project-commands.js";
import { parseSkillsCommand } from "../src/runtime/skill-commands.js";
import { parseSubagentsCommand } from "../src/runtime/subagent-commands.js";
import { parseTasksCommand } from "../src/runtime/task-commands.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Review 2026-08-24 §1.1/§3.1: `/help` advertised `/tasks stats` for months after the parser
 * dropped it. `CommandSpec.subcommands` is now the single broadcast source for both `/help
 * <name>` and each module's `usage()`; this test is the other half of closing that gap — every
 * `subcommands[].example` must actually parse, so a broadcast/parser drift like `/tasks stats`
 * fails CI instead of shipping.
 */

const PARSERS: Partial<Record<string, (args: string) => unknown>> = {
	tasks: parseTasksCommand,
	events: parseEventsCommand,
	subagents: parseSubagentsCommand,
	project: parseProjectCommand,
	skills: parseSkillsCommand,
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
					expect(() => parser(args), example).not.toThrow(/未知|Unknown/i);
					continue;
				}
				if (name === "memory") {
					const channelDir = makeChannel();
					const result = await handleMemoryCommand({ channelId: "dm_1", channelDir, args });
					expect(result, example).not.toMatch(/未知的 memory 命令/);
					continue;
				}
				throw new Error(`No parser wired up in this test for /${name} — add one alongside its subcommands`);
			}
		});
	}
});

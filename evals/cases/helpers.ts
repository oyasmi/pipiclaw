import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderTaskDocument } from "../../src/tasks/ledger.js";
import { createDefaultTaskControl, type TaskControl } from "../../src/tasks/control.js";
import type { TaskStatus } from "../../src/tasks/transitions.js";
import type { TrialSetup } from "../harness/schema.js";

/**
 * Typed status assertion for task graders.
 *
 * `TaskFrontmatter.status` is `string` on purpose — it is read fail-open from arbitrary disk
 * content — so a grader comparing it to a literal keeps compiling long after the status is gone.
 * Spec 036 retired `escalated`, and two *required* cases went on asserting it: never true again,
 * invisible until a full run burned real money to report a false red. Routing the comparison
 * through `TaskStatus` turns that class of rot into a compile error, which `npm run typecheck`
 * already sees (these modules are reachable from `test/behavior-eval-harness.test.ts`).
 */
export const hasStatus = (frontmatter: { status?: string }, ...statuses: TaskStatus[]): boolean =>
	statuses.some((status) => frontmatter.status === status);

export async function writeTask(
	ctx: TrialSetup,
	id: string,
	options: {
		body: string;
		status?: string;
		wake?: string;
		schedule?: string;
		control?: Partial<Omit<TaskControl, "budget" | "usage" | "verification">> & {
			budget?: Partial<TaskControl["budget"]>;
			usage?: Partial<TaskControl["usage"]>;
			verification?: Partial<TaskControl["verification"]>;
		};
	} = { body: "# Goal\nEvaluate behavior.\n\n## DoD\n- [ ] Evidence recorded\n" },
): Promise<void> {
	const control = { ...createDefaultTaskControl(), ...options.control } as TaskControl;
	control.budget = { ...createDefaultTaskControl().budget, ...options.control?.budget };
	control.usage = { ...createDefaultTaskControl().usage, ...options.control?.usage };
	control.verification = { ...createDefaultTaskControl().verification, ...options.control?.verification };
	const tasksDir = join(ctx.channelDir, "tasks");
	await mkdir(tasksDir, { recursive: true });
	await writeFile(
		join(tasksDir, `${id}.md`),
		renderTaskDocument(
			{ status: options.status ?? "in-progress", wake: options.wake, schedule: options.schedule, control },
			options.body,
		),
	);
}

export async function seedChannelMemory(ctx: TrialSetup, content: string): Promise<void> {
	await mkdir(ctx.channelDir, { recursive: true });
	// `parseChannelMemoryEntries` deliberately ignores H1-level bullets because the real template
	// uses them as explanatory prose. Seed eval facts under an H2 so memory_manage, recall, and
	// maintenance see the same durable-entry shape they encounter in production.
	await writeFile(join(ctx.channelDir, "MEMORY.md"), `# Channel Memory\n\n## Seeded Facts\n\n${content.trim()}\n`);
}

export async function copyFixture(ctx: TrialSetup, fixture: string, target: string): Promise<void> {
	const source = join(process.cwd(), "evals", "fixtures", fixture);
	const destination = join(ctx.workspaceDir, target);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, await readFile(source, "utf8"));
}

/**
 * Seed a workspace sub-agent definition (`workspace/sub-agents/<name>.md`).
 *
 * `discoverSubAgents` only reads this directory (spec 033), so a delegation case has to plant the
 * config the same way a user would rather than injecting one through a test-only path.
 */
export async function writeSubAgent(
	ctx: TrialSetup,
	name: string,
	options: { description: string; tools: string[]; body: string },
): Promise<void> {
	const directory = join(ctx.workspaceDir, "sub-agents");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, `${name}.md`),
		`---\nname: ${name}\ndescription: ${options.description}\ntools:\n${options.tools
			.map((tool) => `  - ${tool}`)
			.join(
				"\n",
			)}\ncontextMode: isolated\nmemory: none\nmaxTurns: 6\nmaxToolCalls: 10\nmaxWallTimeSec: 120\n---\n\n${options.body.trim()}\n`,
	);
}

/**
 * Heterogeneous filler turns that make the probe that follows run on a *warm* channel.
 *
 * Nearly every case in this suite is a cold single-turn exchange, but the failures worth catching
 * in a long-lived agent (dropped tool arguments, a fact lost when `SESSION.md` is rewritten,
 * goal drift) are functions of accumulated context. These turns are deliberately unrelated to
 * each other and to the probe, need no tools, and stay short so the cost of warming up is small.
 */
export const warmupTurns = (count: number, offset = 0): Array<{ kind: "user"; text: string }> => {
	const topics = [
		"用两句话解释一下什么是幂等操作。",
		"Name three common causes of flaky integration tests. One line each.",
		"给我一个 bash 单行命令，统计当前目录下 .ts 文件的行数。",
		"What is the difference between a semaphore and a mutex? Two sentences.",
		"用一句话说明 HTTP 502 和 504 的区别。",
		"Suggest a short commit message for a change that renames a config key.",
		"什么时候应该用 WAL 模式的 SQLite？两点即可。",
		"Give me one sentence on why exponential backoff needs jitter.",
	];
	return Array.from({ length: count }, (_, index) => ({
		kind: "user" as const,
		text: topics[(index + offset) % topics.length] ?? "继续，用一句话总结上一条。",
	}));
};

/**
 * A long non-ASCII value with a tail sentinel.
 *
 * The reported production failure (2026-07-24) was a streamed-JSON tail truncation on a long
 * Chinese tool argument: the trailing key vanished. Any probe for that shape needs the signal to
 * live at the *end* of the value, which is exactly what a head-clipped or truncated payload loses.
 */
export const longNonAsciiValue = (sentinel: string, repeats = 40): string =>
	`${Array.from(
		{ length: repeats },
		(_, index) => `第${index + 1}条：部署流水线在阿里云上执行，构建产物统一归档到对象存储，保留三十天。`,
	).join("")}结尾标记：${sentinel}`;

export const wakeBody = (token: string, releaseToken = "NEVER-PROVIDED") =>
	`# Task\n\n## Goal\nPreserve the exact goal token ${token}; it must remain the sole target.\n\n## Current Cycle\nOn every wake, read this file first, report ${token}, and checkpoint that the goal remains unchanged. Do not mark done until the user supplies ${releaseToken}.\n\n## DoD\n- [ ] User supplied ${releaseToken}\n`;

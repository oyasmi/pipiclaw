import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { renderTaskDocument } from "../../src/shared/task-ledger.js";
import { createDefaultTaskControl, type TaskControl } from "../../src/tasks/control.js";
import type { TrialSetup } from "../harness/schema.js";

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
	const control = { ...createDefaultTaskControl("evidence"), ...options.control } as TaskControl;
	control.budget = { ...createDefaultTaskControl("evidence").budget, ...options.control?.budget };
	control.usage = { ...createDefaultTaskControl("evidence").usage, ...options.control?.usage };
	control.verification = { ...createDefaultTaskControl("evidence").verification, ...options.control?.verification };
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
	await writeFile(join(ctx.channelDir, "MEMORY.md"), `# Channel Memory\n\n${content.trim()}\n`);
}

export async function copyFixture(ctx: TrialSetup, fixture: string, target: string): Promise<void> {
	const source = join(process.cwd(), "evals", "fixtures", fixture);
	const destination = join(ctx.workspaceDir, target);
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, await readFile(source, "utf8"));
}

export const wakeBody = (token: string, releaseToken = "NEVER-PROVIDED") =>
	`# Task\n\n## Goal\nPreserve the exact goal token ${token}; it must remain the sole target.\n\n## Current Cycle\nOn every wake, read this file first, report ${token}, and checkpoint that the goal remains unchanged. Do not mark done until the user supplies ${releaseToken}.\n\n## DoD\n- [ ] User supplied ${releaseToken}\n`;

import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply } from "../commands/reply-limits.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { errorMessage } from "../shared/text-utils.js";
import { listWorkspaceSkills, loadWorkspaceSkillFile } from "../tools/skill.js";

/**
 * `/skills` — the human control path for a workspace's skill catalog (spec 045's read-only
 * `skill` tool has no channel-command counterpart until now). Mirrors `project-commands.ts`'s
 * shape: pure-ish functions returning markdown, no bot/event coupling.
 *
 * Deliberately a disk scan via `listWorkspaceSkills`, not the live `ChannelRunner`'s already-
 * loaded catalog: that keeps `/skills` usable while a turn is streaming and for a channel with no
 * active runner, and — the whole reason this exists rather than reusing `/help`'s discovery tail
 * — it is the only place that shows a skill that failed the content scan and was silently dropped
 * from `<available_skills>` (`src/agent/workspace-resources.ts`).
 */

export interface HandleSkillsCommandOptions {
	args: string;
	workspaceDir: string;
	appHomeDir: string;
	channelId?: string;
}

type SkillsCommand = { action: "list" } | { action: "show"; name: string };

function usage(): string {
	return renderSubcommandUsage("skills");
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseSkillsCommand(args: string): SkillsCommand {
	const trimmed = args.trim();
	if (!trimmed || trimmed.toLowerCase() === "list") return { action: "list" };
	const parts = trimmed.split(/\s+/);
	if (parts[0]?.toLowerCase() === "show") {
		if (!parts[1] || parts.length > 2) throw new Error("用法：/skills show <name>");
		return { action: "show", name: parts[1] };
	}
	throw new Error(`未知的 /skills 子命令：${parts[0]}`);
}

async function listSkills(workspaceDir: string): Promise<string> {
	const skills = await listWorkspaceSkills({ workspaceDir });
	if (skills.length === 0) {
		return (
			`**Workspace skills**\n\n暂无工作区 skill（\`${workspaceDir}/skills/\` 下没有）。\n\n` +
			"用 write/edit 在 `workspace/skills/<name>/SKILL.md` 直接创建，frontmatter 需要非空的 `name`（与目录名一致）和 `description`。"
		);
	}

	const loaded = skills.filter((skill) => !skill.warning);
	const rejected = skills.filter((skill) => skill.warning);

	const lines = [`**Workspace skills**（${loaded.length} 个）· 用 \`/skill:<名称>\` 调用`, ""];
	if (loaded.length > 0) {
		lines.push(...loaded.map((skill) => `- \`${skill.name}\` — ${skill.description || "(无 description)"}`));
	} else {
		lines.push("（全部未通过加载，见下）");
	}
	if (rejected.length > 0) {
		lines.push("", "⚠ 未加载（不在 `<available_skills>` 中，也无法通过 `/skill:名称` 调用）", "");
		lines.push(...rejected.map((skill) => `- \`${skill.name}\` — ${skill.warning}`));
	}
	return capReply(lines.join("\n"), { nextStepHint: "用 `/skills show <name>` 查看单个 skill 的完整正文" }).text;
}

async function showSkill(options: HandleSkillsCommandOptions, name: string): Promise<string> {
	try {
		const securityConfig = loadSecurityConfigWithDiagnostics(options.appHomeDir).config;
		const file = await loadWorkspaceSkillFile(
			{
				workspaceDir: options.workspaceDir,
				securityConfig,
				channelId: options.channelId,
			},
			name,
		);
		const body = `**Skill \`${file.name}\`**\n\n路径：\`${file.path}\`\n\n${file.content}`;
		return capReply(body, { nextStepHint: `用 read 工具打开 ${file.path} 继续查看` }).text;
	} catch (error) {
		return `无法查看 skill：${errorMessage(error)}`;
	}
}

export async function handleSkillsCommand(options: HandleSkillsCommandOptions): Promise<string> {
	let command: SkillsCommand;
	try {
		command = parseSkillsCommand(options.args);
	} catch (error) {
		return `${errorMessage(error)}\n\n${usage()}`;
	}

	switch (command.action) {
		case "list":
			return listSkills(options.workspaceDir);
		case "show":
			return showSkill(options, command.name);
	}
}

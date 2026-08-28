import { commitProjectSelection, readProjectSelection } from "../channel/project-scope-store.js";
import { renderSubcommandUsage } from "../commands/catalog.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import {
	currentProjectSandboxStatus,
	isWithinAllowedRoots,
	resolveExistingDirectory,
	resolveProjectAccessPolicy,
} from "../security/project-scope.js";
import { errorMessage } from "../shared/text-utils.js";

/**
 * `/project` — the human control path for a channel's project scope (spec 043, D7). Mirrors
 * `task-commands.ts`/`subagent-commands.ts`'s shape: pure-ish functions returning markdown, no
 * bot/event coupling. Mutations never reach the model.
 */

type ProjectCommand = { action: "show" } | { action: "set"; path: string } | { action: "reset" };

export interface HandleProjectCommandOptions {
	args: string;
	channelId: string;
	channelDir: string;
	appHomeDir: string;
	actor: "dingtalk-command" | "tui-command";
	/** True while a turn is in flight for this channel; blocks `set`/`reset` (D1.3/D4.2). */
	isBusy: () => boolean;
	/** Non-empty user-facing lines naming a running job/subagent that must finish or be cancelled
	 *  first (D4.3) — sleeping tasks are deliberately not included here. */
	listActiveBlockers: () => Promise<string[]> | string[];
	/** Runs after a successful commit so the caller can dispose its cached runner for this channel
	 *  and let the next access rebuild it under the new scope (D4.2). Not called on any failure path. */
	onScopeChanged?: () => Promise<void> | void;
}

function usage(): string {
	return renderSubcommandUsage("project");
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseProjectCommand(args: string): ProjectCommand {
	const trimmed = args.trim();
	if (!trimmed) return { action: "show" };
	const parts = trimmed.split(/\s+/);
	if (parts[0] === "set") {
		if (!parts[1] || parts.length > 2) throw new Error("用法：/project set <absolute-path>");
		return { action: "set", path: parts[1] };
	}
	if (parts[0] === "reset") {
		if (parts.length > 1) throw new Error("用法：/project reset");
		return { action: "reset" };
	}
	throw new Error(`未知的 /project 子命令：${parts[0]}`);
}

function formatShow(options: HandleProjectCommandOptions): string {
	const securityLoad = loadSecurityConfigWithDiagnostics(options.appHomeDir);
	const resolution = resolveProjectAccessPolicy(securityLoad.config, process.cwd());
	const sandbox = currentProjectSandboxStatus();
	const selection = readProjectSelection(options.channelDir);

	const lines = ["**项目作用域**"];
	if (!selection) {
		lines.push(`- 项目目录：\`${resolution.policy.defaultRoot}\`（尚未选择过，将在下次准入时采用 app 默认值）`);
	} else {
		lines.push(`- 项目目录：\`${selection.projectRoot}\`（${selection.updatedBy}，更新于 ${selection.updatedAt}）`);
	}
	lines.push(
		`- 边界：${resolution.configured ? "project（文件工具被约束在此目录内）" : "unbounded（沿用旧的全局文件权限）"}`,
	);
	lines.push(`- Enforcement：${sandbox.level}（${sandbox.summary}）`);

	if (!resolution.configured) {
		lines.push(
			`- 未配置 projectAccess：\`/project set\` 不可用。在 \`security.json\` 写入 projectAccess 段后即可使用。`,
		);
	} else if (!resolution.mutable) {
		lines.push("- projectAccess.defaultRoot 配置有误，项目切换已被禁用，见启动诊断。");
	} else {
		lines.push(`- 可选根：${resolution.policy.allowedRoots.map((root) => `\`${root}\``).join("、")}`);
	}
	for (const diagnostic of resolution.diagnostics) {
		lines.push(`- ⚠ ${diagnostic.message}`);
	}
	return lines.join("\n");
}

async function applyScopeChange(
	options: HandleProjectCommandOptions,
	requestedPath: string,
	label: string,
): Promise<string> {
	const securityLoad = loadSecurityConfigWithDiagnostics(options.appHomeDir);
	const resolution = resolveProjectAccessPolicy(securityLoad.config, process.cwd());
	if (!resolution.configured) {
		return `无法切换项目：未配置 projectAccess。在 \`security.json\` 写入 projectAccess 段（defaultRoot/allowedRoots）后重试。`;
	}
	if (!resolution.mutable) {
		return `无法切换项目：projectAccess.defaultRoot 配置有误（见启动诊断），项目切换已被禁用直到修复。`;
	}

	const real = resolveExistingDirectory(requestedPath);
	if (!real) {
		return `无法切换项目：\`${requestedPath}\` 不是一个存在的绝对目录。`;
	}
	if (!isWithinAllowedRoots(real, resolution.policy)) {
		return `无法切换项目：\`${real}\` 不在允许的可选根内。可选根：${resolution.policy.allowedRoots
			.map((root) => `\`${root}\``)
			.join("、")}。`;
	}

	if (options.isBusy()) {
		return "无法切换项目：当前频道有回合正在进行，请等待结束后重试。";
	}
	const blockers = await options.listActiveBlockers();
	if (blockers.length > 0) {
		return `无法切换项目：\n${blockers.map((line) => `- ${line}`).join("\n")}\n\n结束或取消上述项后重试。`;
	}

	await commitProjectSelection(options.channelDir, real, options.actor);
	await options.onScopeChanged?.();
	return `${label}：\`${real}\`。下一次消息将在新的项目目录下运行。`;
}

export async function handleProjectCommand(options: HandleProjectCommandOptions): Promise<string> {
	let command: ProjectCommand;
	try {
		command = parseProjectCommand(options.args);
	} catch (error) {
		return `${errorMessage(error)}\n\n${usage()}`;
	}

	try {
		switch (command.action) {
			case "show":
				return formatShow(options);
			case "set":
				return await applyScopeChange(options, command.path, "已切换项目");
			case "reset": {
				const securityLoad = loadSecurityConfigWithDiagnostics(options.appHomeDir);
				const resolution = resolveProjectAccessPolicy(securityLoad.config, process.cwd());
				return await applyScopeChange(options, resolution.policy.defaultRoot, "已重置项目");
			}
		}
	} catch (error) {
		return `执行 /project ${command.action} 失败：${errorMessage(error)}`;
	}
}

/**
 * `/desk` — list, create and bind desks (spec 060). Parsing and rendering live here; the
 * runtime capabilities come in through {@link DeskCommandPort}, implemented by the daemon's
 * `DeskRuntime` and, without `bind`, by the TUI.
 */
import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply } from "../commands/reply-limits.js";
import { errorMessage } from "../shared/text-utils.js";
import { normalizeDeskName } from "./paths.js";
import type {
	ArchiveDeskOutcome,
	BindingsFile,
	CreateDeskOutcome,
	DeskAvailability,
	DeskCwdOutcome,
	DeskSummary,
	UnarchiveDeskOutcome,
} from "./types.js";

type DeskCommand =
	| { action: "list" }
	| { action: "new"; name: string; cwd?: string }
	| { action: "bind"; name: string }
	| { action: "cwd"; cwd?: string; reset?: boolean }
	| { action: "archive"; name: string }
	| { action: "unarchive"; name: string };

/** One channel bound to a desk, as `/desk list` shows it. */
export interface DeskListChannel {
	channelId: string;
	/** Rendered by the caller (`channel/channel-id.ts`'s `formatChannelLabel`); desk never parses channel ids. */
	label: string;
}

export interface DeskRuntimeActivity {
	/** Open runnable/waiting tasks in this desk. */
	activeTasks: number;
	/** Outbound task reports/receipts queued in `.delivery/` waiting for a channel. */
	pendingDeliveries: number;
	/** Whether the desk is currently active in `DeskRuntime` (e.g. background tasks or task-spawning events). */
	active: boolean;
}

export interface DeskListItem {
	name: string;
	availability: DeskAvailability;
	channels: DeskListChannel[];
	/** The desk the asking channel is bound to (or, in the TUI, the desk it opened). */
	current: boolean;
	/** Custom working directory when `desk.json` overrides `deskDir`. */
	cwd?: string;
	/** Set when `desk.json` carries `archivedAt`. */
	archived?: boolean;
	activeTasks?: number;
	pendingDeliveries?: number;
	backgroundActive?: boolean;
}

export type BindOutcome =
	| {
			kind: "bound";
			desk: string;
			/** Set when binding to an archived desk automatically restored it. */
			unarchived?: boolean;
			previousDesk?: string;
			/** The previous desk lost its last binding and has no background work, so it went dormant. */
			previousDeskDormant?: boolean;
			/** Open tasks in the previous desk that keep running in the background (deliveries held until rebound). */
			backgroundTasks?: number;
			/** Open tasks / chat events in the previous desk that deliver to this channel and are suspended. */
			suspendedTasks?: number;
			suspendedEvents?: number;
	  }
	| { kind: "same"; desk: string }
	| { kind: "busy"; desk: string }
	| { kind: "unknown"; desk: string }
	| { kind: "unavailable"; desk: string }
	| { kind: "invalid"; desk: string }
	| { kind: "forbidden"; desk: string };

/**
 * `/desk list`'s rows: every desk on disk, plus every desk a binding names that is no longer there
 * (shown missing, D4), each with the channels bound to it. `label` names a channel (the caller
 * owns channel ids); `current` is the asking channel's desk.
 */
export function buildDeskList(
	desks: readonly DeskSummary[],
	bindings: BindingsFile["bindings"],
	current: string | undefined,
	label: (channelId: string) => string,
	activity?: ReadonlyMap<string, DeskRuntimeActivity>,
): DeskListItem[] {
	const summaries = new Map<string, DeskSummary>(desks.map((summary) => [summary.name, summary]));
	const names = [...new Set([...summaries.keys(), ...Object.values(bindings).map((binding) => binding.desk)])].sort();
	return names.map((name) => {
		const summary = summaries.get(name);
		const customCwd = summary?.record?.cwd && summary.record.cwd !== summary.deskDir ? summary.record.cwd : undefined;
		const archived = Boolean(summary?.record?.archivedAt);
		const live = activity?.get(name);
		return {
			name,
			availability: summary?.availability ?? "missing",
			current: name === current,
			channels: Object.entries(bindings)
				.filter(([, binding]) => binding.desk === name)
				.map(([channelId]) => ({ channelId, label: label(channelId) })),
			...(customCwd ? { cwd: customCwd } : {}),
			...(archived ? { archived: true } : {}),
			...(live?.activeTasks ? { activeTasks: live.activeTasks } : {}),
			...(live?.pendingDeliveries ? { pendingDeliveries: live.pendingDeliveries } : {}),
			...(live?.active ? { backgroundActive: true } : {}),
		};
	});
}

export interface DeskCommandPort {
	list(): Promise<DeskListItem[]>;
	/** Absolute path of `CHANNELS.md`, where a truncated `/desk list` sends the reader. */
	channelIndexPath: string;
	create(name: string, cwd?: string): Promise<CreateDeskOutcome>;
	/** Absent in the TUI, which never writes bindings (D18). */
	bind?(name: string): Promise<BindOutcome>;
	/** Inspect or update the current desk's working directory (`desk.json` `cwd`). */
	cwd?(input: { cwd?: string; reset?: boolean }): Promise<DeskCwdOutcome>;
	/** Archive an idle desk (`desk.json` `archivedAt`, stopping events and dropping stale TUI bindings). */
	archive?(name: string): Promise<ArchiveDeskOutcome>;
	/** Restore an archived desk without changing channel bindings. */
	unarchive?(name: string): Promise<UnarchiveDeskOutcome>;
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseDeskCommand(args: string): DeskCommand {
	const trimmed = args.trim();
	const parts = trimmed.split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { action: "list" };
	const [action, ...rest] = parts;
	if (action === "list") {
		if (rest.length > 0) throw new Error("用法：/desk list");
		return { action: "list" };
	}
	if (action === "new") {
		const match = /^new\s+(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
		if (!match) throw new Error("用法：/desk new <名字> [目录绝对路径]");
		const name = normalizeDeskName(match[1]);
		const cwd = match[2]?.trim();
		return cwd ? { action: "new", name, cwd } : { action: "new", name };
	}
	if (action === "bind") {
		if (rest.length !== 1) throw new Error("用法：/desk bind <名字>");
		return { action: "bind", name: normalizeDeskName(rest[0]) };
	}
	if (action === "cwd") {
		const match = /^cwd(?:\s+([\s\S]+))?$/.exec(trimmed);
		const target = match?.[1]?.trim();
		if (!target) return { action: "cwd" };
		if (target === "--reset" || target === "reset") return { action: "cwd", reset: true };
		return { action: "cwd", cwd: target };
	}
	if (action === "archive" || action === "unarchive") {
		if (rest.length !== 1) throw new Error(`用法：/desk ${action} <名字>`);
		return { action, name: normalizeDeskName(rest[0]) };
	}
	throw new Error(`未知子命令 \`${action}\`。`);
}

const NAME_RULE = "工位名只能用 1–32 个小写字母、数字和连字符，且不能以连字符开头或结尾";

/**
 * Why a channel has no usable desk: it has no binding (the default desk could not take it in), or
 * it is bound to a desk that is missing or broken on disk. Either way the user sees one thing.
 */
export type NoDeskResolution = { kind: "unbound" } | { kind: "unavailable"; desk: string };

/** The reply to anything but `/desk` and `/help` on a channel with no usable desk (D4). */
export function formatNoDeskReply(resolution: NoDeskResolution): string {
	const why =
		resolution.kind === "unbound"
			? "默认工位 `default` 不可用，请部署者在服务器上检查 `workspace/desk-default/`"
			: `本频道绑定的工位 \`${resolution.desk}\` 不可用（目录缺失或 desk.json 有误），请部署者在服务器上检查`;
	return `本频道目前没有可用的工位：${why}；也可以用 \`/desk bind <名字>\` 切到其他已有工位。`;
}

/** `canBind` is false in the TUI, whose current desk is the one it opened, not one a channel is bound to. */
function renderList(items: DeskListItem[], channelIndexPath: string, canBind: boolean): string {
	if (items.length === 0) {
		return "暂无工位。默认工位 `default` 缺失且没有任何绑定，需要部署者在服务器上检查 `workspace/`。";
	}
	const lines = ["**工位列表**"];
	for (const item of items) {
		const cwdNote = item.cwd ? ` · 目录 \`${item.cwd}\`` : "";
		const head = `- \`${item.name}\`${item.current ? (canBind ? "（本频道）" : "（当前打开）") : ""}${cwdNote}`;
		const bgBits: string[] = [];
		if (item.activeTasks) bgBits.push(`${item.activeTasks} 个进行中任务`);
		if (item.pendingDeliveries) bgBits.push(`${item.pendingDeliveries} 条待收汇报`);
		const bgSuffix = bgBits.length > 0 ? `（${bgBits.join("、")}）` : "";
		if (item.availability !== "available") {
			lines.push(`${head}：不可用（目录缺失或 desk.json 有误），需要部署者在服务器上检查`);
		} else if (item.archived) {
			lines.push(`${head}：已归档（用 \`/desk bind ${item.name}\` 或 \`/desk unarchive ${item.name}\` 恢复）`);
		} else if (item.channels.length === 0) {
			lines.push(
				item.backgroundActive || bgBits.length > 0
					? `${head}：未绑定频道 · 后台活跃${bgSuffix}`
					: `${head}：未绑定频道 · 已休眠`,
			);
		} else {
			lines.push(`${head}：${item.channels.map((channel) => channel.label).join("、")}${bgSuffix}`);
		}
	}
	return capReply(lines.join("\n"), {
		nextStepHint: `完整的绑定关系在 \`${channelIndexPath}\``,
	}).text;
}

function renderCreate(outcome: CreateDeskOutcome, canBind: boolean): string {
	switch (outcome.kind) {
		case "invalid":
			return `工位名不合法：\`${outcome.name}\`。${NAME_RULE}。`;
		case "invalid_cwd":
			return `工作目录无效：${outcome.reason}。`;
		case "unavailable":
			return `工位 \`${outcome.name}\` 已有绑定但记录缺失，请联系部署者从备份恢复。`;
		case "exists":
			return `工位 \`${outcome.name}\` 已经存在。用 \`/desk\` 查看已有的工位。`;
		case "created": {
			const name = outcome.record.name;
			const cwdNote = outcome.record.cwd ? `（工作目录：\`${outcome.record.cwd}\`）` : "";
			return canBind
				? `已创建工位 \`${name}\`${cwdNote}。用 \`/desk bind ${name}\` 把本频道绑定到它。`
				: `已创建工位 \`${name}\`${cwdNote}。在钉钉频道里用 \`/desk bind ${name}\` 绑定。`;
		}
	}
}

function renderCwd(outcome: DeskCwdOutcome, isQuery: boolean): string {
	switch (outcome.kind) {
		case "invalid_cwd":
			return `工作目录无效：${outcome.reason}。`;
		case "busy":
			return `工位 \`${outcome.desk}\` 当前${outcome.reason}，暂不能切换工作目录。请等当前执行结束或先暂停相关任务后再试。`;
		case "unavailable":
			return `当前频道没有可用的工位，无法查看或修改工作目录。用 \`/desk\` 查看工位状态。`;
		case "ok": {
			const suffix = outcome.isDefault ? "（工位默认目录）" : "（自定义仓库目录，状态仍保存在工位目录）";
			return isQuery
				? `工位 \`${outcome.desk}\` 当前工作目录：\`${outcome.cwd}\`${suffix}。用 \`/desk cwd <绝对路径>\` 切换目录，或 \`/desk cwd --reset\` 恢复默认。`
				: `已将工位 \`${outcome.desk}\` 的工作目录设为 \`${outcome.cwd}\`${suffix}。`;
		}
	}
}

function renderBind(outcome: BindOutcome): string {
	switch (outcome.kind) {
		case "invalid":
			return `工位名不合法：\`${outcome.desk}\`。${NAME_RULE}。`;
		case "forbidden":
			return `当前身份无权使用工位 \`${outcome.desk}\`。`;
		case "unknown":
			return `没有名为 \`${outcome.desk}\` 的工位。用 \`/desk\` 查看已有的工位，或先 \`/desk new ${outcome.desk}\` 创建。`;
		case "unavailable":
			return `工位 \`${outcome.desk}\` 当前不可用（目录缺失或 desk.json 有误），需要部署者在服务器上检查。`;
		case "busy":
			return `本频道正在运行一个回合，现在不能换绑。等它结束后重发 \`/desk bind ${outcome.desk}\`，或先用 \`/stop\` 停止。`;
		case "same":
			return `本频道已经绑定在工位 \`${outcome.desk}\` 上。`;
		case "bound": {
			const unarchivedNote = outcome.unarchived ? "（已从归档恢复）" : "";
			const lines = [`本频道已绑定到工位 \`${outcome.desk}\`${unarchivedNote}。`];
			if (outcome.previousDesk && outcome.previousDeskDormant) {
				lines.push(
					`原工位 \`${outcome.previousDesk}\` 已没有绑定的频道与后台工作，已进入休眠；切回或打开 \`pipiclaw tui --desk ${outcome.previousDesk}\` 后自动恢复。`,
				);
			} else if (outcome.previousDesk) {
				if (outcome.backgroundTasks) {
					lines.push(
						`原工位 \`${outcome.previousDesk}\` 中有 ${outcome.backgroundTasks} 个后台任务继续执行；汇报与提问会暂存在该工位，切回 \`/desk bind ${outcome.previousDesk}\` 后自动送达（也可在其他入口执行 \`/tasks adopt <id>\` 接管）。`,
					);
				}
				if ((outcome.suspendedTasks ?? 0) > 0 || (outcome.suspendedEvents ?? 0) > 0) {
					const parts: string[] = [];
					if (outcome.suspendedTasks) parts.push(`${outcome.suspendedTasks} 个任务`);
					if (outcome.suspendedEvents) parts.push(`${outcome.suspendedEvents} 个聊天定时事件`);
					lines.push(
						`原工位 \`${outcome.previousDesk}\` 中以本频道为投递目标的 ${parts.join("、")}已暂停，切回后自动恢复。`,
					);
				}
			}
			return lines.join("\n");
		}
	}
}

function renderArchive(outcome: ArchiveDeskOutcome): string {
	switch (outcome.kind) {
		case "invalid":
			return `工位名不合法：\`${outcome.desk}\`。${NAME_RULE}。`;
		case "forbidden":
			return `当前身份无权管理工位 \`${outcome.desk}\`。`;
		case "default":
			return "默认工位 `default` 不能归档。";
		case "unknown":
			return `没有名为 \`${outcome.desk}\` 的工位。用 \`/desk\` 查看已有的工位。`;
		case "unavailable":
			return `工位 \`${outcome.desk}\` 当前不可用（目录缺失或 desk.json 有误），需要部署者在服务器上检查。`;
		case "already_archived":
			return `工位 \`${outcome.desk}\` 已经是归档状态。用 \`/desk unarchive ${outcome.desk}\` 或 \`/desk bind ${outcome.desk}\` 恢复。`;
		case "current_channel":
			return `当前频道正绑定在工位 \`${outcome.desk}\` 上。请先切换到其他工位（如 \`/desk bind default\`），再执行 \`/desk archive ${outcome.desk}\`。`;
		case "bound_channels":
			return `工位 \`${outcome.desk}\` 仍绑定着活跃频道（${outcome.channels.join("、")}）。请先在这些频道切走后再归档。`;
		case "busy":
			return `工位 \`${outcome.desk}\` 当前${outcome.reason}，暂不能归档。请等执行结束后再试。`;
		case "open_tasks":
			return `工位 \`${outcome.desk}\` 仍有 ${outcome.count} 个未完成任务（如 \`${outcome.sampleId}\`）。请先完成或执行 \`/tasks cancel <id>\` 取消后再归档。`;
		case "archived": {
			const notes: string[] = [];
			if (outcome.unboundTerminals > 0) notes.push(`清理了 ${outcome.unboundTerminals} 个历史终端绑定`);
			if (outcome.stoppedEvents > 0) notes.push(`暂停了 ${outcome.stoppedEvents} 个定时事件`);
			const extra = notes.length > 0 ? `（${notes.join("，")}）` : "";
			return `已归档工位 \`${outcome.desk}\`${extra}。记忆与历史文件均保留；后续可用 \`/desk bind ${outcome.desk}\` 或 \`/desk unarchive ${outcome.desk}\` 恢复。`;
		}
	}
}

function renderUnarchive(outcome: UnarchiveDeskOutcome): string {
	switch (outcome.kind) {
		case "invalid":
			return `工位名不合法：\`${outcome.desk}\`。${NAME_RULE}。`;
		case "forbidden":
			return `当前身份无权管理工位 \`${outcome.desk}\`。`;
		case "unknown":
			return `没有名为 \`${outcome.desk}\` 的工位。用 \`/desk\` 查看已有的工位。`;
		case "unavailable":
			return `工位 \`${outcome.desk}\` 当前不可用（目录缺失或 desk.json 有误），需要部署者在服务器上检查。`;
		case "not_archived":
			return `工位 \`${outcome.desk}\` 当前未归档，无需恢复。`;
		case "unarchived":
			return outcome.activated
				? `已恢复工位 \`${outcome.desk}\`，后台定时服务已重新启动。可用 \`/desk bind ${outcome.desk}\` 切换过去。`
				: `已恢复工位 \`${outcome.desk}\`。用 \`/desk bind ${outcome.desk}\` 把频道绑定过去后即可使用。`;
	}
}

export async function handleDeskCommand(args: string, port: DeskCommandPort): Promise<string> {
	let command: DeskCommand;
	try {
		command = parseDeskCommand(args);
	} catch (error) {
		return `${errorMessage(error)}\n\n${renderSubcommandUsage("desk")}`;
	}
	try {
		switch (command.action) {
			case "list":
				return renderList(await port.list(), port.channelIndexPath, port.bind !== undefined);
			case "new":
				return renderCreate(await port.create(command.name, command.cwd), port.bind !== undefined);
			case "bind":
				if (!port.bind) return "终端不支持绑定，用 `--desk` 选择工位。";
				return renderBind(await port.bind(command.name));
			case "cwd":
				if (!port.cwd) return "当前入口不支持直接设置工作目录，请在对话频道或守护进程连接下执行 `/desk cwd`。";
				return renderCwd(
					await port.cwd({ cwd: command.cwd, reset: command.reset }),
					!command.cwd && !command.reset,
				);
			case "archive":
				if (!port.archive) return "当前入口不支持归档工位，请在对话频道或守护进程连接下执行 `/desk archive`。";
				return renderArchive(await port.archive(command.name));
			case "unarchive":
				if (!port.unarchive) return "当前入口不支持恢复工位，请在对话频道或守护进程连接下执行 `/desk unarchive`。";
				return renderUnarchive(await port.unarchive(command.name));
		}
	} catch (error) {
		return `执行 /desk ${command.action} 失败：${errorMessage(error)}`;
	}
}

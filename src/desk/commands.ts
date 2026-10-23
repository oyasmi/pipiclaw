/**
 * `/desk` — list, create and bind desks (spec 060). Parsing and rendering live here; the
 * runtime capabilities come in through {@link DeskCommandPort}, implemented by the daemon's
 * `DeskRuntime` and, without `bind`, by the TUI.
 */
import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply } from "../commands/reply-limits.js";
import { errorMessage } from "../shared/text-utils.js";
import { normalizeDeskName } from "./paths.js";
import type { BindingsFile, CreateDeskOutcome, DeskAvailability, DeskSummary } from "./types.js";

type DeskCommand = { action: "list" } | { action: "new"; name: string } | { action: "bind"; name: string };

/** One channel bound to a desk, as `/desk list` shows it. */
export interface DeskListChannel {
	channelId: string;
	/** Rendered by the caller (`channel/channel-id.ts`'s `formatChannelLabel`); desk never parses channel ids. */
	label: string;
}

export interface DeskListItem {
	name: string;
	availability: DeskAvailability;
	channels: DeskListChannel[];
	/** The desk the asking channel is bound to (or, in the TUI, the desk it opened). */
	current: boolean;
}

export type BindOutcome =
	| {
			kind: "bound";
			desk: string;
			previousDesk?: string;
			/** The previous desk lost its last binding and went dormant. */
			previousDeskDormant?: boolean;
			/** Open tasks / events in the previous desk that deliver to this channel and are now suspended. */
			suspendedTasks?: number;
			suspendedEvents?: number;
	  }
	| { kind: "same"; desk: string }
	| { kind: "busy"; desk: string }
	| { kind: "unknown"; desk: string }
	| { kind: "unavailable"; desk: string }
	| { kind: "invalid"; desk: string };

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
): DeskListItem[] {
	const onDisk = new Map<string, DeskAvailability>(desks.map((summary) => [summary.name, summary.availability]));
	const names = [...new Set([...onDisk.keys(), ...Object.values(bindings).map((binding) => binding.desk)])].sort();
	return names.map((name) => ({
		name,
		availability: onDisk.get(name) ?? "missing",
		current: name === current,
		channels: Object.entries(bindings)
			.filter(([, binding]) => binding.desk === name)
			.map(([channelId]) => ({ channelId, label: label(channelId) })),
	}));
}

export interface DeskCommandPort {
	list(): Promise<DeskListItem[]>;
	/** Absolute path of `CHANNELS.md`, where a truncated `/desk list` sends the reader. */
	channelIndexPath: string;
	create(name: string): Promise<CreateDeskOutcome>;
	/** Absent in the TUI, which never writes bindings (D18). */
	bind?(name: string): Promise<BindOutcome>;
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseDeskCommand(args: string): DeskCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { action: "list" };
	const [action, ...rest] = parts;
	if (action === "list") {
		if (rest.length > 0) throw new Error("用法：/desk list");
		return { action: "list" };
	}
	if (action === "new" || action === "bind") {
		if (rest.length !== 1) throw new Error(`用法：/desk ${action} <名字>`);
		return { action, name: normalizeDeskName(rest[0]) };
	}
	throw new Error(`未知子命令 \`${action}\`。`);
}

const NAME_RULE = "工位名只能用 1–32 个小写字母、数字和连字符，且不能以连字符开头或结尾";

/** The reply to anything but `/desk` and `/help` on a channel with no binding (D4). */
export function formatUnboundChannelReply(): string {
	return "默认助手暂时不可用，请联系部署者在服务器上检查 `workspace/desk-default/desk.json`，修复后重发消息。";
}

/** The reply on a channel bound to a desk that is missing or broken on disk (D4). */
export function formatUnavailableDeskReply(desk: string): string {
	return `本频道绑定的工位 \`${desk}\` 当前不可用（目录缺失或 desk.json 有误），需要部署者在服务器上检查；也可以用 \`/desk bind <名字>\` 改绑到别的工位。`;
}

/** `canBind` is false in the TUI, whose current desk is the one it opened, not one a channel is bound to. */
function renderList(items: DeskListItem[], channelIndexPath: string, canBind: boolean): string {
	if (items.length === 0) {
		return "暂无工位。用 `/desk new <名字>` 创建一个，再用 `/desk bind <名字>` 绑定到本频道。";
	}
	const lines = ["**工位列表**"];
	for (const item of items) {
		const head = `- \`${item.name}\`${item.current ? (canBind ? "（本频道）" : "（当前打开）") : ""}`;
		if (item.availability !== "available") {
			lines.push(`${head}：不可用（目录缺失或 desk.json 有误），需要部署者在服务器上检查`);
		} else if (item.channels.length === 0) {
			lines.push(`${head}：未绑定频道，后台工作已暂停`);
		} else {
			lines.push(`${head}：${item.channels.map((channel) => channel.label).join("、")}`);
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
		case "unavailable":
			return `工位 \`${outcome.name}\` 已有绑定但记录缺失，请联系部署者从备份恢复。`;
		case "exists":
			return `工位 \`${outcome.name}\` 已经存在。用 \`/desk\` 查看已有的工位。`;
		case "created": {
			const name = outcome.record.name;
			return canBind
				? `已创建工位 \`${name}\`。用 \`/desk bind ${name}\` 把本频道绑定到它。`
				: `已创建工位 \`${name}\`。在钉钉频道里用 \`/desk bind ${name}\` 绑定。`;
		}
	}
}

function renderBind(outcome: BindOutcome): string {
	switch (outcome.kind) {
		case "invalid":
			return `工位名不合法：\`${outcome.desk}\`。${NAME_RULE}。`;
		case "unknown":
			return `没有名为 \`${outcome.desk}\` 的工位。用 \`/desk\` 查看已有的工位，或先 \`/desk new ${outcome.desk}\` 创建。`;
		case "unavailable":
			return `工位 \`${outcome.desk}\` 当前不可用（目录缺失或 desk.json 有误），需要部署者在服务器上检查。`;
		case "busy":
			return `本频道正在运行一个回合，现在不能换绑。等它结束后重发 \`/desk bind ${outcome.desk}\`，或先用 \`/stop\` 停止。`;
		case "same":
			return `本频道已经绑定在工位 \`${outcome.desk}\` 上。`;
		case "bound": {
			const lines = [`本频道已绑定到工位 \`${outcome.desk}\`。`];
			if (outcome.previousDesk && outcome.previousDeskDormant) {
				lines.push(
					`原工位 \`${outcome.previousDesk}\` 已没有绑定的频道，它的定时事件和任务已暂停，重新绑定后自动恢复。`,
				);
			} else if (outcome.previousDesk && ((outcome.suspendedTasks ?? 0) > 0 || (outcome.suspendedEvents ?? 0) > 0)) {
				const parts: string[] = [];
				if (outcome.suspendedTasks) parts.push(`${outcome.suspendedTasks} 个任务`);
				if (outcome.suspendedEvents) parts.push(`${outcome.suspendedEvents} 个定时事件`);
				lines.push(`原工位 \`${outcome.previousDesk}\` 中以本频道为投递频道的 ${parts.join("、")}已暂停。`);
			}
			return lines.join("\n");
		}
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
				return renderCreate(await port.create(command.name), port.bind !== undefined);
			case "bind":
				if (!port.bind) return "终端不支持绑定，用 `--desk` 选择工位。";
				return renderBind(await port.bind(command.name));
		}
	} catch (error) {
		return `执行 /desk ${command.action} 失败：${errorMessage(error)}`;
	}
}

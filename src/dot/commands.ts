/**
 * `/dot` — list, create and bind dots (spec 058, D5). Parsing and rendering live here; the
 * runtime capabilities come in through {@link DotCommandPort}, implemented by the daemon's
 * `DotRuntime` and, without `bind`, by the TUI.
 */
import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply } from "../commands/reply-limits.js";
import { errorMessage } from "../shared/text-utils.js";
import { normalizeDotName } from "./paths.js";
import type { BindingsFile, CreateDotOutcome, DotAvailability, DotSummary } from "./types.js";

type DotCommand = { action: "list" } | { action: "new"; name: string } | { action: "bind"; name: string };

/** One channel bound to a dot, as `/dot list` shows it. */
export interface DotListChannel {
	channelId: string;
	/** Rendered by the caller (`channel/channel-id.ts`'s `formatChannelLabel`); dot never parses channel ids. */
	label: string;
}

export interface DotListItem {
	name: string;
	availability: DotAvailability;
	channels: DotListChannel[];
	/** The dot the asking channel is bound to (or, in the TUI, the dot it opened). */
	current: boolean;
}

export type BindOutcome =
	| {
			kind: "bound";
			dot: string;
			previousDot?: string;
			/** The previous dot lost its last binding and went dormant. */
			previousDotDormant?: boolean;
			/** Open tasks / events in the previous dot that deliver to this channel and are now suspended. */
			suspendedTasks?: number;
			suspendedEvents?: number;
	  }
	| { kind: "same"; dot: string }
	| { kind: "busy"; dot: string }
	| { kind: "unknown"; dot: string }
	| { kind: "unavailable"; dot: string }
	| { kind: "invalid"; dot: string };

/**
 * `/dot list`'s rows: every dot on disk, plus every dot a binding names that is no longer there
 * (shown missing, D4), each with the channels bound to it. `label` names a channel (the caller
 * owns channel ids); `current` is the asking channel's dot.
 */
export function buildDotList(
	dots: readonly DotSummary[],
	bindings: BindingsFile["bindings"],
	current: string | undefined,
	label: (channelId: string) => string,
): DotListItem[] {
	const onDisk = new Map<string, DotAvailability>(dots.map((summary) => [summary.name, summary.availability]));
	const names = [...new Set([...onDisk.keys(), ...Object.values(bindings).map((binding) => binding.dot)])].sort();
	return names.map((name) => ({
		name,
		availability: onDisk.get(name) ?? "missing",
		current: name === current,
		channels: Object.entries(bindings)
			.filter(([, binding]) => binding.dot === name)
			.map(([channelId]) => ({ channelId, label: label(channelId) })),
	}));
}

export interface DotCommandPort {
	list(): Promise<DotListItem[]>;
	/** Absolute path of `CHANNELS.md`, where a truncated `/dot list` sends the reader. */
	channelIndexPath: string;
	create(name: string): Promise<CreateDotOutcome>;
	/** Absent in the TUI, which never writes bindings (D18). */
	bind?(name: string): Promise<BindOutcome>;
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseDotCommand(args: string): DotCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { action: "list" };
	const [action, ...rest] = parts;
	if (action === "list") {
		if (rest.length > 0) throw new Error("用法：/dot list");
		return { action: "list" };
	}
	if (action === "new" || action === "bind") {
		if (rest.length !== 1) throw new Error(`用法：/dot ${action} <名字>`);
		return { action, name: normalizeDotName(rest[0]) };
	}
	throw new Error(`未知子命令 \`${action}\`。`);
}

const NAME_RULE = "dot 名只能用 1–32 个小写字母、数字和连字符，且不能以连字符开头或结尾";

/** The reply to anything but `/dot` and `/help` on a channel with no binding (D4). */
export function formatUnboundChannelReply(): string {
	return "本频道还没有绑定 dot。用 `/dot` 查看已有的 dot，再用 `/dot bind <名字>` 绑定；需要新的就先 `/dot new <名字>`。";
}

/** The reply on a channel bound to a dot that is missing or broken on disk (D4). */
export function formatUnavailableDotReply(dot: string): string {
	return `本频道绑定的 dot \`${dot}\` 当前不可用（目录缺失或 dot.json 有误），需要部署者在服务器上检查；也可以用 \`/dot bind <名字>\` 改绑到别的 dot。`;
}

/** `canBind` is false in the TUI, whose current dot is the one it opened, not one a channel is bound to. */
function renderList(items: DotListItem[], channelIndexPath: string, canBind: boolean): string {
	if (items.length === 0) {
		return "暂无 dot。用 `/dot new <名字>` 创建一个，再用 `/dot bind <名字>` 绑定到本频道。";
	}
	const lines = ["**dot 列表**"];
	for (const item of items) {
		const head = `- \`${item.name}\`${item.current ? (canBind ? "（本频道）" : "（当前打开）") : ""}`;
		if (item.availability !== "available") {
			lines.push(`${head}：不可用（目录缺失或 dot.json 有误），需要部署者在服务器上检查`);
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

function renderCreate(outcome: CreateDotOutcome, canBind: boolean): string {
	switch (outcome.kind) {
		case "invalid":
			return `dot 名不合法：\`${outcome.name}\`。${NAME_RULE}。`;
		case "exists":
			return `dot \`${outcome.name}\` 已经存在。用 \`/dot\` 查看已有的 dot。`;
		case "created": {
			const name = outcome.record.name;
			return canBind
				? `已创建 dot \`${name}\`。用 \`/dot bind ${name}\` 把本频道绑定到它。`
				: `已创建 dot \`${name}\`。在钉钉频道里用 \`/dot bind ${name}\` 绑定。`;
		}
	}
}

function renderBind(outcome: BindOutcome): string {
	switch (outcome.kind) {
		case "invalid":
			return `dot 名不合法：\`${outcome.dot}\`。${NAME_RULE}。`;
		case "unknown":
			return `没有名为 \`${outcome.dot}\` 的 dot。用 \`/dot\` 查看已有的 dot，或先 \`/dot new ${outcome.dot}\` 创建。`;
		case "unavailable":
			return `dot \`${outcome.dot}\` 当前不可用（目录缺失或 dot.json 有误），需要部署者在服务器上检查。`;
		case "busy":
			return `本频道正在运行一个回合，现在不能换绑。等它结束后重发 \`/dot bind ${outcome.dot}\`，或先用 \`/stop\` 停止。`;
		case "same":
			return `本频道已经绑定在 dot \`${outcome.dot}\` 上。`;
		case "bound": {
			const lines = [`本频道已绑定到 dot \`${outcome.dot}\`。`];
			if (outcome.previousDot && outcome.previousDotDormant) {
				lines.push(
					`原 dot \`${outcome.previousDot}\` 已没有绑定的频道，它的定时事件和任务已暂停，重新绑定后自动恢复。`,
				);
			} else if (outcome.previousDot && ((outcome.suspendedTasks ?? 0) > 0 || (outcome.suspendedEvents ?? 0) > 0)) {
				const parts: string[] = [];
				if (outcome.suspendedTasks) parts.push(`${outcome.suspendedTasks} 个任务`);
				if (outcome.suspendedEvents) parts.push(`${outcome.suspendedEvents} 个定时事件`);
				lines.push(`原 dot \`${outcome.previousDot}\` 中以本频道为投递频道的 ${parts.join("、")}已暂停。`);
			}
			return lines.join("\n");
		}
	}
}

export async function handleDotCommand(args: string, port: DotCommandPort): Promise<string> {
	let command: DotCommand;
	try {
		command = parseDotCommand(args);
	} catch (error) {
		return `${errorMessage(error)}\n\n${renderSubcommandUsage("dot")}`;
	}
	try {
		switch (command.action) {
			case "list":
				return renderList(await port.list(), port.channelIndexPath, port.bind !== undefined);
			case "new":
				return renderCreate(await port.create(command.name), port.bind !== undefined);
			case "bind":
				if (!port.bind) return "终端不支持绑定，用 `--dot` 选择 dot。";
				return renderBind(await port.bind(command.name));
		}
	} catch (error) {
		return `执行 /dot ${command.action} 失败：${errorMessage(error)}`;
	}
}

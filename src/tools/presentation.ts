import { clipText } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";

/**
 * Runtime-side projection from a tool call's raw arguments to the one-line Chinese progress
 * string shown while it runs (`src/agent/session-events.ts`). Replaces the old model-authored,
 * per-tool-required `label` argument (spec 045): the model no longer pays schema tokens or output
 * tokens for a UI string on every single call, and the wording is deterministic instead of
 * whatever the model happened to write.
 *
 * One function per tool name, keyed in a table rather than spread across each tool's own file:
 * `session-events.ts` has only `toolName` + raw `args`, never the tool instance, so there is no
 * natural per-file seam to hang this on without importing all sixteen modules into the session
 * event handler. `test/tool-presentation.test.ts` is what actually prevents drift — it asserts
 * every registered tool name has a describer and that each survives empty/missing args, since the
 * model's args are not guaranteed well-formed at the moment a call starts.
 */

function str(args: unknown, key: string): string | undefined {
	if (!isRecord(args)) return undefined;
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(args: unknown, key: string): boolean {
	return isRecord(args) && args[key] === true;
}

function firstLine(text: string, maxChars: number): string {
	const line = text.split("\n")[0] ?? text;
	return clipText(line, maxChars, { collapseWhitespace: true });
}

/** Host + path only, so a long query string never dominates the progress line. */
function hostAndPath(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		return `${url.host}${url.pathname}`;
	} catch {
		return clipText(rawUrl, 60, { collapseWhitespace: true });
	}
}

type Describer = (args: unknown) => string;

const DESCRIBERS: Record<string, Describer> = {
	read: (args) => {
		const path = str(args, "path") ?? "?";
		const offset = isRecord(args) && typeof args.offset === "number" ? args.offset : undefined;
		return `读取 ${path}${offset !== undefined ? `:${offset}` : ""}`;
	},
	glob: (args) => {
		const pattern = str(args, "pattern") ?? "?";
		const path = str(args, "path");
		return `查找 ${pattern}${path ? ` · ${path}` : ""}`;
	},
	grep: (args) => {
		const pattern = str(args, "pattern") ?? "?";
		const path = str(args, "path");
		return `搜索 "${clipText(pattern, 40, { collapseWhitespace: true })}"${path ? ` · ${path}` : ""}`;
	},
	edit: (args) => `编辑 ${str(args, "path") ?? "?"}`,
	write: (args) => `写入 ${str(args, "path") ?? "?"}`,
	bash: (args) => {
		const command = clipText(str(args, "command") ?? "?", 60, { collapseWhitespace: true });
		return bool(args, "async") ? `后台执行 ${command}` : `执行 ${command}`;
	},
	web_search: (args) => `搜索 "${clipText(str(args, "query") ?? "?", 60, { collapseWhitespace: true })}"`,
	web_fetch: (args) => `抓取 ${hostAndPath(str(args, "url") ?? "")}`,
	send_media: (args) => `发送 ${str(args, "path") ?? "?"}`,
	job: (args) => {
		const op = str(args, "op") ?? "?";
		const ids = isRecord(args) && Array.isArray(args.ids) ? (args.ids as unknown[]).length : 0;
		return `后台作业 ${op}${ids ? ` (${ids})` : ""}`;
	},
	session_search: (args) => `检索历史 "${clipText(str(args, "query") ?? "?", 40, { collapseWhitespace: true })}"`,
	memory_manage: (args) => `记忆 ${str(args, "op") ?? "?"}`,
	skill: (args) => {
		const action = str(args, "action") ?? "?";
		const name = str(args, "name");
		return action === "read" ? `加载 skill ${name ?? "?"}` : "列出 skills";
	},
	event_manage: (args) => `事件 ${str(args, "action") ?? "?"} ${str(args, "name") ?? ""}`.trim(),
	task_list: () => "列出任务",
	task_create: (args) => `创建任务 ${str(args, "id") ?? "?"}`,
	task_update: (args) => `更新任务 ${str(args, "id") ?? "?"}`,
	task_close: (args) => `关闭任务 ${str(args, "id") ?? "?"}（${str(args, "outcome") ?? "?"}）`,
	task_verify: (args) => `导入验收 ${str(args, "id") ?? "?"}`,
	subagent: (args) => {
		const who = str(args, "agent") ?? "?";
		const task = str(args, "task");
		return `委派 ${who}${task ? `：${firstLine(task, 40)}` : ""}`;
	},
	subagent_inline: (args) => {
		const task = str(args, "task");
		return `内联委派${task ? `：${firstLine(task, 40)}` : ""}`;
	},
	subagent_manage: (args) => {
		const op = str(args, "op") ?? "?";
		const runId = str(args, "runId");
		return `委派 ${op}${runId ? ` ${runId}` : ""}`;
	},
};

/** Fallback for any tool name without a specific describer (e.g. an unrecognized/future tool). */
export function describeToolCall(toolName: string, args: unknown): string {
	try {
		return DESCRIBERS[toolName]?.(args) || toolName;
	} catch {
		return toolName;
	}
}

/** One `Label: value` line in a security-guard block message. */
export interface BlockMessageDetail {
	label: string;
	value: string;
}

/**
 * Shared scaffold for a guard's model-facing block message: `"<Subject> blocked [category]"`
 * followed by one line per detail. Used by both the path guard and the command guard so their
 * wording does not drift line by line as each grows its own detail set.
 */
export function formatBlockMessage(
	subject: string,
	category: string | undefined,
	details: BlockMessageDetail[],
): string {
	const lines = [`${subject} blocked${category ? ` [${category}]` : ""}`];
	for (const detail of details) {
		lines.push(`${detail.label}: ${detail.value}`);
	}
	return lines.join("\n");
}

export type GuardKind = "path" | "command" | "network";

/** What a guard refused, in structured form — the user-facing rendering is built from this. */
export interface GuardBlock {
	guard: GuardKind;
	category?: string;
	/** What was refused: the resolved path, the command, or the URL. */
	target: string;
	/** Path guard only. */
	operation?: "read" | "write";
}

/**
 * A guard refusal (spec 053, D5.2). Its `message` is the model-facing English text, unchanged —
 * it steers the model to explain the intent to the user. `blocked` carries the same refusal as
 * data, so the chat can show a short Chinese line instead of the model's text.
 */
export class GuardBlockedError extends Error {
	constructor(
		message: string,
		readonly blocked: GuardBlock,
	) {
		super(message);
		this.name = "GuardBlockedError";
	}
}

const PATH_BLOCK: Record<string, (op: string) => string> = {
	"outside-allowed-roots": (op) => `${op}允许范围以外的路径`,
	"system-path": (op) => `${op}系统路径`,
	"sensitive-read-path": (op) => `${op}敏感路径`,
	"sensitive-write-path": (op) => `${op}敏感路径`,
	"symlink-write": () => "通过符号链接写入",
	"configured-deny": (op) => `${op} security.json 禁止的路径`,
};

const COMMAND_BLOCK: Record<string, string> = {
	"destructive-file-op": "属于破坏性文件操作",
	"system-manipulation": "会修改系统配置",
	"privilege-escalation": "涉及提权",
	"process-manipulation": "会操作其他进程",
	"network-abuse": "属于高风险网络操作",
	"container-escape": "可能突破容器隔离",
	obfuscation: "包含混淆或动态拼接的内容",
	"configured-command-deny": "被 security.json 禁止",
};

/** Network refusals a deployer can lift in security.json; the rest are just unreachable URLs. */
const NETWORK_BLOCK: Record<string, { reason: string; adjustable: boolean }> = {
	"private-address": { reason: "指向内网地址", adjustable: true },
	"blocked-host": { reason: "是被禁止访问的主机", adjustable: true },
	"dns-failure": { reason: "主机名无法解析", adjustable: false },
	"invalid-url": { reason: "不是有效的网址", adjustable: false },
	"unsupported-scheme": { reason: "使用了不支持的协议", adjustable: false },
	"missing-host": { reason: "缺少主机名", adjustable: false },
};

function clipTarget(target: string, max: number): string {
	const flat = target.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ADJUST_HINT = "（如需放行，由部署者调整 security.json）";

/** The one chat line for a guard refusal, e.g. `已拦截：写入允许范围以外的路径 \`/x/y\`（…）`. */
export function renderGuardBlockForUser(block: GuardBlock): string {
	switch (block.guard) {
		case "path": {
			const op = block.operation === "write" ? "写入" : "读取";
			const what = (block.category ? PATH_BLOCK[block.category] : undefined)?.(op) ?? `${op}受保护的路径`;
			return `已拦截：${what} \`${clipTarget(block.target, 160)}\`${ADJUST_HINT}`;
		}
		case "command": {
			const why = (block.category ? COMMAND_BLOCK[block.category] : undefined) ?? "属于高危操作";
			return `已拦截：命令 \`${clipTarget(block.target, 80)}\` ${why}${ADJUST_HINT}`;
		}
		case "network": {
			const known = block.category ? NETWORK_BLOCK[block.category] : undefined;
			const url = `\`${clipTarget(block.target, 120)}\``;
			if (known && !known.adjustable) return `无法访问 ${url}：${known.reason}`;
			return `已拦截：访问 ${url}${known ? ` ${known.reason}` : ""}${ADJUST_HINT}`;
		}
	}
}

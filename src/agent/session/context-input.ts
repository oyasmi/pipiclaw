import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { type AgentSession, convertToLlm } from "@earendil-works/pi-coding-agent";
import type { TurnContext } from "../../channel/turn-context.js";

/** Import context without emitting agent events (which would execute/archive history again). */
function contextMessages(context: TurnContext, model: Model<Api>): Message[] {
	return context.messages.map((message, index): Message => {
		const timestamp = Date.now();
		if (message.role === "system" || message.role === "developer") {
			return {
				role: "system",
				...{ contextRole: message.role },
				content: message.content
					.filter((p) => p.type === "text")
					.map((p) => p.text)
					.join("\n"),
				timestamp,
			};
		}
		if (message.role === "user") return { role: "user", content: message.content, timestamp };
		return {
			role: "assistant",
			content: message.content
				.filter((p) => p.type === "text")
				.map((part) => ({
					...part,
					...(message.phase
						? {
								textSignature: JSON.stringify({
									v: 1,
									id: `msg_${createHash("sha256").update(`${index}:${part.text}`).digest("hex").slice(0, 32)}`,
									phase: message.phase,
								}),
							}
						: {}),
				})),
			...(message.phase ? { phase: message.phase } : {}),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		};
	});
}

/** The converter overlay lives only for the active generation and is never written to the session. */
export class RequestContextInput {
	private active: { instructions?: string; footer: string } | undefined;
	convert(messages: AgentMessage[]): Message[] {
		const converted = convertToLlm(messages);
		if (!this.active) return converted;
		const content = [this.active.instructions, this.active.footer].filter(Boolean).join("\n\n");
		return content ? [...converted, { role: "system", content, timestamp: Date.now() }] : converted;
	}
	import(session: AgentSession, context: TurnContext): void {
		if (!session.model) throw new Error("Select an available model before sending API requests.");
		for (const message of contextMessages(context, session.model)) session.sessionManager.appendMessage(message);
		session.refreshContext();
	}
	async prompt(session: AgentSession, context: TurnContext, footer: string): Promise<void> {
		this.active = { instructions: context.instructions, footer };
		try {
			await session.agent.prompt([]);
		} finally {
			this.active = undefined;
		}
	}
}

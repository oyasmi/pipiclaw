import { Agent } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { convertToLlm } from "@mariozechner/pi-coding-agent";

export interface SidecarTask<T> {
	name: string;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	systemPrompt: string;
	prompt: string;
	parse: (text: string) => T;
}

export interface SidecarResult<T> {
	output: T;
	rawText: string;
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is Extract<AssistantMessage["content"][number], { type: "text"; text: string }> => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export async function runSidecarTask<T>(task: SidecarTask<T>): Promise<SidecarResult<T>> {
	const apiKey = await task.resolveApiKey(task.model);
	const worker = new Agent({
		initialState: {
			systemPrompt: task.systemPrompt,
			model: task.model,
			thinkingLevel: "off",
			tools: [],
		},
		convertToLlm,
		getApiKey: async () => apiKey,
	});

	await worker.prompt(task.prompt);
	await worker.waitForIdle();

	const lastMessage = worker.state.messages[worker.state.messages.length - 1];
	if (!lastMessage || lastMessage.role !== "assistant") {
		throw new Error(`Sidecar task "${task.name}" returned no assistant message`);
	}

	if (lastMessage.stopReason === "error" || lastMessage.stopReason === "aborted") {
		throw new Error(lastMessage.errorMessage || `Sidecar task "${task.name}" failed`);
	}

	const rawText = extractAssistantText(lastMessage);
	return {
		output: task.parse(rawText),
		rawText,
	};
}

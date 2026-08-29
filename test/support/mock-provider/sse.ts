/**
 * OpenAI chat-completions SSE encoding — the minimal subset pi's `openai-completions`
 * client actually decodes (spec 048 F8): `choice.delta.content`, `choice.delta.tool_calls[]`
 * (aggregated by `index`, `function.arguments` concatenated), `choice.finish_reason`, and a
 * trailing `chunk.usage`. Everything else pi ignores, so the mock does not emit it.
 */

export interface TextStep {
	text: string;
}
export interface ToolCallStep {
	toolCall: { id?: string; name: string; args: unknown };
}
export type ResponseStep = TextStep | ToolCallStep;

/** One model response = the steps of a single assistant message. */
export interface ScriptedResponse {
	steps: ResponseStep[];
	/** Overrides the derived finish_reason (`tool_calls` if the last step is a tool call, else `stop`). */
	finishReason?: string;
	usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function chunk(model: string, choice: Record<string, unknown>, extra?: Record<string, unknown>): string {
	const payload = {
		id: "chatcmpl-e2e-mock",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: choice.__none ? [] : [{ index: 0, ...choice }],
		...extra,
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Serialize a scripted response into the SSE frames pi will consume, ending with `[DONE]`. */
export function encodeResponse(model: string, response: ScriptedResponse): string {
	const frames: string[] = [];
	frames.push(chunk(model, { delta: { role: "assistant" }, finish_reason: null }));

	let toolIndex = 0;
	let lastStepWasToolCall = false;
	for (const step of response.steps) {
		if ("text" in step) {
			frames.push(chunk(model, { delta: { content: step.text }, finish_reason: null }));
			lastStepWasToolCall = false;
		} else {
			const call = step.toolCall;
			frames.push(
				chunk(model, {
					delta: {
						tool_calls: [
							{
								index: toolIndex,
								id: call.id ?? `call_e2e_${toolIndex}`,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
							},
						],
					},
					finish_reason: null,
				}),
			);
			toolIndex += 1;
			lastStepWasToolCall = true;
		}
	}

	const finishReason = response.finishReason ?? (lastStepWasToolCall ? "tool_calls" : "stop");
	frames.push(chunk(model, { delta: {}, finish_reason: finishReason }));
	frames.push(
		chunk(
			model,
			{ __none: true },
			{ usage: response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
		),
	);
	frames.push("data: [DONE]\n\n");
	return frames.join("");
}

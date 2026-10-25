/** Structured input to one generation. History is context, never a sequence of new turns. */
export type ContextPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ContextMessage {
	role: "user" | "assistant" | "system" | "developer";
	content: ContextPart[];
	phase?: "commentary" | "final_answer";
}

export interface TurnContext {
	/**
	 * Imported before the generation, in place of a user prompt. Empty when the turn's own text and
	 * images are the input (a conversation's user message): it then runs as an ordinary channel turn.
	 */
	messages: ContextMessage[];
	/** Applies only to this generation, including its tool iterations. */
	instructions?: string;
}

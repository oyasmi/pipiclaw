/** Structured input to one generation. History is context, never a sequence of new turns. */
export type ContextPart = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ContextMessage {
	role: "user" | "assistant" | "system" | "developer";
	content: ContextPart[];
	phase?: "commentary" | "final_answer";
}

export interface TurnContext {
	messages: ContextMessage[];
	/** Applies only to this generation, including its tool iterations. */
	instructions?: string;
}

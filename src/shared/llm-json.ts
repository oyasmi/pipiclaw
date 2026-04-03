export class LlmJsonParseError extends Error {
	readonly rawText: string;

	constructor(message: string, rawText: string) {
		super(message);
		this.name = "LlmJsonParseError";
		this.rawText = rawText;
	}
}

function extractFromFence(text: string): string | null {
	const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	return fenceMatch?.[1]?.trim() || null;
}

function findBalancedJsonObject(text: string): string | null {
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < text.length; index++) {
		const char = text[index];

		if (start === -1) {
			if (char === "{") {
				start = index;
				depth = 1;
			}
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === "{") {
			depth++;
			continue;
		}

		if (char === "}") {
			depth--;
			if (depth === 0) {
				return text.slice(start, index + 1);
			}
		}
	}

	return null;
}

export function extractJsonObject(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) {
		throw new LlmJsonParseError("Model response was empty; expected a JSON object", text);
	}

	const candidates = [trimmed, extractFromFence(trimmed)].filter((candidate): candidate is string => !!candidate);
	for (const candidate of candidates) {
		if (candidate.startsWith("{") && candidate.endsWith("}")) {
			return candidate;
		}
		const balanced = findBalancedJsonObject(candidate);
		if (balanced) {
			return balanced;
		}
	}

	throw new LlmJsonParseError("Could not locate a balanced JSON object in the model response", text);
}

export function parseJsonObject(text: string): unknown {
	return JSON.parse(extractJsonObject(text));
}

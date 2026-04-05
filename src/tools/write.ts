import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { writeContent } from "./write-content.js";

const writeSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're writing (shown to user)" }),
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteTool(executor: Executor): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { label: string; path: string; content: string },
			signal?: AbortSignal,
		) => {
			await writeContent(executor, path, content, signal, { createParentDir: true });
			const bytesWritten = Buffer.byteLength(content, "utf-8");

			return {
				content: [{ type: "text", text: `Successfully wrote ${bytesWritten} bytes to ${path}` }],
				details: undefined,
			};
		},
	};
}

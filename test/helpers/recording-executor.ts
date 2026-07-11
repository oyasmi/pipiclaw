import type { ExecOptions, ExecResult, Executor } from "../../src/executor.js";

export type ExecHandler = (command: string, options?: ExecOptions) => Promise<ExecResult> | ExecResult;

/**
 * A shared test double for {@link Executor} that records every call. Construct it with either a
 * handler (route/inspect commands) or a fixed {@link ExecResult}; the default is a clean exit.
 */
export class RecordingExecutor implements Executor {
	public readonly calls: Array<{ command: string; options?: ExecOptions }> = [];
	private readonly handler: ExecHandler;

	constructor(handlerOrResult: ExecHandler | ExecResult = { code: 0, stdout: "", stderr: "" }) {
		this.handler = typeof handlerOrResult === "function" ? handlerOrResult : () => handlerOrResult;
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ command, options });
		return this.handler(command, options);
	}
}

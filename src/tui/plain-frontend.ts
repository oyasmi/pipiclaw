/**
 * Plain-stream frontend: no raw mode, no differential rendering.
 *
 * Used when stdout/stdin is not a TTY (piped, redirected) or when `--print` is
 * requested. Progress and notices go to stderr (silenceable with `--quiet`); the
 * final answer goes to stdout so it can be captured by scripts. Input is read
 * line-by-line via readline, which also handles piped stdin (each line → a turn,
 * then EOF).
 */
import { createInterface, type Interface } from "node:readline";
import { dim, gray } from "./colors.js";
import type { Frontend, FrontendCallbacks } from "./renderer.js";

export interface PlainFrontendOptions {
	/** Suppress progress/notice output on stderr; only the final answer is printed. */
	quiet?: boolean;
	/** When false, do not read input (one-shot `--print` where the app supplies the prompt). */
	interactive?: boolean;
}

export class PlainFrontend implements Frontend {
	private rl: Interface | undefined;
	private readonly quiet: boolean;
	private readonly interactive: boolean;

	constructor(options: PlainFrontendOptions = {}) {
		this.quiet = options.quiet ?? false;
		this.interactive = options.interactive ?? true;
	}

	start(callbacks: FrontendCallbacks): void {
		if (!this.interactive) return;
		this.rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "" });
		this.rl.on("line", (line) => callbacks.onSubmit(line));
		this.rl.on("SIGINT", () => callbacks.onInterrupt());
		this.rl.on("close", () => callbacks.onEof());
	}

	appendProgress(text: string): void {
		if (this.quiet) return;
		process.stderr.write(`${dim(text)}\n`);
	}

	showFinal(markdown: string): void {
		process.stdout.write(`${markdown}\n`);
	}

	showNotice(text: string): void {
		if (this.quiet) return;
		process.stderr.write(`${gray(text)}\n`);
	}

	// A plain stream cannot retract already-written lines.
	clearProgress(): void {}

	setWorking(_on: boolean): void {}

	setStatus(text: string): void {
		if (this.quiet || !text.trim()) return;
		process.stderr.write(`${gray(text)}\n`);
	}

	setBusy(_busy: boolean): void {}

	showBanner(text: string): void {
		if (this.quiet) return;
		process.stderr.write(`${text}\n`);
	}

	stop(): void {
		this.rl?.close();
		this.rl = undefined;
	}
}

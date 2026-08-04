/**
 * readline-based `LoginUi` for `pipiclaw auth login`. All rendering goes to
 * stderr so stdout stays free for script-consumable output (spec §5.3). The
 * only other implementation this file's contract anticipates is a future TUI
 * modal (spec §10) — none of this is imported from there.
 */
import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { openBrowser } from "../shared/open-browser.js";
import { LoginCancelledError, type LoginUi } from "./provider-login.js";

type SelectPrompt = Extract<AuthPrompt, { type: "select" }>;

export interface ReadlineLoginUiOptions {
	input?: Readable;
	output?: Writable;
	signal?: AbortSignal;
	/** Preset answer id for the first `select` prompt only (backs `--device-code`). */
	presetFirstSelect?: string;
	/** Skip opening a browser for `auth_url` events (backs `--no-browser`). */
	noBrowser?: boolean;
}

function hyperlink(url: string, label?: string): string {
	// OSC 8 hyperlink escape; terminals that don't support it just show the fallback text.
	return `\x1b]8;;${url}\x07${label ?? url}\x1b]8;;\x07`;
}

export class ReadlineLoginUi implements LoginUi {
	readonly signal: AbortSignal;
	private readonly rl: Interface;
	private readonly output: Writable;
	private readonly presetFirstSelect?: string;
	private readonly noBrowser: boolean;
	private firstSelectConsumed = false;

	constructor(options: ReadlineLoginUiOptions = {}) {
		const input = options.input ?? process.stdin;
		this.output = options.output ?? process.stderr;
		this.rl = createInterface({ input, output: this.output });
		this.signal = options.signal ?? new AbortController().signal;
		this.presetFirstSelect = options.presetFirstSelect;
		this.noBrowser = options.noBrowser ?? false;
	}

	async ask(prompt: AuthPrompt): Promise<string> {
		if (prompt.type === "select" && this.presetFirstSelect !== undefined && !this.firstSelectConsumed) {
			this.firstSelectConsumed = true;
			const match = prompt.options.find((option) => option.id === this.presetFirstSelect);
			if (match) return match.id;
			// Preset doesn't apply to this particular select — fall through to asking interactively.
		}

		switch (prompt.type) {
			case "text":
				return this.question(this.formatPrompt(prompt.message, prompt.placeholder), prompt.signal);
			case "manual_code":
				return this.question(this.formatPrompt(prompt.message, prompt.placeholder), prompt.signal);
			case "secret":
				return this.askSecret(prompt.message, prompt.placeholder, prompt.signal);
			case "select":
				return this.askSelect(prompt);
		}
	}

	notify(event: AuthEvent): void {
		switch (event.type) {
			case "info": {
				this.output.write(`${event.message}\n`);
				for (const link of event.links ?? []) {
					this.output.write(`  ${hyperlink(link.url, link.label)}\n`);
				}
				break;
			}
			case "auth_url": {
				this.output.write(`${event.instructions ?? "Open this URL to continue:"}\n`);
				this.output.write(`  ${hyperlink(event.url)}\n`);
				if (!this.noBrowser) openBrowser(event.url);
				break;
			}
			case "device_code": {
				this.output.write(`Open ${hyperlink(event.verificationUri)} and enter this code:\n`);
				this.output.write(`  ${event.userCode}\n`);
				if (event.expiresInSeconds) {
					const minutes = Math.round(event.expiresInSeconds / 60);
					this.output.write(`  (expires in ~${minutes} min)\n`);
				}
				break;
			}
			case "progress": {
				this.output.write(`${event.message}\n`);
				break;
			}
		}
	}

	/** Release stdin so the process can exit after the login flow finishes. */
	close(): void {
		this.rl.close();
	}

	private formatPrompt(message: string, placeholder?: string): string {
		return placeholder ? `${message} (e.g. ${placeholder}) ` : `${message} `;
	}

	/**
	 * Shared question path. Combines the overall SIGINT signal (→
	 * `LoginCancelledError`) with a per-prompt signal (→ quiet empty-string
	 * resolution, used when `manual_code` loses its race against the OAuth
	 * callback server).
	 */
	private async question(promptText: string, promptSignal?: AbortSignal): Promise<string> {
		const signals = [this.signal, promptSignal].filter((value): value is AbortSignal => value !== undefined);
		const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
		try {
			return await this.rl.question(promptText, { signal: combined });
		} catch (error) {
			if (this.signal.aborted) {
				throw new LoginCancelledError();
			}
			if (promptSignal?.aborted) {
				return "";
			}
			throw error;
		}
	}

	private async askSecret(
		message: string,
		placeholder: string | undefined,
		promptSignal?: AbortSignal,
	): Promise<string> {
		const promptText = this.formatPrompt(message, placeholder);
		const rlInternal = this.rl as unknown as { _writeToOutput?: (text: string) => void; terminal?: boolean };
		const originalWrite = rlInternal._writeToOutput;

		if (rlInternal.terminal !== true || !originalWrite) {
			// Non-TTY streams (pipes, tests) are never locally echoed by readline anyway.
			return this.question(promptText, promptSignal);
		}

		this.output.write(promptText);
		rlInternal._writeToOutput = (text: string) => {
			if (text === "\n" || text === "\r\n") {
				originalWrite.call(this.rl, text);
			}
			// Swallow everything else so keystrokes never echo.
		};
		try {
			return await this.question("", promptSignal);
		} finally {
			rlInternal._writeToOutput = originalWrite;
		}
	}

	private async askSelect(prompt: SelectPrompt): Promise<string> {
		this.output.write(`${prompt.message}\n`);
		prompt.options.forEach((option, index) => {
			const description = option.description ? ` — ${option.description}` : "";
			this.output.write(`  ${index + 1}) ${option.label}${description}\n`);
		});

		while (true) {
			const raw = (await this.question("> ", prompt.signal)).trim();
			if (raw === "") return prompt.options[0].id;

			const index = Number.parseInt(raw, 10);
			if (Number.isInteger(index) && index >= 1 && index <= prompt.options.length) {
				return prompt.options[index - 1].id;
			}

			const byId = prompt.options.find((option) => option.id.toLowerCase() === raw.toLowerCase());
			if (byId) return byId.id;

			this.output.write(`Invalid choice: ${raw}. Enter a number 1-${prompt.options.length}.\n`);
		}
	}
}

/**
 * Rich pi-tui frontend: differential rendering, a scrolling transcript, a live
 * status line + working spinner, and an editor with history and slash-command
 * autocomplete.
 *
 * Layout (top → bottom): transcript, status line, spinner, editor.
 *
 * Ctrl-C and Ctrl-D are intercepted via a global input listener (raw mode does
 * not raise SIGINT). The two-stage Ctrl-C policy lives in the app; here we just
 * surface the events.
 */
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	type EditorTheme,
	Loader,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	ProcessTerminal,
	type SlashCommand,
	Text,
	TUI,
} from "@earendil-works/pi-tui";
import { bold, cyan, dim, gray, italic, red, strikethrough, underline, yellow } from "./colors.js";
import type { Frontend, FrontendCallbacks } from "./renderer.js";

const MARKDOWN_THEME: MarkdownTheme = {
	heading: (t) => bold(cyan(t)),
	link: (t) => underline(cyan(t)),
	linkUrl: (t) => dim(t),
	code: (t) => yellow(t),
	codeBlock: (t) => yellow(t),
	codeBlockBorder: (t) => gray(t),
	quote: (t) => dim(t),
	quoteBorder: (t) => gray(t),
	hr: (t) => gray(t),
	listBullet: (t) => cyan(t),
	bold: (t) => bold(t),
	italic: (t) => italic(t),
	strikethrough: (t) => strikethrough(t),
	underline: (t) => underline(t),
};

const EDITOR_THEME: EditorTheme = {
	borderColor: (t) => gray(t),
	selectList: {
		selectedPrefix: (t) => cyan(t),
		selectedText: (t) => bold(t),
		description: (t) => gray(t),
		scrollInfo: (t) => gray(t),
		noMatch: (t) => gray(t),
	},
};

export interface PiTuiFrontendOptions {
	/** Slash commands to offer in editor autocomplete. */
	commands?: SlashCommand[];
	/** Base path for the autocomplete provider (file completion is disabled). */
	basePath?: string;
}

export class PiTuiFrontend implements Frontend {
	private readonly ui: TUI;
	private readonly transcript = new Container();
	private readonly statusLine = new Text("", 1, 0);
	private readonly spinnerContainer = new Container();
	private readonly editor: Editor;
	private readonly loader: Loader;
	private readonly editorContainer = new Container();
	private turnProgress: Component[] = [];
	private removeInputListener: (() => void) | undefined;
	private spinnerShown = false;

	constructor(options: PiTuiFrontendOptions = {}) {
		this.ui = new TUI(new ProcessTerminal(), true);
		this.editor = new Editor(this.ui, EDITOR_THEME, { paddingX: 1 });
		this.loader = new Loader(
			this.ui,
			(s) => cyan(s),
			(s) => gray(s),
			"Working…",
		);
		if (options.commands?.length) {
			this.editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(options.commands, options.basePath ?? process.cwd(), null),
			);
		}
		this.editorContainer.addChild(this.editor as Component);
		this.ui.addChild(this.transcript);
		this.ui.addChild(this.statusLine);
		this.ui.addChild(this.spinnerContainer);
		this.ui.addChild(this.editorContainer);
	}

	start(callbacks: FrontendCallbacks): void {
		this.editor.onSubmit = (text: string) => {
			if (text.length === 0) return;
			// Raw mode gives no terminal echo and the editor clears on submit, so
			// render the user's message into the transcript ourselves.
			this.showUser(text);
			callbacks.onSubmit(text);
		};
		// Use pi-tui's key matcher, not a raw byte compare: with the Kitty keyboard
		// protocol active, Ctrl-C/Ctrl-D arrive as CSI escape sequences, not \x03/\x04.
		this.removeInputListener = this.ui.addInputListener((data: string) => {
			if (matchesKey(data, "ctrl+c")) {
				callbacks.onInterrupt();
				return { consume: true };
			}
			if (matchesKey(data, "ctrl+d") && this.editor.getText().length === 0) {
				callbacks.onEof();
				return { consume: true };
			}
			return undefined;
		});
		this.ui.setFocus(this.editor);
		this.ui.start();
		this.ui.requestRender();
	}

	/** Echo the user's submitted message into the transcript. */
	showUser(text: string): void {
		this.transcript.addChild(new Text(`${cyan(bold("›"))} ${text}`, 1, 0));
		this.ui.requestRender();
	}

	appendProgress(text: string): void {
		const line = new Text(dim(text), 1, 0);
		this.transcript.addChild(line);
		this.turnProgress.push(line);
		this.ui.requestRender();
	}

	showFinal(markdown: string): void {
		this.transcript.addChild(new Markdown(markdown, 1, 1, MARKDOWN_THEME));
		// The turn's progress becomes permanent scrollback; stop tracking it so a
		// later clearProgress cannot retract it.
		this.turnProgress = [];
		this.ui.requestRender();
	}

	showNotice(text: string): void {
		this.transcript.addChild(new Text(gray(text), 1, 0));
		this.ui.requestRender();
	}

	clearProgress(): void {
		for (const component of this.turnProgress) {
			this.transcript.removeChild(component);
		}
		this.turnProgress = [];
		this.ui.requestRender();
	}

	setWorking(on: boolean): void {
		this.showSpinner(on);
	}

	setStatus(text: string): void {
		this.statusLine.setText(text ? gray(text) : "");
		this.ui.requestRender();
	}

	setBusy(busy: boolean): void {
		this.showSpinner(busy);
	}

	private showSpinner(on: boolean): void {
		if (on === this.spinnerShown) return;
		this.spinnerShown = on;
		if (on) {
			this.spinnerContainer.addChild(this.loader);
			this.loader.start();
		} else {
			this.loader.stop();
			this.spinnerContainer.clear();
		}
		this.ui.requestRender();
	}

	stop(): void {
		this.removeInputListener?.();
		this.removeInputListener = undefined;
		this.loader.stop();
		this.ui.stop();
	}

	/** Render the final error to the transcript when the app cannot continue. */
	showError(text: string): void {
		this.transcript.addChild(new Text(red(text), 1, 0));
		this.ui.requestRender();
	}
}

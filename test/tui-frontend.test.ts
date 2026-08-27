import { Markdown, type MarkdownTheme, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { PiTuiFrontend } from "../src/tui/pitui-frontend.js";

const theme: MarkdownTheme = {
	heading: (value) => value,
	link: (value) => value,
	linkUrl: (value) => value,
	code: (value) => value,
	codeBlock: (value) => value,
	codeBlockBorder: (value) => value,
	quote: (value) => value,
	quoteBorder: (value) => value,
	hr: (value) => value,
	listBullet: (value) => value,
	bold: (value) => value,
	italic: (value) => value,
	strikethrough: (value) => value,
	underline: (value) => value,
};

describe("pi 0.84 TUI seam", () => {
	it("constructs the main-screen implementation through the Pipiclaw frontend", () => {
		const frontend = new PiTuiFrontend();
		expect(frontend).toBeInstanceOf(PiTuiFrontend);
	});

	it("keeps LaTeX source text when renderLatex is disabled", () => {
		const markdown = new Markdown("Euler: $x^2$", 0, 0, theme, undefined, { renderLatex: false });
		expect(markdown.render(80).join("\n")).toContain("$x^2$");
	});

	it("exposes the expected pi main-screen constructor", () => {
		expect(new TuiMainScreen(new ProcessTerminal(), true)).toBeInstanceOf(TuiMainScreen);
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { PlainFrontend } from "../src/tui/plain-frontend.js";
import { createFrontend } from "../src/tui/renderer.js";

afterEach(() => vi.restoreAllMocks());

function captureStreams() {
	const out: string[] = [];
	const err: string[] = [];
	vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		out.push(String(chunk));
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
		err.push(String(chunk));
		return true;
	});
	return { out, err };
}

describe("createFrontend", () => {
	it("returns the plain frontend when forced", () => {
		expect(createFrontend({ plain: true, interactive: false })).toBeInstanceOf(PlainFrontend);
	});

	it("returns the plain frontend when stdout is not a TTY", () => {
		// In the test runner stdout is not a TTY, so the selector must fall back.
		expect(createFrontend({ interactive: false })).toBeInstanceOf(PlainFrontend);
	});
});

describe("PlainFrontend", () => {
	it("prints final answers to stdout and progress/notices to stderr", () => {
		const { out, err } = captureStreams();
		const fe = new PlainFrontend();
		fe.appendProgress("Running: bash");
		fe.showNotice("skill loaded");
		fe.showFinal("the answer");
		expect(out.join("")).toContain("the answer");
		expect(err.join("")).toContain("Running: bash");
		expect(err.join("")).toContain("skill loaded");
		expect(out.join("")).not.toContain("Running: bash");
	});

	it("quiet mode suppresses stderr but still prints the final answer", () => {
		const { out, err } = captureStreams();
		const fe = new PlainFrontend({ quiet: true });
		fe.appendProgress("progress");
		fe.showNotice("notice");
		fe.setStatus("status");
		fe.showFinal("answer");
		expect(err.join("")).toBe("");
		expect(out.join("")).toContain("answer");
	});

	it("does not read input when non-interactive", () => {
		const fe = new PlainFrontend({ interactive: false });
		const onSubmit = vi.fn();
		// Must not throw or attach a readline interface.
		fe.start({ onSubmit, onInterrupt: vi.fn(), onEof: vi.fn() });
		fe.stop();
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

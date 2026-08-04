import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ReadlineLoginUi } from "../src/models/login-ui.js";
import { LoginCancelledError } from "../src/models/provider-login.js";

function makeStreams() {
	const input = new PassThrough();
	const output = new PassThrough();
	const chunks: string[] = [];
	output.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
	return {
		input,
		output,
		type(line: string) {
			input.write(`${line}\n`);
		},
		text: () => chunks.join(""),
	};
}

describe("ReadlineLoginUi", () => {
	it("answers a text prompt", async () => {
		const streams = makeStreams();
		const ui = new ReadlineLoginUi({ input: streams.input, output: streams.output });

		const answer = ui.ask({ type: "text", message: "Enter name" });
		streams.type("hello");
		await expect(answer).resolves.toBe("hello");
		expect(streams.text()).toContain("Enter name");
		ui.close();
	});

	it("does not echo a secret answer over non-TTY streams", async () => {
		const streams = makeStreams();
		const ui = new ReadlineLoginUi({ input: streams.input, output: streams.output });

		const answer = ui.ask({ type: "secret", message: "Enter API key" });
		streams.type("sk-super-secret");
		await expect(answer).resolves.toBe("sk-super-secret");
		expect(streams.text()).not.toContain("sk-super-secret");
		ui.close();
	});

	it("resolves a select prompt by number", async () => {
		const streams = makeStreams();
		const ui = new ReadlineLoginUi({ input: streams.input, output: streams.output });

		const answer = ui.ask({
			type: "select",
			message: "Pick one",
			options: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Beta" },
			],
		});
		streams.type("2");
		await expect(answer).resolves.toBe("b");
		expect(streams.text()).toContain("Alpha");
		expect(streams.text()).toContain("Beta");
		ui.close();
	});

	it("defaults a blank select answer to the first option", async () => {
		const streams = makeStreams();
		const ui = new ReadlineLoginUi({ input: streams.input, output: streams.output });

		const answer = ui.ask({
			type: "select",
			message: "Pick one",
			options: [
				{ id: "a", label: "Alpha" },
				{ id: "b", label: "Beta" },
			],
		});
		streams.type("");
		await expect(answer).resolves.toBe("a");
		ui.close();
	});

	it("returns the preset answer for the first select only", async () => {
		const streams = makeStreams();
		const ui = new ReadlineLoginUi({
			input: streams.input,
			output: streams.output,
			presetFirstSelect: "device_code",
		});

		const first = await ui.ask({
			type: "select",
			message: "Method",
			options: [
				{ id: "browser", label: "Browser" },
				{ id: "device_code", label: "Device code" },
			],
		});
		expect(first).toBe("device_code");

		const second = ui.ask({
			type: "select",
			message: "Second pick",
			options: [
				{ id: "x", label: "X" },
				{ id: "y", label: "Y" },
			],
		});
		streams.type("2");
		await expect(second).resolves.toBe("y");
		ui.close();
	});

	it("quietly resolves manual_code with an empty string when its own signal aborts (callback server won the race)", async () => {
		const streams = makeStreams();
		const ui = new ReadlineLoginUi({ input: streams.input, output: streams.output });
		const promptController = new AbortController();

		const answer = ui.ask({ type: "manual_code", message: "Paste code", signal: promptController.signal });
		promptController.abort();
		await expect(answer).resolves.toBe("");
		ui.close();
	});

	it("rejects with LoginCancelledError when the overall signal aborts", async () => {
		const streams = makeStreams();
		const controller = new AbortController();
		const ui = new ReadlineLoginUi({ input: streams.input, output: streams.output, signal: controller.signal });

		const answer = ui.ask({ type: "text", message: "Enter name" });
		controller.abort();
		await expect(answer).rejects.toBeInstanceOf(LoginCancelledError);
		ui.close();
	});

	it("renders info, auth_url, and device_code notifications", () => {
		const streams = makeStreams();
		const ui = new ReadlineLoginUi({ input: streams.input, output: streams.output, noBrowser: true });

		ui.notify({ type: "info", message: "hello world", links: [{ url: "https://example.test", label: "docs" }] });
		ui.notify({ type: "auth_url", url: "https://example.test/authorize", instructions: "Open this" });
		ui.notify({
			type: "device_code",
			userCode: "ABCD-1234",
			verificationUri: "https://example.test/device",
			expiresInSeconds: 900,
		});
		ui.notify({ type: "progress", message: "waiting for authorization..." });

		const text = streams.text();
		expect(text).toContain("hello world");
		expect(text).toContain("Open this");
		expect(text).toContain("ABCD-1234");
		expect(text).toContain("expires in ~15 min");
		expect(text).toContain("waiting for authorization...");
		ui.close();
	});
});

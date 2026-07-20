import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/executor.js";
import type { MediaSender, MediaSendResult, OutboundMedia } from "../src/runtime/channel-context.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createSendMediaTool } from "../src/tools/send-media.js";

class ScriptedExecutor implements Executor {
	public readonly calls: string[] = [];
	constructor(private readonly results: ExecResult[]) {}
	async exec(command: string, _options?: ExecOptions): Promise<ExecResult> {
		this.calls.push(command);
		const result = this.results.shift();
		if (!result) throw new Error(`Unexpected command: ${command}`);
		return result;
	}
}

class RecordingSender implements MediaSender {
	public readonly sent: Array<{ channelId: string; media: OutboundMedia }> = [];
	constructor(private readonly result: MediaSendResult = { ok: true }) {}
	async sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
		this.sent.push({ channelId, media });
		return this.result;
	}
}

// stat probe ("OK") followed by base64 of the given bytes.
function fileReads(bytes: Buffer): ExecResult[] {
	return [
		{ code: 0, stdout: "OK\n", stderr: "" },
		{ code: 0, stdout: bytes.toString("base64"), stderr: "" },
	];
}

const disabledSecurity = { ...DEFAULT_SECURITY_CONFIG, enabled: false };

describe("send_media tool", () => {
	it("reads the file via the executor and forwards bytes to the bound channel", async () => {
		const payload = Buffer.from("hello-image");
		const executor = new ScriptedExecutor(fileReads(payload));
		const sender = new RecordingSender();
		const tool = createSendMediaTool(executor, {
			mediaSender: sender,
			channelId: "dm_alice",
			securityConfig: disabledSecurity,
		});

		const result = await tool.execute("call", { label: "send", path: "chart.png" });

		expect(sender.sent).toHaveLength(1);
		expect(sender.sent[0].channelId).toBe("dm_alice");
		expect(sender.sent[0].media.kind).toBe("image");
		expect(sender.sent[0].media.fileName).toBe("chart.png");
		expect(sender.sent[0].media.data.equals(payload)).toBe(true);
		const first = result.content[0];
		expect(first.type).toBe("text");
		expect(first.type === "text" && first.text).toContain("Sent image");
	});

	it("classifies non-image extensions as file attachments and honors fileName override", async () => {
		const executor = new ScriptedExecutor(fileReads(Buffer.from("PDFDATA")));
		const sender = new RecordingSender();
		const tool = createSendMediaTool(executor, {
			mediaSender: sender,
			channelId: "group_x",
			securityConfig: disabledSecurity,
		});

		await tool.execute("call", { label: "send", path: "out/report-final.pdf", fileName: "Q3 Report.pdf" });

		expect(sender.sent[0].media.kind).toBe("file");
		expect(sender.sent[0].media.fileName).toBe("Q3 Report.pdf");
	});

	it("surfaces a transport failure as a thrown error", async () => {
		const executor = new ScriptedExecutor(fileReads(Buffer.from("x")));
		const sender = new RecordingSender({ ok: false, error: "exceeds the 1MB limit" });
		const tool = createSendMediaTool(executor, {
			mediaSender: sender,
			channelId: "dm_alice",
			securityConfig: disabledSecurity,
		});

		await expect(tool.execute("call", { label: "send", path: "big.png" })).rejects.toThrow("1MB limit");
	});

	it("rejects a non-existent / non-regular file before reading bytes", async () => {
		const executor = new ScriptedExecutor([{ code: 0, stdout: "NO\n", stderr: "" }]);
		const sender = new RecordingSender();
		const tool = createSendMediaTool(executor, {
			mediaSender: sender,
			channelId: "dm_alice",
			securityConfig: disabledSecurity,
		});

		await expect(tool.execute("call", { label: "send", path: "missing.png" })).rejects.toThrow("not a regular file");
		expect(sender.sent).toHaveLength(0);
	});

	it("rejects an empty file", async () => {
		const executor = new ScriptedExecutor([
			{ code: 0, stdout: "OK\n", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
		]);
		const sender = new RecordingSender();
		const tool = createSendMediaTool(executor, {
			mediaSender: sender,
			channelId: "dm_alice",
			securityConfig: disabledSecurity,
		});

		await expect(tool.execute("call", { label: "send", path: "empty.png" })).rejects.toThrow("empty");
		expect(sender.sent).toHaveLength(0);
	});

	it("blocks a path rejected by the path-guard without touching the transport", async () => {
		const executor = new ScriptedExecutor([]);
		const sender = new RecordingSender();
		const tool = createSendMediaTool(executor, {
			mediaSender: sender,
			channelId: "dm_alice",
			// Guard enabled with default config; an absolute system path escapes the workspace.
			securityConfig: DEFAULT_SECURITY_CONFIG,
			securityContext: { workspaceDir: "/home/agent/workspace", cwd: "/home/agent/workspace" },
		});

		await expect(tool.execute("call", { label: "send", path: "/etc/passwd" })).rejects.toThrow(/blocked/i);
		expect(executor.calls).toHaveLength(0);
		expect(sender.sent).toHaveLength(0);
	});
});

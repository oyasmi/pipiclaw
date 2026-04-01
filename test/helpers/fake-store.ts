import { join } from "path";

export class FakeChannelStore {
	logged: Array<{ method: string; args: unknown[] }> = [];

	async logMessage(channelId: string, message: unknown): Promise<boolean> {
		this.logged.push({ method: "logMessage", args: [channelId, message] });
		return true;
	}

	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		this.logged.push({ method: "logBotResponse", args: [channelId, text, ts] });
	}

	async logSubAgentRun(channelId: string, run: unknown): Promise<void> {
		this.logged.push({ method: "logSubAgentRun", args: [channelId, run] });
	}

	getChannelDir(channelId: string): string {
		return join("/tmp", channelId);
	}
}

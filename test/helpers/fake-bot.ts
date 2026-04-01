import type { DingTalkEvent } from "../../src/dingtalk.js";

export class FakeDingTalkBot {
	calls: Array<{ method: string; args: unknown[] }> = [];
	private readonly returnValues = new Map<string, unknown>();

	configure(method: string, returnValue: unknown): void {
		this.returnValues.set(method, returnValue);
	}

	private getReturnValue<T>(method: string, fallback: T): T {
		return (this.returnValues.get(method) as T | undefined) ?? fallback;
	}

	async streamToCard(channelId: string, content: string): Promise<boolean> {
		this.calls.push({ method: "streamToCard", args: [channelId, content] });
		return this.getReturnValue("streamToCard", true);
	}

	async finalizeCard(channelId: string, content: string): Promise<boolean> {
		this.calls.push({ method: "finalizeCard", args: [channelId, content] });
		return this.getReturnValue("finalizeCard", true);
	}

	async finalizeExistingCard(channelId: string, content: string): Promise<boolean> {
		this.calls.push({ method: "finalizeExistingCard", args: [channelId, content] });
		return this.getReturnValue("finalizeExistingCard", true);
	}

	discardCard(channelId: string): void {
		this.calls.push({ method: "discardCard", args: [channelId] });
	}

	async sendPlain(channelId: string, text: string): Promise<boolean> {
		this.calls.push({ method: "sendPlain", args: [channelId, text] });
		return this.getReturnValue("sendPlain", true);
	}

	enqueueEvent(event: DingTalkEvent): boolean {
		this.calls.push({ method: "enqueueEvent", args: [event] });
		return this.getReturnValue("enqueueEvent", true);
	}
}

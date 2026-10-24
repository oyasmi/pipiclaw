import { describe, expect, it } from "vitest";
import { parseChannelId, transportOf } from "../src/channel/channel-id.js";
import {
	conversationTypeFor,
	dingtalkDmChannelId,
	dingtalkGroupChannelId,
	parseDingTalkChannelId,
} from "../src/dingtalk/channel-ids.js";

describe("channel id parsing", () => {
	it("splits only at the first colon, so a native address may contain ':' '/' '+' '='", () => {
		// A DingTalk conversation id is base64 and can hold every one of these. Splitting at any later
		// colon would hand the runtime a different (wrong) transport or truncate the address.
		const group = dingtalkGroupChannelId("cidAb+c/d=:tail");
		expect(parseChannelId(group)).toEqual({ transport: "dingtalk", native: "group:cidAb+c/d=:tail" });
		expect(parseDingTalkChannelId(group)).toEqual({ kind: "group", native: "cidAb+c/d=:tail" });
		expect(transportOf(dingtalkDmChannelId("staff-1"))).toBe("dingtalk");
	});

	it("rejects ids that name no transport or no address", () => {
		for (const id of ["", "tui", "dingtalk:", ":dm:1", "dingtalk:dm:\0x"]) {
			expect(parseChannelId(id), id).toBeUndefined();
		}
		// An unknown transport still parses: a stale record must be recognizable as unreachable, not crash.
		expect(parseChannelId("feishu:chat:1")).toEqual({ transport: "feishu", native: "chat:1" });
	});

	it("derives the DingTalk kind only from a well-formed dingtalk address", () => {
		expect(parseDingTalkChannelId("webapi:conv_0123")).toBeUndefined();
		expect(parseDingTalkChannelId("dingtalk:channel:1")).toBeUndefined();
		expect(parseDingTalkChannelId("dingtalk:dm:")).toBeUndefined();
		expect(conversationTypeFor(dingtalkGroupChannelId("g"))).toBe("2");
		expect(conversationTypeFor(dingtalkDmChannelId("u"))).toBe("1");
	});
});

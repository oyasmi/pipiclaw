/**
 * Low-level DingTalk HTTP: the shared axios instance, the two API hosts, and the one POST that
 * delivers every non-card robot message (plain text/markdown, images, files).
 */
import axios from "axios";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import type { DingTalkConfig } from "./config.js";

export const DINGTALK_API = "https://api.dingtalk.com";
// Media upload lives on the legacy oapi host, not the v1.0 api host. It returns a
// reusable `media_id` that the v1.0 robot send endpoints reference (photoURL /
// mediaId). The `access_token` query param is the same app access token minted by
// `/v1.0/oauth2/accessToken` — DingTalk unified the internal-app token across both
// hosts — so the one `AccessTokenProvider` is reused rather than fetching a second token.
export const DINGTALK_OAPI = "https://oapi.dingtalk.com";

// Bound every outbound DingTalk HTTP call. Without this, axios waits forever on a
// hung connection, and a stalled card-streaming request would wedge the delivery
// sync loop (never resolving flush()), leaving the whole channel permanently busy.
// A timeout turns "hang" into a normal failure that the existing fallback paths
// (bounded snapshot replay / sendPlain) already handle.
const DINGTALK_HTTP_TIMEOUT_MS = 15_000;
export const http = axios.create({ timeout: DINGTALK_HTTP_TIMEOUT_MS });

/** Where a channel's messages go: enough to pick the DM-vs-group endpoint and the recipient. */
export interface ConversationMeta {
	conversationId: string;
	conversationType: string;
	senderId: string;
}

/**
 * POST a robot message with an arbitrary msgKey/msgParam, routing DM vs group
 * to the correct endpoint. The single outbound path for every non-card message:
 * plain text/markdown, images, and files.
 */
export async function sendRobotMessage(
	deps: { config: DingTalkConfig; getAccessToken: () => Promise<string | null> },
	meta: ConversationMeta,
	msgKey: string,
	msgParam: string,
): Promise<boolean> {
	const token = await deps.getAccessToken();
	if (!token) return false;

	const robotCode = deps.config.robotCode || deps.config.clientId;
	const isGroup = meta.conversationType === "2";
	const url = isGroup
		? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
		: `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

	const body: Record<string, unknown> = { robotCode, msgKey, msgParam };
	if (isGroup) {
		body.openConversationId = meta.conversationId;
	} else {
		body.userIds = [meta.senderId];
	}

	try {
		await http.post(url, body, {
			headers: {
				"x-acs-dingtalk-access-token": token,
				"Content-Type": "application/json",
			},
		});
		return true;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response) {
			log.logWarn("dingtalk.send.failed", "Message send failed", {
				reason: JSON.stringify(err.response.data),
				fields: { msgKey, status: err.response.status },
			});
		} else {
			log.logWarn("dingtalk.send.failed", "Message send failed", {
				reason: errorMessage(err),
				fields: { msgKey },
			});
		}
		return false;
	}
}

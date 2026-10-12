/** App access token cache: one token shared by every DingTalk host, refreshed on demand. */
import axios from "axios";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { DINGTALK_API, http } from "./api.js";

export class AccessTokenProvider {
	private accessToken: string | null = null;
	private tokenExpiry = 0;
	private tokenRefreshPromise: Promise<string | null> | null = null;

	constructor(private credentials: { clientId: string; clientSecret: string }) {}

	async get(): Promise<string | null> {
		if (this.accessToken && Date.now() / 1000 < this.tokenExpiry) {
			return this.accessToken;
		}

		// Coalesce concurrent refresh requests into a single HTTP call
		if (!this.tokenRefreshPromise) {
			this.tokenRefreshPromise = this.refresh().finally(() => {
				this.tokenRefreshPromise = null;
			});
		}
		return this.tokenRefreshPromise;
	}

	private async refresh(): Promise<string | null> {
		try {
			const resp = await http.post(
				`${DINGTALK_API}/v1.0/oauth2/accessToken`,
				{
					appKey: this.credentials.clientId,
					appSecret: this.credentials.clientSecret,
				},
				{
					headers: { "Content-Type": "application/json" },
				},
			);

			const data = resp.data as { accessToken?: string; expireIn?: number };
			this.accessToken = data.accessToken || null;
			this.tokenExpiry = Date.now() / 1000 + (data.expireIn || 7200) - 60;
			return this.accessToken;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarn("dingtalk.token.failed", "Access token request failed", {
					reason: JSON.stringify(err.response.data),
					fields: { status: err.response.status },
				});
			} else {
				log.logWarn("dingtalk.token.failed", "Access token request failed", { reason: errorMessage(err) });
			}
			return null;
		}
	}
}

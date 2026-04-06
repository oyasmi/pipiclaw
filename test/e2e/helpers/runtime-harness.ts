import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { DingTalkBot, DingTalkEvent } from "../../../src/runtime/dingtalk.js";
import { type CapturedDelivery, E2EFakeDingTalkBot } from "./fake-bot.js";
import { cleanupE2ETestHome, createE2ETestHome, type E2ETestHome } from "./setup.js";

export interface E2ERuntimeHarness {
	homeDir: string;
	workspaceDir: string;
	channelId: string;
	channelDir: string;
	deliveries: CapturedDelivery[];
	sendUserMessage(text: string, overrides?: Partial<DingTalkEvent>): Promise<void>;
	shutdown(): Promise<void>;
}

function getChannelDirName(channelId: string): string {
	return channelId.replaceAll("/", "__");
}

export async function createRuntimeHarness(options?: {
	channelId?: string;
	enableDebug?: boolean;
	home?: E2ETestHome;
}): Promise<E2ERuntimeHarness> {
	const home = options?.home ?? createE2ETestHome({ enableDebug: options?.enableDebug });
	process.env.PIPICLAW_HOME = home.homeDir;

	const { createRuntimeContext } = await import("../../../src/runtime/bootstrap.js");
	const channelId = options?.channelId ?? "dm_e2e_user";
	const channelDir = join(home.workspaceDir, getChannelDirName(channelId));
	const fakeBot = new E2EFakeDingTalkBot();
	const runtime = createRuntimeContext({
		paths: {
			appName: "pipiclaw",
			appHomeDir: home.homeDir,
			workspaceDir: home.workspaceDir,
			authConfigPath: join(home.homeDir, "auth.json"),
			channelConfigPath: join(home.homeDir, "channel.json"),
			modelsConfigPath: join(home.homeDir, "models.json"),
			settingsConfigPath: join(home.homeDir, "settings.json"),
			toolsConfigPath: join(home.homeDir, "tools.json"),
		},
		sandbox: { type: "host" },
		dingtalkConfig: {
			clientId: "e2e-client-id",
			clientSecret: "e2e-client-secret",
			robotCode: "e2e-client-id",
			cardTemplateKey: "content",
			stateDir: home.workspaceDir,
		},
		registerSignalHandlers: false,
		startServices: false,
		createBot: () => fakeBot as unknown as DingTalkBot,
		createEventsWatcher: () => ({ start() {}, stop() {} }),
	});

	return {
		homeDir: home.homeDir,
		workspaceDir: home.workspaceDir,
		channelId,
		channelDir,
		deliveries: fakeBot.deliveries,
		async sendUserMessage(text: string, overrides?: Partial<DingTalkEvent>): Promise<void> {
			await runtime.handler.handleEvent(
				{
					type: "dm",
					channelId,
					ts: Date.now().toString(),
					user: "e2e_user",
					userName: "E2E Tester",
					text,
					conversationId: "conv_e2e",
					conversationType: "1",
					...overrides,
				},
				fakeBot as unknown as DingTalkBot,
			);
		},
		async shutdown(): Promise<void> {
			await runtime.shutdown("manual");
			cleanupE2ETestHome(home.homeDir);
		},
	};
}

export function writeWorkspaceFile(
	harness: Pick<E2ERuntimeHarness, "workspaceDir">,
	relativePath: string,
	content: string,
): string {
	const path = join(harness.workspaceDir, relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
	return path;
}

export function getChannelFile(harness: Pick<E2ERuntimeHarness, "channelDir">, filename: string): string {
	return join(harness.channelDir, filename);
}

export function channelFileExists(harness: Pick<E2ERuntimeHarness, "channelDir">, filename: string): boolean {
	return existsSync(getChannelFile(harness, filename));
}

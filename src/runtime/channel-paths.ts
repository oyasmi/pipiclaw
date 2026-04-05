import { mkdirSync } from "fs";
import { join } from "path";

export function getChannelDirName(channelId: string): string {
	return channelId.replaceAll("/", "__");
}

export function getChannelDir(baseDir: string, channelId: string): string {
	return join(baseDir, getChannelDirName(channelId));
}

export function ensureChannelDir(baseDir: string, channelId: string): string {
	const channelDir = getChannelDir(baseDir, channelId);
	mkdirSync(channelDir, { recursive: true });
	return channelDir;
}

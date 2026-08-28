import { mkdirSync } from "fs";
import { join } from "path";

/**
 * Every channel id is `dm_<staffId>` or `group_<conversationId>`.
 *
 * The remainder is deliberately unconstrained apart from path-safety: a DingTalk
 * conversation id is base64 and routinely contains `/` and `=`, so the charset allowlist this
 * check used to carry (`[A-Za-z0-9._:-]+`) rejected every real group. Anything that filtered
 * ids through it — workspace scans, the maintenance scheduler's known-channel filter — silently
 * dropped those channels.
 *
 * What still has to hold is that an id can never escape the directory it names. `getChannelDir`
 * folds `/` into `__`, but not every consumer escapes (the memory-maintenance state file
 * interpolates the id straight into a filename), so a `..` segment and the path separators that
 * survive escaping are rejected here, once, for everyone.
 */
const CHANNEL_ID_PATTERN = /^(dm|group)_[^\0\\]+$/;

export function isChannelId(value: string): boolean {
	if (!CHANNEL_ID_PATTERN.test(value)) return false;
	return !value.split("/").includes("..");
}

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

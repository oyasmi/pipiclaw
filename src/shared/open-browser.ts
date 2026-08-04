import { spawn } from "node:child_process";

/**
 * Best-effort attempt to open a URL in the user's default browser. Never
 * throws or rejects — a login flow must keep working (via the printed URL)
 * even on a headless server with no browser available.
 */
export function openBrowser(url: string): void {
	try {
		const platform = process.platform;
		const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
		const args = platform === "win32" ? ["/c", "start", '""', url] : [url];
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			// No browser available (headless server, missing xdg-open, etc). The
			// caller already printed the URL, so this is silently swallowed.
		});
		child.unref();
	} catch {
		// Never let a browser-launch failure interrupt the login flow.
	}
}

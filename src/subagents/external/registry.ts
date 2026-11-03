import { claudeCodeHarness } from "./claude-code.js";
import { codexCliHarness } from "./codex-cli.js";
import { cursorCliHarness } from "./cursor-cli.js";
import { execHarness } from "./exec.js";
import type { ExternalHarness } from "./harness.js";

const harnesses: Partial<Record<ExternalHarness["id"], ExternalHarness>> = {
	"codex-cli": codexCliHarness,
	"claude-code": claudeCodeHarness,
	"cursor-cli": cursorCliHarness,
	exec: execHarness,
};

export function getExternalHarness(id: string): ExternalHarness | undefined {
	return harnesses[id as ExternalHarness["id"]];
}

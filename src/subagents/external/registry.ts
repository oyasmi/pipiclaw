import { claudeCodeHarness } from "./claude-code.js";
import { codexCliHarness } from "./codex-cli.js";
import { execHarness } from "./exec.js";
import type { ExternalHarness } from "./harness.js";

const harnesses: Partial<Record<ExternalHarness["id"], ExternalHarness>> = {
	"codex-cli": codexCliHarness,
	"claude-code": claudeCodeHarness,
	exec: execHarness,
};

export function getExternalHarness(id: string): ExternalHarness | undefined {
	return harnesses[id as ExternalHarness["id"]];
}

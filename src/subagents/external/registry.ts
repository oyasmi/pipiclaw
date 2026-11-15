import type { RunHarness } from "../run-record.js";
import { antigravityCliHarness } from "./antigravity-cli.js";
import { claudeCodeHarness } from "./claude-code.js";
import { codexCliHarness } from "./codex-cli.js";
import { cursorCliHarness } from "./cursor-cli.js";
import { execHarness } from "./exec.js";
import type { ExternalHarness } from "./harness.js";

/** Exhaustive `Record<RunHarness, ExternalHarness>`: adding an id to `EXTERNAL_HARNESS_IDS` fails typecheck until registered here. */
const harnesses: Record<RunHarness, ExternalHarness> = {
	"codex-cli": codexCliHarness,
	"claude-code": claudeCodeHarness,
	"cursor-cli": cursorCliHarness,
	"antigravity-cli": antigravityCliHarness,
	exec: execHarness,
};

export function getExternalHarness(id: string): ExternalHarness | undefined {
	return Object.hasOwn(harnesses, id) ? harnesses[id as RunHarness] : undefined;
}

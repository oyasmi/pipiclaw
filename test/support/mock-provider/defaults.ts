/**
 * Default responses for the memory sidecar (spec 048 D2.7).
 *
 * The sidecar shares the provider endpoint with the main turn. Tests that do not
 * care about memory should not have to hand-script every extraction / rerank /
 * SESSION-update call — but these are still explicitly registered routes, not a
 * catch-all fallback. A test that needs to assert on memory behaviour registers a
 * higher-priority route (`script.prependRoute`) for the same matcher.
 */

import { reply, type Script } from "./script.js";

/** A minimal valid `# Current State` document the SESSION.md writer would accept. */
const DEFAULT_SESSION_JSON = {
	title: "E2E session",
	currentState: ["deterministic e2e run"],
	userIntent: [],
	activeFiles: [],
	decisions: [],
	constraints: [],
	errorsAndCorrections: [],
	nextSteps: [],
	worklog: [],
	resolved: [],
};

export function registerSidecarDefaults(script: Script): void {
	// Covers both turn-boundary extraction and inline consolidation — both go through
	// buildMemoryExtractionSystemPrompt, so both carry this marker.
	script.route({
		name: "sidecar:memory-extraction",
		when: (req) => !req.isMainTurn && req.systemPrompt.includes("durable memory extraction worker"),
		respond: [reply.json({ memoryOps: [], discarded: [], historyBlock: "" })],
	});
	script.route({
		name: "sidecar:recall-rerank",
		when: (req) => !req.isMainTurn && req.systemPrompt.includes("which memory snippets are most relevant"),
		respond: [reply.json({ selectedIds: [] })],
	});
	script.route({
		name: "sidecar:session-memory",
		when: (req) => !req.isMainTurn && req.systemPrompt.includes("You maintain a Pipiclaw SESSION.md file"),
		respond: [reply.json(DEFAULT_SESSION_JSON)],
	});
	script.route({
		name: "sidecar:session-search-summary",
		when: (req) => !req.isMainTurn && req.systemPrompt.includes("summarize current-channel transcript search hits"),
		respond: [reply.text("No relevant transcript hits.")],
	});
}

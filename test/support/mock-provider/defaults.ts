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

export function registerSidecarDefaults(script: Script): void {
	// Spec 050: the single reflect pass, fired both from the idle scheduler and from
	// MemoryLifecycle's boundary triggers (compaction / `/new` / shutdown) — the latter run
	// detached in the background, so any test that reaches one of those boundaries needs this
	// covered even when it does not care about memory itself.
	script.route({
		name: "sidecar:memory-reflect",
		when: (req) => !req.isMainTurn && req.systemPrompt.includes("memory reflection worker"),
		respond: [reply.json({ journal: [], ops: [], discarded: [] })],
		repeat: true,
	});
	script.route({
		name: "sidecar:recall-rerank",
		when: (req) => !req.isMainTurn && req.systemPrompt.includes("which memory snippets are most relevant"),
		respond: [reply.json({ selectedIds: [] })],
		repeat: true,
	});
	script.route({
		name: "sidecar:session-search-summary",
		when: (req) => !req.isMainTurn && req.systemPrompt.includes("summarize current-channel transcript search hits"),
		respond: [reply.text("No relevant transcript hits.")],
		repeat: true,
	});
}

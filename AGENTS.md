# AGENTS.md

## Project

Pipiclaw is a DingTalk-first AI coding assistant runtime built on `@earendil-works/pi-coding-agent`. It adds AI Card streaming, layered memory, scheduled work, per-channel workspaces, and unified delegation to internal agents or external Claude Code, Codex CLI, and custom executors.

## Core Structure

- `src/runtime/`: DingTalk transport, background services, and the composition root (`bootstrap`, `dingtalk`, `delivery`, `events`, `task-driver`)
- `src/channel/`: the transport-neutral channel domain — its two I/O contracts (`channel-context` outbound, `channel-event` inbound), identity (`channel-paths`, `channel-index`) and persisted state (`store`, `active-session-store`, `project-scope-store`). Depends on no transport; this is what `agent`, `memory`, `tools` and `tui` mean when they say "channel"
- `src/agent/`: main agent orchestration and session event handling
- `src/commands/`: the product-wide slash-command catalog (`catalog.ts`) and the shared reply length budget (`reply-limits.ts`). Imports nothing; handlers stay in the layer that owns their state
- `src/memory/`: one-fact-per-file channel memory, daily journal, and the single background reflect pass (spec 050)
- `src/subagents/`: role discovery, internal/external execution, run lifecycle, harnesses, workspace leases, and delegation tools
- `src/tools/`: tool implementations exposed to the coding agent
- `src/security/`: command, path, and network guard configuration and enforcement helpers
- `src/web/`: web search/fetch client, extraction, formatting, and provider implementations
- `src/models/`: model reference formatting, matching, default resolution, and API key lookup helpers
- `src/shared/`: small cross-cutting helpers that are truly shared across domains

The intended direction is domain-first organization. Avoid adding new generic root-level utilities when a file clearly belongs to an existing domain.

## Runtime Model

- App-level files: `channel.json`, `auth.json`, `models.json`, `settings.json`, `tools.json`, `security.json`
- Workspace-level files: `SOUL.md`, `AGENTS.md`, `MEMORY.md`, `ENVIRONMENT.md`, `skills/`, `events/`, `sub-agents/`
- Channel-level files: `memory/<name>.md` + generated `MEMORY.md` index, `journal/YYYY-MM-DD.md`, tasks, delegation records/artifacts, `log.jsonl`, `context.jsonl`
- `memory/<name>.md` is one durable fact per file (frontmatter metadata); `MEMORY.md` is generated from it — never hand-edited
- `journal/YYYY-MM-DD.md` is the day-by-day working record, written only by the background reflect pass
- `log.jsonl`, rotated logs, and `context.jsonl` are cold storage, not normal working memory; access them through `session_search` when needed

## Development Commands

- `npm run typecheck`
- `npm run test`
- `npm run test:coverage`
- `npm run test:e2e` — deterministic full-stack layer (scripted mock provider, no network, no API cost; runs in well under 90s)
- `npm run test:e2e:live` — the 5-ish real-model smoke cases (follows `~/.pipiclaw/settings.json`; manual / nightly)
- `npm run build`
- `npm run check`

Use `npm run typecheck` and `npm run test` as the minimum validation after non-trivial changes. **Also run `npm run test:e2e` when you change the runtime, memory, delegation, or command plane** — that layer is the only coverage for `runner ↔ session ↔ tools ↔ memory ↔ delivery`, the transport queue, and process/restart behaviour (spec 048).

## Test Layering

Three layers, each with a distinct job. Putting an assertion in the wrong layer is a review defect.

| Layer | Proves | Assertion style | Runs in |
|---|---|---|---|
| unit | one module's branches, edges, contracts | anything fakeable belongs here | `npm run check` |
| e2e (deterministic) | full-stack **mechanism**: cross-module timing, persisted side effects, process/restart, delivery sequencing, guard wiring | observable side effects — disk state, the request body sent to the provider, delivery count/order, audit records, run state. Never the model's wording. | `npm run test:e2e` |
| evals | real-model **behaviour quality** | grader / baseline / gate | `npm run eval` (not a gate) |

e2e hard rules:

1. **Mechanism only.** No assertion on whether the model answered *well* — that is an evals concern. To prove a path never reached the model, assert the model request count is 0.
2. **Assert side effects, not rendered text.** Pinning a literal help/status/reply string makes the test a change-detector; an intentional copy edit then turns the suite red and hides real failures (this is exactly how spec 048 happened).
3. **Timing is test-controlled.** Use the mock provider's `hold`/`release` to build deterministic concurrency windows. No `sleep`, no polling for an event you can control precisely.
4. **Every case names the failure it catches** in a comment — which commit or class of regression. A case that cannot name one is not accepted.
5. **Cheap enough to run every time.** The deterministic layer must pass offline with no credentials; a case that needs the network is in the wrong layer.
6. **Mutation check on the way in.** Before a new deterministic case merges, break the code it guards once, confirm the case goes red, and record that in the case's comment. A case that stays green when its target is broken is not a safety net.

## Engineering Rules

- Preserve the domain boundaries above; prefer moving code into the right module over adding compatibility aliases
- Keep `src/main.ts` thin; startup assembly belongs in runtime bootstrap code
- Keep runtime behavior reliable: queueing, reconnection, persistence, memory maintenance, and delegation settlement are higher priority than cosmetic refactors
- Prefer explicit types over `as any`
- Do not treat tests as optional; runtime, memory, and DingTalk behavior should be covered when changed
- Tests must be valuable — cover logic that can break: branches, edge cases, boundaries, concurrency, contracts, security guards, regressions. Do not add obvious low-value tests: asserting the literal text of a rendered help/status/label string, `new X() instanceof X` smoke checks, echoing a constant, or re-testing a branchless one-line formatter. A test that could only break when someone also intentionally edits the same string is a change-detector, not a safety net — leave it out
- Avoid creating barrel files or re-export shims unless they materially reduce coupling
- Every tool error or truncation output must carry a next-step instruction the model can act on directly (e.g. "Use offset=N to continue", "use the grep tool instead") — errors steer the model rather than just reporting failure
- Reject a bad tool call with `RecoverableToolError` (`src/shared/recoverable-error.ts`) when the model can fix it alone — a missing field, an unknown id, an illegal transition. Throw a plain `Error` only when the user must act or know: a guard refusal, an approval gate, corrupt state, a real fault. Only plain errors reach the user's chat, so the test is "can the model resolve this alone?", not "how severe is it?"
- A tool result's `details` is the runtime's channel (the model reads `content`). `buildToolSet` stamps `kind` from the registration name and that stamp is authoritative — a `kind` written inside a tool is redundant and cannot override it, so the discriminator can never drift from the tool it names. New tools need only return their own fields
- Keep `SubAgentRunManager` the sole owner of settlement, usage, leases, and completion wake; preserve its idempotency markers
- External agents bypass Pipiclaw's guards. Their role command, CLI sandbox, host account, and environment are the permission boundary; `mutates` is not a sandbox

## Command Reply Conventions

Slash-command output (`src/commands/catalog.ts`, `src/runtime/*-commands.ts`, `src/memory/commands.ts`, `src/agent/command-extension.ts`, `src/agent/status-render.ts`, `src/usage/render.ts`) follows six rules, established by the 2026-08-24 command-subsystem review to keep replies readable in DingTalk's markdown subset (which does not preserve indentation or run-together whitespace):

1. A command reply is one of three shapes: a confirmation (one sentence), a report (a bold headline plus blocks), or an error (one reason + one next step; usage text only on a bad argument).
2. Narrate in Chinese; keep only identifiers in English — command names, ids, field names (`wake`, `status`), model refs, and file paths.
3. No `#` headings; use a `**bold**` first line as the headline.
4. Only one flat level of `- ` bullets. Never use a 2-space continuation line as a sub-field, never align columns with spaces, never paste a long file/prompt verbatim into a reply.
5. Every report has a length budget (DingTalk target: ≤ 20 lines / 1,500 chars). Over budget, say what command to run next — do not just show more content.
6. Empty state uses one shape: `暂无 X。` plus a one-line "how to start".

## Practical Notes

- Node.js target is `>= 22.19.0`
- DingTalk transport commands are handled in the runtime layer; session commands are handled inside the agent session layer
- Event administration commands (`/events list|show|delete|history`) are runtime-layer commands and must stay path-confined to `workspace/events/` and event history
- The package version lives in `package.json` and the top-level package entry in `package-lock.json`
- Web tools are configured through app-level `tools.json`; security policy is configured through app-level `security.json`
- Workspace skills live only under `workspace/skills/`; do not add channel-scoped skill directories
- The daemon owns durable external-run wake/recovery; TUI does not. `/stop` never cancels dispatched runs

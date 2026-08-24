# AGENTS.md

## Project

Pipiclaw is a DingTalk-first AI coding assistant runtime built on `@earendil-works/pi-coding-agent`. It adds AI Card streaming, layered memory, scheduled work, per-channel workspaces, and unified delegation to internal agents or external Claude Code, Codex CLI, and custom executors.

## Core Structure

- `src/runtime/`: DingTalk transport and runtime wiring (`bootstrap`, `dingtalk`, `delivery`, `events`, `store`)
- `src/agent/`: main agent orchestration and session event handling
- `src/memory/`: channel memory lifecycle, consolidation, recall, session memory, and file helpers
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
- Channel-level files: `SESSION.md`, `MEMORY.md`, `HISTORY.md`, tasks, delegation records/artifacts, `log.jsonl`, `context.jsonl`
- `SESSION.md` is the current working state
- `MEMORY.md` is durable channel memory
- `HISTORY.md` is summarized older history
- `log.jsonl`, rotated logs, and `context.jsonl` are cold storage, not normal working memory; access them through `session_search` when needed

## Development Commands

- `npm run typecheck`
- `npm run test`
- `npm run test:coverage`
- `npm run build`
- `npm run check`

Use `npm run typecheck` and `npm run test` as the minimum validation after non-trivial changes.

## Engineering Rules

- Preserve the domain boundaries above; prefer moving code into the right module over adding compatibility aliases
- Keep `src/main.ts` thin; startup assembly belongs in runtime bootstrap code
- Keep runtime behavior reliable: queueing, reconnection, persistence, memory maintenance, and delegation settlement are higher priority than cosmetic refactors
- Prefer explicit types over `as any`
- Do not treat tests as optional; runtime, memory, and DingTalk behavior should be covered when changed
- Avoid creating barrel files or re-export shims unless they materially reduce coupling
- Every tool error or truncation output must carry a next-step instruction the model can act on directly (e.g. "Use offset=N to continue", "use the grep tool instead") — errors steer the model rather than just reporting failure
- Reject a bad tool call with `RecoverableToolError` (`src/shared/recoverable-error.ts`) when the model can fix it alone — a missing field, an unknown id, an illegal transition. Throw a plain `Error` only when the user must act or know: a guard refusal, an approval gate, corrupt state, a real fault. Only plain errors reach the user's chat, so the test is "can the model resolve this alone?", not "how severe is it?"
- A tool result's `details` is the runtime's channel (the model reads `content`). `buildToolSet` stamps `kind` from the registration name and that stamp is authoritative — a `kind` written inside a tool is redundant and cannot override it, so the discriminator can never drift from the tool it names. New tools need only return their own fields
- Keep `SubAgentRunManager` the sole owner of settlement, usage, leases, and completion wake; preserve its idempotency markers
- External agents bypass Pipiclaw's guards. Their role command, CLI sandbox, host account, and environment are the permission boundary; `mutates` is not a sandbox

## Command Reply Conventions

Slash-command output (`src/agent/commands.ts`, `src/runtime/*-commands.ts`, `src/memory/commands.ts`, `src/agent/command-extension.ts`, `src/agent/status-render.ts`, `src/usage/render.ts`) follows six rules, established by the 2026-08-24 command-subsystem review to keep replies readable in DingTalk's markdown subset (which does not preserve indentation or run-together whitespace):

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

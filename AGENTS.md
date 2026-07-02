# AGENTS.md

## Project

Pipiclaw is a DingTalk-first AI coding assistant runtime built on top of `@earendil-works/pi-coding-agent`.
It adds the runtime pieces needed for long-lived team usage: DingTalk transport, AI Card streaming, sub-agents, layered memory, scheduled events, and per-channel workspaces.

## Core Structure

- `src/runtime/`: DingTalk transport and runtime wiring (`bootstrap`, `dingtalk`, `delivery`, `events`, `store`)
- `src/agent/`: main agent orchestration and session event handling
- `src/memory/`: channel memory lifecycle, consolidation, recall, session memory, and file helpers
- `src/subagents/`: predefined sub-agent discovery and the sub-agent tool
- `src/tools/`: tool implementations exposed to the coding agent
- `src/security/`: command, path, and network guard configuration and enforcement helpers
- `src/web/`: web search/fetch client, extraction, formatting, and provider implementations
- `src/models/`: model reference formatting, matching, default resolution, and API key lookup helpers
- `src/shared/`: small cross-cutting helpers that are truly shared across domains

The intended direction is domain-first organization. Avoid adding new generic root-level utilities when a file clearly belongs to an existing domain.

## Runtime Model

- App-level files: `channel.json`, `auth.json`, `models.json`, `settings.json`, `tools.json`, `security.json`
- Workspace-level files: `SOUL.md`, `AGENTS.md`, `MEMORY.md`, `ENVIRONMENT.md`, `skills/`, `events/`, `sub-agents/`
- Channel-level files: `SESSION.md`, `MEMORY.md`, `HISTORY.md`, `log.jsonl`, `context.jsonl`
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
- Keep runtime behavior reliable: queueing, reconnection, persistence, and memory maintenance are higher priority than cosmetic refactors
- Prefer explicit types over `as any`
- Do not treat tests as optional; runtime, memory, and DingTalk behavior should be covered when changed
- Avoid creating barrel files or re-export shims unless they materially reduce coupling

## Practical Notes

- Node.js target is `>= 22`
- DingTalk transport commands are handled in the runtime layer; session commands are handled inside the agent session layer
- The package version lives in `package.json` and the top-level package entry in `package-lock.json`
- Web tools are configured through app-level `tools.json`; security policy is configured through app-level `security.json`
- Workspace skills live only under `workspace/skills/`; do not add channel-scoped skill directories

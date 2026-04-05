# AGENTS.md

## Project

Pipiclaw is a DingTalk-first AI coding assistant runtime built on top of `@mariozechner/pi-coding-agent`.
It adds the runtime pieces needed for long-lived team usage: DingTalk transport, AI Card streaming, sub-agents, layered memory, scheduled events, and per-channel workspaces.

## Core Structure

- `src/runtime/`: DingTalk transport and runtime wiring (`bootstrap`, `dingtalk`, `delivery`, `events`, `store`)
- `src/agent/`: main agent orchestration and session event handling
- `src/memory/`: channel memory lifecycle, consolidation, recall, session memory, and file helpers
- `src/subagents/`: predefined sub-agent discovery and the sub-agent tool
- `src/tools/`: tool implementations exposed to the coding agent
- `src/shared/`: small cross-cutting helpers that are truly shared across domains

The intended direction is domain-first organization. Avoid adding new generic root-level utilities when a file clearly belongs to an existing domain.

## Runtime Model

- Workspace-level files: `SOUL.md`, `AGENTS.md`, `MEMORY.md`, `ENVIRONMENT.md`, `skills/`, `events/`, `sub-agents/`
- Channel-level files: `SESSION.md`, `MEMORY.md`, `HISTORY.md`, `log.jsonl`, `context.jsonl`
- `SESSION.md` is the current working state
- `MEMORY.md` is durable channel memory
- `HISTORY.md` is summarized older history
- `log.jsonl` and `context.jsonl` are cold storage, not normal working memory

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

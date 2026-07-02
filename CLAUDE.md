# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the source of truth for domain boundaries and engineering rules — read it too. This file adds the commands and the cross-file architecture that AGENTS.md does not spell out.

## Commands

- `npm run check` — full gate: `lint` + `typecheck` + `deadcode` (knip) + `test`. Run this before considering a change done.
- `npm run test` — unit/integration tests (Vitest). Excludes `test/e2e/**`.
- Single test file: `npx vitest run test/memory-lifecycle.test.ts`
- Single test by name: `npx vitest run -t "creates a distinct session id"`
- `npm run test:e2e` — end-to-end suite (`vitest.config.e2e.ts`); slower, runs a real bootstrap.
- `npm run typecheck` — `tsc --noEmit` against `tsconfig.json` (the config with `noUnusedLocals`/`noUnusedParameters`; `tsconfig.build.json` is emit-only).
- `npm run lint` — Biome (format + lint); autofix with `npx biome check --write .`.
- `npm run deadcode` — knip. Configured with `ignoreExportsUsedInFile`, so an `export` used only inside its own file is not flagged; a *genuinely* unused export must be deleted or its `export` dropped, not suppressed.
- `npm run build` — `tsc -p tsconfig.build.json`, then chmods `dist/main.js` (the `pipiclaw` bin).

Node `>= 22.19.0`.

## Architecture

Pipiclaw is a long-lived runtime that wraps the `@earendil-works/pi-coding-agent` SDK (a fork; the README's `@mariozechner/...` name is historical) and drives it from DingTalk. The layers below are traversed on every message.

**Transport → agent → delivery flow**
1. `src/runtime/bootstrap.ts` loads config, constructs the `DingTalkBot`, memory scheduler, and events watcher, and wires them together. `src/main.ts` is intentionally a thin entrypoint that just calls `bootstrap`.
2. `src/runtime/dingtalk.ts` receives Stream-mode events and produces a `DingTalkContext` (the delivery surface: `respond`, `respondInThread`, AI Card streaming).
3. Each channel gets one `ChannelRunner` (`src/agent/channel-runner.ts`), cached by `src/agent/runner-factory.ts`. This is the orchestrator: it assembles the SDK `Agent`/`AgentSession`, the tool set, memory, sub-agents, and prompt, then runs a turn and streams progress back through the `DingTalkContext`.
4. `src/agent/session-events.ts` translates SDK session events into progress/AI-Card updates.

**Concurrency model (important, spans several files)**
- Per channel, turns are serialized by a **run queue** (`src/agent/run-queue.ts`): a promise chain so a channel processes one turn at a time while still accepting `/steer`, `/followup`, `/stop`.
- Memory writes are serialized by **per-channel serial queues** built on `src/shared/serial-queue.ts`. `src/memory/channel-maintenance-queue.ts` exposes a *shared singleton* queue so `lifecycle` and `maintenance-jobs` never race on the same channel's files — do not inline it.
- Config/state files are written via `src/shared/atomic-file.ts` (write-temp-then-rename).

**Memory subsystem (`src/memory/`)** — layered, do not flatten:
- Working files per channel: `SESSION.md` (current state), `MEMORY.md` (durable), `HISTORY.md` (summarized older history); `log.jsonl`/`context.jsonl` are cold storage.
- `lifecycle.ts` orchestrates a channel's memory; `recall.ts` retrieves relevant memory for a turn; `consolidation.ts` folds/cleans; `scheduler.ts` + `maintenance-jobs.ts` + `maintenance-gates.ts` + `maintenance-state.ts` form a *gated, scheduled* maintenance pipeline (gates decide whether each job may run given idle/interval/threshold state). Each of these has dedicated tests — keep them as separate, single-responsibility units.
- `sidecar-worker.ts` runs LLM-backed memory work off the main turn.

**Tools (`src/tools/`)** are the capabilities handed to the coding agent (`bash`, `read`, `write`, `edit`, `attach`, `web_search`/`web_fetch`, skill + config tools). Every filesystem/command/network tool goes through `src/security/` guards: `command-guard.ts`, `path-guard.ts`, `network.ts`, with blocked actions written to the audit logger. `write.ts` is a thin tool wrapper over the shared `write-content.ts` (also used by the sub-agent tool) — that split is deliberate.

**Config & state live outside the repo**, under `APP_HOME_DIR` (`~/.pi/pipiclaw`, overridable via `PIPICLAW_HOME`). Paths are centralized in `src/paths.ts` (`channel.json`, `auth.json`, `models.json`, `settings.json`, `tools.json`, `security.json`, plus `workspace/` and `state/`). `src/index.ts` is the public library barrel; keep its exported names stable when moving code.

## Docs

`docs/` holds the configuration/deployment/security guides and `docs/specs/NNN-*` design specs (one per feature, e.g. `010-memory-maintenance-scheduler`) — the spec for a subsystem is the best context before changing it.

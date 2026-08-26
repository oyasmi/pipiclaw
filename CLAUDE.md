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

## Git

- Write good commit messages: a concise imperative subject line (e.g. `feat: add proxy routing for LLM requests`), optionally followed by a blank line and a body that explains *why* the change was made. Match the existing conventional-commit style (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`, etc.).
- **Never add a `Co-Authored-By:` trailer** (or any similar signature) to commit messages.

## Architecture

Pipiclaw is a long-lived runtime that wraps the `@earendil-works/pi-coding-agent` SDK (a fork of `@mariozechner/pi-coding-agent`) and drives it from DingTalk. The layers below are traversed on every message.

**Transport → agent → delivery flow**
1. `src/runtime/bootstrap.ts` loads config and wires the bot, durable dispatch, task/event/memory services, background jobs, and sub-agent run persistence. `src/main.ts` is intentionally a thin entrypoint that just calls `bootstrap`.
2. `src/runtime/dingtalk.ts` receives Stream-mode events; `src/runtime/delivery.ts` builds the `ChannelContext` (the transport-neutral delivery contract in `src/runtime/channel-context.ts`: `respond`, `respondInThread`, AI Card streaming). The terminal TUI (`src/tui/`) is a second implementation of the same contract.
3. Each channel gets one `ChannelRunner` (`src/agent/channel-runner.ts`), cached by `src/agent/runner-factory.ts`. It assembles the SDK session, tools, memory, roles, and prompt, then streams the turn through the transport-neutral `ChannelContext`.
4. `src/agent/session-events.ts` translates SDK session events into progress/AI-Card updates.

**Concurrency model (important, spans several files)**
- Per channel, turns are serialized by the **`ChannelQueue`** (`src/runtime/channel-queue.ts`, consumed by the DingTalk transport): a channel processes one message at a time while still accepting `/steer`, `/followup`, `/stop` mid-turn. Busy state itself has a single owner: the runner's turn state machine (`TurnPhase` in `src/agent/types.ts`; transports call `beginTurn`/`endTurn`, everything else derives from `isBusy()`/`getTurnStatus()`). `src/agent/run-queue.ts` is a different, per-run queue that serializes *outbound delivery calls* (progress updates to the DingTalk API) within a single turn.
- Memory writes are serialized by **per-channel serial queues** built on `src/shared/serial-queue.ts`. `src/memory/channel-maintenance-queue.ts` exposes a *shared singleton* queue so `lifecycle` and `maintenance-jobs` never race on the same channel's files — do not inline it.
- Config/state files are written via `src/shared/atomic-file.ts` (write-temp-then-rename).

**Delegation (`src/subagents/`)** — workspace roles select internal execution or an external `claude-code` / `codex-cli` / `exec` harness. `SubAgentRunManager` alone owns settlement, usage, leases, persistence, and completion wake; preserve its idempotency flags. External runs are async/detached and daemon-reconciled; TUI has no durable wake/re-adoption. `mutates: write` leases overlapping working directories, and `/stop` does not cancel runs.

**Memory subsystem (`src/memory/`)** — layered, do not flatten:
- Working files per channel: `SESSION.md` (current state), `MEMORY.md` (durable), `HISTORY.md` (summarized older history); `log.jsonl`/`context.jsonl` are cold storage.
- `lifecycle.ts` orchestrates a channel's memory; `recall.ts` retrieves relevant memory for a turn; `consolidation.ts` folds/cleans; `scheduler.ts` + `maintenance-jobs.ts` + `maintenance-gates.ts` + `maintenance-state.ts` form a *gated, scheduled* maintenance pipeline (gates decide whether each job may run given idle/interval/threshold state). Each of these has dedicated tests — keep them as separate, single-responsibility units.
- `sidecar-worker.ts` runs LLM-backed memory work off the main turn.

**Tools (`src/tools/`)** are the capabilities handed to the main agent and internal sub-agents (`bash`, files, web, memory, skills, tasks, events, jobs, delegation). Pipiclaw-owned filesystem/command/network tools go through `src/security/` guards, with blocked actions written to the audit logger. File tools (`read`, `edit`, `write`, `send_media`) go through `src/file-store.ts`'s `FileStore` port straight onto `node:fs`; command tools (`bash`, `grep`) go through `src/executor.ts`'s `Executor`. Both are bound to the same `resolvedPath` `guardPath` returns — a path is resolved once and that value is what actually gets opened, never re-derived (spec 044, D1.1). External agents are separate host processes and bypass those guards: their role command, CLI sandbox, host account, and environment are the real boundary; `mutates` is not a permission control. `write.ts` remains a thin wrapper over shared `write-content.ts`. A tool's parameter set is exactly the fields its one call shape needs — nothing conditionally required by another field's value, nothing a deployer should have decided once instead (spec 046): the long-running task mechanism is five tools (`task_list`/`task_create`/`task_update`/`task_close`/`task_verify`) rather than one `action`-dispatched tool, and delegation is `subagent` (a configured role; no override fields) plus `subagent_inline` (a one-off; carries every field a role file would otherwise supply), gated by `tools.subagentInline.enabled`.

**Config & state live outside the repo**, under `APP_HOME_DIR` (`~/.pipiclaw`, overridable via `PIPICLAW_HOME`). Paths are centralized in `src/paths.ts` (`channel.json`, `auth.json`, `models.json`, `settings.json`, `tools.json`, `security.json`, plus `workspace/` and `state/`). `src/index.ts` is the public library barrel, deliberately minimal (spec 035): it supports embedding the daemon (`bootstrap`, `DingTalkBot`, `ChannelContext`, path constants, `PipiclawSettings`) and nothing else. Keep those names stable; do not add to it — every export there is also a knip blind spot, since it is a knip entry point.

`settings.json` accepts only product intent — booleans, enums, and model references. Numeric thresholds (intervals, budgets, backoffs, confidence bars) are code constants; retired keys are listed in `RETIRED_SETTINGS_KEYS` in `src/settings.ts` and warned about on load.

## Docs

`docs/README.md` is the user-documentation map. Top-level guides and `docs/architecture.md` describe current behavior; `docs/specs/NNN-*` are historical design records that explain earlier decisions but may contain retired paths or contracts. For behavior changes, verify code and tests first, update the relevant top-level guide, and preserve specs as history unless writing a new design record.

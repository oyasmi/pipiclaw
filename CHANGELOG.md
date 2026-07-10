# Changelog

Note: keep this file in sync with `CHANGELOG.zh-CN.md`.

## [0.8.0] - 2026-07-10

### Added

- Task Loop v2 completes the lightweight autonomous-work loop: every driver turn gets a compact Task Capsule (title, state, latest checkpoint, next action, and remaining attempt budget) while the complete Markdown task remains the human-readable source of truth.
- Operator control surface: `/tasks run <id>` resumes and immediately durably queues a task when the DingTalk runtime is available; `/tasks stats [id]` reports attempt, token, cost, wall-time, outcome, and verification facts without consuming an LLM turn.
- `/stop` now durably pauses an in-flight task-driver task before aborting its model turn, preventing an accidental automatic restart after a user halt.
- Added the Task Loop v2 design specification (`docs/specs/024-task-loop-v2`), documenting the at-least-once, bounded-spend contract, state machine, recovery path, and intentional non-goals.

### Changed

- The final v2 flow is explicit and inspectable: wake/event/user run → durable dispatch → bounded driver attempt → atomic checkpoint → continue, wait, verify, pause, or escalate. It remains file-native and single-process rather than becoming a workflow engine.

## [0.7.10] - 2026-07-10

### Added

- Governed task control (P1): validated priority/deadline/next-action, cumulative attempt/token/cost/wall-time budgets, side-effect policy, parent/dependency links, isolation intent, and verification state. The native driver checks hard limits and terminal dependencies without an LLM, records actual run usage, and escalates instead of looping.
- Independent acceptance: task skeletons include Verification; `subagent purpose=verify` runs a read-only checker and persists a body-bound attestation for `task_manage verify`. `done` rejects missing/stale/failed verification, incomplete dependencies/children, and unapproved external actions.
- Explicit external-action approval via `/tasks approve <id>`, handled directly by the runtime with issuer/time audit fields; `task_manage` cannot self-grant it.
- Long-task decomposition and isolation (P2): parent/child and `dependsOn` graphs gate execution/close-out and reject missing/self/cyclic links; `subagent isolation=worktree` creates or reuses task-owned host git worktrees and returns path/branch metadata.
- Native task driver: the DingTalk daemon now deterministically scans channel task ledgers and wakes actionable tasks from `status`/`wake`, so long-running work resumes without a hand-installed heartbeat event, `tasks-pending.mjs`, or paired `.checkin` file. Dispatches skip active channels, round-robin across channels, cap each tick, continue changed ledgers after a short cooldown, and back off unchanged ledgers to prevent token loops.
- `task_manage progress`: atomically appends a Current Cycle checkpoint and updates status/wake/recurrence in one file replacement. The built-in system prompt now teaches the complete task lifecycle whenever the tool is registered.
- `settings.taskDriver` controls the native driver (`enabled`, continuation delay, stalled retry, and per-tick dispatch cap), with conservative defaults and bounded values.
- Task-driver cooldown now keys off semantic task state rather than file mtime: usage/cost accounting no longer makes a no-progress governed task retry at the short continuation interval.
- Added `/tasks pause <id>` and `/tasks resume <id>` for a user-controlled durable stop to autonomous wake-ups.
- Added `task_manage start-cycle` for completed recurring tasks. It archives visible current-cycle notes into History, opens a named cycle, and resets cycle-scoped usage, approval, verification, and worktree state.
- Durable synthetic dispatch: scheduled events and task-driver wakes are first written to `state/dispatch/`, then handed to the in-memory channel queue. A lease protects active work; pending or expired dispatches are replayed after restart, providing intentional at-least-once delivery.
- Past one-shot events now fire once during recovery instead of being silently discarded. Periodic events retain their existing cadence and queue-full behaviour.
- Quality lane: `task_manage candidate` moves checked work into `verifying`; the native driver gives that turn an explicit checker-only instruction instead of another implementation prompt.
- Independent verifier attestations now bind the task body and, on host Git checkouts, a SHA-256 artifact subject covering HEAD, status, staged, and unstaged diffs. Importing or completing a PASS rejects a changed artifact subject.

### Changed

- `/tasks`, task agenda injection, and `/tasks doctor` now surface governance state. `task_manage` adds `verify` and `cancel`, while progress invalidates old verification.
- Task `wake` is now the single normal resume condition. Task-owned one-shot `.checkin` events are legacy: the driver briefly yields to a live checkin during upgrades, `/tasks doctor` recommends removing it, and periodic `.schedule` events remain only for opening recurring cycles.
- Task agenda extraction now reports the last Current Cycle entry instead of the first, so the injected summary reflects actual recent progress rather than the skeleton's creation note.

## [0.7.7] - 2026-07-09

Task ledger hardening: tightened the task/event lifecycle so long-running autonomous work has a clearer, more auditable control surface without adding another concept for users to learn.

### Added

- `task_manage create`: creates a standardized task ledger with frontmatter and the expected `Goal`, `DoD`, `Manual`, `Current Cycle`, and `History` sections, giving the model one canonical starting shape for long tasks.
- `/tasks doctor`: a read-only diagnostics command for DingTalk and the TUI that checks task/event consistency, including malformed frontmatter, archived tasks with live events, orphan task events, missing recurrence schedules, mismatched check-ins, and missing standard ledger sections. Every issue includes an actionable next step.
- Shared task helpers for task event names and task ledger sections, so runtime commands and tools now enforce the same conventions from one implementation.

### Changed

- `task_manage done` now requires a completion `summary` and `evidence`, appends a `Completion Evidence` section to the task ledger, marks the task done, and then archives it. Optional `residualRisk` can be recorded alongside the evidence.
- Recurring task cleanup now preserves only the canonical `task.<channel>.<taskId>.schedule.json` periodic schedule. Lifecycle check-ins and delegated-work polling events are removed when the task is completed, avoiding stale wakeups.
- `/tasks` help, autocomplete, documentation, and task diagnostics now expose the task ledger model more consistently across DingTalk and TUI usage.

## [0.7.6] - 2026-07-09

Toolset enhancement (spec 021): four design kernels — token economy, errors-as-navigation, one entry per class of need, and long tasks that don't block the turn — landed without expanding the tool count, keeping pipiclaw a lean long-running assistant.

### Added

- `grep` tool (T2): regex file-content search with a thin executor layer and heavy JS-side shaping — grouped by file, before=1/after=3 context, 512-char line truncation, per-file match cap (20 multi-file / 200 single-file), 20-files-per-page with `Use skip=N` paging, and empty-result widening hints. `pattern`/`path` go through `shellEscape` and `glob` through regex escaping; `path` is path-guarded. Available to sub-agents for research. Gated by `tools.grep.enabled` (default on).
- Background bash jobs + `job` tool (T3): `bash async:true` launches a command in the executor's world via `nohup` and returns a job id immediately, so a long command (`npm install`, crawls) no longer holds the channel run queue. The `job` tool (op `list`/`poll`/`cancel`) inspects and controls them; `poll` blocks briefly for the first job to finish. Jobs live entirely in shell (host or Docker), state is in-memory and not persisted (prior jobs surface as `lost` after a restart), capped at 5 running per channel with a JS-enforced hard timeout. Main-agent only (sub-agents cannot background). Gated by `tools.jobs.enabled` (default on).
- `read` directory and PDF support (T5): reading a directory returns a depth-2 tree (12 entries per directory, `[+N more]`, `(empty directory)`); reading a `.pdf` runs `pdftotext -layout` through the normal offset/limit/truncate pipeline, degrading gracefully with a next-step hint when the binary is missing or the file is scanned/image-based.
- `web_fetch` caching + pagination (T6): fetched readable text is cached per channel (`sha256(mode\nurl)` key, 15-minute TTL, LRU-capped at 20 files) and `offset`/`limit` page through it without refetching; the truncation footer is an actionable "re-call with offset=Y (served from cache, no refetch)" instruction. Each page re-applies the untrusted-content banner.
- Error-navigation rule in `AGENTS.md` (T1): every tool error or truncation must carry a next-step instruction. Applied to `read` out-of-range/empty offsets, `bash` command-guard blocks, and `session_search` empty results.
- `edit` no-op loop guard and diff echo (T1): three consecutive byte-identical no-op edits escalate to a hard error that tells the model to re-read the anchor rather than widen `oldText`; successful edits now echo a compact (≤40-line) diff in the result so the model rarely needs a verifying re-read.

### Changed

- `memory_save` evolved into `memory_manage` (T4) with ops `save`/`search`/`forget`, net-zero tool count. `search` is a cheap deterministic point-query over distilled `MEMORY.md`/`HISTORY.md` (recall scoring reused, model rerank off); `forget` removes a uniquely-matched entry and refuses ambiguous targets. All writes serialize through the shared channel-maintenance queue, closing the race that direct `edit` of `MEMORY.md` had with background consolidation. Gate key stays `tools.memory.save.enabled` to avoid resetting existing configs.
- `skill_list` and `skill_view` merged into `skill_manage` (T7): one op-style tool (`list`/`view`/`create`/`patch`/`write_file`) instead of three, trimming two prompt-hint lines. Gate stays `tools.skills.manage.enabled`.
- `bash` interceptor (T8): with `tools.bashInterceptor.enabled` (default on), a few unambiguous bare shell forms (`cat <file>`, recursive `grep`/`rg`, `sed -i`/`perl -i`) are steered to their dedicated tool. Runs after the command guard (which always sees the real command) and before rtk; piped/compound commands pass through untouched. Depends on T2.
- The system prompt now instructs the model not to edit or write channel `MEMORY.md`/`HISTORY.md` directly — those files are runtime-managed and must go through `memory_manage`.

### Fixed

- Background jobs: a running job's reported `durationMs` was an absolute epoch timestamp instead of elapsed time, so the `job` tool rendered astronomical durations for in-flight jobs.
- Background jobs: a finished or timed-out job was only reaped when the model happened to call `list`/`poll`/`cancel`, so a job that was never polled held its concurrency slot forever and could eventually block all `async` on a channel. A low-frequency internal sweeper now reconciles running jobs (without waking the channel) and frees their slots.
- `bash` interceptor: the recursive-`grep` rule was not end-anchored, so a legitimate piped recursive grep (`grep -rn foo . | wc -l`) was wrongly blocked. It now excludes pipe/redirect characters and anchors to end of line, matching the `cat`/`rg` rules.
- `grep`: `details.matchCount` counted every match in a paged file rather than the number actually shown, over-reporting when a file's matches were capped.
- `memory_manage` `forget` now writes an audit line (`reason: "user-forget"`, with the removed entry) to the channel maintenance log (`memory-review.jsonl`), so forgets are auditable rather than only recoverable from `.memory-backups/`.

## [0.7.5] - 2026-07-08

### Added

- Task ledger support (spec 019/020): documented the channel-scoped `workspace/<channelId>/tasks/*.md` convention, heartbeat pattern, task/event naming scheme, and operator workflows in `docs/tasks.md`.
- Added the `event_manage` tool so the main agent can create, update, and delete scheduled event files with upfront validation, channel ownership checks, immediate/self-wakeup guardrails, cron frequency limits, preAction command guarding, and atomic writes.
- Added `/tasks` as a read-only command in DingTalk and the TUI, including active task lists, archived task lists, and task detail rendering while preserving per-channel isolation.
- Added deterministic task agenda injection for main-agent turns, controlled by `settings.taskDigest`, so active task frontmatter and titles are available as bounded background context without requiring an LLM-driven task scan.
- Added the `task_manage` tool for structured task frontmatter updates, task listing, and done/archival cleanup, including deletion of related task checkpoint events.

### Changed

- `event_manage` now allows tighter periodic schedules only when a `preAction` gate is present: ungated periodic events keep the 30-minute minimum interval, while gated periodic events may run every 5 minutes for completion-driven polling such as delegated agentmux work.
- Documented task visibility, delegated-work follow-up, and the intended relationship between task files, event checkpoints, and periodic heartbeat sensors.

## [0.7.4] - 2026-07-07

### Added

- rtk command optimizer (`tools.rtk`): an opt-in `bash` integration with [rtk (Rust Token Killer)](https://github.com/rtk-ai/rtk) that rewrites known read-only commands to their token-compact `rtk` equivalents (e.g. `git status` → `rtk git status`) before execution, cutting the output the model has to read. Enabled with a single `tools.rtk.enabled` flag in `tools.json` (default off); rtk owns all the rewrite rules via its `rtk rewrite` contract, so pipiclaw hardcodes none and no operational knobs are exposed. The rewrite runs *after* the command guard, so `command-guard` always inspects the operator's real command; it applies to both the main agent and sub-agent bash; it probes rtk availability through the actual execution environment (host PATH or inside the Docker sandbox) and caches the result per executor; and it is best-effort — any failure (rtk absent, timeout, no equivalent) silently falls back to the original command, so enabling rtk can never make a bash command fail. The decision keys off `rtk rewrite`'s stdout rather than its exit code, since rtk 0.43.0 exits 3 on a successful rewrite despite its `--help` documenting exit 0.

## [0.7.3] - 2026-07-05

### Changed

- Documentation sync after the Windows removal (0.7.1) and the `/status` / `/usage` commands landed: dropped README's obsolete Windows/WSL host-mode section and the dead `PIPICLAW_SHELL` env var, corrected the Node lower bound to `>=22.19.0` (matching `package.json` engines), added `/status` and `/usage` to the README and scaling-doc busy-command tables, and refreshed `CLAUDE.md` (removed the deleted `attach` tool and the stale package-name note) and `configuration.md` (SDK package name, `security.json`, `PIPICLAW_LOG_LEVEL` / `PIPICLAW_LOG_FILE`).

### Removed

- Removed dead code that knip could not see (its `ignoreExportsUsedInFile` setting treats in-file self-references as used): the `createPipiclawBaseTools` helper (superseded by the tool registry) and its public barrel export, `ChannelStore.getLastTimestamp`, the never-emitted `auto_compaction_*` session-event branches (the union is narrowed to the live `compaction_start` / `compaction_end` names), and the legacy `memoryEntries` consolidation fallback that silently coerced the old shape into all-add ops.

### Fixed

- Memory candidate file reads no longer swallow non-ENOENT errors: a permission or IO failure now propagates instead of being treated as an absent file, matching the other memory readers.

### Development

- Deduplicated internal helpers: a shared `readOptionalTextFile` / `isNodeError` (`src/shared/fs-utils.ts`) now backs the memory file readers, `eventNameFromFilename` and `parseUpdateHeadingTimestamp` are single-sourced, and `ChannelStore` reuses the shared `SerialQueue` instead of a hand-rolled write chain.

## [0.7.2] - 2026-07-05

### Added

- Terminal TUI (spec 018): a new `pipiclaw tui` subcommand for chatting with the agent directly in the terminal, reusing the same config, memory, and per-channel session as the DingTalk runtime — with **no DingTalk credentials required**. The TUI shares app services (settings, tools, security, sandbox validation) with the daemon path via `prepareAppServices`, but skips the DingTalk gate, so it runs without a filled-in `channel.json` and never constructs a `DingTalkBot`.
  - On a TTY it renders a full-screen pi-tui frontend (scrollback transcript, status line, streaming progress, slash-command completion); non-TTY input (pipe/redirect) and `--print` fall back to a plain frontend automatically.
  - Flags: `--channel <id>` attaches to any past conversation (e.g. `dm_<staffId>` to share a DingTalk conversation's memory; default `tui_local`); `--print`/`-p` runs a one-shot non-interactive turn (prompt from args or stdin) and exits; `--quiet`/`-q` prints only the final answer; `--plain` forces the plain frontend; `--sandbox=host` (default) or `--sandbox=docker:<name>` selects tool isolation.
  - Resume is implicit and per-channel: re-running with the same `--channel` restores the previous conversation from `context.jsonl` — there is no `/resume` command, and longer-term facts carry across sessions through the memory layer.
  - Slash commands: `/help`, `/new`, `/compact`, `/session`, `/status`, `/model`, `/usage`, `/events`, `/steer`, `/followup`, `/stop`, and `/exit`; a startup welcome banner; and reliable exit on `Ctrl-C` / `Ctrl-D` / `/exit` (memory is flushed before quitting).
  - Output shape is controlled by an optional `tui` block in `settings.json` (`responseMode`), independent of DingTalk's `channel.json.responseMode`.

### Changed

- Refactored `bootstrap.ts` to separate transport-neutral app initialization (`prepareAppServices`) from the DingTalk-specific runtime wiring, so the terminal TUI and the DingTalk daemon share the same config, sandbox, and logging setup without duplicating it.

## [0.7.1] - 2026-07-05

### Added

- Single backup model fallback (spec 017): when the primary model's turn fails on its first API call before any tool runs (the common 429 / quota / auth case, excluding `/stop` and context-overflow), the runtime switches to a configured `fallbackModel` and re-runs the turn once; after a 5-minute cooldown it automatically retries the primary. A failure that surfaces mid-turn (after tools have already run) is reported rather than retried, to avoid corrupting the transcript. Configured via the `fallbackModel` settings key (unset disables it), surfaced on the `/status` `Fallback` line, and recorded as a structured `model_fallback` log event.

### Removed

- Dropped Windows support and its platform-specific complexity: removed `isWindowsPlatform()` and the command/path guard fail-open branches (Windows previously bypassed the security guards entirely), Git Bash shell detection, `PIPICLAW_SHELL`, `taskkill` process killing, `windowsHide` sandbox options, the `toShellPath`/`shellEscapePath` split (collapsed into `shellEscape`), the win32 no-op in secret-file permission hardening, and the associated Windows-only tests and docs sections.

## [0.7.0] - 2026-07-04

### Added

- `edit` gains a `replaceAll` option to replace every occurrence of the target text instead of requiring a unique match.

### Changed

- `bash` now reports a non-zero exit code inline as a normal result instead of raising it as an error, so exit codes from `grep`, `diff`, and `test` are treated as data rather than tool failures.
- Tightened tool input schemas with enum and integer constraints (`skill_manage.action`, `subagent.contextMode`/`memory`, `memory_save.kind`, `session_search.roleFilter`, and the numeric parameters of `read`, `web_search`, `session_search`, and `bash`), so invalid values are rejected at generation time instead of failing during execution.
- `skill_view` now returns raw file content capped by the shared truncation limits instead of unbounded, JSON-escaped text; `skill_list` and `session_search` emit compact JSON.
- Reworked the tool layer around a declarative registry (`src/tools/registry.ts`): the main tool set, the sub-agent tool set, and the system-prompt tool hints are now derived from one source instead of three hand-maintained lists.

### Removed

- Removed the unused `attach` tool; it was never registered and was unsupported in DingTalk mode.

### Fixed

- The system prompt no longer drifts from the actual tool set. With the default config (web tools off) it previously advertised `web_search`/`web_fetch` that were not registered, and it omitted the registered `memory_save`. The `## Tools` section and every tool-specific instruction are now generated from the tools actually registered for the session.
- `bash` truncated-output spill files are now written inside the sandbox through the executor, so the reported "full output" path is reachable by `read`/`bash` under the Docker sandbox (previously a host temp path the model could not open); the un-awaited write stream was also removed.
- `bash` now applies a default 300s timeout when none is provided, so a command that never returns can no longer wedge the channel's run queue until `/stop`.

### Development

- Added spec `015-tool-registry` documenting the registry design and deferred follow-ups (tool middleware/telemetry pipeline, `tools.json` schema-ization, MCP client, `read` line numbers / Read-before-Edit).
- Added contract tests: a cross-layer check keeping the registered tool set and the prompt's tool list in sync, and a tool-registry test covering name uniqueness, hint coverage, main vs sub-agent derivation, and config gating.

## [0.6.10] - 2026-07-03

### Added

- Added `/events` DingTalk transport commands for first-pass scheduled event administration:
  - `/events list` lists event file names, types, target `channelId`, `schedule` / `at`, and text previews, while marking invalid JSON files without hiding them.
  - `/events show <name>` displays the full formatted JSON for an event file.
  - `/events delete <name>` deletes the corresponding `workspace/events/<name>.json` file.
  - `/events history [name]` shows recent event scheduling history from `state/events/history.jsonl`, optionally filtered by event name.
- Added structured event scheduling history at `${PIPICLAW_HOME:-~/.pi/pipiclaw}/state/events/history.jsonl`, recording local-time JSONL entries for event loading, scheduling, triggering, pre-action outcomes, queue results, deletion, invalid files, and cancellation.
- Added a Claude Code guidance document (`CLAUDE.md`) covering development commands, runtime layering, concurrency rules, memory subsystem boundaries, tool/security structure, and documentation entrypoints.

### Changed

- Event file parsing is now shared between `EventsWatcher` and the new `/events` command handler, keeping command output and runtime scheduling validation aligned.
- `/events` is handled entirely in the runtime layer and remains available while a channel is busy, alongside `/stop`, `/steer`, and `/followup`.
- `/new` now returns promptly by running outgoing-session durable memory consolidation in the background while still allowing shutdown and tests to await the detached work.
- Updated README, AGENTS, and event documentation to reflect current package scope, runtime domains, app-level config files, `session_search`, workspace skill management, and the new event administration command.
- Tightened the test suite by removing a slow duplicate `/new` runtime test and moving the session-id assertion to the lighter command-extension test.

### Fixed

- Fixed `extractToolResultText(undefined)` so progress formatting always returns a string instead of leaking the `undefined` return value from `JSON.stringify`.

### Development

- Added `knip` dead-code checking to the standard `npm run check` gate and enabled TypeScript unused-symbol checks in `tsconfig.json`.
- Removed unused exports and pre-existing lint issues found by the new dead-code and unused-symbol checks.
- Added focused `progress-formatter` and `event-commands` tests, plus DingTalk/runtime coverage for `/events` command routing.

## [0.6.9] - 2026-06-24

### Security

- Closed three command-guard bypasses that let dangerous commands evade the deny rules:
  - `allowPatterns` now match per command atom with word-boundary anchoring instead of a whole-command substring test, so an allowed fragment can no longer whitelist a chained dangerous command (e.g. `git status; rm -rf /`).
  - The guard now recurses into shell script bodies passed via `-c` (`sh`/`bash`/`zsh`/`dash`/`ash`/`ksh`, including combined flags like `-lc`), so content such as `bash -c "rm -rf /"` is inspected.
  - The guard now unwraps wrapper commands (`xargs`, `env`, `time`, `nice`, `timeout`, `nohup`, `find -exec`/`-execdir`, etc.) and guards the inner command, so `xargs rm -rf /` or `find . -exec shred {} ;` are blocked. Recursion is depth-limited.

### Changed

- Upgraded the pi dependency set from `0.75.5` to `0.80.2`, including `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-coding-agent`.
- Updated Pipiclaw's pi integration for the `0.80.x` API split by reading built-in models from `@earendil-works/pi-ai/providers/all` and adding the project-trust methods expected by the new resource loader.
- Changed the project license from Apache License 2.0 to GNU Affero General Public License v3.0.

### Fixed

- `/stop` now drops queued-but-not-started messages for the channel in addition to aborting the in-flight run, so a burst of messages no longer keeps running after the user asks to halt.
- The delivery layer now archives a final response only after it is confirmed delivered, so the conversation log no longer claims the bot answered when the send failed.
- When the event queue is full, one-shot/immediate events are no longer silently dropped: the source file is preserved and a `.error.txt` marker records the loss. Periodic events are unaffected (they fire again on the next tick).
- DingTalk AI Card creation is now singleflighted per channel, eliminating a race where card warmup and the first progress update could both create a card.
- The busy-routing race is closed: a channel's running state is now set synchronously at dispatch, so a second message arriving in the same tick is correctly routed as a steer/follow-up instead of starting a fresh run.
- Shutdown memory consolidation now also persists tool-only sessions that produced durable activity without a final assistant turn (previously skipped).

## [0.6.8] - 2026-05-26

### Added

- `/session` command now shows the actual model that responded when an auto-routing provider (e.g. OpenRouter, Cloudflare AI Gateway) resolves to a different model than the one configured; the runtime also logs the actual model at the end of each run.
- Edit tool result now includes a standard unified `patch` field alongside the existing custom `diff`, making the output directly usable by diff-rendering consumers.

### Changed

- Upgraded pi dependency scope from `@mariozechner/pi-*` to `@earendil-works/pi-*` and bumped the version from `0.70.2` to `0.75.5` (upstream renamed the package scope at `0.74.0`). All public API symbols used by Pipiclaw are unchanged across the version range.
- Raised the minimum Node.js engine requirement from `>=22.0.0` to `>=22.19.0` to match the hard minimum introduced in pi `0.75.0`.

## [0.6.7] - 2026-05-26

### Added

- Added `responseMode` in `channel.json` with three values: `full_progress_then_plain_final` (default), `rolling_progress_then_plain_final`, and `final_card_only`. The mode derives two orthogonal traits (progress style and final-delivery target) so the runtime no longer branches on the raw enum string.
- Added `cardAutoLayout` in `channel.json` (default `true`) as a user-facing wide-card toggle for DingTalk AI Cards.

### Changed

- In `final_card_only` mode, runtime now suppresses intermediate process output (`tool`/`thinking`/compaction/retry/error progress) and renders only the final answer on AI Card in a single-stream flow.

### Removed

- Removed the `progressDisplay` channel option and the legacy `responseMode: "progress_then_plain_final"` alias; both are now rejected at startup.

### Fixed

- Fixed DingTalk wide-card parameter delivery by switching AI Card creation payloads to `cardData.cardParamMap.sys_full_json_obj` with `{"config":{"autoLayout":...}}`, matching DingTalk's documented interface behavior.
- Fixed `final_card_only` mode leaking intermediate assistant text as card progress; progress writes are now fully suppressed (also guarded at the delivery layer) so only the final answer reaches the card.
- Fixed DingTalk reconnection getting permanently stuck after a transient disconnect. The reconnect backoff sleep shared a single timer field with the reconnect scheduler, so a WebSocket `close` event arriving during the backoff would clear the sleep timer and leave `isReconnecting` wedged at `true` forever, blocking all future reconnect attempts. The backoff sleep now uses a dedicated timer, `scheduleReconnect` no longer preempts an in-flight attempt, and the `>90s` connection-timeout watchdog now proactively forces a reconnect instead of only logging.

## [0.6.6] - 2026-04-27

### Changed

- Upgraded the pi-mono dependency set to `0.70.2`, including `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, and `@mariozechner/pi-coding-agent`.
- Migrated custom tool schemas from `@sinclair/typebox` to `typebox` 1.x for compatibility with the updated pi tool validation path.
- Updated channel session replacement handling to use the new `AgentSessionRuntime` flow for `/new`, fork, and session switch operations.

### Fixed

- Fixed a race where busy-window follow-up messages could be lost or incorrectly queued after the active task had already stopped; late follow-ups are now requeued as normal work.
- Moved `/new` command follow-up messaging onto the replacement-session context so new-session confirmations keep working after pi invalidates stale pre-replacement extension contexts.
- Migrated memory boundary tracking from the removed `session_switch` extension event to the current `session_start` event model.

## [0.6.5] - 2026-04-20

### Added

- Added `busyMessageDefault` in `channel.json` so DingTalk bots can choose whether plain messages received during an active task default to `steer` or `followUp`; the config also accepts `followup` as a lowercase alias and rejects invalid explicit values during startup.
- Added `progressDisplay` in `channel.json`; `rolling` mode keeps AI Card progress compact by showing only recent entries while a task runs and replacing the progress card with a short completion summary after the final response is sent.

## [0.6.4] - 2026-04-19

### Added

- **Memory Growth and Recall Engine**: a comprehensive upgrade to Pipiclaw's long-term and procedural memory
  - **Session Search**: New `session_search` tool enabling the agent to search through cold-storage channel transcripts (`context.jsonl` and `log.jsonl`) to retrieve historical details
  - **Post-Turn Review**: A dedicated background pipeline that evaluates turns for durable facts and procedural workflows, separating smart memory extraction from basic session maintenance
  - **Procedural Memory (Skills)**: Agents can now actively create, patch, and manage workspace skills using new `skill_manage`, `skill_list`, and `skill_view` tools
  - **Memory Audit Log**: Decisions on memory promotion, suggestion, and discarding are now transparently logged to `memory-review.jsonl` with automatic 1MB rotation
- **Memory Maintenance Scheduler**: an internal scheduler now batches memory upkeep outside the user-facing turn path
  - Adds hidden per-channel scheduler state under `${PIPICLAW_HOME}/state/memory/` for dirty flags, run timestamps, thresholds, and failure backoff
  - Adds scheduled jobs for session refresh, durable consolidation, growth review, and structural cleanup/folding
  - Adds local no-LLM gates for every scheduled job, so clean, active, under-threshold, or backoff channels skip without spending model tokens
  - Keeps memory maintenance internal instead of exposing it through `workspace/events/` or synthetic DingTalk turns

### Changed

- Hardened memory file boundaries: `MEMORY.md` is now strictly for durable facts and decisions, preventing transient task states from polluting long-term memory
- Normal turns now only mark memory activity and counters; session refresh, durable consolidation, post-turn growth review, cleanup, and history folding move to scheduled maintenance
- `HISTORY.md` remains focused on boundary summaries from compaction, `/new`, and shutdown, while scheduled durable consolidation only writes durable channel memory
- Memory recall reranking now defaults to `"auto"`, using local scoring when confidence is high and reserving model rerank for ambiguous memory-sensitive queries
- `session_search` model summaries remain disabled by default and now skip LLM summarization for empty queries, no-result searches, and short previews
- Accelerated intra-turn session transcript searches with a 30-second TTL corpus cache
- `memoryGrowth.minSkillAutoWriteConfidence` now honors stricter user overrides while enforcing a `0.9` safety floor for workspace skill auto-writes
- Cleaned up obsolete pre-scheduler memory lifecycle wiring and removed the retired `runBackgroundMaintenance` wrapper from the public API
- `skill_list` now uses async filesystem APIs, matching the other workspace skill tools

### Fixed

- Strengthened skill execution security with expanded patterns to block prompt injection variants, `wget` pipe-to-shell, `dd`, `mkfs`, and credential file scanning
- Hardened memory extraction JSON parsing to gracefully handle LLM-generated markdown code fences
- Resolved a timestamp drift race condition that could leak temporary files during atomic memory and skill writes
- Constrained channel session corpus loading to a maximum of 5000 turns to safeguard host memory limits
- Removed obsolete lifecycle tests for the retired idle timer and refreshed memory tests around the new scheduled-maintenance model
- Fixed scheduler channel selection so active channels no longer consume the only per-tick maintenance slot when other channels are eligible
- Fixed duplicate `context.jsonl` processing in `session_search` corpus building
- Fixed review log rotation so the entry that triggers rotation remains in the active log
- Centralized memory and skill atomic writes with temp-file cleanup on failure, and centralized memory-side serial queues
- Updated the session-memory E2E test to exercise scheduled `SESSION.md` refresh through the internal memory scheduler


## [0.6.3] - 2026-04-14

### Added

- CLI now supports `--version`, printing the current Pipiclaw version and exiting immediately
- Runtime documentation now includes clearer scaling, concurrency, and DingTalk Stream reconnect guidance for long-lived deployments

### Changed

- Build and runtime dependencies were trimmed by removing redundant packages and replacing `chalk`/`shx` usage with built-in Node.js capabilities, reducing install size and lockfile churn

### Fixed

- DingTalk Stream reconnect handling now uses Pipiclaw as the single reconnect owner, disabling SDK auto-reconnect to avoid competing reconnect loops
- Stream socket cleanup is now deterministic during reconnect and shutdown, with forced termination for stale sockets that do not close cleanly
- Hanging DingTalk Stream connect attempts now time out instead of wedging the reconnect loop indefinitely under unstable network conditions

## [0.6.2] - 2026-04-11

### Added

- New reference documentation comparing Pipiclaw with Hermes and capturing lessons learned from the Hermes runtime
- Archived code review bugfix spec documenting the 2026-04-11 review findings, decisions, and applied fixes

### Fixed

- Event `preAction` commands now execute through the configured sandbox executor instead of running directly on the host, so scheduled events follow the same host or Docker isolation rules as normal tool execution
- `MEMORY.md` and `HISTORY.md` updates are now serialized through a dedicated durable-memory queue, and atomic writes use unique temp files to avoid concurrent write races during consolidation and background maintenance
- The `read` tool now reports total line counts and line window boundaries correctly for empty files and files with or without trailing newlines
- SDK compatibility getters for compaction settings now honor user-configured reserve and keep-recent token values instead of falling back to hardcoded defaults

## [0.6.1] - 2026-04-10

### Added

- Event files now support a `preAction` command gate so scheduled jobs can deterministically skip runs before enqueuing an LLM session
- Preventive context compaction now runs ahead of oversized incoming prompts and queued steer or follow-up messages when projected context usage is too high

### Changed

- Memory recall candidate loading now uses file-aware caching and keeps a tighter history shortlist, improving recall performance on long-lived channels
- DingTalk AI Card streaming now appends deltas instead of replaying the full transcript on every update, with better warmup and finalization behavior
- Compaction progress and failure reporting now surface clearer runtime feedback, including explicit recovery details when compaction contributes to a run failure

### Fixed

- `/new` and related session command bindings now stay wired correctly inside the channel runner
- Background memory maintenance now gets more time to finish, reducing false failures during compaction-heavy runs

## [0.6.0] - 2026-04-07

### Added

- Bootstrap-time diagnostics for invalid `settings.json`, `tools.json`, and `security.json` values, including field-level warnings for malformed tool and security settings

### Changed

- Memory session and consolidation sidecar updates now retry transient failures instead of failing immediately on the first timeout or aborted worker run
- Runtime recovery and config reload handling was hardened across DingTalk delivery, scheduled events, settings, security, and web tool configuration
- Invalid scheduled event files now leave `.error.txt` markers with parse or schedule details instead of disappearing without explanation
- DingTalk AI Card delivery now warms cards earlier for interactive runs and cleans up card state more predictably on stop, abort, and final response paths

### Fixed

- Windows command and path guards now apply platform-specific handling correctly, including bootstrap wiring for security config in runtime and test harnesses

## [0.5.9] - 2026-04-06

### Changed

- Version bump release to publish the latest web tools and runtime fixes under `0.5.9`

## [0.5.8] - 2026-04-06

### Added

- Built-in `web_search` and `web_fetch` tools with provider-based search, HTML/JSON/text/image fetch handling, and SSRF-aware request validation
- New `tools.json` configuration entrypoint for built-in tool settings, including `tools.web` provider, proxy, and fetch behavior controls
- Network guard support in `security.json` for web requests, including host/CIDR allowlists and redirect limits
- Prompt, main tool registry, and sub-agent integration for the new web tools
- Dedicated design and implementation specs for the web tools rollout

### Changed

- Windows shell execution now respects a POSIX shell path instead of forcing `cmd`, and hides flashing console windows during tool execution
- DingTalk runtime and web tools now respect standard proxy environment variables by default; the old `DINGTALK_FORCE_PROXY` behavior was removed
- Default bootstrap `tools.json` template now starts with web tools disabled and includes Brave plus proxy examples for first-time setup

### Fixed

- `web_fetch` now suppresses noisy `jsdom` stylesheet parse warnings so malformed inline CSS does not pollute runtime logs while content extraction still succeeds

## [0.5.7] - 2026-04-05

### Changed

- `/model` now supports unique substring matching against full `provider/modelId` references, in addition to exact `provider/modelId` and exact bare `modelId`
- README and docs were updated to document the new `/model` matching behavior and examples such as `/model turbo`

## [0.5.6] - 2026-04-05

### Fixed

- Path guard realpath handling on macOS so workspace, home, and temp path checks behave correctly when the filesystem resolves through `/private/...`
- Temporary directory detection so macOS runtime temp paths are treated consistently by the file safety layer

## [0.5.5] - 2026-04-05

### Added

- Runtime-level end-to-end test harness that drives the real runtime with a mocked DingTalk transport
- Tool-level security guards for `bash`, `read`, `write`, `edit`, and related file operations, including audit logging hooks

### Changed

- Shutdown flushing and write piping behavior made more robust during runtime teardown
- Group chat channel directory naming normalized for safer and more predictable persistence paths

### Fixed

- Import ordering issue that was blocking `npm run check`

## [0.5.4] - 2026-04-03

### Changed

- Reorganized `src/` around the existing domain boundaries, moving agent, memory, model, and settings code into their respective modules
- Removed the root-level `src/agent.ts` compatibility shim and updated imports to reference `src/agent/` directly
- Upgraded GitHub Actions workflows to newer `actions/checkout` and `actions/setup-node` releases, and switched release publishing to `gh release create`

## [0.5.3] - 2026-04-03

### Added

- User-facing configuration guide for DingTalk, models/providers, settings, and workspace files
- Dedicated guide for scheduled events and predefined sub-agents
- Dedicated deployment and operations guide covering long-running setup, logs, upgrades, and backups
- README quickstart path for AI agents, with a copy-paste installation and setup prompt

### Changed

- README restructured around two primary onboarding paths: `For AI Agent` and `For Human`
- README and configuration docs now recommend configuring AI Card for normal use, while still documenting a fallback path for first-time troubleshooting
- npm publish contents now exclude `docs/`, `docs/specs/`, `test/`, and `CHANGELOG.md`
- Publish builds no longer emit `.js.map` and `.d.ts.map` files, significantly reducing package size

### Fixed

- Biome import ordering issue in `src/agent/channel-runner.ts`

## [0.5.2] - 2026-04-02

### Added

- Agents usage guide and expanded memory design documentation
- First-turn memory bootstrap refinements for better initial context loading

### Changed

- Memory pipeline made non-blocking so consolidation and refresh work no longer stall the main session path
- Runtime foundations refactored into clearer domain modules, including bootstrap extraction and source tree reorganization
- Memory lifecycle and recall quality improved, including better first-turn bootstrap behavior and more robust runtime maintenance
- Sub-agent configuration parsing improved to handle YAML arrays and numeric frontmatter values more reliably

### Fixed

- Lint blockers and formatting inconsistencies across runtime, memory, and sub-agent modules

## [0.5.1] - 2026-04-01

Note: no `v0.5.0` git tag exists in this repository; the changes leading up to the `0.5.0` release are grouped here with `0.5.1`.

### Added

- Channel-level memory model with runtime-managed `SESSION.md`, `MEMORY.md`, and `HISTORY.md`
- Relevant memory recall pipeline for injecting a small amount of useful prior context into active turns
- Contextual sub-agent memory injection so sub-agents can receive bounded session and memory context
- Expanded standalone test coverage for delivery, DingTalk, and memory flows

### Changed

- Memory and recall behavior refined to work as a cohesive runtime pipeline rather than ad hoc prompt injection
- Standalone repository test coverage baseline expanded in preparation for the `0.5.x` release line

## [0.4.0] - 2026-03-31

### Added

- Initial standalone Pipiclaw npm package and CLI repository
- User-facing README improvements and release workflow scaffolding for independent package publishing

### Changed

- Package metadata, Node.js support declaration, and CI matrix updated for the standalone release

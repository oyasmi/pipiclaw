# Changelog

Note: keep this file in sync with `CHANGELOG.zh-CN.md`.

## [Unreleased]

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

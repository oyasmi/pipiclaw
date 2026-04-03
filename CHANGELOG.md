# Changelog

## [Unreleased]

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

- Initial implementation of pipiclaw package
- Standalone npm project scaffolding for the independent Pipiclaw repository
- Memory management guidelines in system prompt
- MEMORY.md size warning (> 5000 chars prompts Agent to consolidate)
- log.jsonl rotation (> 1MB archived to .1)
- Periodic memory consolidation event template in README
- DingTalk channel now intercepts `/help`, `/new`, `/compact`, `/session`, and `/model` as built-in slash commands instead of sending them to the LLM
- DingTalk channel now supports busy-time steering controls: plain messages default to steer, and `/steer`, `/followup`, and `/stop` are handled directly while a task is running
- Channel-level `HISTORY.md` for runtime-managed summarized history
- Runtime memory consolidation pipeline for channel `MEMORY.md` and `HISTORY.md`

### Changed

- `syncLogToSessionManager` uses byte-offset incremental reads instead of full file scan
- `syncLogToSessionManager` uses timestamp-based dedup instead of text matching (fixes duplicate-text-drop bug)
- Shared `shellEscape` utility replaces 4 duplicated definitions
- `attachTool` uses factory function instead of module-level global state
- Debug file (`last_prompt.json`) gated behind `PIPICLAW_DEBUG` env var
- Markdown detection regex is more conservative (no longer triggers on plain multi-line text)
- DingTalk reconnection logic auto-retries with exponential backoff on failure
- Message dedup uses `Set` with FIFO eviction instead of `O(n)` array scan
- Replaced inline `await import("axios")` with top-level import
- Refactored DingTalk delivery into an explicit progress/final lifecycle so AI Cards only show process output and final answers are sent as standalone Markdown messages
- Final answer emission now keys off agent turn completion instead of every assistant `message_end`, avoiding intermediate assistant text being sent as the final reply
- Conversation metadata is persisted per channel so scheduled events and proactive sends continue to work after process restarts
- Package, CLI, and data directory renamed to `pipiclaw`, `@oyasmi/pipiclaw`, and `~/.pi/pipiclaw/`
- Pipiclaw now bootstraps `channel.json`, `auth.json`, `models.json`, `settings.json`, and the workspace skeleton automatically on first start
- Auto-generated `models.json` now starts as an empty valid config, and `SOUL.md` / `AGENTS.md` are guidance templates instead of prefilled behavior
- Global pipiclaw settings now live in `~/.pi/pipiclaw/settings.json`, and saved default models are restored on restart
- DingTalk channel configuration is now read from `~/.pi/pipiclaw/channel.json`
- Workspace `SOUL.md` and `AGENTS.md` now load only at session start instead of every turn
- Workspace and channel memory files are no longer injected into the system prompt by default
- `log.jsonl` and `context.jsonl` are now treated as cold raw storage and are no longer proactively scanned for memory/context loading
- Channel memory consolidation now hooks into AgentSession compaction and session-switch lifecycle without replacing AgentSession auto-compaction
- Session commands and prompt loading now run through pi extension/resource hooks instead of parallel pipiclaw-specific prompt plumbing
- Pipiclaw now reloads AgentSession resources before the first turn so `SOUL.md`, `AGENTS.md`, and skill summaries apply immediately
- Workspace `SOUL.md` now appends to the default pi system prompt instead of replacing the pi base prompt
- Channel directories now create `MEMORY.md` and `HISTORY.md` immediately when the channel state is initialized
- Workspace and channel memory templates are now structured around stable shared context instead of placeholder comments only
- Sub-agent frontmatter parsing now accepts native YAML arrays and numeric values instead of assuming every field is a string
- Pipiclaw no longer relies on the pi-mono monorepo build configuration and now ships with its own standalone TypeScript, test, lint, and CI setup

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

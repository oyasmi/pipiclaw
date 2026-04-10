# Code Review Task: pipiclaw Deep Analysis

## Objective

Perform a thorough code review of the **pipiclaw** project (`~/projects/pipiclaw`) and produce a detailed review document with actionable optimization suggestions for design and implementation.

## Project Overview

- **Name**: @oyasmi/pipiclaw (v0.6.0)
- **Description**: An AI assistant runtime for coding and team workflows, with DingTalk AI Cards, sub-agents, memory, and scheduled events.
- **Scale**: 72 TypeScript source files, 65 test files
- **Tech stack**: TypeScript, Node.js, Biome (linter/formatter), Vitest (testing)

## Source Code Structure

Key directories under `src/`:
- `agent/` — Agent runner, session management, prompt building, context budgeting, command handling
- `memory/` — Memory management (workspace, channel, session)
- `models/` — LLM model configuration
- `runtime/` — Core runtime: bootstrap, event processing, DingTalk integration, delivery, store
- `security/` — Path guards, command guards, network security, config security, platform checks
- `shared/` — Shared utilities (config diagnostics, text utils, LLM JSON parsing, type guards, markdown sections, shell escape)
- `subagents/` — Sub-agent tool implementation, discovery
- `tools/` — Tool implementations (bash, read, write, edit, web-search, web-fetch, attach, etc.)
- `web/` — Web client, search providers, content extraction, fetch

## Review Scope

Please review the following areas **in depth**:

### 1. Architecture & Design
- Overall module organization and dependency graph
- Separation of concerns between agent/runtime/security/tools
- Event-driven design patterns (events system, session events)
- Sub-agent isolation and lifecycle management
- Memory system design (workspace/session/channel layers)

### 2. Code Quality
- TypeScript type safety (any usage, type assertions, missing type narrowing)
- Error handling patterns (are errors properly caught, categorized, propagated?)
- Async/await patterns (unhandled promise rejections, missing error boundaries)
- Code duplication or near-duplication across modules
- Dead code or unused exports

### 3. Performance & Scalability
- Context budgeting and token management
- File I/O patterns (unnecessary reads, missing caching)
- Concurrency handling (run queue, parallel tool execution)
- Memory footprint considerations for long-running sessions

### 4. Security
- Path traversal protections in path-guard
- Command injection prevention in command-guard
- Network security boundaries
- Input validation and sanitization across tools
- Credential/secret handling

### 5. Reliability & Resilience
- Graceful degradation when LLM calls fail
- Session persistence and recovery
- Rate limiting and backpressure
- Resource cleanup on errors/shutdown

### 6. Testing
- Test coverage gaps (which critical paths lack tests?)
- Test quality (are tests testing behavior or implementation?)
- Edge case coverage

## Output Format

Write the review to: `~/projects/pipiclaw/docs/code-review-2026-04-11.md`

Structure:
1. **Executive Summary** — Top 3-5 most impactful findings
2. **Architecture Assessment** — Overall design strengths and weaknesses
3. **Detailed Findings** — Grouped by the categories above, each with:
   - Severity (Critical / High / Medium / Low)
   - Location (file path, function name)
   - Description of the issue
   - Concrete suggestion (code-level if possible)
4. **Quick Wins** — Low-effort, high-impact fixes that can be done immediately
5. **Medium-term Improvements** — Larger refactors or new patterns worth considering

## Process

1. Start by reading `README.md`, `AGENTS.md`, and `package.json` for context
2. Study the entry points: `src/main.ts`, `src/index.ts`
3. Review `src/runtime/` (bootstrap, events, delivery, store) as the core runtime
4. Review `src/agent/` (runner, prompt-builder, context-budget, session management)
5. Review `src/security/` (all guard modules)
6. Review `src/tools/` (each tool implementation)
7. Review `src/memory/`, `src/models/`, `src/subagents/`, `src/shared/`
8. Review `src/web/` (search, fetch, extraction)
9. Skim tests in `test/` for coverage gaps
10. Write the comprehensive review document

Be specific. Reference exact file paths, line numbers, and code snippets. Prioritize actionable suggestions over vague observations.

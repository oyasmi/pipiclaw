# Pipiclaw Memory Model RFC

## Status

Draft

## Goals

1. Define a minimal memory model for `pipiclaw` aligned with the `nanobot` style.
2. Make memory flow explicit: record, read, consolidate, and reuse.
3. Keep raw transport/session files cold and separate from memory.
4. Limit what is loaded into session context by default.
5. Preserve simple file-based operations and avoid introducing a dedicated memory database or memory-specific tools.

## Non-Goals

1. No OpenClaw-style vector retrieval, embedding index, or memory plugins.
2. No `memory_search` or `memory_get` tool.
3. No automatic runtime mutation of workspace-level `MEMORY.md`, `SOUL.md`, or `AGENTS.md`.
4. No automatic loading or scanning of `log.jsonl` or `context.jsonl` as part of memory behavior.

## Design Summary

Pipiclaw memory is split into two channel-level files plus one workspace-level admin file:

- `workspace/MEMORY.md`
  - Stable, admin-managed, shared background memory.
  - Not automatically updated by runtime consolidation.
- `<channel>/MEMORY.md`
  - Durable channel memory.
  - Updated automatically by consolidation.
  - May also be updated manually by the agent.
- `<channel>/HISTORY.md`
  - Channel history summaries.
  - Updated automatically by consolidation only.
  - Not intended for direct manual maintenance by the agent.

Raw storage remains separate:

- `<channel>/log.jsonl`
  - Raw message log only.
  - Cold storage.
  - Not proactively loaded or scanned by runtime.
- `<channel>/context.jsonl`
  - Raw session persistence only.
  - Cold storage.
  - Not proactively loaded or scanned by runtime for memory purposes.

## File Model

### Workspace-Level Files

- `SOUL.md`
  - Loaded into session context at session start.
  - Read-only from the agent's perspective unless a human explicitly changes it.
- `AGENTS.md`
  - Loaded into session context at session start.
  - Read-only from the agent's perspective unless a human explicitly changes it.
- `MEMORY.md`
  - Not loaded by default.
  - Listed in the system prompt with its role and path.
  - Intended to be read on demand by the agent.
  - Stable and admin-managed.

### Channel-Level Files

- `MEMORY.md`
  - Not loaded by default.
  - Listed in the system prompt with its role and path.
  - Intended to be read on demand by the agent.
  - Primary durable memory for the channel.
- `HISTORY.md`
  - Not loaded by default.
  - Listed in the system prompt with its role and path.
  - Intended to be read on demand by the agent.
  - Append-oriented summary history for older context.
- `log.jsonl`
  - Raw archive only.
  - Not memory.
  - Runtime must not proactively load or scan it.
- `context.jsonl`
  - Raw session archive only.
  - Not memory.
  - Runtime must not proactively load or scan it.

## Default Context Loading

At session start, runtime loads the following into session context:

1. Workspace-level `SOUL.md`
2. Workspace-level `AGENTS.md`
3. Built-in tool descriptions
4. Summaries of both workspace-level and channel-level skills

At session start, runtime does not load the following by default:

1. Workspace-level `MEMORY.md`
2. Channel-level `MEMORY.md`
3. Channel-level `HISTORY.md`
4. `<channel>/log.jsonl`
5. `<channel>/context.jsonl`

The system prompt must explicitly tell the agent:

1. Where `workspace/MEMORY.md`, `<channel>/MEMORY.md`, and `<channel>/HISTORY.md` live.
2. What each file is for.
3. That these files are not preloaded.
4. That the agent is encouraged to read them on demand when memory or history is relevant.

Changes to workspace-level `SOUL.md` and `AGENTS.md` take effect on new sessions. They are not reloaded on every turn.

## Agent Read/Write Rules

### Reads

The agent should prefer:

1. `<channel>/MEMORY.md` for durable channel facts, decisions, preferences, and ongoing state.
2. `<channel>/HISTORY.md` for older summarized context.
3. `workspace/MEMORY.md` for stable shared background.

The agent should not treat `log.jsonl` or `context.jsonl` as normal memory sources. Those files are for raw recovery, debugging, or explicit transcript-level investigation only.

### Writes

The agent may:

1. Read `workspace/MEMORY.md`
2. Read `<channel>/MEMORY.md`
3. Read `<channel>/HISTORY.md`
4. Manually update `<channel>/MEMORY.md` when necessary

The agent should not manually maintain `<channel>/HISTORY.md` during normal operation. `HISTORY.md` is runtime-managed.

The runtime must never automatically update:

1. `workspace/SOUL.md`
2. `workspace/AGENTS.md`
3. `workspace/MEMORY.md`

## Consolidation

Consolidation is the primary mechanism that keeps memory moving.

Consolidation takes recent session material and produces two outputs:

1. Durable facts and live channel state in `<channel>/MEMORY.md`
2. Older summarized history in `<channel>/HISTORY.md`

Consolidation must not write to workspace-level `MEMORY.md`.

### Trigger Model

Runtime should run consolidation automatically only when a session is about to compact or trim context.

There is no separate turn-count trigger, token-watermark trigger, or per-turn memory-dirty trigger in this RFC.

### Consolidation Input

Consolidation operates on recent session material already in the active session state. It does not scan `log.jsonl` or `context.jsonl`.

### Consolidation Output Rules

`<channel>/MEMORY.md` should contain:

1. Durable facts about the channel, user, project, preferences, constraints, and long-lived open threads.
2. Current state that matters across turns.
3. Cleaned and deduplicated entries.
4. Structured sections rather than free-form prose.

`<channel>/HISTORY.md` should contain:

1. Append-oriented summaries of older conversation chunks.
2. Resolved decisions and notable milestones.
3. Enough context for later recovery without replaying raw transcripts.

### Consolidation Semantics

Consolidation should:

1. Extract durable facts from recent session material.
2. Append new channel-memory entries into `<channel>/MEMORY.md` during normal operation.
3. Periodically clean up `<channel>/MEMORY.md` with a larger sweep that removes outdated entries, merges duplicates, and tightens wording.
4. Append or roll forward summarized older material into `<channel>/HISTORY.md`.
5. Periodically fold older `HISTORY.md` blocks into coarser summaries while keeping newer blocks more detailed.
6. Remove redundancy between the two files.
7. Prefer stable facts in `MEMORY.md` and narrative progression in `HISTORY.md`.

This RFC adopts an append-first strategy for `MEMORY.md`, with periodic cleanup passes rather than full rewrite on every consolidation.

Consolidation should not:

1. Dump raw message transcripts into `HISTORY.md`
2. Copy large blocks from `context.jsonl` or `log.jsonl`
3. Preserve outdated facts just because they were once true

## Suggested File Semantics

`<channel>/MEMORY.md` should be organized as stable sections such as:

1. `## Identity / Participants`
2. `## Preferences`
3. `## Ongoing Work`
4. `## Constraints`
5. `## Decisions`
6. `## Open Loops`

`<channel>/HISTORY.md` should be organized as chronological summary blocks such as:

1. Dated headings
2. Short summaries of work periods
3. Key decisions and outcomes

Exact formatting can evolve, but the split between durable memory and summarized history should remain stable.

## Consolidation Execution Model

Consolidation uses a two-phase execution model:

1. Inline phase
   - Runs synchronously when a compaction or trim is about to happen.
   - Responsible for producing the minimum safe memory updates needed before context is reduced.
2. Background phase
   - Runs later as a per-channel queued maintenance pass.
   - Responsible for larger cleanup work, including `MEMORY.md` cleanup sweeps and `HISTORY.md` folding.

The background phase must not replace the inline phase for compaction safety. It is an additional maintenance pass, not the primary durability guarantee.

## Compaction And Trimming Contract

Consolidation is hard-gated before compaction or trim.

This means:

1. If a compaction or trim would discard context, runtime must first run inline consolidation.
2. If inline consolidation fails, compaction or trim must not proceed.
3. After successful inline consolidation, the runtime may compact or trim.

This RFC does not allow trim-first or compact-first behavior when memory durability depends on consolidation.

## Runtime Responsibilities

Runtime is responsible for:

1. Loading only the default context described in this RFC.
2. Exposing file locations and roles clearly in the system prompt.
3. Running automatic consolidation.
4. Updating `<channel>/MEMORY.md` and `<channel>/HISTORY.md` during consolidation.
5. Keeping `log.jsonl` and `context.jsonl` cold.

Runtime is not responsible for:

1. Auto-loading memory files into every turn
2. Indexing memory into a vector database
3. Providing special memory-only tools

## Session Model

Session context is warm.

Memory files are warm-on-demand.

`log.jsonl` and `context.jsonl` are cold.

The intended flow is:

1. Session starts with `SOUL.md`, `AGENTS.md`, built-in tool descriptions, and skill summaries.
2. Agent reads channel or workspace memory files if the task needs them.
3. Conversation progresses in session state.
4. Runtime consolidates session material into `<channel>/MEMORY.md` and `<channel>/HISTORY.md`.
5. Older raw storage remains available but is not part of ordinary memory behavior.

## Migration Impact

This RFC implies the following behavior changes from the current implementation:

1. `workspace/MEMORY.md` and `<channel>/MEMORY.md` are no longer injected into the system prompt by default.
2. `SOUL.md` and `AGENTS.md` are no longer reloaded on every turn.
3. `log.jsonl` is no longer scanned to rebuild context as part of normal turn processing.
4. `context.jsonl` is no longer treated as a memory source.
5. Consolidation becomes the main persistence path for channel memory.

## Fixed Decisions

This RFC fixes the following design choices:

1. Consolidation triggers only before compaction or trim.
2. `<channel>/MEMORY.md` uses append-first updates with periodic cleanup sweeps.
3. `<channel>/HISTORY.md` uses append-first updates with periodic folding of older blocks.
4. Consolidation uses a two-phase execution model: inline for safety, background for maintenance.
5. Consolidation is hard-gated before compaction or trim.

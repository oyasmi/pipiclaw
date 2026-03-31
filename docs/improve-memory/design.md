# Pipiclaw Context Upgrade Design

## Scope

This document translates the context-upgrade spec into runtime behavior for `pipiclaw`.

It covers:

1. relevant memory injection
2. `SESSION.md`
3. changed `MEMORY.md` / `HISTORY.md` flow
4. compaction integration
5. contextual sub-agents
6. skill metadata and lightweight hooks

## Current Baseline

Today the main integration points are:

1. [ChannelRunner](/Users/oyasmi/projects/pipiclaw/src/agent.ts#L260)
2. [buildAppendSystemPrompt](/Users/oyasmi/projects/pipiclaw/src/prompt-builder.ts#L7)
3. [MemoryLifecycle](/Users/oyasmi/projects/pipiclaw/src/memory-lifecycle.ts#L20)
4. [memory consolidation](/Users/oyasmi/projects/pipiclaw/src/memory-consolidation.ts#L271)
5. [sub-agent discovery and execution](/Users/oyasmi/projects/pipiclaw/src/sub-agents.ts#L189) [subagent tool](/Users/oyasmi/projects/pipiclaw/src/tools/subagent.ts#L235)
6. [channel memory file bootstrap](/Users/oyasmi/projects/pipiclaw/src/memory-files.ts#L60)

The design below intentionally reuses these hooks rather than introducing a second runtime.

## Design Overview

### Main Idea

Introduce a new working-state artifact, `SESSION.md`, and a recall pipeline that proactively surfaces only the memory slices most likely to matter on the current turn.

The runtime then uses three complementary maintenance loops:

1. turn-time recall loop
2. session-state update loop
3. durable consolidation loop

### Why This Works

This design borrows the highest-value ideas from `claude-code` without importing its heaviest machinery:

1. proactive relevant-memory surfacing
2. explicit session notes
3. sidecar worker pattern for background extraction
4. compaction informed by working-state artifacts

It does not attempt to reproduce:

1. full prompt-cache-safe fork infrastructure
2. multi-backend swarm orchestration
3. complex task OS abstractions

## Runtime Components

### A. Relevant Memory Recall

Purpose:

- improve precision of context use without making every turn read full memory files

Inputs:

1. user message
2. current session model
3. `SESSION.md`
4. channel `MEMORY.md`
5. workspace `MEMORY.md`
6. channel `HISTORY.md`

Outputs:

1. a small injected memory block prepended to the user prompt

Selection pipeline:

1. parse each file into sections/blocks
2. score locally with lexical and structural heuristics
3. if candidate set is large, optionally rerank with a small model call
4. truncate to injection budget

Priority order:

1. `SESSION.md`
2. channel `MEMORY.md`
3. workspace `MEMORY.md`
4. `HISTORY.md`

Reasons:

1. current state usually matters more than old history
2. channel-local state usually matters more than workspace-shared background
3. history should help recovery, not dominate normal turns

### B. SESSION.md Updater

Purpose:

- maintain a compact, structured representation of the current working state

Shape:

Recommended stable sections:

1. `# Session Title`
2. `# Current State`
3. `# User Intent`
4. `# Active Files`
5. `# Decisions`
6. `# Constraints`
7. `# Errors & Corrections`
8. `# Next Steps`
9. `# Worklog`

Update model:

1. background updates after meaningful work
2. forced refresh before compaction
3. forced refresh before `/new` session switch

Important choice:

The updater should return structured JSON, and the runtime should render Markdown.

Reason:

1. less fragile than asking the worker to surgically edit Markdown
2. easier to test
3. easier to enforce section boundaries
4. easier to migrate format later

### C. Durable Consolidation

Purpose:

- promote long-lived facts to `MEMORY.md`
- push older narrative to `HISTORY.md`

This extends the existing system rather than replacing it.

Behavioral change:

The consolidation worker should treat `SESSION.md` as an input artifact when deciding:

1. what belongs in durable memory
2. what is still merely active work state
3. what should move to history

That change closes the loop:

recent transcript -> `SESSION.md` -> durable promotion -> future recall

### D. Sidecar Worker Abstraction

Purpose:

- unify small internal worker tasks under one runtime helper

Candidate tasks:

1. relevant-memory reranking
2. `SESSION.md` update generation
3. durable consolidation cleanup
4. history folding

This does not need prompt-cache-safe inheritance in the first iteration.

The first version should optimize for:

1. correctness
2. isolation
3. observability
4. shared error handling

## Source Of Truth Rules

The runtime should make conflicts boring and deterministic.

### Current Work State

For current active work state, trust:

1. live in-memory session messages first
2. then `SESSION.md`
3. then `MEMORY.md`
4. then `HISTORY.md`

### Durable Constraints And Decisions

For durable constraints and decisions, trust:

1. explicit human-managed workspace files first
2. then channel `MEMORY.md`
3. then `SESSION.md`
4. then `HISTORY.md`

This prevents the new hot-memory layer from accidentally becoming the durable truth for everything.

## Detailed Lifecycle

### 1. Channel Bootstrap

When a channel directory is created or touched for the first time:

1. ensure `MEMORY.md`
2. ensure `HISTORY.md`
3. ensure `SESSION.md`

This should extend the existing [ensureChannelMemoryFilesSync](/Users/oyasmi/projects/pipiclaw/src/memory-files.ts#L60) behavior.

### 2. Session Start

At session start:

1. load `SOUL.md`
2. load `AGENTS.md`
3. load skills metadata
4. do not preload `MEMORY.md`, `HISTORY.md`, or `SESSION.md`

Rationale:

1. keep base prompt lean
2. let recall injection decide what to surface

### 3. Normal User Turn

Before `session.prompt()`:

1. build the formatted user message as today
2. run relevant-memory recall
3. prepend a runtime context block if recall produced useful results

After the turn finishes successfully:

1. evaluate whether the turn dirtied working state enough to refresh `SESSION.md`
2. if yes, queue the background updater

Dirty signals include:

1. at least one assistant final response
2. tool activity
3. file-writing activity
4. large token delta
5. explicit user steering that changes task direction

### 4. Busy Steering / Follow-Up

Steer and follow-up messages remain normal runtime messages, but they should also count as `SESSION.md`-dirty signals.

Reason:

These are precisely the moments when "current state" tends to change.

### 5. Before Compaction

When `session_before_compact` fires:

1. synchronously refresh `SESSION.md` using the current session messages
2. run inline durable consolidation
3. proceed to compaction

Fallback:

1. if refresh fails, keep the last persisted `SESSION.md`
2. if durable consolidation fails, compaction still proceeds with the last good durable files

### 6. After Compaction

After compaction:

1. queue background cleanup for `MEMORY.md`
2. queue background folding for `HISTORY.md`
3. do not immediately rewrite `SESSION.md` again unless compaction changed work state interpretation

### 7. Before New Session

When `session_before_switch(reason=new)` fires:

1. synchronously refresh `SESSION.md`
2. run inline durable consolidation
3. allow session switch

After switch:

1. background cleanup may run
2. `SESSION.md` remains available to the next session

### 8. Process Restart

After restart:

1. the runner should reconstruct state from files
2. `SESSION.md` serves as the persisted hot handoff
3. no extra persisted metadata is required in the first iteration

Design choice:

Do not add a `memory-state.json` file yet.

Reason:

1. first iteration can remain simple
2. `SESSION.md` is already the persisted hot state
3. current session messages plus file timestamps are sufficient for an initial robust version

If later needed, a metadata file can be added as a follow-up optimization rather than a baseline dependency.

### 9. Old Channel Migration

For existing channels that predate this design:

1. create `SESSION.md` lazily when the channel is next touched
2. do not perform a one-shot rewrite of `MEMORY.md`
3. let background cleanup gradually strip transient working-state details from `MEMORY.md`

This avoids rollout-time churn on live channels.

## Memory Ownership Rules

### SESSION.md Owns

1. precise active task state
2. active files and commands
3. immediate next steps
4. recent significant errors
5. temporary but important work hypotheses

### MEMORY.md Owns

1. durable facts
2. durable preferences
3. stable constraints
4. decisions that should survive beyond current execution
5. medium-horizon open loops

### HISTORY.md Owns

1. chronological work periods
2. milestones
3. older summarized context

### Cleanup Implication

Background cleanup should now be allowed to remove from `MEMORY.md` content that is clearly transient working state and belongs in `SESSION.md`.

This is an intentional semantic shift from the current append-first-only behavior.

## End-To-End Flow

The intended steady-state loop is:

1. user sends a message
2. runtime recalls relevant context from `SESSION.md`, `MEMORY.md`, and `HISTORY.md`
3. main agent runs with a small injected memory block
4. turn completes
5. runtime updates `SESSION.md` if work state changed enough
6. before compaction or new session, runtime forces a fresh `SESSION.md` flush
7. runtime promotes durable facts to `MEMORY.md` and older narrative to `HISTORY.md`
8. next turn benefits from the updated files

This is the operational closure that the current design lacks.

## Recall Injection Format

Use an explicit runtime wrapper rather than pretending the memory snippets are part of the user text.

Recommended shape:

```text
<runtime_context>
Relevant context for this turn:

[session/current-state]
...

[channel-memory/constraints]
...
</runtime_context>

<user_message>
...
</user_message>
```

Rationale:

1. separates runtime-provided context from user intent
2. keeps prompts inspectable in debug mode
3. makes future migration to attachment-style rendering easier

## SESSION.md Rendering

The runtime should render `SESSION.md` deterministically from structured update data.

Properties:

1. stable section order
2. empty sections omitted or left blank according to template choice
3. explicit truncation for very large sections
4. deterministic formatting for testing

Recommended rule:

- keep a stable template
- render empty sections as present but blank only if needed for readability
- otherwise omit clearly empty tail sections to keep file lean

Recommended practical default:

1. keep top sections stable
2. omit empty low-value tail sections such as `Worklog` when fully empty
3. cap `Worklog` aggressively so it never becomes a second `HISTORY.md`

## Update Trigger Strategy

The updater should not run on every turn.

Suggested thresholds:

1. at least 2 meaningful user/assistant exchanges since last update
2. or at least 4 tool calls since last update
3. or at least one file mutation plus a final assistant reply
4. or an impending compaction / new-session switch

This keeps cost bounded while still refreshing the working state at natural boundaries.

## Failure Handling

### Relevant Recall Failure

If recall fails:

1. continue the turn without injected memory
2. log warning
3. do not block the agent

### SESSION.md Update Failure

If the background update fails:

1. keep the last persisted file
2. mark no special error to user
3. retry next time thresholds are met

If the synchronous pre-compaction refresh fails:

1. keep the last persisted file
2. log warning
3. continue to compaction

If no persisted `SESSION.md` exists yet:

1. fall back to an empty template
2. continue without blocking the user

### Durable Consolidation Failure

If inline durable consolidation fails:

1. keep existing `MEMORY.md` and `HISTORY.md`
2. continue to compaction if `SESSION.md` is available
3. queue background retry later

### Corruption Policy

All writes to `SESSION.md`, `MEMORY.md`, and `HISTORY.md` should be atomic.

That matches the direction already used in [memory-files.ts](/Users/oyasmi/projects/pipiclaw/src/memory-files.ts#L38).

## Sub-Agent Design Integration

Current sub-agents are explicitly isolated and only receive a generated runtime preamble plus the supplied task, [subagent.ts](/Users/oyasmi/projects/pipiclaw/src/tools/subagent.ts#L170).

The upgraded design adds:

1. `contextMode: isolated | contextual`
2. `memory: none | relevant | session | channel`

Semantics:

1. `isolated`
   - current behavior
2. `contextual + relevant`
   - prepend relevant recall slices for the subtask
3. `contextual + session`
   - prepend condensed `SESSION.md`
4. `contextual + channel`
   - prepend relevant `SESSION.md` plus durable memory summary

This avoids forcing the parent agent to manually hand-write all background context into `task`.

## Skill Design Integration

Current skill loading is metadata-light and passive, [agent.ts](/Users/oyasmi/projects/pipiclaw/src/agent.ts#L362).

The upgraded design adds light frontmatter semantics:

1. `when_to_use`
2. `allowed_tools`
3. `paths`
4. `hooks`
5. optional `memory_scope`

Supported hook points in first iteration:

1. `before_prompt`
2. `after_response`
3. `before_compact`
4. `after_subagent`

These hooks should remain session-scoped and lightweight. They exist to shape runtime context, not to build a separate automation engine.

## Explicitly Deferred Decisions

These are intentionally deferred so they do not block the first strong implementation:

1. persisted dirty-cursor metadata
2. prompt-cache-safe fork inheritance
3. richer background scheduling policy
4. automatic promotion heuristics based on file edit detection alone

If the first rollout proves stable, these can be revisited from real usage data rather than guessed up front.

## What We Intentionally Do Not Adopt Yet

We do not adopt these `claude-code` patterns in the first implementation:

1. full cache-safe fork inheritance
2. streaming concurrent tool executor
3. tmux/swarm task backends
4. full task OS abstractions

Reason:

The biggest near-term performance gain for `pipiclaw` comes from context quality, not orchestration maximalism.

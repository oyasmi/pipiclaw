# Pipiclaw Context Upgrade Spec

## Status

Draft

## Purpose

This spec defines the next-stage context architecture for `pipiclaw`.

It extends the existing [memory RFC](/Users/oyasmi/projects/pipiclaw/docs/memory-rfc.md) rather than replacing it wholesale.

The primary goal is not "more memory files". The goal is to materially improve:

1. cross-turn continuity
2. long-task stability
3. compaction resilience
4. sub-agent usefulness
5. skill usefulness in a long-running DingTalk channel workspace

The design remains file-based and runtime-local. It does not introduce embeddings, vector search, or a dedicated memory database.

## Problems To Solve

The current model is good enough to persist durable facts, but still leaves several gaps:

1. `MEMORY.md` and `HISTORY.md` are available but not proactively surfaced, so the model often fails to use them at the right time.
2. "current working state" is mixed into durable memory and is therefore either too weak, too stale, or too noisy.
3. compaction happens with only indirect help from memory consolidation, which is weaker than having an explicit working-state artifact.
4. sub-agents are context-isolated, but there is no standard way to give them the most relevant channel memory automatically.
5. skills are loaded, but they do not yet participate in a richer lifecycle where memory and runtime hooks reinforce one another.

## Non-Goals

1. No vector retrieval, embedding index, semantic database, or memory plugin framework.
2. No special standalone `memory_search` tool for the model.
3. No automatic mutation of workspace-level `SOUL.md`, `AGENTS.md`, or workspace `MEMORY.md`.
4. No proactive scanning of `log.jsonl` or `context.jsonl` as normal memory inputs.
5. No attempt to clone the full `claude-code` agent OS, swarm runtime, or prompt-cache infrastructure in this phase.

## Context Layers

The upgraded context model has five layers.

### 1. Identity Layer

- `workspace/SOUL.md`
- `workspace/AGENTS.md`

Semantics:

- loaded into session context at session start
- human-managed
- authoritative
- not rewritten by runtime maintenance

### 2. Shared Durable Memory

- `workspace/MEMORY.md`

Semantics:

- stable shared background
- read on demand
- not auto-rewritten by runtime

### 3. Channel Durable Memory

- `<channel>/MEMORY.md`

Semantics:

- durable facts, decisions, preferences, constraints, medium-horizon open loops
- append-first, then cleanup/fold
- channel-scoped
- runtime-managed

Important change:

`MEMORY.md` is no longer the primary owner of minute-by-minute "what am I doing right now" state. It may still contain open loops, but detailed active execution state belongs to `SESSION.md`.

### 4. Channel Working Memory

- `<channel>/SESSION.md`

Semantics:

- current task state
- active files and commands
- current hypotheses and next steps
- recent important errors and corrections
- channel-scoped handoff artifact across sessions and compactions
- runtime-managed

This is the major addition in this spec.

### 5. Channel History

- `<channel>/HISTORY.md`

Semantics:

- summarized chronological recovery material
- older work periods, decisions, milestones
- runtime-managed
- not intended for normal manual maintenance

## Cold Storage

These files remain cold:

- `<channel>/log.jsonl`
- `<channel>/context.jsonl`

They are not part of normal memory recall and are not proactively loaded into prompts.

## Core Invariants

The upgraded design must preserve these invariants:

1. File-based operation remains the source of truth.
2. The model should not need to remember to manually read the right memory file in common cases.
3. `SESSION.md` is the working-state artifact.
4. `MEMORY.md` is the durable-facts artifact.
5. `HISTORY.md` is the chronological-summary artifact.
6. Workspace memory remains human-managed.
7. Raw transport/session archives remain cold.
8. Failure of a background updater must not corrupt persisted memory files.
9. The system must degrade gracefully when an updater fails.
10. Memory improvements must help sub-agents and skills, not just the main agent.

## File Semantics

### `SESSION.md`

`SESSION.md` is channel-scoped hot memory.

It should answer:

1. What is the user currently trying to achieve?
2. What is the current state of work?
3. Which files and commands matter right now?
4. What constraints and recent failures should not be forgotten?
5. What are the next likely steps?

It should not become:

1. a raw transcript
2. a duplicate of all durable facts already in `MEMORY.md`
3. an infinite worklog

Read/write rule:

1. runtime-managed by default
2. eligible for automatic targeted recall
3. not intended for normal manual maintenance by the main agent
4. may be edited only when an explicit user/admin instruction makes that the task itself

### `MEMORY.md`

`MEMORY.md` remains the durable channel memory, but the threshold for what belongs here gets stricter.

It should keep:

1. stable preferences
2. durable decisions
3. medium-horizon constraints
4. important open loops that must survive beyond the current execution burst

It should avoid:

1. step-by-step active worklog
2. temporary local debugging observations unless they have lasting value
3. detailed "current state" that will likely be obsolete after a few turns

Read/write rule:

1. readable on demand
2. writable by runtime consolidation
3. still manually writable when necessary
4. cleanup is allowed to remove transient state that should now live in `SESSION.md`

### `HISTORY.md`

`HISTORY.md` remains the recovery narrative.

It should keep:

1. notable work periods
2. milestones
3. decision outcomes
4. enough chronology for later recovery

It should avoid:

1. dense per-turn detail
2. raw snippets copied from transcript
3. facts better represented in `MEMORY.md`

Read/write rule:

1. readable on demand
2. runtime-managed
3. not intended for ordinary manual edits

## Closed-Loop Lifecycle

The upgraded model introduces an explicit closed loop:

1. active session work happens in warm context
2. recent work updates `SESSION.md`
3. stable facts and medium-horizon open loops are promoted into `MEMORY.md`
4. older narrative is summarized into `HISTORY.md`
5. future prompts receive targeted recall from `SESSION.md`, `MEMORY.md`, and `HISTORY.md`

This loop must work even when:

1. the session compacts
2. the user starts a new session in the same channel
3. the process restarts
4. the main agent delegates work to a sub-agent

## Recall Model

The system should stop relying purely on "the model may remember to read memory files".

Instead, each turn may inject a small amount of relevant memory context chosen from:

1. `SESSION.md`
2. channel `MEMORY.md`
3. workspace `MEMORY.md`
4. channel `HISTORY.md`

Selection rules:

1. small budget
2. high precision
3. recency-aware
4. section-aware
5. prefer `SESSION.md` when current work state matters
6. prefer `MEMORY.md` when durable constraints or preferences matter
7. prefer `HISTORY.md` when recovery of older narrative matters

## SESSION.md Lifecycle Contract

`SESSION.md` must follow this lifecycle:

1. created automatically with the channel memory files
2. not loaded wholesale into every prompt
3. eligible for targeted recall injection
4. updated in the background during normal work
5. synchronously refreshed before context-reduction boundaries when possible
6. carried across `/new` session boundaries within the same channel
7. cleaned and condensed periodically so it remains current
8. recreated automatically if missing on an old channel directory

Important semantic rule:

`/new` starts a new model session, but does not imply "forget current channel work". `SESSION.md` is allowed to survive `/new` if the channel still has active work.

## Relationship Between SESSION.md And Existing Memory Files

The relationship is:

1. `SESSION.md` owns high-churn working state
2. `MEMORY.md` owns durable and semi-durable channel knowledge
3. `HISTORY.md` owns older narrative recovery

Promotion rules:

1. stable facts discovered in `SESSION.md` may be promoted into `MEMORY.md`
2. resolved work periods may be summarized into `HISTORY.md`
3. stale transient content should be removed from `SESSION.md`
4. cleanup may also remove overly transient content that had historically accumulated in `MEMORY.md`

This lets the system gradually migrate away from using channel `MEMORY.md` as the sole carrier of both durable and active state.

## Source Of Truth Precedence

When the same topic appears in multiple files, runtime and prompts should treat them in this precedence order:

1. `SESSION.md` for current active work state
2. `MEMORY.md` for durable constraints and decisions
3. `HISTORY.md` for older chronology

Practical implication:

1. a stale `MEMORY.md` note must not override a fresher `SESSION.md` current-state section
2. a stale `HISTORY.md` block must not override a fresher durable decision in `MEMORY.md`

## Compaction Contract

Compaction should become `SESSION.md`-aware.

The preferred order is:

1. refresh `SESSION.md`
2. run inline durable consolidation into `MEMORY.md` and `HISTORY.md`
3. compact using the latest `SESSION.md` as part of the retained context strategy

Graceful degradation rules:

1. if `SESSION.md` refresh fails, use the last persisted `SESSION.md`
2. if durable consolidation fails, compaction may still proceed if `SESSION.md` is available
3. failures must be logged and retried in background maintenance

This keeps compaction safe without turning memory maintenance into a hard availability dependency.

## Migration Contract

Existing channel directories already containing only `MEMORY.md` and `HISTORY.md` must migrate safely.

Migration rules:

1. missing `SESSION.md` is treated as normal and repaired by ensure-file bootstrap
2. existing `MEMORY.md` and `HISTORY.md` content remains authoritative
3. no one-time destructive rewrite of historical `MEMORY.md` content is required
4. transient content historically living in `MEMORY.md` is cleaned gradually by normal maintenance

This keeps rollout incremental and low-risk for live DingTalk channels.

## Sub-Agent Contract

Sub-agents remain isolated by default, but the runtime gains a standard way to provide them with the right memory context.

Two modes should exist:

1. isolated
   - current behavior
   - only runtime basics plus the explicitly provided task
2. contextual
   - runtime prepends relevant memory and working-state context automatically

The contextual mode should pull from the same recall pipeline as the main agent, but with stricter budgets.

## Skill Contract

Skills should become lightweight participants in the upgraded context system.

Expected improvements:

1. richer frontmatter describing when a skill should be used
2. optional scoped hooks for session lifecycle events
3. optional declaration of memory relevance or path relevance

The skill system is still intentionally lighter than the `claude-code` version. The goal is stronger reuse and better context shaping, not a full plugin platform.

## Rollout Principle

This spec is designed for staged implementation:

1. first improve recall
2. then add `SESSION.md`
3. then bridge compaction
4. then upgrade sub-agent and skill integration

At each stage, existing `MEMORY.md` and `HISTORY.md` behavior must continue to work.

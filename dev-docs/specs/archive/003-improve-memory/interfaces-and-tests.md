# Pipiclaw Context Upgrade Interfaces And Test Plan

## Purpose

This document turns the context-upgrade design into an implementation map:

1. interfaces
2. directory and file layout
3. phased rollout plan
4. test checklist

## Proposed Files

### New Files

- `src/memory-candidates.ts`
- `src/memory-recall.ts`
- `src/session-memory-files.ts`
- `src/session-memory.ts`
- `src/sidecar-worker.ts`
- `src/skill-hooks.ts`

### Existing Files To Modify

- [src/agent.ts](/Users/oyasmi/projects/pipiclaw/src/agent.ts)
- [src/context.ts](/Users/oyasmi/projects/pipiclaw/src/context.ts)
- [src/prompt-builder.ts](/Users/oyasmi/projects/pipiclaw/src/prompt-builder.ts)
- [src/memory-files.ts](/Users/oyasmi/projects/pipiclaw/src/memory-files.ts)
- [src/memory-consolidation.ts](/Users/oyasmi/projects/pipiclaw/src/memory-consolidation.ts)
- [src/memory-lifecycle.ts](/Users/oyasmi/projects/pipiclaw/src/memory-lifecycle.ts)
- [src/sub-agents.ts](/Users/oyasmi/projects/pipiclaw/src/sub-agents.ts)
- [src/tools/subagent.ts](/Users/oyasmi/projects/pipiclaw/src/tools/subagent.ts)
- [src/config-loader.ts](/Users/oyasmi/projects/pipiclaw/src/config-loader.ts)
- [src/command-extension.ts](/Users/oyasmi/projects/pipiclaw/src/command-extension.ts)
- [src/main.ts](/Users/oyasmi/projects/pipiclaw/src/main.ts)

## Directory Layout

### Channel Workspace

Target layout:

```text
<channel>/
├── MEMORY.md
├── SESSION.md
├── HISTORY.md
├── log.jsonl
└── context.jsonl
```

### Workspace Root

Unchanged plus richer semantics:

```text
workspace/
├── SOUL.md
├── AGENTS.md
├── MEMORY.md
├── sub-agents/
├── skills/
└── events/
```

## Interface Sketches

### 1. Memory Candidates

```ts
export interface MemoryCandidate {
  id: string;
  source: "workspace-memory" | "channel-memory" | "channel-session" | "channel-history";
  path: string;
  title: string;
  content: string;
  timestamp?: string;
  sectionKind?: string;
  priority: number;
}

export interface BuildMemoryCandidatesOptions {
  workspaceDir: string;
  channelDir: string;
}

export async function buildMemoryCandidates(
  options: BuildMemoryCandidatesOptions,
): Promise<MemoryCandidate[]>;
```

Responsibilities:

1. read the relevant files
2. split them into sections/blocks
3. normalize titles and timestamps
4. assign coarse priority hints

### 2. Memory Recall

```ts
export interface RecallRequest {
  query: string;
  workspaceDir: string;
  channelDir: string;
  maxCandidates: number;
  maxInjected: number;
  maxChars: number;
  rerankWithModel: boolean;
  model: Model<Api>;
  resolveApiKey: (model: Model<Api>) => Promise<string>;
}

export interface RecalledMemory {
  source: MemoryCandidate["source"];
  path: string;
  title: string;
  content: string;
  score: number;
}

export interface RecallResult {
  items: RecalledMemory[];
  renderedText: string;
}

export async function recallRelevantMemory(
  request: RecallRequest,
): Promise<RecallResult>;
```

Responsibilities:

1. score candidates locally
2. optionally rerank
3. apply caps
4. return rendered prompt block

### 3. SESSION.md File Helpers

```ts
export function getChannelSessionPath(channelDir: string): string;
export async function ensureChannelSessionFile(channelDir: string): Promise<void>;
export function ensureChannelSessionFileSync(channelDir: string): void;
export async function readChannelSession(channelDir: string): Promise<string>;
export async function rewriteChannelSession(channelDir: string, content: string): Promise<void>;
```

These should mirror existing `memory-files.ts` conventions.

### 4. Session Memory Structure

```ts
export interface SessionMemoryState {
  title: string;
  currentState: string[];
  userIntent: string[];
  activeFiles: string[];
  decisions: string[];
  constraints: string[];
  errorsAndCorrections: string[];
  nextSteps: string[];
  worklog: string[];
}

export interface SessionMemoryUpdateOptions {
  channelDir: string;
  messages: AgentMessage[];
  model: Model<Api>;
  resolveApiKey: (model: Model<Api>) => Promise<string>;
}

export async function updateChannelSessionMemory(
  options: SessionMemoryUpdateOptions,
): Promise<SessionMemoryState>;

export function renderSessionMemory(state: SessionMemoryState): string;
```

### 5. Sidecar Worker

```ts
export interface SidecarTask<T> {
  name: string;
  model: Model<Api>;
  resolveApiKey: (model: Model<Api>) => Promise<string>;
  systemPrompt: string;
  prompt: string;
  parse: (text: string) => T;
}

export interface SidecarResult<T> {
  output: T;
  rawText: string;
}

export async function runSidecarTask<T>(task: SidecarTask<T>): Promise<SidecarResult<T>>;
```

### 6. Settings

Extend [src/context.ts](/Users/oyasmi/projects/pipiclaw/src/context.ts) settings:

```ts
export interface PipiclawMemoryRecallSettings {
  enabled: boolean;
  maxCandidates: number;
  maxInjected: number;
  maxChars: number;
  rerankWithModel: boolean;
}

export interface PipiclawSessionMemorySettings {
  enabled: boolean;
  minTurnsBetweenUpdate: number;
  minToolCallsBetweenUpdate: number;
  forceRefreshBeforeCompact: boolean;
  forceRefreshBeforeNewSession: boolean;
}
```

### 7. Sub-Agent Frontmatter Extensions

Extend [src/sub-agents.ts](/Users/oyasmi/projects/pipiclaw/src/sub-agents.ts):

```ts
export interface SubAgentConfig {
  // existing fields...
  contextMode?: "isolated" | "contextual";
  memory?: "none" | "relevant" | "session" | "channel";
  paths?: string[];
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
}
```

Behavior:

1. preserve current behavior when omitted
2. only enrich context when explicitly configured

### 8. Skill Frontmatter Extensions

Introduce parsing support for:

```ts
export interface PipiclawSkillMeta {
  name?: string;
  description?: string;
  whenToUse?: string;
  allowedTools?: string[];
  paths?: string[];
  hooks?: {
    before_prompt?: string[];
    after_response?: string[];
    before_compact?: string[];
    after_subagent?: string[];
  };
  memoryScope?: "none" | "relevant" | "session";
}
```

## Integration Map

### ChannelRunner

Update [src/agent.ts](/Users/oyasmi/projects/pipiclaw/src/agent.ts):

1. before `session.prompt()`, call `recallRelevantMemory()`
2. inject `renderedText` into the prompt if non-empty
3. after final turn, queue `SESSION.md` maintenance when thresholds are met
4. before session resource reload or switches, ensure session-memory hooks are respected

### MemoryLifecycle

Update [src/memory-lifecycle.ts](/Users/oyasmi/projects/pipiclaw/src/memory-lifecycle.ts):

1. before compact, refresh `SESSION.md`, then durable consolidation
2. before new-session switch, refresh `SESSION.md`, then durable consolidation
3. background maintenance expands to:
   - cleanup `MEMORY.md`
   - fold `HISTORY.md`
   - optionally trim stale `SESSION.md` sections

### Memory Consolidation

Update [src/memory-consolidation.ts](/Users/oyasmi/projects/pipiclaw/src/memory-consolidation.ts):

1. read current `SESSION.md` as an additional input
2. use it when deciding what belongs in durable memory versus active session state
3. keep append-first behavior for `MEMORY.md`, but allow cleanup to remove transient state

### Memory File Bootstrap

Update [src/memory-files.ts](/Users/oyasmi/projects/pipiclaw/src/memory-files.ts) and [src/main.ts](/Users/oyasmi/projects/pipiclaw/src/main.ts):

1. ensure `SESSION.md` exists wherever channel memory files are created
2. document it in the bootstrap-generated workspace model
3. preserve compatibility for channel dirs created before this upgrade

### Prompt Builder

Update [src/prompt-builder.ts](/Users/oyasmi/projects/pipiclaw/src/prompt-builder.ts):

1. include `SESSION.md` in workspace layout and memory rules
2. explain that memory files are not preloaded wholesale
3. explain that runtime may inject relevant memory snippets automatically

## Phased Rollout

### Phase 0: Relevant Memory Recall

Deliverables:

1. candidate builder
2. recall scoring
3. injected runtime context block
4. settings toggles

Success criteria:

1. turns involving prior channel context use the right memory more often
2. no noticeable latency spike for common turns
3. no huge prompt bloat

### Phase 1: SESSION.md

Deliverables:

1. `SESSION.md` file lifecycle
2. session updater
3. background thresholds
4. prompt-builder documentation

Success criteria:

1. current work state survives `/new`
2. current work state survives compaction better
3. `MEMORY.md` stops absorbing excessive transient detail

### Phase 1.5: Compaction Bridge

Deliverables:

1. pre-compaction session refresh
2. durable consolidation informed by `SESSION.md`
3. fallback semantics

Success criteria:

1. fewer "forgot what we were doing" failures after compaction
2. no brittle dependency on background maintenance

### Phase 2: Contextual Sub-Agents

Deliverables:

1. `contextMode`
2. `memory` scope
3. recall-aware task preamble for sub-agents

Success criteria:

1. sub-agents require less hand-written context
2. review and research agents produce better results on long-running channels

### Phase 3: Skill Metadata And Hooks

Deliverables:

1. richer frontmatter
2. lightweight lifecycle hooks
3. optional memory scope shaping

Success criteria:

1. skills become better aligned with channel context
2. skill-triggered behavior remains understandable and debuggable

## Test Plan

### Phase 0 Unit Tests

1. splits `MEMORY.md`, `SESSION.md`, and `HISTORY.md` into stable candidates
2. ranks session-current-state above old history for matching queries
3. respects max item and max char budgets
4. produces empty injection when nothing is relevant
5. handles malformed or missing files gracefully

### Phase 0 Integration Tests

1. injected memory block appears before the user message in debug prompt output
2. unrelated turns do not receive noisy memory injection
3. recall remains stable when channel files are empty

### Phase 1 Unit Tests

1. `ensureChannelSessionFile*()` creates the default template
2. `renderSessionMemory()` is deterministic
3. updater preserves section boundaries
4. updater truncates oversized sections
5. updater can render an effectively empty but valid session file

### Phase 1 Integration Tests

1. a normal coding turn updates `SESSION.md`
2. a steer/follow-up updates `SESSION.md`
3. `/new` keeps `SESSION.md` intact for the channel
4. existing `MEMORY.md` / `HISTORY.md` behavior continues to work
5. an old channel directory without `SESSION.md` is repaired automatically

### Phase 1.5 Unit Tests

1. pre-compaction refresh is invoked before durable consolidation
2. durable consolidation receives `SESSION.md` as input
3. fallback uses last persisted `SESSION.md` when refresh fails
4. cleanup can remove transient content from `MEMORY.md`

### Phase 1.5 Integration Tests

1. compaction followed by another turn still remembers current work
2. new session after compaction still recovers current state
3. failure in the updater does not crash the run loop
4. fallback works when `SESSION.md` was missing before the first compaction

### Phase 2 Unit Tests

1. sub-agent config parses `contextMode` and `memory`
2. isolated sub-agents retain current behavior
3. contextual sub-agents receive bounded relevant memory preamble

### Phase 2 Integration Tests

1. reviewer sub-agent sees the right open loop without the parent hand-copying it
2. simple sub-agents do not get unnecessary memory noise

### Phase 3 Unit Tests

1. skill frontmatter parsing handles new fields
2. invalid hook declarations are rejected cleanly
3. hook registration stays session-scoped

### Phase 3 Integration Tests

1. a skill with `before_compact` hook runs in the expected lifecycle
2. a skill with `memoryScope=relevant` shapes prompt preparation predictably

## Manual Validation Checklist

1. Start a fresh channel and confirm `SESSION.md` is created.
2. Run a multi-step coding task and confirm `SESSION.md` tracks active files and next steps.
3. Trigger `/compact` and confirm current work state survives.
4. Trigger `/new` and confirm channel working state survives but raw session history resets as expected.
5. Use a contextual sub-agent and verify it inherits relevant channel state without seeing the full parent transcript.
6. Confirm `MEMORY.md` remains concise and durable after repeated work cycles.
7. Confirm `HISTORY.md` remains chronological and non-transcript-like.
8. Restart the process mid-task and confirm the next turn recovers state primarily from `SESSION.md`.
9. Test an older pre-upgrade channel directory and confirm migration is silent and non-destructive.

## Open Questions To Resolve During Implementation

1. Should `SESSION.md` keep blank stable sections, or omit empty sections for brevity?
2. Should recall injection be visible in `last_prompt.json` as a separate field for debugging?
3. Should `SESSION.md` cleanup run only during background maintenance, or also during forced refresh?
4. At what point should `MEMORY.md` cleanup become allowed to remove historical transient content aggressively?

The recommended default is:

1. deterministic rendering
2. visible debug output
3. cleanup in background plus light normalization in forced refresh
4. conservative cleanup first, then more aggressive pruning only after observing real channels

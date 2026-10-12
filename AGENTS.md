# AGENTS.md

## Project

Pipiclaw is a DingTalk-first AI coding assistant runtime built on `@earendil-works/pi-coding-agent`. It adds AI Card streaming, layered memory, scheduled work, per-channel workspaces, and unified delegation to internal agents or external Claude Code, Codex CLI, and custom executors.

## Core Structure

- `src/runtime/`: DingTalk transport, background services, and the composition root (`bootstrap`, `dingtalk`, `delivery`, `task-driver`)
- `src/channel/`: the transport-neutral channel domain — its two I/O contracts (`channel-context` outbound, `channel-event` inbound), identity (`channel-paths`, `channel-index`) and persisted state (`store`, `active-session-store`, `project-scope-store`). Depends on no transport; this is what `agent`, `memory`, `tools` and `tui` mean when they say "channel"
- `src/events/`: scheduled/sensor events — definitions, cron/one-shot validation, the filesystem watcher, and admin-command parsing (`events`, `event-validation`, `event-commands`). A separate subsystem from tasks: the only edge between them is a template event asking the runtime (via the injected `spawnTask` callback) for a task instance — events never read or write task files (spec 052, INV-8)
- `src/agent/`: main agent orchestration and session event handling
- `src/commands/`: the product-wide slash-command catalog (`catalog.ts`) and the shared reply length budget (`reply-limits.ts`). Imports nothing; handlers stay in the layer that owns their state
- `src/memory/`: one-fact-per-file channel memory, daily journal, and the single background reflect pass (spec 050)
- `src/tasks/`: the one-off task project: contract (Goal/DoD/Work Items), waiting tickets, loop log with dispatch/settle records, the team board and budget (specs 051, 052)
- `src/subagents/`: role discovery, internal/external execution, run lifecycle, harnesses, workspace leases, and delegation tools
- `src/tools/`: tool implementations exposed to the coding agent
- `src/security/`: command, path, and network guard configuration and enforcement helpers
- `src/web/`: web search/fetch client, extraction, formatting, and provider implementations
- `src/models/`: model reference formatting, matching, default resolution, and API key lookup helpers
- `src/shared/`: small cross-cutting helpers that are truly shared across domains

The intended direction is domain-first organization. Avoid adding new generic root-level utilities when a file clearly belongs to an existing domain.

## Runtime Model

- App-level files: `channel.json`, `auth.json`, `models.json`, `settings.json`, `tools.json`, `security.json`
- Workspace-level files: `SOUL.md`, `AGENTS.md`, `MEMORY.md`, `ENVIRONMENT.md`, `skills/`, `events/`, `sub-agents/`
- Channel-level files: `memory/<name>.md` + generated `MEMORY.md` index, `journal/YYYY-MM-DD.md`, `tasks/<id>.md` (contract) + `tasks/<id>.jsonl` (loop log) + `tasks/.sessions/` (one agent session per task), delegation records/artifacts, `log.jsonl`, `context.jsonl`
- `memory/<name>.md` is one durable fact per file (frontmatter metadata); `MEMORY.md` is generated from it — never hand-edited
- `journal/YYYY-MM-DD.md` is the day-by-day working record, written only by the background reflect pass
- `log.jsonl`, rotated logs, and `context.jsonl` are cold storage, not normal working memory; access them through `session_search` when needed

## Development Commands

- `npm run typecheck`
- `npm run test`
- `npm run test:coverage`
- `npm run test:e2e` — deterministic full-stack layer (scripted mock provider, no network, no API cost; runs in well under 90s)
- `npm run test:e2e:live` — the 5-ish real-model smoke cases (follows `~/.pipiclaw/settings.json`; manual / nightly)
- `npm run build`
- `npm run check`

Use `npm run typecheck` and `npm run test` as the minimum validation after non-trivial changes. **Also run `npm run test:e2e` when you change the runtime, memory, delegation, or command plane** — that layer is the only coverage for `runner ↔ session ↔ tools ↔ memory ↔ delivery`, the transport queue, and process/restart behaviour (spec 048).

## Test Layering

Three layers, each with a distinct job. Putting an assertion in the wrong layer is a review defect.

| Layer | Proves | Assertion style | Runs in |
|---|---|---|---|
| unit | one module's branches, edges, contracts | anything fakeable belongs here | `npm run check` |
| e2e (deterministic) | full-stack **mechanism**: cross-module timing, persisted side effects, process/restart, delivery sequencing, guard wiring | observable side effects — disk state, the request body sent to the provider, delivery count/order, audit records, run state. Never the model's wording. | `npm run test:e2e` |
| evals | real-model **behaviour quality** | grader / baseline / gate | `npm run eval` (not a gate) |

e2e hard rules:

1. **Mechanism only.** No assertion on whether the model answered *well* — that is an evals concern. To prove a path never reached the model, assert the model request count is 0.
2. **Assert side effects, not rendered text.** Pinning a literal help/status/reply string makes the test a change-detector; an intentional copy edit then turns the suite red and hides real failures (this is exactly how spec 048 happened).
3. **Timing is test-controlled.** Use the mock provider's `hold`/`release` to build deterministic concurrency windows. No `sleep`, no polling for an event you can control precisely.
4. **Every case names the failure it catches** in a comment — which commit or class of regression. A case that cannot name one is not accepted.
5. **Cheap enough to run every time.** The deterministic layer must pass offline with no credentials; a case that needs the network is in the wrong layer.
6. **Mutation check on the way in.** Before a new deterministic case merges, break the code it guards once, confirm the case goes red, and record that in the case's comment. A case that stays green when its target is broken is not a safety net.

## Engineering Rules

- Preserve the domain boundaries above; prefer moving code into the right module over adding compatibility aliases
- Keep `src/main.ts` thin; startup assembly belongs in runtime bootstrap code
- Keep runtime behavior reliable: queueing, reconnection, persistence, memory maintenance, and delegation settlement are higher priority than cosmetic refactors
- Prefer explicit types over `as any`
- Do not treat tests as optional; runtime, memory, and DingTalk behavior should be covered when changed
- Tests must be valuable — cover logic that can break: branches, edge cases, boundaries, concurrency, contracts, security guards, regressions. Do not add obvious low-value tests: asserting the literal text of a rendered help/status/label string, `new X() instanceof X` smoke checks, echoing a constant, or re-testing a branchless one-line formatter. A test that could only break when someone also intentionally edits the same string is a change-detector, not a safety net — leave it out
- Avoid creating barrel files or re-export shims unless they materially reduce coupling
- Every tool error or truncation output must carry a next-step instruction the model can act on directly (e.g. "Use offset=N to continue", "use the grep tool instead") — errors steer the model rather than just reporting failure
- Reject a bad tool call with `RecoverableToolError` (`src/shared/recoverable-error.ts`) when the model can fix it alone — a missing field, an unknown id, an illegal transition. Throw a plain `Error` only when the user must act or know: a guard refusal, an approval gate, corrupt state, a real fault. Only plain errors reach the user's chat, so the test is "can the model resolve this alone?", not "how severe is it?"
- A tool result's `details` is the runtime's channel (the model reads `content`). `buildToolSet` stamps `kind` from the registration name and that stamp is authoritative — a `kind` written inside a tool is redundant and cannot override it, so the discriminator can never drift from the tool it names. New tools need only return their own fields
- Keep `SubAgentRunManager` the sole owner of settlement, usage, leases, and completion wake; preserve its idempotency markers
- A task parks only on a ticket produced by `resolveTicket`, and every ticket carries a runtime-derived backstop. Never write `ticket` frontmatter directly, and never add a resumption path that bypasses `redeemTicket` — "parked with nothing that can wake it" is the one failure spec 051 exists to make unrepresentable
- Task steps run in the task's own session and are silent by default; only `task_step_end`'s `report` (and the deterministic runtime receipts) reach the channel
- A task is a one-off project the model leads; recurring or scheduled work is an event with a `task` template that spawns an instance per occurrence (spec 052). Verification is the leader's judgement: a `VERDICT` is recorded information, never a runtime gate
- Runtime playbooks are developer-curated and read-only at runtime; put mechanism knowledge there, not in a new runtime-writable carrier
- External agents bypass Pipiclaw's guards. Their role command, CLI sandbox, host account, and environment are the permission boundary; `mutates` is not a sandbox

## User-Facing Copy Conventions

Everything the runtime says to a person follows these rules — slash-command replies, runtime pushes (task receipts, delegation notices, wake failures, busy hints), progress cards, error bubbles and the TUI. They come from the 2026-08-24 command review and were widened to all user copy by [spec 053](docs/specs/053-user-facing-copy/design.md), whose §D4 glossary is the single source of interface terms (等待条件, 最晚检查时间, 任务说明, 工作项, 任务记录, 观察期, 工作日记, 工具调用 …). Design words (等待票, 兜底, 契约, 结算, 墓碑化) stay in specs and model-facing text only.

**Audiences and language.** Three audiences, one language each: users (DingTalk, TUI) read Chinese, keeping only identifiers they type or see in files in English (command names, ids, model refs, paths, frontmatter keys — introduced by a Chinese label, e.g. `类型（type）`); deployers and operators (CLI stdout/stderr, runtime logs) read English, deliberately; the model's text (prompts, tool `content`, step briefs, wake text) is out of scope here.

**Audience isolation.** Model-facing text never reaches a user channel. When two audiences share data, render it twice from the same structure (`renderTaskLogLine` / `renderTaskLogLineForUser`, `renderTaskBoard` / `renderTaskBoardForUser`, a guard refusal's English `message` / its structured `blocked` form). User copy never contains tool names (`read`, `task_create`, `subagent_run` …), prompt tags (`<available_skills>`), call syntax (`op=…`) or producer tags (`TASK_DRIVER`); a next step is always something the user can do — send a message, send a slash command, or (said explicitly) a deployer action on the server.

Shape rules:

1. A reply is one of three shapes: a confirmation (one sentence), a report (a bold headline plus blocks), or an error (one reason + one next step; usage text only on a bad argument).
2. No `#` headings; use a `**bold**` first line as the headline.
3. Only one flat level of `- ` bullets. Never use a 2-space continuation line as a sub-field, never align columns with spaces, never paste a long file/prompt verbatim into a reply (`flattenMarkdownForChat` reshapes quoted markdown).
4. Every report has a length budget — it goes through `capReply` (DingTalk target ≤ 1,500 chars). Over budget, say what command to run next — do not just show more content.
5. Empty state uses one shape: `暂无 X。` plus a one-line "how to start".
6. Runtime pushes carry the id the user acts on (task id, `run_…`) and use four markers only: ✅ done, ⚠️ needs attention, 🛑 stopped, ⏳ in progress (`✕` is reserved for error lines inside a progress card).
7. Text used in more than one place is derived, not copied: the busy hint and `/help` grouping from `availableWhileBusy`, task state labels from `taskStateLabel`, queue replies and `/new` from `commands/catalog.ts`, durations from `formatElapsedZh` / `formatSpanZh`, doc links from `docsUrl`.

`test/user-copy-shape.test.ts` pins these structurally (budget, no indentation, no `#`, no tags or tool names); never assert a literal wording.

**Logs.** Warnings go through `log.logWarn(event, message, { channelId, reason, fields })` with a `<domain>.<object>.<verb>` event name; the message is a fixed `<Subject> failed` sentence and anything variable goes to `reason`/`fields`. A "task" in a log is a long-horizon task; a conversation round is a turn.

## Practical Notes

- Node.js target is `>= 22.19.0`
- DingTalk transport commands are handled in the runtime layer; session commands are handled inside the agent session layer
- Event administration commands (`/events list|show|delete|history`) are runtime-layer commands and must stay path-confined to `workspace/events/` and event history
- The package version lives in `package.json` and the top-level package entry in `package-lock.json`
- Web tools are configured through app-level `tools.json`; security policy is configured through app-level `security.json`
- Workspace skills live only under `workspace/skills/`; do not add channel-scoped skill directories
- The daemon owns durable external-run wake/recovery; TUI does not. `/stop` never cancels dispatched runs

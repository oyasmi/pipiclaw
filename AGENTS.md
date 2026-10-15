# AGENTS.md

## Project

Pipiclaw is a DingTalk-first AI coding assistant runtime built on `@earendil-works/pi-coding-agent`. It adds AI Card streaming, layered memory, scheduled work, per-channel workspaces, and unified delegation to internal agents or external Claude Code, Codex CLI, and custom executors.

## Core Structure

A module is a path under `src/`. Dependencies run strictly downward through the layers below: a module may import only what its "May import" column names (same-layer modules never import each other, and `import type` counts). `scripts/check-architecture.mjs` (`npm run arch`, part of `npm run check`) enforces this table together with file-level cycles, a 800-line file budget, dangling relative paths and file references in this document, `CLAUDE.md` and `docs/architecture.md`. If this table and the script disagree, the script wins — fix this table in the same commit.

| Layer | Module | Path | Owns | May import | Typical files |
|---|---|---|---|---|---|
| 0 | `shared` | `src/shared/` | small helpers with no domain knowledge | — | `serial-queue.ts`, `atomic-file.ts`, `text-utils.ts` |
| 0 | `commands` | `src/commands/catalog.ts`, `reply-limits.ts` | the slash-command catalog and the reply length budget | — | `catalog.ts`, `reply-limits.ts` |
| 1 | `foundation` | `src/log.ts`, `paths.ts`, `executor.ts`, `file-store.ts` | process-wide logging and paths, plus the host I/O ports (`Executor` for commands, `FileStore` for file contents, spec 044) | shared | the four files named |
| 2 | `security` | `src/security/` | command, path and network guards, project scope, audit log | layers 0–1 | `command-guard.ts`, `path-guard.ts`, `network.ts`, `logger.ts` |
| 2 | `usage` | `src/usage/` | usage ledger, usage rendering, `UsageTotals` | layers 0–1 | `ledger.ts`, `render.ts`, `totals.ts` |
| 2 | `tasks` | `src/tasks/` | the one-off task project: contract, waiting tickets, loop log, budget, `/tasks`. Scheduling and wake wiring live in `runtime/task-*.ts` so this module stays a leaf | layers 0–1 | `contract.ts`, `ticket.ts`, `loop-log.ts`, `bound-work.ts`, `commands.ts` |
| 2 | `playbooks` | `src/playbooks/` | read-only runtime playbooks shipped with the package | layers 0–1 | `catalog.ts`, `*.md` |
| 3 | `channel` | `src/channel/` | the transport-neutral channel domain: the delivery and event contracts, identity, persisted state, `/project` | layers 0–1, security | `channel-context.ts`, `channel-event.ts`, `channel-index.ts`, `store.ts`, `commands.ts` |
| 3 | `tools-contract` | `src/tools/contract/` | tool-result `details` contract, how a tool call is shown, the tool-name lists | layers 0–1, security | `details.ts`, `presentation.ts`, `names.ts` |
| 4 | `config` | `src/config/` | `settings.json` and `tools.json` loading and validation | layers 0–1, channel (types only) | `settings.ts`, `tools.ts` |
| 5 | `models` | `src/models/` | model references, the model runtime, API keys, backup-model fallback | layers 0–1, config | `reference.ts`, `runtime.ts`, `fallback.ts` |
| 5 | `web` | `src/web/` | search and fetch clients, extraction | layers 0–1, security, config | `client.ts`, `search.ts`, `fetch.ts` |
| 5 | `skills` | `src/skills/` | workspace skill loading, validation, reading, `/skills` | layers 0–1, security | `loader.ts`, `workspace.ts`, `validation.ts`, `commands.ts` |
| 6 | `memory` | `src/memory/` | channel memory, daily journal, the reflect pass, session search, `/memory` | layers 0–1, channel, config, models, usage | `store.ts`, `reflect.ts`, `scheduler.ts`, `commands.ts` |
| 6 | `events` | `src/events/` | scheduled and sensor events: definitions, validation, the file watcher, `/events`. Never touches task files (spec 052, INV-8) | layers 0–1, channel, security, tasks | `types.ts`, `parse.ts`, `watcher.ts`, `validation.ts`, `commands.ts` |
| 7 | `jobs` | `src/jobs/` | background shell jobs | layers 0–1, channel, tasks | `manager.ts`, `launch.ts`, `record.ts` |
| 7 | `subagents` | `src/subagents/` | role discovery, delegation dispatch, internal and external execution, run lifecycle, leases, `/subagents`. `discovery.ts` is a registered over-long exception: do not grow it | layers 0–1, security, usage, tasks, channel, config, models, memory, tools-contract | `dispatch.ts`, `runs.ts`, `internal/run.ts`, `external/dispatch.ts`, `discovery.ts` |
| 8 | `tools` | `src/tools/` (not `contract/`) | the tools handed to the model: schemas, validation, calls into domain code, `content`/`details` | layers 0–7 | `registry.ts`, `subagent.ts`, `job.ts`, `memory-manage.ts` |
| 9 | `agent` | `src/agent/` | per-channel orchestration: the SDK session, one turn, prompts, session commands | layers 0–8 | `channel-runner.ts`, `session/session-host.ts`, `turn/turn-pipeline.ts`, `prompt/` |
| 10 | `commands-router` | `src/commands/router.ts` | the one dispatch point for stateless report commands, shared by both transports | layers 0–9 | `router.ts` |
| 10 | `app` | `src/app/` | the process shell: app-home scaffolding, CLI args, shared services, LLM proxy, `pipiclaw auth` | layers 0–9 | `home.ts`, `services.ts`, `proxy.ts`, `auth-command.ts` |
| 11 | `dingtalk` | `src/dingtalk/` | the DingTalk Stream transport: connection, AI cards, media, inbound routing, `channel.json` | layers 0–10 | `bot.ts`, `handler.ts`, `cards.ts`, `connection.ts`, `delivery.ts`, `config.ts` |
| 11 | `tui` | `src/tui/` | the terminal front end: the second `ChannelContext` implementation | layers 0–10 | `app.ts`, `frontend.ts` |
| 12 | `runtime` | `src/runtime/` | the daemon: composition root and the services that join several subsystems | everything except `tui` | `bootstrap.ts`, `turn-handler.ts`, `shutdown.ts`, `durable-dispatch.ts`, `task-driver.ts` |
| — | `entry` | `src/main.ts`, `src/index.ts` | the executable entry and the public library surface (spec 035) | any | `main.ts`, `index.ts` |

`src/index.ts` is a compatibility promise: its exported names stay stable. Everything else under `src/` is internal and its import paths may change.

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
- `npm run arch` — module dependency, cycle, file-size and path-reference checks (see Core Structure)
- `npm run test`
- `npm run test:coverage`
- `npm run test:evals` — offline eval-tooling checks, including the actual worker with a mock provider
- `npm run eval` — read-only daily evaluation plan; `npm run eval -- cycle` executes autonomous real-model probes
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
| evals | real-model **behaviour quality** | grader / baseline / gate | `npm run eval -- run` (not a gate) |

### Behavior-eval iteration

When changing model-facing prompts/playbooks, tool guidance, memory recall strategy, or task/delegation decisions, plan the affected behavior probes (`npm run eval -- plan --changed-since <ref>`) and run the relevant dev cases with the configured local model when credentials are available. Record the run id, failures and their attribution; unavailable credentials or execution are not a quality pass. A pure code move does not require paid probes. Changes to `evals/` require `npm run test:evals`.

Use the six-case dev set for daily feedback, core for periodic/release regression, and paired candidate runs for model or major prompt decisions. Smoke is not a baseline. Preserve failed evidence and distinguish product failures from fixture/oracle/provider problems; correcting an oracle creates a separate assessment or run, never overwrites the failure. Every paid run first checks executable positive, negative and equivalence controls; failed controls stop before model calls and uncovered cases remain inconclusive. Use `cycle` for automatic diagnostics, sealed-evidence replay and compatible immutable references. Model judges are optional advisory opinions, off by default; human labels or approval are never prerequisites. New automatic references live in ignored `evals/results/references/` so they cannot alter the checkout fingerprint. See [the evaluation guide](docs/evals.md) for commands and limits.

### Unit-test admission and size control

Test count and fixture code are maintenance costs, not quality targets. **Default to no net growth in unit-test cases for an existing feature.** First extend the closest valuable scenario or replace a weaker case; do not merge unrelated failure modes merely to lower the reported count. A new failure mode may justify growth, but the change description must name the risk, explain why existing unit/e2e coverage cannot catch it, and report the case-count delta. Do not chase line or branch coverage percentages.

Before adding a case, identify a plausible incorrect implementation that would make it fail and the resulting project impact. If the only failure is an intentional wording, template value, field order, private helper, or file-layout change, omit the case. For a pure move, split, rename, or dependency-injection refactor such as spec 054, update existing imports/fixtures and run the architecture/e2e gates; do not add one test per extracted collaborator.

Do not test a constant against a copied constant, a getter/setter with no domain decision, a forwarding adapter against an echoing mock, or third-party behavior recreated by a test-owned setup. Do not mirror the same input/output matrix at the domain, adapter, and runtime layers. Keep the matrix in its owning domain; use only distinct wiring/guard tests above it, with full-stack mechanism in deterministic e2e. Exact text is warranted for machine-consumed protocols, persisted data, escaping, and actionable identifiers — ordinary copy is covered structurally by the shared user-copy suite.

Keep concurrency, recovery, persistence integrity, accounting/idempotency, security boundaries, and meaningful parser/budget edge cases even when they are small or expensive. Pruning removes low-value cases and unused fixtures rather than skipping tests, reducing discovery scope, increasing timeouts, or weakening required checks. The [2026-10-13 audit](docs/reviews/2026-10-13-unit-test-pruning.md) records this cleanup and its retained coverage.

e2e hard rules:

1. **Mechanism only.** No assertion on whether the model answered *well* — that is an evals concern. To prove a path never reached the model, assert the model request count is 0.
2. **Assert side effects, not rendered text.** Pinning a literal help/status/reply string makes the test a change-detector; an intentional copy edit then turns the suite red and hides real failures (this is exactly how spec 048 happened).
3. **Timing is test-controlled.** Use the mock provider's `hold`/`arrived`/`release` to build deterministic concurrency windows. No `sleep`, no polling for an event you can control precisely.
4. **Every case names the failure it catches** in a comment — which commit or class of regression. A case that cannot name one is not accepted.
5. **Cheap enough to run every time.** The deterministic layer must pass offline with no credentials; a case that needs the network is in the wrong layer.
6. **Mutation check on the way in.** Before a new deterministic case merges, break the code it guards once, confirm the case goes red, and record that in the case's comment. A case that stays green when its target is broken is not a safety net.

**E2E admission and size control.** Existing features default to no net growth in deterministic cases too: replace a weaker scenario or extend the relevant chain first. Any growth must name a cross-module failure that existing unit/e2e cases cannot catch, explain its impact, report the case-count delta, and include a mutation check. A direct domain call with fake wake/notify proves domain behavior, not bootstrap wiring; test the real producer → runtime → consumer path for that claim. Same-process `restart()` proves graceful runtime reinitialization; a process/crash claim requires a separate daemon whose old callbacks are gone. Wait for persistence/settlement completion, not just provider arrival or a state value that was already true before the action. Keep deterministic fixtures offline for their whole lifetime, including lazily created registries and shutdown maintenance. `npm run test:e2e` builds first so the process fixture runs current code. [E2E review](docs/reviews/2026-10-13-e2e-test-review.md) records the 55-case audit.

## Engineering Rules

- Preserve the domain boundaries above; prefer moving code into the right module over adding compatibility aliases. `npm run arch` enforces them: when it fails, fix the dependency (move the code, or define an interface in the lower layer and inject the implementation). The baseline in `scripts/architecture-baseline.json` may only shrink — never add an exception, and never use `--init` again. A new top-level directory needs an entry in both `scripts/check-architecture.mjs` and the table above
- Where new code goes: first the module table (the lowest layer that can own the state or behaviour), then the naming conventions — kebab-case files that do not repeat their directory (`events/commands.ts`, not an `event-commands` file inside `events/`); `<domain>/commands.ts` for a domain's slash-command handlers; `tools/<name>.ts` for model-facing tool adapters; a domain type that its own implementation files import goes in `types.ts` to avoid a cycle; never a catch-all `utils` or `helpers` file — name the file for its content; no re-exports or compatibility aliases when a file moves
- `tools/<name>.ts` is an adapter: parameter schema, validation (throwing `RecoverableToolError` where the model can fix it), a call into domain code, and the `content`/`details` it returns. Persistence, state machines, scheduling and policy live in the domain directory, which imports only `tools/contract/`, never `tools/`. The delegation tools follow the same rule: `tools/subagent.ts` adapts, `subagents/` dispatches and executes
- Keep `src/main.ts` thin; startup assembly belongs in `runtime/bootstrap.ts`
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
- A slash command has three parts, each in a fixed place: the catalog entry in `commands/catalog.ts`, the handler in the domain that owns the state (`<domain>/commands.ts`), and — for a stateless report — one case in `commands/router.ts`, which both transports share. Session commands (`/model`, `/compact`, …) live in `agent/session/command-extension.ts`. Adding a `/foo` report means touching exactly those three files
- Event administration commands (`/events list|show|delete|history`, `events/commands.ts`) must stay path-confined to `workspace/events/` and event history
- The package version lives in `package.json` and the top-level package entry in `package-lock.json`
- Web tools are configured through app-level `tools.json`; security policy is configured through app-level `security.json`
- Workspace skills live only under `workspace/skills/`; do not add channel-scoped skill directories
- The daemon owns durable external-run wake/recovery; TUI does not. `/stop` never cancels dispatched runs

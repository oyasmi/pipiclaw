# 024 — Task Loop v2

| Field | Value |
|---|---|
| Status | IMPLEMENTED in 0.8.0 |
| Goal | Convert bounded model attempts into durable, verified task progress without turning Pipiclaw into a workflow platform. |

## Product contract

Pipiclaw remains a file-native, single-process personal runtime. A long task is readable as Markdown and may be repaired by a human, while the runtime owns deterministic wake, queue recovery, budgets, and close-out gates.

The important promise is **at-least-once work recovery with bounded token spend**. It does not promise distributed exactly-once execution, an approval system for hostile agents, or a general DAG engine.

## Loop

```text
wake / event / user run
  -> durable dispatch record
  -> task-driver claim + bounded attempt
  -> Task Capsule + one concrete agent step
  -> atomic task checkpoint
  -> continue / wait / verify / pause / escalate
```

- `wake` is the normal continuation condition.
- `state/dispatch/*.json` is a durable outbox for synthetic task and event work. A queued/running record has a lease; expired records replay after restart.
- A task driver dispatch carries a compact capsule: title, status, latest checkpoint, next action, and attempt budget. The agent must still read the complete task file before acting.
- `progress` is semantic only. Runtime usage accounting never counts as task progress, so no-progress work receives the stalled backoff.

## Task lifecycle

```text
open / in-progress <-> awaiting-user / blocked
                         |
                       paused --resume--> in-progress
                         |
candidate -> verifying -> PASS -> done
                       \-> FAIL -> in-progress
```

`task_manage candidate` requires every DoD/Verification checkbox to be checked and turns the following driver wake into a checker-only turn. The verifier is a fresh `purpose=verify` subagent. It may inspect and run checks but must not edit implementation files.

Verifier evidence binds the task body plus, in host Git workspaces, a subject hash containing HEAD, status, staged diff, and unstaged diff. `verify` and `done` reject a stale subject.

## Recurring work

A completed recurring task starts a new named cycle through `task_manage start-cycle`. The operation moves visible current-cycle notes into History and clears cycle-scoped attempts, token/cost/wall-time usage, approval, verification, and worktree metadata. It intentionally does not create concurrent cycles: an unfinished old cycle must first be completed, cancelled, or explicitly repaired.

## Operator controls and observability

- `/tasks pause <id>` is a durable stop. `/stop` during a task-driver run performs this pause before aborting the current model turn.
- `/tasks resume <id>` makes a paused task ready again.
- `/tasks run <id>` persists and immediately queues a ready attempt in DingTalk; without a daemon it leaves the task ready and tells the operator to continue with a normal prompt.
- `/tasks stats [id]` reports bounded operational facts—attempts, tokens, cost, wall time, last outcome, and verifier state—without invoking the model.

## Deliberate non-goals

1. No database, workflow DSL, distributed scheduler, or exactly-once protocol.
2. No automatic parallel swarm: channels stay serial; worktree subagents remain opt-in.
3. No cryptographic approval or adversarial security claims. Runtime-managed commands prevent accidental control-state edits, while task Markdown remains intentionally human-repairable.
4. No automatic skill promotion for every task. Completion review should improve the task Manual first; workspace skills are promoted only for repeated, reusable lessons.

## Required tests

- usage accounting cannot defeat stalled backoff;
- paused tasks are not driver-actionable and `/stop` pauses a driver task;
- recurring cycles reset cycle-scoped state;
- queue rejection, process restart, lease expiry, and completion exercise durable dispatch;
- stale verifier body/artifact subjects are rejected;
- task commands remain zero-LLM runtime operations.

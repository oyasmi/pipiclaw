# Pipiclaw

[简体中文](./README.md) | **English**

**Turn DingTalk into an AI engineering entry point that keeps working.**

Pipiclaw is an AI coding assistant runtime for individuals and teams. It lets an AI assistant do more than answer a single question: it stays in your DingTalk, understands context, operates your workspace, remembers long-term conventions, keeps tasks moving on a plan, and delegates the heavy lifting to Claude Code, Codex CLI, or your own executor.

What you see is one assistant, but behind it can be a well-divided AI engineering team: the main agent owns understanding goals and delivering results, lightweight sub-agents handle retrieval and triage, and external agents handle cross-file implementation, independent review, and verification runs. All work has state, artifacts, and control entry points, instead of being scattered across a few terminal windows as throwaway conversations.

- npm: [`@oyasmi/pipiclaw`](https://www.npmjs.com/package/@oyasmi/pipiclaw)
- Runtime: Node.js `>= 22.19.0`, Linux / macOS; on Windows use WSL2
- License: [GNU AGPL v3](./LICENSE)

## Why Pipiclaw

### One entry point, coordinating multiple agents

Pipiclaw supports two kinds of delegation at once: built-in sub-agents do lightweight work in-process such as retrieval and log triage; external agents launch real Claude Code, Codex CLI, or any script to handle heavy tasks that need long runs, many files, and repeated self-testing.

In DingTalk daemon mode, external tasks keep running in the background after dispatch and automatically wake the originating channel on completion. You can use `/subagents` at any time to check run status, the actual command, and outputs, use `/subagents cancel` to terminate directly, and let the main agent keep asking follow-up questions on a finished Claude Code / Codex session. The repo ships planner, builder, reviewer, verifier, and documenter role templates that are ready to adapt.

### Work does not end when a conversation ends

Every session has its own current state, long-term memory, and history summary. The task ledger persists goals, done criteria, progress, next steps, and verification records to Markdown files; the built-in task driver resumes work at the right time — continuing when there is progress, backing off when stalled, and stopping and telling you when a boundary is crossed.

### Natively at home in DingTalk

Pipiclaw uses DingTalk Stream Mode, so no self-hosted message relay or public IP is needed. AI Cards can continuously show thinking, tool execution, and status updates; while a task runs you can still use `/steer` to adjust direction, `/followup` to queue the next thing, and `/stop` to abort the current turn. Generated reports, screenshots, and exported files can be delivered as native DingTalk attachments.

A single bot instance can serve many direct and group chats at once: DMs get a channel per user, groups get a channel per group, and model turns in different channels can progress in parallel; within one channel turns run serially so one conversation's context is not modified by multiple turns at once. Note that session isolation is not code-directory isolation; if several channels point at the same project directory, you should still avoid having the main agent edit the same set of files concurrently, or prepare separate Git worktrees for parallel implementation. See [Scaling and concurrency](https://github.com/oyasmi/pipiclaw/blob/main/docs/scaling-and-concurrency.md) for the full boundaries.

### Autonomous, and always interruptible

Scheduled events are good for reminders, periodic checks, and zero-token conditional sensors; the task ledger is good for long-running work that spans hours and sessions. Runtime status, model usage, tasks, memory, and delegation runs all have control commands that do not go through the LLM, so even when the model is unavailable or the current turn is stuck, you can still inspect and intervene.

### Your config, data, and way of working

Models support built-in providers, OpenAI-compatible gateways, API keys, and subscription login. Memory, tasks, roles, events, and team rules are all stored in human-readable files on your machine. Pipiclaw provides command, path, and network guards plus an audit log; when you need stronger isolation, you can put the whole process in its own account or container.

## What it's good for

- Providing an always-online dev assistant, internal tech support, or ops collaboration entry point in DingTalk
- Handing requirement analysis, implementation, review, verification, and documentation to different AI agents working together
- Following up on coding, investigation, migration, reporting, and periodic work that spans hours or days
- Keeping mutually isolated context and memory across many group and direct chats
- Reusing existing model gateways, Claude Code / Codex CLI accounts, and team working conventions

Pipiclaw today targets individuals and small teams, self-hosted, single-instance. It is not a hard multi-tenant SaaS, and it does not provide an OS-level sandbox; the real permissions an external agent holds are determined together by the target CLI's sandbox parameters, the run account, and the host environment.

## Quick start

Below are three progressive paths: verify a model in the terminal first, then connect DingTalk, then enable external agents. If you already have a clear goal, jump straight to the relevant part.

### 1. Install and confirm the CLI

```bash
npm install -g @oyasmi/pipiclaw
pipiclaw tui --help
```

The first real start of `pipiclaw` or `pipiclaw tui` creates:

```text
~/.pipiclaw/
├── channel.json      # DingTalk app
├── auth.json         # model credentials
├── models.json       # custom model providers
├── settings.json     # default model and runtime settings
├── tools.json        # capability switches for web tools, tasks, etc.
├── security.json     # command, path, and network guards
└── workspace/        # memory, tasks, events, skills, agent roles, and channel data
```

Set `PIPICLAW_HOME=/your/path` to relocate this directory as a whole.

### 2. Fastest taste: get it working in the terminal first

Terminal mode needs no DingTalk credentials, only a working model. Pick either way:

```bash
# Option A: use an API key
export ANTHROPIC_API_KEY=sk-ant-...

# Option B: log in to a subscription provider supported by the SDK
pipiclaw auth login
```

Then start:

```bash
pipiclaw tui
```

It can also be used for scripted one-shot requests:

```bash
pipiclaw tui --print "Review the current project and give me the three highest-priority risks"
```

To connect an enterprise gateway, a local model, or set a default model, see [Configuration reference](https://github.com/oyasmi/pipiclaw/blob/main/docs/configuration.md).

### 3. Connect DingTalk

Create an enterprise internal app on the [DingTalk Open Platform](https://open-dev.dingtalk.com/):

1. Get the `Client ID` and `Client Secret`
2. Enable the bot capability
3. Enable Stream Mode
4. Recommended: create an AI Card template and get its `Card Template ID`

Edit `~/.pipiclaw/channel.json`:

```json
{
  "clientId": "your-dingtalk-client-id",
  "clientSecret": "your-dingtalk-client-secret",
  "robotCode": "",
  "cardTemplateId": "",
  "cardTemplateKey": "content",
  "allowFrom": []
}
```

- The only hard-required fields are `clientId` and `clientSecret`.
- When `robotCode` is empty it falls back to `clientId`.
- `cardTemplateId` can be left empty for now; configuring an AI Card is recommended for real use.
- `allowFrom: []` means all senders are allowed; during a limited rollout, fill in tester staff IDs.
- The file must not keep any `your-*` placeholder values.

Start the daemon:

```bash
pipiclaw
```

In DingTalk, send `/model` first to confirm the model is available, then send:

```text
Please introduce yourself and explain what you can do right now
```

If the first message does not succeed, start from [Deployment and operations](https://github.com/oyasmi/pipiclaw/blob/main/docs/deployment-and-operations.md).

### 4. Enable external agent delegation

First install and log in to the target CLI under the same account that runs Pipiclaw, then copy the roles you need. The example below enables both a Claude Code builder and a Codex reviewer:

```bash
mkdir -p ~/.pipiclaw/workspace/sub-agents
PIPICLAW_PACKAGE_DIR="$(npm root -g)/@oyasmi/pipiclaw"
cp "$PIPICLAW_PACKAGE_DIR"/examples/sub-agents/{builder,reviewer}.md \
  ~/.pipiclaw/workspace/sub-agents/
```

Role file changes are rediscovered at runtime. Send:

```text
/subagents roles
```

Once the roles show as available, you can describe a goal and name a role directly:

```text
Please hand this cross-module implementation to the builder, and once it's done have the reviewer check it independently.
```

Common control entry points:

```text
/subagents                         # running and recently completed delegations
/subagents show <runId>            # status, actual argv, artifact directory, stderr
/subagents output <runId>          # view text output
/subagents cancel <runId|all>      # terminate directly, not through the model
/subagents roles [name]            # view the role directory and a single role's config
```

External agents do not go through Pipiclaw's command and path guards. Before using the example roles, read the authorization, security boundary, and sandbox notes in the [Agent delegation guide](https://github.com/oyasmi/pipiclaw/blob/main/docs/sub-agents.md).

Long-running external delegations should run in the DingTalk daemon; the TUI currently does not provide completion notifications for external runs or re-adoption after exit.

### 5. Optional: enable web tools

`web_search` / `web_fetch` are off by default. Edit `~/.pipiclaw/tools.json`, set `tools.web.enable: true`, and configure a search provider. DuckDuckGo, Brave, Tavily, Jina, and SearXNG are supported; see [Configuration reference](https://github.com/oyasmi/pipiclaw/blob/main/docs/configuration.md) for the full fields.

<details>
<summary>Let your favorite AI agent install it for you</summary>

Hand the following request to Claude Code, Codex, or another local AI agent:

```text
Please install and initialize Pipiclaw for me:

1. Check Node.js >= 22.19.0; stop and explain if it is not met.
2. Run npm install -g @oyasmi/pipiclaw; on a permission failure do not sudo on your own.
3. Run pipiclaw once to initialize ~/.pipiclaw/; it prompting you to complete channel.json and exiting because it is still a template is normal.
4. Ask me whether I want to use an API key, a custom provider, or a subscription login supported by pipiclaw auth login; do not invent missing values.
5. If I want to connect DingTalk, collect clientId, clientSecret, optional cardTemplateId, and allowFrom item by item, write them into channel.json, and remove all your-* placeholder values.
6. When configuration is done, ask first whether to start. Terminal mode uses pipiclaw tui; DingTalk mode uses pipiclaw.
7. Honestly list the operations performed, files changed, verification results, and information still missing; do not pretend it succeeded.
```

</details>

## Common commands

| Command | Purpose |
|---|---|
| `/help` | Full command help for the current version |
| `/stop` | Stop the current turn; a task-driven turn also pauses its task |
| `/steer <message>` | Adjust the running turn |
| `/followup <message>` | Queue the next request |
| `/status` | Execution status, model, context, uptime, and version |
| `/usage [7d\|month]` | Model usage and cost for this channel and globally |
| `/tasks ...` | View, diagnose, and control long-running tasks |
| `/subagents ...` | View and control delegation runs and the role directory |
| `/memory ...` | View this channel's long-term memory |
| `/model [ref]` | View or switch the model |

`/help`, `/stop`, `/steer`, `/followup`, `/events`, `/tasks`, `/status`, `/usage`, `/context`, and `/subagents` are handled directly by the runtime and work mid-turn. `/stop` does not cancel an already dispatched delegation run; use `/subagents cancel`.

See [Interaction and commands](https://github.com/oyasmi/pipiclaw/blob/main/docs/interaction-and-commands.md) for full interaction details.

## Documentation

The full index is at **[docs/README.md](https://github.com/oyasmi/pipiclaw/blob/main/docs/README.md)**. Good starting points:

| I want to understand | Doc |
|---|---|
| DingTalk, TUI, AI Card, and control commands | [Interaction and commands](https://github.com/oyasmi/pipiclaw/blob/main/docs/interaction-and-commands.md) |
| Claude Code / Codex / built-in sub-agent delegation | [Agent delegation](https://github.com/oyasmi/pipiclaw/blob/main/docs/sub-agents.md) |
| Configuring models, tools, and the workspace | [Configuration reference](https://github.com/oyasmi/pipiclaw/blob/main/docs/configuration.md) |
| Memory, scheduled events, and long-running tasks | [Memory](https://github.com/oyasmi/pipiclaw/blob/main/docs/memory.md) · [Events and tasks](https://github.com/oyasmi/pipiclaw/blob/main/docs/events-and-tasks.md) |
| Default security boundaries and external agent authorization | [Security guide](https://github.com/oyasmi/pipiclaw/blob/main/docs/security.md) |
| Deployment, upgrades, backup, and troubleshooting | [Deployment and operations](https://github.com/oyasmi/pipiclaw/blob/main/docs/deployment-and-operations.md) |
| The concurrency model and capacity limits for many groups and DMs | [Scaling and concurrency](https://github.com/oyasmi/pipiclaw/blob/main/docs/scaling-and-concurrency.md) |

## Development

```bash
npm install
npm run build
npm run check    # lint + typecheck + deadcode + test
```

Minimal verification: `npm run typecheck` and `npm run test`. Real-model E2E uses `npm run test:e2e` and is not part of the daily unit tests.

## License

GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).

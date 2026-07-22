# Example workspace sub-agents

These files are examples, not runtime defaults. Copy the ones you want into
`~/.pipiclaw/workspace/sub-agents/` and edit them to match your project:

```bash
cp examples/sub-agents/{explorer,researcher,verifier,git-committer}.md ~/.pipiclaw/workspace/sub-agents/
```

The four templates cover the common delegation shapes:

- **explorer** — read-only codebase mapping (locate, trace, summarize).
- **researcher** — external information gathering with source attribution.
- **verifier** — independent, read-only acceptance check (`purpose: verify`).
- **git-committer** — turn pending changes into clean, well-described commits,
  isolating the context-heavy diff review from the main conversation.

Pipiclaw only loads Markdown files that actually exist in the workspace
`sub-agents/` directory. An empty directory is valid; inline delegation with
`systemPrompt` remains available. `purpose: verify` is enforced by the runtime
and does not require a file named `verifier`.

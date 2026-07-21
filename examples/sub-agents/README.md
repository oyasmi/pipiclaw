# Example workspace sub-agents

These files are examples, not runtime defaults. Copy the ones you want into
`~/.pipiclaw/workspace/sub-agents/` and edit them to match your project:

```bash
cp examples/sub-agents/{explorer,researcher,verifier}.md ~/.pipiclaw/workspace/sub-agents/
```

Pipiclaw only loads Markdown files that actually exist in the workspace
`sub-agents/` directory. An empty directory is valid; inline delegation with
`systemPrompt` remains available. `purpose: verify` is enforced by the runtime
and does not require a file named `verifier`.

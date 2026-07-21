# Workspace-only sub-agents

## Decision

Pipiclaw does not bundle default sub-agent definitions. Runtime discovery scans
only `workspace/sub-agents/*.md`; the directory contents are the complete named
sub-agent catalog for that workspace.

The former `explorer`, `researcher`, and `verifier` definitions are maintained as
copyable templates in `examples/sub-agents/`. They are not loaded automatically.
Inline delegation remains valid when the directory is empty, and the
`purpose: verify` runtime protocol remains independent of any agent name.

## Rationale

- One predictable source of truth is easier to inspect and version.
- Users can edit role prompts without package upgrades silently changing behavior.
- Discovery no longer needs package-resource lookup, precedence, override warnings,
  or built-in disable markers.
- The sub-agent execution, isolation, budget, and verification machinery remains
  unchanged.

## Migration

Users who want the former roles can copy the templates:

```bash
cp examples/sub-agents/{explorer,researcher,verifier}.md ~/.pipiclaw/workspace/sub-agents/
```

Removing a file removes that named role. No `enabled: false` marker is needed.

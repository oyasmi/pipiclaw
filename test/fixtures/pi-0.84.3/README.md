# pi 0.84.3 sessions

Generated offline with the published `@earendil-works/pi-coding-agent@0.84.3`
SessionManager, before upgrading the dependency. Headers, entry IDs, timestamps and
cwd were normalized to fixed fixture values; message content and entry relationships
come from the old writer. No credentials or real project paths are included.

- `chat.jsonl`: OLD_HISTORY / OLD_ANSWER, medium thinking, e2e-mock/mock-main.
- `branch.jsonl`: compaction at KEPT_HISTORY, FIXTURE_SUMMARY; branch includes
  DISCARDED_BRANCH / BRANCH_ANSWER but excludes DISCARDED_ANSWER.
- `fork.jsonl`: old SDK createBranchedSession of the active branch, with parent provenance.
- `task.jsonl`: independent task transcript with fulfilled fixture-tool and TASK_TOOL_RESULT.
- `interrupted.jsonl`: unsuccessful INTERRUPTED_INPUT, raw error and usage retained.
- `azure.jsonl`: historical azure-openai-responses/fixture-deployment metadata;
  current deployment settings must explicitly select azure/fixture-deployment.

Tests consume these committed files without installing the old SDK or using a network.
New context_edit/system semantics do not imply that the old SDK can safely read new sessions.

Regenerate explicitly (never during tests):
`node test/fixtures/pi-0.84.3/generate.mjs /path/to/isolated-0.84.3-install`.
The generator verifies the old package version; harness seeding relocates only the header cwd.

# Channel Memory

## Identity / Participants
- User speaks Chinese, calls me "Ki"

## Preferences
- **Role: project manager, not a task forwarder**. When delegating with `subagent` I own the result:
  - give the agent well-scoped context, fill gaps proactively
  - capture/inspect regularly to track progress; step in when stuck
  - check the output myself; send it back if it is not good enough
- User wants the daily news briefing to cover world affairs, tech, and markets, in simplified Chinese. <!--id:m-72a97ee9-->
- The daily project review runs in report-only mode: no code, config, or docs changes. <!--id:m-7f252e91-->

## Constraints
- External subagent availability follows the discovery state under `workspace/sub-agents/`; do not silently fall back. <!--id:m-ee8052dc-->
- The claude CLI is installed at ~/.local/bin/claude; the ClaudeCode template is usable. Prior constraint is outdated. <!--id:m-bcd19304-->

## Ongoing Work
- The demo project source lives at ~/projects/demo/; most projects are under ~/projects/. <!--id:m-4cfb7bba-->
- Demo has an unfixed P1 redirect credential-leak risk that still needs tracking. <!--id:m-690272b3-->

## Decisions
- Project scope is decided jointly by the security policy and each channel's project.json; removed dirs fail closed. <!--id:m-45ee7b84-->

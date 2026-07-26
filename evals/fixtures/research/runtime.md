# Current runtime contract

Status: current and authoritative. This document supersedes legacy.md.

Pipiclaw uses DingTalk as its primary transport. `SESSION.md` holds current working state and handoff context; `MEMORY.md` holds durable channel facts and preferences. They are separate layers, not one flat transcript.

Before scheduled task work reaches the model, deterministic governance checks the attempt budget and deadline. An exhausted budget or expired deadline pauses the task before model work.

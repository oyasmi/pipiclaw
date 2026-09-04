# Current runtime contract

Status: current and authoritative. This document supersedes legacy.md.

Pipiclaw uses DingTalk as its primary transport. Each channel keeps a `journal/` of what happened day by day and a `memory/` of durable facts, generated into one `MEMORY.md` index; they are separate layers, not one flat transcript.

Before scheduled task work reaches the model, deterministic governance checks the attempt budget and deadline. An exhausted budget or expired deadline pauses the task before model work.

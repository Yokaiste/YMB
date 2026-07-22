# Agent Skills

Create `.agents/skills/<skill-name>/SKILL.md` when a hard task yields a reusable, verified
procedure. A skill is warranted when following the procedure saves meaningful research or avoids
a known WARNO/YMB hazard; ordinary one-command tasks do not need one.

Use this compact shape:

```markdown
---
name: skill-name
description: When an agent should use this procedure.
---

# Skill title

## Inputs

Required files, state, and assumptions.

## Procedure

Ordered, reproducible steps using repository-relative paths.

## Validation

Commands or observations that prove success.

## Pitfalls

Known failure modes and safe recovery.
```

Keep a skill narrow and deterministic. Prefer repository tools and public YMB APIs. Do not embed
secrets, local absolute paths, copied generated data, or a compatibility workaround that the
codebase should remove. Update or delete stale skills immediately.

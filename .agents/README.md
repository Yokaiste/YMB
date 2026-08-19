# Agent Knowledge

Guidance for future agents that is too implementation-specific for the public YMB docs.

- `memories/`: constraints that survive being fixed — things that will still be true tomorrow.
- `skills/`: reusable procedures, one `<skill-name>/SKILL.md` per skill.
- `suggestions/`: improvements worth making that need a human decision first.

Anything a user or public API consumer needs belongs in `README.md` or `docs/` instead, and
mod-specific guidance belongs in that mod's README.

Never store credentials, personal data, unverified theories, generated output, or machine-specific
absolute paths here. Keep every path repository-relative.

**Update or delete an entry in the same change that makes it stale.** A wrong entry costs more than
a missing one.

## The bar for adding anything

This directory is small on purpose. Before adding a file, the honest question is whether the work
is done:

| You found                                    | Do this                                        |
| -------------------------------------------- | ---------------------------------------------- |
| A bug                                        | **Fix it and add the test.** Never record it.  |
| An improvement that breaks nothing           | **Implement it and test it.** Never record it. |
| An improvement that would break something    | `suggestions/`, `Status: proposed`             |
| Work the user explicitly parked for later    | `suggestions/`, `Status: deferred`             |
| A constraint that remains true after the fix | `memories/`                                    |
| A procedure worth repeating exactly          | `skills/`                                      |

A note describing a defect is a defect that shipped. Running out of turn is not a reason to write
one: finish the fix, or tell the user what is left. **Only the user parks work** — an agent may
open a `deferred` entry when they said so, never to excuse an unfinished change.

## Memories

Add one only when difficult work reveals a constraint that outlives the change: a rule the platform
or the game data imposes, an invariant two pieces of code must both honour, a measurement that
settles a design argument. A fact the code states plainly does not need an entry, and neither does
anything already in `AGENTS.md`.

Name the file `YYYY-MM-DD-topic.md` when it comes from a specific investigation, or `topic.md` when
it describes standing behavior. Link related entries with a relative Markdown link.

```markdown
# Descriptive title

Last verified: YYYY-MM-DD
Relevant paths: `relative/path`, `another/path`

## Finding

The durable constraint.

## Why it matters

The decision or risk it settles.

## How to verify

The smallest command or inspection that confirms it.
```

Prefer one verified sentence over a paragraph of context. Do not bump `Last verified` for content
you did not re-check.

## Skills

Add one when a hard task produces a reusable, verified procedure that saves real research time or
avoids a known WARNO/YMB hazard. A routine one-command task does not need a skill.

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

Keep skills narrow and deterministic, and prefer repository tools and public YMB APIs over
one-off commands.

## Suggestions

Two kinds of entry live here, and the `Status:` line says which.

**`proposed`** — an improvement worth making that you must not make alone, because it changes a
command, a config schema, the script API, a generated contract, or the output an existing source
mod depends on.

**`deferred`** — work the user explicitly postponed. Write it so the next session can start
without repeating your investigation: what you already checked, what you found, and where the
work stops.

Name the file `topic.md`. Delete it once the work lands or the user rejects it.

```markdown
# What to change

Status: proposed | deferred
Raised: YYYY-MM-DD
Relevant paths: `relative/path`

## Today

The current behavior, and the concrete cost of keeping it. For deferred work, what is already
verified — so nobody re-derives it.

## Proposed

The end state, specifically enough to implement without rediscovering it.

## What breaks

Commands, configs, APIs, docs, tests, and source mods that would have to change, and whether they
can be migrated. Write `nothing` when that is the answer.

## Why it is here

For `proposed`, why it cannot simply be implemented and tested. For `deferred`, when the user
parked it.
```

One item per file, and only for something you would start today if it were allowed.

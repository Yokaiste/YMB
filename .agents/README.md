# Agent Knowledge

This directory stores durable guidance that is useful to future agents but too implementation-
specific for the public YMB documentation.

- `memories/`: verified facts, hazards, and debugging discoveries.
- `skills/`: repeatable procedures, one directory and `SKILL.md` per skill.

Use these only for knowledge worth maintaining. User-facing behavior and supported public
contracts still belong in `README.md` or `docs/`; mod-specific public guidance belongs in the
mod's README. Never store credentials, personal data, unverified theories, generated output, or
machine-specific absolute paths here.

When an entry becomes wrong, update or delete it in the same change that invalidates it.

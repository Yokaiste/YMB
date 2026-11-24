# YMB agent rules

This checkout contains the builder. Mod projects in `mods/` own their gameplay
rules and persistent identities. Change mod projects only when the user includes them in the task. The current development YSM is mods/YSM; production remains a read-only reference.

Read affected code, the project's AGENTS.md, and public contracts before editing. Read [.agents/README.md](.agents/README.md) for shared implementation constraints. Use the smallest complete
change, existing mechanisms, and standard-library facilities first. Keep input
validation, ownership, saved originals, interruption recovery, and memory bounds.
Keep one implementation for each shared behavior. Merge equivalent paths and use
them in every caller; retain differences only when a concrete contract needs them.
The shared UI in src/ymb/src/ui.rs owns the design language for YMB, deploy,
and development commands. Reuse its menus, prompts, diagnostics, reports, and
progress renderer. Sync is the reference: declare the real stages before work,
advance at stage boundaries, and send transient details through ui::phase.
Only successful work may receive a completion marker. Omit writes during dry
runs and stages that do not apply; extend the plan after discovery when needed.
Mark failed attempts explicitly and reset their status before a retry.
YMB and Dev.bat prepare files locally. Uploading artifacts and creating remote
releases belong to the separate GitHub workflow, never to the executable or
development frontend. Describe local operations as saving or replacing files.
Keep progress on stderr, JSON silent, redirected output plain, and input blocked
only while unattended work runs. PowerShell launches the development frontend;
it must not implement another menu, status renderer, or command workflow.
New logic needs a focused behavior test. Do not commit or publish without a request.

The directory containing ymb.mod.yaml is the mod's operational root. Keep reusable
generator binaries, receipts, licenses, identities, and generated persistent files
in its .ymb folder. Keep dist beside that config. Mod session files, compiler work,
and SDK result caches belong in YMB/.ymb/mods/ID; use the shared storage paths.
Default mod archives contain the config tree, including .ymb, and explicit
release.include paths relative to the enclosing project folder. Download URLs
point directly to HTTPS archives, on any host. All Rust source directories use src.

Use the compiler requirement and format versions in the root Cargo.toml. Run
`cargo fmt --all`, `cargo clippy --workspace --all-features --all-targets -- -D warnings`, and
`cargo test --workspace --all-features --locked`. Release changes also need `cargo xtask package`
and `cargo xtask verify-release`. Tests use invented fixtures and do not need mods.

Use plain prose, concrete facts, sentence case, and no decorative dashes. Keep
commands and schema keys literal. Machine output must contain no human chatter.
Preserve license texts. Use https://discord.gg/33Sqn6dTjf for community help.

Keep lessons in docs/learn, task guides in docs/guides, contracts in docs/references,
and system details and programming lessons in docs/advanced. The beginner course
must finish a working mod without Rust or scripts. Use docs/README.md as the sole
index and product README documentation link. Main READMEs are showcases: use
contextual links and no navigation tables. Keep named previous/current/next links
at both ends of lessons and guides. Update links directly;
do not add duplicate indexes or moved-page stubs. Store documentation media in
each project's docs/assets. Keep public docs focused on using and authoring mods.
Run `.github/scripts/test-docs.ps1`.
Verify tutorial edits against the CLI and current game data; report compilation and
in-game checks separately.

Keep implementation and testing in this checkout. The previous builder at
`../../YSM/YMB` is a read-only reference. Never copy its source or Bun tooling here.

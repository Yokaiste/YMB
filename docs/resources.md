# Further reading and help

| Previous | You are here | Next |
| --- | --- | --- |
| [Documentation](README.md) | Further reading and help | [0. Meet your mod folder](learn/00-warno-basics.md) |

Use these when a lesson leaves you curious or a game tool needs more explanation. You do not need to read a language specification before changing a tank. There are better ways to ruin an evening.

## WARNO's own manuals

In Steam, open WARNO's local files, then `Mods`. These files come with the game; open your installed copies so the instructions match your tools.

| File in `WARNO/Mods/` | Use it for |
| --- | --- |
| `ReadMe.txt` | The supplied tools and their setup |
| `modding_manual.pdf` | Creating, generating, activating, updating, and uploading a WARNO mod |
| `ndf_reference_manual.pdf` | NDF syntax, types, objects, lists, and references |

YMB prepares and applies your edits before WARNO compiles them. When a manual says to edit game data, keep the intended change in a YMB patch or asset, build, and sync it. Continue with the manual's compile and game steps. After an update, follow [YMB's recovery sequence](guides/update-and-recover.md#after-a-warno-update) before replacing data that YMB currently manages.

## Help with the beginner course

| Resource | When it helps |
| --- | --- |
| [Microsoft: getting started with PowerShell](https://learn.microsoft.com/en-us/powershell/scripting/learn/ps101/01-getting-started) | Finding the terminal and understanding the prompt before lesson 1. Run the lesson's commands; there is no scripting homework. |
| [YAML: language overview](https://yaml.org/spec/1.2.2/#chapter-2-language-overview) | Looking up lists, keys, and quoted values. Start with the examples; this is a specification, not required reading. YMB's own [configuration reference](references/configuration.md) defines the keys it accepts. |
| [WARNO's Steam modding forum](https://steamcommunity.com/app/1611600/discussions/1/) | Game-tool errors and game-specific questions. Community replies can describe older game versions; compare paths and values with your installed data. |
| [YMB community help](https://discord.gg/33Sqn6dTjf) | YMB configuration, diagnostics, and project questions. Include the command, YMB version, and diagnostic code; remove personal paths before posting. |

## Optional programming preparation

These are for the [advanced generator lesson](advanced/health-generator.md). The beginner course is complete without them.

| Official Rust resource | Read it for |
| --- | --- |
| [Install Rust](https://rust-lang.org/tools/install/) | The compiler, Cargo, and Windows toolchain prerequisites |
| [Hello, Cargo](https://doc.rust-lang.org/book/ch01-03-hello-cargo.html) | A Rust project's files and build commands |
| [Common programming concepts](https://doc.rust-lang.org/book/ch03-00-common-programming-concepts.html) | Variables, types, functions, and control flow |
| [Error handling](https://doc.rust-lang.org/book/ch09-00-error-handling.html) | Why the generator returns `Result` and uses `?` |
| [Writing tests](https://doc.rust-lang.org/book/ch11-01-writing-tests.html) | Checking the health rule on small invented inputs |

Use the Rust requirement declared by your YMB release. Learning material explains the language; the [YMB SDK reference](references/generators.md) explains YMB's interfaces.

| Previous | You are here | Next |
| --- | --- | --- |
| [Documentation](README.md) | Further reading and help | [0. Meet your mod folder](learn/00-warno-basics.md) |

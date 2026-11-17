# Advanced lesson: write and test a health generator

[All documentation](../README.md#advanced)

| Previous | You are here | Next |
| --- | --- | --- |
| [Advanced workflows](../README.md#advanced) | Advanced lesson · Health generator | [Generator SDK reference](../references/generators.md) |

Finish the [beginner course](../README.md#beginner-course) first. This optional Rust lesson assumes variables, functions, lists, and error handling.

Keep first_mod and its welcome title. Replace the earlier YAML health rule with a generator that gives the M1A1 and M1IP Abrams 50% more HP, capped at 18. YAML already covers this formula; the example teaches target reads, checked input, the shared NDF tools, and focused tests.

Generators are trusted executables with your account's permissions. The SDK stages game output and authored writes so the builder can commit or roll them back. Direct filesystem writes do not have that protection.

## Before the code

Use the [official Rust installer](https://rust-lang.org/tools/install/) and the [Rust preparation list](../resources.md#optional-programming-preparation) if these tools are new. Read **Hello, Cargo**, **Common programming concepts**, and **Error handling** before editing the program. The **Writing tests** chapter explains the final check.

## Replace the earlier health rule

Remove the tutorial's mods.first_mod override from .ymb/config.yaml, keeping unrelated settings. Replace the whole config/patch/gameplay/health/ymb.patch.yaml with:

~~~yaml
version: 2
id: gameplay.health
name: Capped tank health
scope: prod
variables:
  healthUnits:
    - Descriptor_Unit_M1A1_Abrams_US
    - Descriptor_Unit_M1IP_Abrams_US
  healthPercent: 150
  healthCap: 18
generators:
  - id: health
    project: generator/Cargo.toml
    binary: scale-health
    entry: generate
    tests:
      - {id: health_checks, when: before}
~~~

Remove the earlier targets and readValues entries. Running both versions would scale a value the YAML rule already changed.

## Create the Cargo project

Create generator/Cargo.toml beside that patch config:

~~~toml
[package]
name = "scale-health"
version = "0.1.0"
edition = "2024"

[workspace]

[dependencies]
ymb-sdk = { path = "../../../../../../../sdk/src/sdk" }
serde_json = "1"
~~~

This path fits a downloaded YMB package. In a builder source checkout, use ../../../../../../../src/sdk instead. The standalone workspace keeps the mod separate from the builder's Cargo workspace.

Install stable Rust meeting YMB's requirement, or use Install Rust for a private portable toolchain. The requirement lives in sdk/Cargo.toml for downloads and root Cargo.toml for source checkouts. `--install-rust` permits automatic setup; users with matching precompiled generators need no Cargo. See [Rust setup](../references/commands.md).

The `cargo` commands below assume a system installation. With portable Rust, use YMB's build command to compile the generator.

Create generator/src/main.rs:

| Part | Job |
| --- | --- |
| `operations` | Read selected health and prepare checked edits |
| `generate` | Read one target, apply edits, return output |
| `check_rule` | Test on tiny invented units |
| `health_checks` | Expose that check to YMB |
| `main` | Register the generator and check |

~~~rust
use serde_json::{Value, json};
use std::collections::HashMap;
use ymb_sdk::{
    Context, GeneratedFile, GeneratorEntry, Result, TestEntry, TestResult,
    ensure, ndf, values,
};

const FILE: &str = "GameData/Generated/Gameplay/TacticalUnits.ndf";
const HEALTH: &str =
    "ModulesDescriptors.[TBaseDamageModuleDescriptor].MaxPhysicalDamages";

fn operations(source: &str, names: &[String], percent: u64, cap: u64)
    -> Result<Vec<Value>>
{
    ensure(!names.is_empty(), "healthUnits is empty.", "Add a unit name.")?;
    ensure(percent > 0 && cap > 0, "Health limits must be positive.",
           "Use positive whole numbers.")?;
    let blocks = ndf::scan(source)?;
    let index: HashMap<_, _> = blocks.iter()
        .filter_map(|block| block.name.map(|name| (name, block)))
        .collect();
    names.iter().map(|name| {
        let block = index.get(name.as_str()).ok_or_else(|| {
            ymb_sdk::failure(format!("Missing unit {name}."),
                             "Check its name in TacticalUnits.ndf.")
        })?;
        let text = &source[block.span.clone()];
        let raw = &text[ndf::read::path_range(text, HEALTH)?];
        let value = ndf::values::parse_scalar(raw);
        let hp = value.value.as_f64().filter(|hp| {
            matches!(value.kind.as_str(), "int" | "float")
                && hp.is_finite() && *hp > 0.0
        }).ok_or_else(|| ymb_sdk::failure(
            format!("{name} has no positive numeric health."),
            "Check its damage module."))?;
        let scaled = hp * percent as f64 / 100.0;
        ensure(scaled.is_finite(), "Health calculation overflowed.",
               "Use a smaller percentage.")?;
        let health = scaled.round().clamp(1.0, cap as f64) as u64;
        Ok(json!({
            "op": "modify",
            "selector": {
                "kind": "field", "by": "path",
                "value": format!("{name}.{HEALTH}")
            },
            "value": health
        }))
    }).collect()
}

fn generate(ctx: &mut Context) -> Result<Vec<GeneratedFile>> {
    let names: Vec<String> = ctx.value("healthUnits")?;
    let percent = values::positive_integer(
        &ctx.variables["healthPercent"], "healthPercent")?;
    let cap = values::positive_integer(
        &ctx.variables["healthCap"], "healthCap")?;
    let source = ctx.read_target(FILE)?;
    let edits = operations(&source, &names, percent, cap)?;
    let output = ctx.patch(&source, FILE, &edits)?;
    Ok(vec![ctx.output_text(FILE, output.text)?])
}

fn check_rule() -> Result<()> {
    let source = [("Sample_A", 10), ("Sample_B", 14), ("Untouched", 8)]
        .map(|(name, hp)| format!(
            "{name} is TEntityDescriptor\n(\n ModulesDescriptors = [\n\
             TBaseDamageModuleDescriptor\n(\n MaxPhysicalDamages = {hp}\n\
             ),\n ]\n)\n"))
        .join("\n");
    let names = vec!["Sample_A".into(), "Sample_B".into()];
    let edits = operations(&source, &names, 150, 18)?;
    let edits = ndf::operation::expand(&edits, &json!({}))?;
    let output = ndf::patch::apply(
        &source, &edits, &ndf::operation::Identity::default())?;
    for (name, expected) in [("Sample_A", 15.0), ("Sample_B", 18.0),
                             ("Untouched", 8.0)] {
        let path = format!("{name}.{HEALTH}");
        let raw = &output.text[ndf::read::path_range(&output.text, &path)?];
        let hp = ndf::values::parse_scalar(raw).value.as_f64();
        ensure(hp == Some(expected), format!("Wrong health for {name}."),
               "Check scaling, the cap, and selection.")?;
    }
    ensure(operations(&source, &["Missing".into()], 150, 18).is_err(),
           "Missing units must fail.", "Keep the required-unit check.")?;
    ensure(operations(&source, &names, 0, 18).is_err(),
           "Zero percent must fail.", "Keep positive input checks.")
}

fn health_checks(_: &mut Context) -> Result<Vec<TestResult>> {
    check_rule()?;
    Ok(vec![TestResult::passed(
        "Health scaling, cap, untouched unit, and invalid inputs")])
}

fn main() {
    ymb_sdk::run(
        &[GeneratorEntry { name: "generate", generate }],
        &[TestEntry { name: "health_checks", run: health_checks }],
    );
}

#[test]
fn health_rule() {
    check_rule().unwrap();
}
~~~

The generator reads TacticalUnits.ndf once and indexes named blocks once. Each selected unit keeps at least 1 HP. A missing unit or invalid health fails with a diagnostic. The NDF reader and patcher come from the same implementation used by YAML.

The invented names belong only to the test. It checks the cap, selection, a missing unit, and invalid input without copying a game file into the project.

## Build and check it

Open PowerShell in the generator folder:

~~~powershell
cargo test
~~~

Keep the generated Cargo.lock with the project. From YMB, run:

~~~powershell
.\YMB.exe build --mod first_mod
~~~

YMB compiles the source generator, runs its registered check, and applies its output. Later builds reuse unchanged compilation. See [generator execution and caching](../references/generators.md#compilation-and-cache-locations) for storage details.


Inspect TacticalUnits.ndf in .ymb/build/output. With original HP of 10, both Abrams variants should now have 15. Other units and the welcome title remain. Precompiled registrations avoid source compilation.

Set healthPercent to 200 and rebuild: both selected tanks should stop at 18. Restore 150 when you finish the experiment.

When the preview matches:

~~~powershell
.\YMB.exe sync --mod first_mod --yes
~~~

Run MyFirstMod/GenerateMod.bat, enable MyFirstMod, then check both regular Abrams variants in the armory and a fresh skirmish.

| Selection | Expected M1A1 / M1IP HP |
| --- | --- |
| `first_mod` alone | 15 / 15 |
| `tank_training` | 18 / 15; the add-on multiplies M1A1 again |

These assume original HP of 10 and no earlier contributor changing health.

### Try it yourself

Change the test's `Sample_A` HP from 10 to 11, and its expected result from 15 to 17. Run `cargo test`: 11 × 1.5 rounds to 17. Then restore both test values. A real test can fail; it does not just congratulate the code for existing.

Leave `healthPercent: 150`, `healthCap: 18`, and both Abrams names in the patch. Build once more. Both should have 15 HP on the tutorial data, and the title should remain.

To return to the beginner version, replace the entire generator patch with [lesson 4's two-tank YAML](../learn/04-calculations.md#apply-the-calculation-to-two-tanks), set its default `healthMultiplier` to `1.5`, then build and sync `first_mod`. Replacing the whole file removes the generator registration. The unused source folder can stay while you experiment.

The [generator reference](../references/generators.md#distribute-without-a-compiler) shows how to share a compiled executable so other users do not need Rust.

| Previous | You are here | Next |
| --- | --- | --- |
| [Advanced workflows](../README.md#advanced) | Advanced lesson · Health generator | [Generator SDK reference](../references/generators.md) |

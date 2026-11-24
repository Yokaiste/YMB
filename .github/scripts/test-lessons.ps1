param(
    [Parameter(Mandatory)][string]$Package,
    [Parameter(Mandatory)][string]$GameArchive
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$packagePath = (Resolve-Path -LiteralPath $Package).Path
$archivePath = (Resolve-Path -LiteralPath $GameArchive).Path
$work = Join-Path $root ('.ymb/lesson-check-' + [Guid]::NewGuid().ToString('N'))
$game = Join-Path $work 'MyFirstMod'
$builder = Join-Path $game 'YMB'
$exe = Join-Path $builder 'YMB.exe'
$checks = [Collections.Generic.List[object]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-Utf8([string]$Path, [string]$Text) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, $utf8)
}
function Blocks([string]$File, [string]$Language) {
    $text = [IO.File]::ReadAllText((Join-Path $root "docs/$File"))
    $pattern = '(?ms)^(`{3}|~{3})' + $Language + '\r?\n(.*?)^\1\s*$'
    return ,@([regex]::Matches($text, $pattern) | ForEach-Object { $_.Groups[2].Value.TrimEnd() + "`n" })
}
function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Run([string[]]$Arguments, [switch]$ExpectFailure) {
    $output = & $exe @Arguments --json
    $exitCode = $LASTEXITCODE
    $result = ($output -join "`n") | ConvertFrom-Json
    if ($ExpectFailure) {
        Require ($exitCode -ne 0 -and $result.status -eq 'error') "Expected failure: $Arguments"
    } else {
        Require ($exitCode -eq 0 -and $result.status -eq 'ok' -and $result.diagnosticCounts.error -eq 0) ($result | ConvertTo-Json -Depth 30)
    }
    $checks.Add(@{ command = ($Arguments -join ' '); expectedFailure = [bool]$ExpectFailure; passed = $true })
    return $result
}
function Health([string]$Text, [string]$Name) {
    $plain = [regex]::Replace($Text, '(?s)/\*.*?\*/|(?m)//[^\r\n]*', '')
    $pattern = '(?s)\b' + [regex]::Escape($Name) + '\s+is\s+TEntityDescriptor\b(.*?)(?=\n(?:export\s+)?\w+\s+is\s+|\z)'
    $block = [regex]::Match($plain, $pattern)
    Require $block.Success "Missing unit: $Name"
    $value = [regex]::Match($block.Groups[1].Value, '\bMaxPhysicalDamages\s*=\s*(\d+(?:\.\d+)?)')
    Require $value.Success "Missing health: $Name"
    return [double]::Parse($value.Groups[1].Value, [Globalization.CultureInfo]::InvariantCulture)
}
# Guard the assertions against reading commented originals instead of active output.
Require ((Health "Sample is TEntityDescriptor`n(`n// MaxPhysicalDamages = 99`n/* MaxPhysicalDamages = 88 */`nMaxPhysicalDamages = 12`n)" 'Sample') -eq 12) 'Health reader self-check failed.'

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Directory]::CreateDirectory($game) | Out-Null
[IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $game)
[IO.Compression.ZipFile]::ExtractToDirectory($packagePath, $game)
Require (Test-Path -LiteralPath $exe) 'Package must contain YMB/YMB.exe.'
Require (Test-Path -LiteralPath (Join-Path $builder 'mods/README.md')) 'Package must include the mod folder guide.'
$unitTarget = 'GameData/Generated/Gameplay/TacticalUnits.ndf'
$menuTarget = 'GameData/UserInterface/Use/OutGame/UISpecificOutGameWelcomeView.ndf'
$original = [IO.File]::ReadAllText((Join-Path $game $unitTarget))
$originalHash = (Get-FileHash -LiteralPath (Join-Path $game $unitTarget)).Hash
$m1a1 = 'Descriptor_Unit_M1A1_Abrams_US'
$m1ip = 'Descriptor_Unit_M1IP_Abrams_US'
Require ((Health $original $m1a1) -eq 10 -and (Health $original $m1ip) -eq 10) 'The tutorial baseline changed; review documented HP expectations.'
$preview = Join-Path $builder '.ymb/build/output'
$project = Join-Path $builder 'mods/first_mod/config'
$healthPatch = Join-Path $project 'patch/gameplay/health/ymb.patch.yaml'
$local = Join-Path $builder '.ymb/config.yaml'
function Check-Health([double]$A, [double]$B) {
    $text = [IO.File]::ReadAllText((Join-Path $preview $unitTarget))
    Require ((Health $text $m1a1) -eq $A) "M1A1 should have $A HP."
    Require ((Health $text $m1ip) -eq $B) "M1IP should have $B HP."
}
Push-Location $builder
try {
    Run @('init','--id','first_mod','--name','My First Mod') | Out-Null
    Run @('doctor') | Out-Null
    Run @('build','--mod','first_mod') | Out-Null
    $projectConfig = Get-Content -LiteralPath (Join-Path $project 'ymb.mod.yaml') -Raw
    $projectConfig = $projectConfig -replace '(?m)^name:.*$', 'name: My Very Serious Mod'
    Write-Utf8 (Join-Path $project 'ymb.mod.yaml') $projectConfig
    Run @('build','--mod','first_mod') | Out-Null
    Require ([IO.File]::ReadAllText((Join-Path $preview 'GameData/Localisation/MyFirstMod/INTERFACE_OUTGAME.csv')).Contains('My Very Serious Mod')) 'Title template did not update.'
    $found = Run @('find','--file',$unitTarget,'--name','M1A1_Abrams_US')
    Require (@($found.data.matches | Where-Object name -EQ $m1a1).Count -eq 1) 'Real unit search failed.'

    $health = Blocks 'learn/02-unit-health.md' 'yaml'
    Require ($health.Count -eq 4) 'Expected four complete health patches in lesson 2.'
    for ($i = 0; $i -lt $health.Count; $i++) {
        Write-Utf8 $healthPatch $health[$i]
        Run @('build','--mod','first_mod') | Out-Null
        if ($i -eq 0) { Check-Health 20 10 } else { Check-Health 20 20 }
    }
    Write-Utf8 $healthPatch ($health[0].Replace($m1a1, 'Descriptor_Unit_MissingLessonUnit'))
    Run @('build','--mod','first_mod') -ExpectFailure | Out-Null
    Write-Utf8 $healthPatch $health[0]
    $settings = Blocks 'learn/03-settings.md' 'yaml'
    Write-Utf8 $local $settings[1]
    Run @('sync','--mod','first_mod','--yes') | Out-Null
    Check-Health 30 10
    Write-Utf8 $local $settings[2]
    Run @('sync','--mod','first_mod','--yes') | Out-Null
    Require (-not (Test-Path -LiteralPath (Join-Path $preview $unitTarget))) 'Disabled health should leave the preview.'
    Require ((Get-FileHash -LiteralPath (Join-Path $game $unitTarget)).Hash -eq $originalHash) 'Disabling the feature did not restore the original.'
    Write-Utf8 $local $settings[1]
    Write-Utf8 $healthPatch ($health[0].Replace('scope: prod','scope: dev'))
    Run @('build','--mod','first_mod') | Out-Null
    Require (-not (Test-Path -LiteralPath (Join-Path $preview $unitTarget))) 'Production selection included a development patch.'
    Run @('build','--mod','first_mod','--scope','dev') | Out-Null
    Check-Health 30 10

    $math = Blocks 'learn/04-calculations.md' 'yaml'
    Write-Utf8 $local $math[0]
    Write-Utf8 $healthPatch $math[1]
    Run @('build','--mod','first_mod') | Out-Null
    Check-Health 20 10
    Write-Utf8 $local $math[2]
    Run @('build','--mod','first_mod') | Out-Null
    Check-Health 15 10
    Write-Utf8 $healthPatch $math[3]
    Run @('build','--mod','first_mod') | Out-Null
    Check-Health 15 15

    $projectConfig = $projectConfig -replace '(?m)^description:.*$', 'description: "Base training: M1A1 and M1IP gain 50% health."'
    Write-Utf8 (Join-Path $project 'ymb.mod.yaml') $projectConfig
    $menu = Blocks 'learn/05-menu-and-assets.md' 'yaml'
    Write-Utf8 (Join-Path $project 'patch/ui/title-size/ymb.patch.yaml') $menu[0]
    $csv = Join-Path $project 'replace/GameData/Localisation/${modRootName}/INTERFACE_OUTGAME.csv'
    Write-Utf8 (Join-Path $project 'patch/welcome/assets/INTERFACE_OUTGAME.csv') ([IO.File]::ReadAllText($csv))
    Remove-Item -LiteralPath $csv
    $welcome = Join-Path $project 'patch/welcome/ymb.patch.yaml'
    Write-Utf8 $welcome $menu[1]
    Run @('build','--mod','first_mod') | Out-Null
    for ($i = 2; $i -lt $menu.Count; $i++) {
        Write-Utf8 $welcome ($menu[1] + "`n" + $menu[$i])
        Run @('build','--mod','first_mod') | Out-Null
        $menuText = [IO.File]::ReadAllText((Join-Path $preview $menuTarget))
        if ($i -eq 2) { Require ($menuText.Contains('HorizontalFitStyle = ~/FitStyle/FitToContent')) 'Field addition missing.' }
        if ($i -eq 4) { Require ($menuText.Contains('MainComponentDescriptor = ~/FirstModWelcomeDescriptor')) 'Copied menu was not referenced.' }
    }
    Write-Utf8 $welcome $menu[1]
    Write-Utf8 $healthPatch ($math[3].Replace('healthMultiplier: 2','healthMultiplier: 1.5'))
    Write-Utf8 $local "version: 2`n"
    Run @('build','--mod','first_mod') | Out-Null
    Check-Health 15 15
    $layers = Blocks 'learn/06-combine-projects.md' 'yaml'
    Write-Utf8 (Join-Path $builder 'mods/tank_training/config/ymb.mod.yaml') $layers[0]
    Write-Utf8 (Join-Path $builder 'mods/tank_training/config/patch/health/ymb.patch.yaml') $layers[1]
    Run @('explain','--mod','tank_training') | Out-Null
    Run @('sync','--mod','tank_training','--require-all','--yes') | Out-Null
    Check-Health 18 15
    $unchanged = Run @('sync','--mod','tank_training','--yes')
    Require ($unchanged.data.changedFiles -eq 0) 'Unchanged sync rewrote game files.'
    Run @('recover','--mod','first_mod','--mod','tank_training','--dry-run') | Out-Null
    Run @('recover','--mod','first_mod','--mod','tank_training','--yes') | Out-Null
    Require ((Get-FileHash -LiteralPath (Join-Path $game $unitTarget)).Hash -eq $originalHash) 'Recovery changed original bytes.'
    Run @('build','--mod','tank_training','--require-all') | Out-Null
    Check-Health 18 15
    $beginnerCommands = $checks.Count
    Require (-not (Test-Path -LiteralPath (Join-Path $project 'patch/gameplay/health/generator'))) 'The beginner route unexpectedly requires generator source.'

    Write-Utf8 $local "version: 2`n"
    Write-Utf8 $healthPatch (Blocks 'advanced/health-generator.md' 'yaml')[0]
    $generator = Join-Path $project 'patch/gameplay/health/generator'
    Write-Utf8 (Join-Path $generator 'Cargo.toml') (Blocks 'advanced/health-generator.md' 'toml')[0]
    Write-Utf8 (Join-Path $generator 'src/main.rs') (Blocks 'advanced/health-generator.md' 'rust')[0]
    & cargo generate-lockfile --offline --manifest-path (Join-Path $generator 'Cargo.toml')
    Require ($LASTEXITCODE -eq 0) 'Tutorial generator dependency resolution failed.'
    & cargo test --locked --offline --manifest-path (Join-Path $generator 'Cargo.toml') --target-dir (Join-Path $root '.ymb/target')
    Require ($LASTEXITCODE -eq 0) 'Tutorial generator self-test failed.'
    Run @('build','--mod','first_mod') | Out-Null
    Check-Health 15 15
    $registered = [IO.File]::ReadAllText($healthPatch)
    Write-Utf8 $healthPatch ($registered.Replace('healthPercent: 150','healthPercent: 200'))
    Run @('build','--mod','first_mod') | Out-Null
    Check-Health 18 18
    Write-Utf8 $healthPatch $registered

    Run @('build','--mod','first_mod') | Out-Null
    Check-Health 15 15
    & cargo build --release --locked --offline --manifest-path (Join-Path $generator 'Cargo.toml') --target-dir '.ymb/target'
    Require ($LASTEXITCODE -eq 0) 'Portable tutorial generator compilation failed.'
    New-Item -ItemType Directory -Force (Join-Path $project 'patch/gameplay/health/bin') | Out-Null
    Copy-Item -LiteralPath '.ymb/target/release/scale-health.exe' -Destination (Join-Path $project 'patch/gameplay/health/bin/scale-health.exe')
    $portable = (Blocks 'references/generators.md' 'yaml')[0]
    Write-Utf8 $healthPatch ($registered.Substring(0, $registered.IndexOf('generators:')) + $portable)
    $previousPath = $env:PATH
    try {
        $env:PATH = Join-Path $env:SystemRoot 'System32'
        Run @('build','--mod','first_mod','--no-cache') | Out-Null
        Check-Health 15 15
    } finally { $env:PATH = $previousPath }
    Run @('build','--mod','tank_training') | Out-Null
    Check-Health 18 15
    $report = @{ beginnerCommands = $beginnerCommands; package = $packagePath; gameArchive = $archivePath; workspace = $work; checks = $checks; gameCompilation = 'not run'; inGame = 'not run' }
    Write-Utf8 (Join-Path $root '.ymb/docs-verification.json') ($report | ConvertTo-Json -Depth 10)
    Write-Host "Passed $($checks.Count) tutorial commands plus generator tests. Review project and preview: $builder"
} finally { Pop-Location }

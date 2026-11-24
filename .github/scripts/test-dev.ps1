$ErrorActionPreference = 'Stop'
$devRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$before = @(Get-ChildItem -LiteralPath (Join-Path $devRoot '.ymb') -Filter 'dev-*.exe' -ErrorAction SilentlyContinue | ForEach-Object FullName)

function Invoke-DevFixture([string]$Arguments, [string]$InputText = '', [string]$Directory = $devRoot) {
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = $env:ComSpec
    $process.StartInfo.Arguments = '/d /c ""' + (Join-Path $devRoot 'Dev.bat') + '" ' + $Arguments + '"'
    $process.StartInfo.WorkingDirectory = $Directory
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $process.StartInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if ($InputText) { $process.StandardInput.Write($InputText) }
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Development fixture did not finish.' }
        $out = $stdout.GetAwaiter().GetResult()
        $err = $stderr.GetAwaiter().GetResult()
        [pscustomobject]@{ Code = $process.ExitCode; Output = $out + $err; Stderr = $err }
    } finally { $process.Dispose() }
}

$unknown = Invoke-DevFixture unknown
if ($unknown.Code -ne 2 -or $unknown.Output -notmatch '\[E2\]') { throw "Unknown commands must retain the shared diagnostic and exit code: $($unknown.Output)" }
if ($unknown.Stderr -notmatch '^Starting YMB development\.\.\.\r?\n') { throw 'Dev.bat must show a startup status on stderr before Cargo runs.' }
$menu = Invoke-DevFixture '' "unknown`r`n`r`nexit`r`n"
if ($menu.Code -ne 0 -or [regex]::Matches($menu.Output, '(?m)^  YMB development\r?$').Count -lt 2) { throw "The menu must return after a failed command: $($menu.Output)" }
if ($menu.Output -match '\x1b\[') { throw 'Redirected development output must not contain terminal decoration.' }
$help = Invoke-DevFixture help '' ([IO.Path]::GetTempPath())
if ($help.Code -ne 0 -or $help.Output -notmatch 'Development commands' -or $help.Output -notmatch 'dist/YMB.exe') { throw "Development help must work outside the checkout: $($help.Output)" }
$clean = Invoke-DevFixture clean
if ($clean.Code -ne 2 -or $clean.Output -notmatch '\[E1\]') { throw 'Unattended cleanup must require -Yes before starting work.' }
$invalid = Invoke-DevFixture 'build extra'
if ($invalid.Code -ne 2 -or $invalid.Output -notmatch '\[E1\]') { throw 'Invalid arguments must reach the shared parser before work starts.' }
foreach ($arguments in @('--help', 'help -Yes', 'bu --he', '--ye HELP')) {
    $result = Invoke-DevFixture $arguments
    if ($result.Code -ne 0 -or $result.Output -notmatch 'Development commands') { throw "Bootstrap argument forwarding failed: $arguments" }
}
$typo = Invoke-DevFixture 'build --yess'
if ($typo.Code -ne 2 -or $typo.Output -notmatch "Did you mean '--yes'") { throw 'Unknown development options must suggest the available matching flag.' }
$remaining = @(Get-ChildItem -LiteralPath (Join-Path $devRoot '.ymb') -Filter 'dev-*.exe' | Where-Object FullName -NotIn $before)
if ($remaining.Count) { throw 'Development launchers must remove their temporary executable.' }
$dictionary = [IO.File]::ReadAllText((Join-Path $devRoot 'docs/references/message-codes.md'))
foreach ($source in @(Get-ChildItem -LiteralPath (Join-Path $devRoot 'src') -Recurse -Filter '*.rs' -File) + @(Get-Item -LiteralPath (Join-Path $PSScriptRoot 'dev-launch.ps1'))) {
    foreach ($match in [regex]::Matches([IO.File]::ReadAllText($source.FullName), '(?:"|\[)([EWI][0-9]+)(?:"|\])')) {
        if (-not $dictionary.Contains("| $($match.Groups[1].Value) |")) { throw "Undocumented message code: $($match.Value)" }
    }
}
$global:LASTEXITCODE = 0
Write-Host 'Shared development frontend checks passed.'

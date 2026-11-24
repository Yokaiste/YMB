$ErrorActionPreference = 'Stop'
$devRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$env:CARGO_TARGET_DIR = Join-Path $devRoot '.ymb/target'
$runtime = Join-Path $devRoot ".ymb/dev-$([guid]::NewGuid()).exe"
$code = 1
$encoding = [Console]::OutputEncoding
$devMessages = $null
Push-Location $devRoot
try {
    $devMessages = (Get-Content -LiteralPath (Join-Path $devRoot 'resources/messages/en/development.json') -Raw -Encoding UTF8 | ConvertFrom-Json).bootstrap
    # Cargo's JSON uses UTF-8 even when the console uses another code page.
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $messages = & cargo build --quiet --locked --package xtask --message-format=json-render-diagnostics
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        $artifact = $messages | ForEach-Object { $_ | ConvertFrom-Json } |
            Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'xtask' -and $_.executable } |
            Select-Object -Last 1
        if (-not $artifact) { throw $devMessages.no_executable }
        # Run outside target so cargo clean can remove its own compiler output on Windows.
        Copy-Item -LiteralPath $artifact.executable -Destination $runtime
        $arguments = @('dev') + @($args)
        & $runtime @arguments
        $code = $LASTEXITCODE
    }
} catch {
    $reason = $_.Exception.Message
    if ($devMessages) { $reason = $devMessages.cannot_start.Replace('@ERROR@', $reason) }
    [Console]::Error.WriteLine("[E32] $reason")
    $code = 1
} finally {
    [Console]::OutputEncoding = $encoding
    if (Test-Path -LiteralPath $runtime) { Remove-Item -LiteralPath $runtime -Force }
    Pop-Location
}
exit $code

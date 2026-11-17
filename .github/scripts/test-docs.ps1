param([string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path)
$ErrorActionPreference = 'Stop'

function Get-MarkdownAnchors([string]$Text) {
    $anchors = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $counts = @{}
    $fence = ''
    foreach ($line in ($Text -split '\r?\n')) {
        if ($line -match '^\s*(`{3,}|~{3,})') {
            $mark = $Matches[1].Substring(0, 1)
            if (-not $fence) { $fence = $mark } elseif ($mark -eq $fence) { $fence = '' }
            continue
        }
        if ($fence) { continue }
        if ($line -match '^#{1,6}\s+(.+?)\s*#*\s*$') {
            $slug = ($Matches[1].ToLowerInvariant() -replace '<[^>]+>', '' -replace '[^\p{L}\p{N}_\- ]', '') -replace ' ', '-'
            $base = $slug
            if ($counts.ContainsKey($base)) { $slug += '-' + $counts[$base] }
            $counts[$base] = 1 + $counts[$base]
            [void]$anchors.Add($slug)
        }
        foreach ($match in [regex]::Matches($line, '<a\s+id="([^"]+)"')) {
            [void]$anchors.Add($match.Groups[1].Value)
        }
    }
    if ($fence) { throw 'Unclosed Markdown code fence.' }
    return ,$anchors
}

function Test-DocumentNavigation([string]$Text) {
    $pattern = '(?m)^\|[ \t]*Previous[ \t]*\|[ \t]*You are here[ \t]*\|[ \t]*Next[ \t]*\|[ \t]*\r?\n' +
        '\|(?:[ \t]*:?-{3,}:?[ \t]*\|){3}[ \t]*\r?\n(?<row>\|[^\r\n]+\|)[ \t]*\r?$'
    $tables = [regex]::Matches($Text, $pattern)
    if ($tables.Count -ne 2 -or $tables[0].Index -gt 250 -or
        $Text.TrimEnd().Length -gt $tables[1].Index + $tables[1].Length) { return $false }
    $rows = @($tables | ForEach-Object {
        ($_.Groups['row'].Value -split '\|' | ForEach-Object { $_.Trim() }) -join '|'
    })
    $rows[0] -ceq $rows[1]
}

# Check the parser on punctuation, repeated headings, explicit anchors and fenced text.
$fixture = "# A ``field``!`n# A ``field``!`n~~~text`n# Hidden`n~~~`n<a id=`"old-link`"></a>"
$parsed = Get-MarkdownAnchors $fixture
if ($parsed.Count -ne 3 -or -not $parsed.Contains('a-field-1') -or -not $parsed.Contains('old-link')) {
    throw 'Markdown anchor self-check failed.'
}

$navigation = "| Previous | You are here | Next |`n| --- | --- | --- |`n| [Back](back.md) | Guide | [Next](next.md) |"
$padded = "| Previous       | You are here   | Next                  |`n| :------------- | :------------: | --------------------: |`n| [Back](back.md) | Guide          | [Next](next.md)        |"
foreach ($newline in @("`n", "`r`n")) {
    $bottom = $padded.Replace("`n", $newline)
    $page = "# Guide`n`n$navigation`n`nInstructions.`n`n$padded`n".Replace("`n", $newline)
    if (-not (Test-DocumentNavigation $page) -or -not (Test-DocumentNavigation $page.TrimEnd())) { throw 'Navigation must accept padded tables and either line ending, with or without a final newline.' }
    foreach ($invalid in @(
        $page.Replace($bottom, $bottom.Replace('next.md', 'Next.md')),
        ($page + 'Unexpected content.'),
        (('x' * 251) + $page),
        $navigation
    )) {
        if (Test-DocumentNavigation $invalid) { throw 'Navigation must reject changed links, missing tables, and misplaced tables.' }
    }
}

$files = @(Get-Item -LiteralPath (Join-Path $Root 'README.md'))
$files += @(Get-ChildItem -LiteralPath (Join-Path $Root 'docs') -Filter '*.md' -Recurse)
$files += @(Get-ChildItem -LiteralPath (Join-Path $Root 'resources/release/structure') -Filter '*.md' -Recurse)
foreach ($project in @('YSM', 'WTO')) {
    $folder = Join-Path $Root "mods/$project"
    if (Test-Path -LiteralPath $folder) { $files += @(Get-ChildItem -LiteralPath $folder -Filter '*.md') }
}
$contents = @{}
$anchors = @{}
$failures = [Collections.Generic.List[string]]::new()
$docsRoot = (Join-Path $Root 'docs') + [IO.Path]::DirectorySeparatorChar
$docsIndex = Join-Path $Root 'docs/README.md'
$indexedPages = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $files) {
    $contents[$file.FullName] = [IO.File]::ReadAllText($file.FullName)
    try { $anchors[$file.FullName] = Get-MarkdownAnchors $contents[$file.FullName] }
    catch { $failures.Add("$($file.FullName): $_") }
}
$linkCount = 0
foreach ($file in $files) {
    $text = $contents[$file.FullName]
    if ($file.FullName.StartsWith((Join-Path $Root 'docs/learn') + [IO.Path]::DirectorySeparatorChar) -and
        $text -match '(?m)^(?:`{3}|~{3})(?:rust|python|javascript|typescript|toml)\b|\bcargo (?:run|build|test|install)\b|^generators:') {
        $failures.Add("$($file.FullName): move generator and programming lessons to docs/advanced.")
    }
    if ($file.FullName.StartsWith((Join-Path $Root 'docs') + [IO.Path]::DirectorySeparatorChar)) {
        if (-not (Test-DocumentNavigation $text)) {
            $failures.Add("$($file.FullName): keep identical named navigation at the top and bottom.")
        }
    }
    # Ignore literal Markdown examples in fenced code blocks.
    $text = [regex]::Replace($text, '(?ms)^\s*(`{3,}|~{3,})[^\n]*\n.*?^\s*\1\s*$', '')
    $links = @([regex]::Matches($text, '\[[^\]\n]*\]\(([^\s)]+)\)') | ForEach-Object { $_.Groups[1].Value })
    $links += @([regex]::Matches($text, '<img\s[^>]*src="([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
    foreach ($link in $links) {
        if ($link -match '^[a-z]+:') { continue }
        $parts = $link -split '#', 2
        $target = $file.FullName
        if ($parts[0]) { $target = [IO.Path]::GetFullPath((Join-Path $file.DirectoryName ([Uri]::UnescapeDataString($parts[0])))) }
        # The release structure is copied into the package root; docs are copied separately.
        $releaseRoot = (Join-Path $Root 'resources/release/structure') + [IO.Path]::DirectorySeparatorChar
        if (-not (Test-Path -LiteralPath $target) -and $target.StartsWith($releaseRoot)) {
            $target = Join-Path $Root $target.Substring($releaseRoot.Length)
        }
        if ($file.FullName -eq $docsIndex) { [void]$indexedPages.Add($target) }
        if ($file.FullName -eq (Join-Path $Root 'README.md') -and $target.StartsWith($docsRoot) -and
            $target.EndsWith('.md') -and $target -ne $docsIndex) {
            $failures.Add("$($file.FullName): route documentation links through docs/README.md.")
        }
        $linkCount++
        if (-not (Test-Path -LiteralPath $target)) {
            $failures.Add("$($file.FullName): missing $link")
        } elseif ($parts.Count -eq 2 -and $parts[1] -and $target.EndsWith('.md')) {
            if (-not $anchors.ContainsKey($target)) { $anchors[$target] = Get-MarkdownAnchors ([IO.File]::ReadAllText($target)) }
            if (-not $anchors[$target].Contains([Uri]::UnescapeDataString($parts[1]))) {
                $failures.Add("$($file.FullName): missing anchor $link")
            }
        }
    }
}
foreach ($file in $files) {
    if ($file.FullName.StartsWith($docsRoot) -and $file.FullName -ne $docsIndex -and
        -not $indexedPages.Contains($file.FullName)) {
        $failures.Add("$($file.FullName): add this page to docs/README.md.")
    }
}
if ($failures.Count) { throw ($failures -join "`n") }
Write-Host "Checked $($files.Count) Markdown files, $linkCount local links, code fences, anchors, navigation, and the documentation index."

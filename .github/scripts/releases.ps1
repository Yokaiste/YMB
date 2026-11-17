. "$PSScriptRoot/../../resources/examples/welcome/.github/scripts/release-config.ps1"

function Get-YmbReleaseConfig {
    Read-ReleaseConfig "$PSScriptRoot/../../resources/release/config.json"
}

function Get-CargoVersion([string] $Source) {
    if ($Source -match '(?ms)^\[workspace\.package\]\s*\r?\n(?:(?!^\[).)*?^version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)"') { $Matches[1] }
}

function Add-YmbArtifactNames([object[]] $Plan) {
    foreach ($release in $Plan) {
        $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($release.tag))).ToLowerInvariant()
        $release | Add-Member -NotePropertyName artifact -NotePropertyValue "YMB-$digest" -PassThru
    }
}

function Get-RepositoryYmbReleasePlan([string] $Repository, $Config = (Get-YmbReleaseConfig)) {
    $branches = @(foreach ($branch in (Get-GitHubItems "repos/$Repository/branches")) {
        $rule = Get-ReleaseBranch $branch.name $Config
        if (-not $rule) { continue }
        $files = Invoke-Gh api "repos/$Repository/contents?ref=$($branch.commit.sha)" | ConvertFrom-Json
        if ('Cargo.toml' -cnotin $files.name) { continue }
        $version = ''
        if (-not $rule.pattern -or -not (New-ReleaseRegex $rule.pattern).Match($branch.name).Groups['version'].Success) {
            $file = Invoke-Gh api "repos/$Repository/contents/Cargo.toml?ref=$($branch.commit.sha)" | ConvertFrom-Json
            $version = Get-CargoVersion ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($file.content)))
        }
        [pscustomobject]@{ name = $branch.name; commit = $branch.commit; version = $version }
    })
    Add-YmbArtifactNames @(Get-ReleasePlan $branches $Config)
}

function Get-CheckedArchiveVersion([string] $Archive) {
    Assert-ReleaseChecksum $Archive
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $entry = $null
        foreach ($name in @('YMB/release-manifest.json', 'release-manifest.json', './YMB/release-manifest.json', './release-manifest.json')) {
            $entry = $zip.GetEntry($name)
            if ($entry) { break }
        }
        if (-not $entry -or $entry.Length -gt 16MB) { throw 'Missing or oversized package manifest.' }
        $reader = [IO.StreamReader]::new($entry.Open())
        try { $version = ($reader.ReadToEnd() | ConvertFrom-Json).version } finally { $reader.Dispose() }
    } finally { $zip.Dispose() }
    if (-not $version) { throw 'The package manifest has no version.' }
    $version
}

function Publish-YmbReleases([object[]] $Plan, [string] $Directory, [string] $Repository, $Config = (Get-YmbReleaseConfig)) {
    $checked = @(foreach ($release in $Plan) {
        if ($release.artifact -cnotmatch '^YMB-[0-9a-f]{64}$') { throw 'Invalid release artifact name.' }
        $folder = Join-Path $Directory $release.artifact
        $archives = @(Get-ChildItem -LiteralPath $folder -Filter 'YMB-*-windows-x64.zip' -File)
        if ($archives.Count -ne 1) { throw 'Each release must have exactly one checked portable archive.' }
        $archive = $archives[0].FullName
        $version = Get-CheckedArchiveVersion $archive
        Assert-ReleaseVersion $version $release.version $release.prerelease
        $assets = @(Get-ReleaseAssets $folder $Config)
        if ($archive -notin $assets) { throw 'release.assets must include the checked portable archive.' }
        $presentation = Get-ReleasePresentation $Config $release $version $assets
        [pscustomobject]@{ release = $release; assets = $assets; presentation = $presentation }
    })
    $current = @(Get-RepositoryYmbReleasePlan $Repository $Config)
    if ((ConvertTo-Json -InputObject $Plan -Compress) -cne (ConvertTo-Json -InputObject $current -Compress)) { throw 'The release branches changed while artifacts were being checked. Run the workflow again.' }
    foreach ($item in $checked) {
        $notes = [IO.Path]::GetTempFileName()
        try {
            [IO.File]::WriteAllText($notes, $item.presentation.description, [Text.UTF8Encoding]::new($false))
            $release = $item.release
            Publish-CheckedRelease $Repository $release.tag $release.sha $item.assets $item.presentation.title $release.prerelease $release.latest $notes $Config 'ymb'
        } finally { Remove-Item -LiteralPath $notes -Force }
    }
    Remove-ObsoleteReleases $Repository @($Plan.tag) @() $Config 'ymb'
}

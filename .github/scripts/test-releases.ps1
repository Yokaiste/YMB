. "$PSScriptRoot/releases.ps1"

function Assert([bool] $Condition, [string] $Message) {
    if (-not $Condition) { throw $Message }
}

function Get-YmbReleasePlan([object[]] $Branches, [string] $MasterVersion) {
    $rows = @($Branches | ForEach-Object {
        [pscustomobject]@{ name = $_.name; commit = $_.commit; version = $(if ($_.name -ceq 'master') { $MasterVersion } else { '' }) }
    })
    Add-YmbArtifactNames @(Get-ReleasePlan $rows (Get-YmbReleaseConfig))
}

$branches = @('master', '1.9.2', '1.9.10', '2.0.1', '2.0.2-pre', '2.10.1', '2.9.90-pre', 'feature/99.0.0', 'v8.0.0', '2.3.0-other', '02.0.0') | ForEach-Object { [pscustomobject]@{ name = $_; commit = @{ sha = "sha-$_" } } }
$plan = @(Get-YmbReleasePlan $branches '2.0.0')
Assert ($plan.Count -eq 5) 'Unexpected release branches.'
Assert (($plan | Where-Object tag -CEQ '1.9.X').branch -ceq '1.9.10') 'Patch versions must compare numerically.'
Assert (($plan | Where-Object latest).branch -ceq 'master') 'master must own latest stable.'
Assert (($plan | Where-Object tag -CEQ '2.0.X-pre').branch -ceq '2.0.2-pre') 'Only the highest patch in each lane may publish.'
Assert (($plan | Where-Object prerelease | Select-Object -Last 1).branch -ceq '2.10.1') 'The greatest numeric version must be the newest prerelease.'
$promoted = @(Get-YmbReleasePlan $branches '3.0.0')
Assert (-not ($promoted | Where-Object tag -CEQ '2.10.X').prerelease) 'A newer master must reclassify older version branches as stable.'
Assert (($promoted | Where-Object tag -CEQ '2.9.X-pre').prerelease) 'Explicit prereleases must stay prereleases.'
$sameSeries = @(Get-YmbReleasePlan $branches '1.9.11')
Assert (($sameSeries | Where-Object tag -CEQ '1.9.X').branch -ceq 'master') 'master must win its stable series.'
$remaining = @($branches | Where-Object name -CNE '1.9.10')
Assert ((Get-YmbReleasePlan $remaining '2.0.0' | Where-Object tag -CEQ '1.9.X').branch -ceq '1.9.2') 'Deleting the newest patch branch must fall back to the remaining branch.'
$fallback = @(Get-YmbReleasePlan $branches '')
Assert (($fallback | Where-Object latest).branch -ceq '2.10.1') 'Without master metadata, the newest ordinary version must be latest stable.'
Assert (($fallback | Where-Object branch -CEQ '2.0.2-pre').prerelease) 'An explicit -pre branch must remain a preview without master metadata.'
Assert (@($fallback | Where-Object branch -CEQ 'master').Count -eq 0) 'master without release metadata must not enter the Rust build matrix.'
$previewOnly = @(Get-YmbReleasePlan @($branches | Where-Object name -CEQ '2.0.2-pre') '')
Assert ($previewOnly.Count -eq 1 -and $previewOnly[0].prerelease -and -not $previewOnly[0].latest) 'A preview must publish even when master is absent.'
Assert (@(Get-YmbReleasePlan @() '').Count -eq 0) 'Deleting the final Rust branch must allow an empty cleanup plan.'

$releases = @(@{ id = 1; tag_name = '2.0.X'; draft = $false }, @{ id = 2; tag_name = 'old'; draft = $false }, @{ id = 3; tag_name = '2.1.X-pre'; draft = $true }, @{ id = 4; tag_name = '2.0.X'; draft = $true })
$tags = @('2.0.X', '2.1.X-pre', 'old', 'orphan') | ForEach-Object { @{ name = $_ } }
$cleanup = Get-ReleaseCleanup $releases $tags @('2.0.X', '2.1.X-pre') @('2.1.X-pre')
Assert (($cleanup.releases -join ',') -ceq '2,3') 'Cleanup must remove obsolete releases and preserve configured draft channels.'
Assert (($cleanup.tags -join ',') -ceq '2.1.X-pre,old,orphan') 'Cleanup must include replaced and orphan tags.'
$cleanup = Get-ReleaseCleanup $releases $tags @('2.0.X') @()
Assert ('2.1.X-pre' -cin $cleanup.tags) 'Deleting the preview branch must remove its release tag.'
Assert ((Get-CargoVersion "[workspace.package]`nversion = `"2.10.3`"`n[workspace.metadata]`nversion = `"9.9.9`"") -ceq '2.10.3') 'Read the workspace version only.'

$configPath = "$PSScriptRoot/../../resources/release/config.json"
$custom = Read-ReleaseConfig $configPath @{
    branches = @(@{name='main';tag='v{{version}}';latest=$true}, @{pattern='^candidate/(?<version>[0-9]+\.[0-9]+\.[0-9]+)$';tag='v{{version}}{{previewSuffix}}';prerelease='auto'})
    managedTags = '^v[0-9]+\.[0-9]+\.[0-9]+(?:-pre)?$'
}
$customBranches = @([pscustomobject]@{name='main';version='2.0.0';commit=@{sha='sha-main'}}, [pscustomobject]@{name='candidate/2.1.0';commit=@{sha='sha-preview'}})
$customPlan = @(Get-ReleasePlan $customBranches $custom)
Assert ($customPlan.Count -eq 2 -and $customPlan[0].tag -ceq 'v2.0.0' -and $customPlan[0].latest -and $customPlan[1].tag -ceq 'v2.1.0-pre') 'Configured names, captures, tags, and automatic previews must replace the default branch policy.'
$largeConfig = Read-ReleaseConfig $configPath @{
    title = 'x' * 300
    description = 'x' * 70000
    discussionCategory = 'x' * 300
    assets = @(1..65 | ForEach-Object { '*' * 300 })
    branches = @(1..65 | ForEach-Object { @{name="branch$_";tag=('stable/' * 50) + "$_"} })
    managedTags = ''
}
$largePlan = @(Get-ReleasePlan @([pscustomobject]@{name='branch1';version='2.0.0';commit=@{sha='fixture'}}) $largeConfig)
$largePresentation = Get-ReleasePresentation $largeConfig $largePlan[0] '2.0.0' @()
Assert ($largePlan[0].tag.Length -gt 255 -and $largePresentation.title.Length -eq 300 -and $largePresentation.description.Length -gt 65536) 'Release metadata must not have arbitrary count or text limits.'
Assert ((New-ReleaseRegex ('^' + ('a' * 5000) + '$')).MatchTimeout.TotalSeconds -eq 1) 'Removing the pattern length cap must retain the regex time limit.'
$nestedTags = Read-ReleaseConfig $configPath @{branches=@(@{name='main';tag='stable/{{version}}';latest=$true});managedTags='^stable/.*$'}
$artifact = @(Add-YmbArtifactNames @(Get-ReleasePlan $customBranches $nestedTags))
Assert ($artifact.Count -eq 1 -and $artifact[0].artifact -cmatch '^YMB-[0-9a-f]{64}$') 'Valid tags containing slashes must still have safe artifact names.'
foreach ($invalid in @(
    @{assets=@('../secret.zip')}, @{draft='false'}, @{managedTags='.*'}, @{title="Two`nlines"},
    @{branches=@(@{name='main';tag='stable';latest='yes'})}, @{surprise=$true},
    @{branches=@(@{name='main';pattern='^main$';tag='stable'})},
    @{branches=@(@{pattern='^[$';tag='stable'})}
)) {
    $rejected = $false
    try { $null = Read-ReleaseConfig $configPath $invalid } catch { $rejected = $true }
    Assert $rejected 'Malformed release config must fail before publishing.'
}
$ambiguous = Read-ReleaseConfig $configPath @{branches=@(@{name='main';tag='stable'}, @{pattern='^main$';tag='preview'})}
$rejected = $false
try { $null = Get-ReleasePlan $customBranches $ambiguous } catch { $rejected = $_ -match 'More than one' }
Assert $rejected 'Overlapping branch rules must fail instead of choosing silently.'
$emptyCapture = Read-ReleaseConfig $configPath @{branches=@(@{pattern='^main(?<version>.*)$';tag='stable'})}
$rejected = $false
try { $null = Get-ReleasePlan $customBranches $emptyCapture } catch { $rejected = $_ -match 'version capture is empty' }
Assert $rejected 'An empty version capture must stop reconciliation instead of silently dropping its release.'

$script:mockBranches = @('master', '1.9.2', '2.10.1') | ForEach-Object { [pscustomobject]@{ name = $_; commit = @{ sha = "sha-$_" } } }
$script:missingManifests = @()
$script:masterSource = "[workspace.package]`nversion = `"2.0.0`""
$script:commands = [Collections.Generic.List[object]]::new()
$script:notes = [Collections.Generic.List[string]]::new()
function Reset-RemoteReleases {
    $script:remoteReleases = [Collections.Generic.List[object]]::new()
    foreach ($row in @(@{ id=1; tag_name='2.0.X'; draft=$false }, @{ id=2; tag_name='0.1.X'; draft=$false }, @{ id=3; tag_name='2.10.X-pre'; draft=$true }, @{ id=4; tag_name='v1.18.0'; draft=$false })) { $script:remoteReleases.Add([pscustomobject]$row) }
    $script:remoteTags = [Collections.Generic.List[object]]::new()
    foreach ($name in @('2.0.X','1.9.X','2.10.X-pre','0.1.X','v1.18.0')) { $script:remoteTags.Add([pscustomobject]@{name=$name;commit=@{sha="old-$name"}}) }
    $script:failCreate=$false
    $script:failPromotion=$false
    $script:commands.Clear()
    $script:notes.Clear()
}
Reset-RemoteReleases
function gh {
    $script:commands.Add(@($args))
    $global:LASTEXITCODE = 0
    $endpoint = $args[-1]
    if ($endpoint -like '*branches`?*') { "[$(ConvertTo-Json -InputObject $script:mockBranches -Depth 10 -Compress)]" }
    elseif ($endpoint -like '*contents`?ref=*') {
        if (($endpoint -split '\?ref=')[1] -cin $script:missingManifests) { '[{"name":"package.json"}]' }
        else { '[{"name":"Cargo.toml"}]' }
    }
    elseif ($endpoint -like '*contents/Cargo.toml`?*') { @{ content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script:masterSource)) } | ConvertTo-Json }
    elseif ($endpoint -like '*releases`?*') { "[$(ConvertTo-Json -InputObject @($script:remoteReleases.ToArray()) -Depth 10 -Compress)]" }
    elseif ($endpoint -like '*tags`?*') { "[$(ConvertTo-Json -InputObject @($script:remoteTags.ToArray()) -Depth 10 -Compress)]" }
    elseif ($args[0] -ceq 'release' -and $args[1] -ceq 'create') {
        $at = [array]::IndexOf($args, '--notes-file')
        if ($at -ge 0) { $script:notes.Add([IO.File]::ReadAllText($args[$at+1])) }
        if ($script:failCreate) { $global:LASTEXITCODE=1; return }
        $script:remoteReleases.Add([pscustomobject]@{id=100+$script:commands.Count;tag_name=$args[2];draft=$true})
    }
    elseif ($args[0] -ceq 'release' -and $args[1] -ceq 'edit') {
        if ($script:failPromotion -and '--draft=false' -cin $args) { $global:LASTEXITCODE=1; return }
        $release = $script:remoteReleases | Where-Object tag_name -CEQ $args[2]
        if (-not $release) { throw "Unknown mocked release: $($args[2])" }
        $at = [array]::IndexOf($args,'--tag')
        if ($at -ge 0) { $release.tag_name=$args[$at+1] }
        if ('--draft=false' -cin $args) { $release.draft=$false }
    }
    elseif ($args[0] -ceq 'api' -and 'DELETE' -cin $args) {
        if ($endpoint -match '/releases/(\d+)$') { $id=[int]$Matches[1]; @($script:remoteReleases | Where-Object id -EQ $id) | ForEach-Object { $script:remoteReleases.Remove($_)|Out-Null } }
        elseif ($endpoint -match '/git/refs/tags/(.+)$') { $name=[uri]::UnescapeDataString($Matches[1]); @($script:remoteTags|Where-Object name -CEQ $name)|ForEach-Object {$script:remoteTags.Remove($_)|Out-Null} }
    }
    elseif ($args[0] -ceq 'api' -and 'POST' -cin $args) {
        $name=($args|Where-Object {$_ -like 'ref=refs/tags/*'}).Substring(14)
        $sha=($args|Where-Object {$_ -like 'sha=*'}).Substring(4)
        $script:remoteTags.Add([pscustomobject]@{name=$name;commit=@{sha=$sha}})
    }
    elseif ($args[0] -ceq 'api' -and 'PATCH' -cin $args) {
        $ref=$args|Where-Object {$_ -like 'repos/*/git/refs/tags/*'}
        $name=[uri]::UnescapeDataString(($ref -split '/tags/')[1])
        ($script:remoteTags|Where-Object name -CEQ $name).commit.sha=($args|Where-Object {$_ -like 'sha=*'}).Substring(4)
    }
    else { throw "Unexpected mocked GitHub command: $($args -join ' ')" }
}
$plan = @(Get-RepositoryYmbReleasePlan 'fixture/repository')
Assert ($plan.Count -eq 3) 'Paginated GitHub metadata must be flattened.'
$optionalCapture = Read-ReleaseConfig $configPath @{branches=@(@{pattern='^master(?<version>[0-9]+\.[0-9]+\.[0-9]+)?$';tag='2.0.X';latest=$true})}
$optionalPlan = @(Get-RepositoryYmbReleasePlan 'fixture/repository' $optionalCapture)
Assert ($optionalPlan.Count -eq 1 -and $optionalPlan[0].version -ceq '2.0.0') 'A branch without its optional version capture must read the Cargo version.'
$script:missingManifests = @('sha-master', 'sha-1.9.2')
$script:commands.Clear()
$fallback = @(Get-RepositoryYmbReleasePlan 'fixture/repository')
Assert ($fallback.Count -eq 1 -and $fallback[0].branch -ceq '2.10.1' -and $fallback[0].latest -and -not $fallback[0].prerelease) 'Legacy branches without Cargo.toml must leave the normal stable release available.'
Assert (@($script:commands | Where-Object { $_[-1] -like '*contents/Cargo.toml`?*' }).Count -eq 0) 'Missing optional manifests must never be requested.'
$script:missingManifests = @()
$script:masterSource = '[workspace]'
$fallback = @(Get-RepositoryYmbReleasePlan 'fixture/repository')
Assert (@($fallback | Where-Object branch -CEQ 'master').Count -eq 0 -and ($fallback | Where-Object latest).branch -ceq '2.10.1') 'Incomplete optional master metadata must use the stable fallback.'
$script:masterSource = "[workspace.package]`nversion = `"2.0.0`""
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "ymb-release-tests-$([guid]::NewGuid())"))
try {
    foreach ($release in $plan) {
        $directory = Join-Path $testRoot $release.artifact
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $archive = Join-Path $directory "YMB-$($release.version)-windows-x64.zip"
        $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
        try {
            $writer = [IO.StreamWriter]::new($zip.CreateEntry('YMB/release-manifest.json').Open())
            try { $writer.Write((@{ version = $release.version } | ConvertTo-Json)) } finally { $writer.Dispose() }
        } finally { $zip.Dispose() }
        "$((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash)  $(Split-Path -Leaf $archive)" | Set-Content -LiteralPath "$archive.sha256"
    }
    $script:commands.Clear()
    $badDescription = Read-ReleaseConfig $configPath @{description='{{unknown_field}}'}
    $rejected = $false
    try { Publish-YmbReleases $plan $testRoot 'fixture/repository' $badDescription } catch { $rejected = $_ -match 'Unknown release placeholder' }
    Assert ($rejected -and $script:commands.Count -eq 0) 'A template typo must fail before touching GitHub.'
    $savedVersion = $plan[0].version
    $plan[0].version = '999.0.0'
    $rejected = $false
    try { Publish-YmbReleases $plan $testRoot 'fixture/repository' } catch { $rejected = $_ -match 'version does not match' }
    Assert ($rejected -and $script:commands.Count -eq 0) 'A branch version must match the checked package before publishing.'
    $plan[0].version = $savedVersion
    $script:mockBranches[0].commit.sha = 'moved-master'
    $rejected = $false
    try { Publish-YmbReleases $plan $testRoot 'fixture/repository' } catch { $rejected = $_ -match 'branches changed' }
    Assert $rejected 'A moved branch must reject stale release artifacts.'
    Assert (@($script:commands | Where-Object { 'DELETE' -cin $_ -or 'create' -cin $_ }).Count -eq 0) 'A stale plan must not mutate GitHub.'
    $script:mockBranches[0].commit.sha = 'sha-master'
    $checksum = Get-ChildItem -LiteralPath $testRoot -Recurse -Filter '*.sha256' | Select-Object -First 1
    $saved = Get-Content -LiteralPath $checksum.FullName -Raw
    'broken' | Set-Content -LiteralPath $checksum.FullName
    $script:commands.Clear()
    $rejected = $false
    try { Publish-YmbReleases $plan $testRoot 'fixture/repository' } catch { $rejected = $_ -match 'checksum mismatch' }
    Assert $rejected 'A corrupt artifact must stop publication.'
    Assert ($script:commands.Count -eq 0) 'All artifacts must be checked before any GitHub mutation.'
    $saved | Set-Content -LiteralPath $checksum.FullName
    Reset-RemoteReleases
    $script:failCreate=$true
    $rejected=$false
    try { Publish-CheckedRelease 'fixture/repository' '2.0.X' 'sha-master' @($checksum.FullName.Substring(0, $checksum.FullName.Length - 7)) 'Fixture' $false $true -Prefix ymb } catch { $rejected=$true }
    Assert $rejected 'An upload failure must stop publication.'
    Assert (@($script:commands|Where-Object {'DELETE' -cin $_ -or 'edit' -cin $_}).Count -eq 0) 'A failed staging upload must leave all old releases and tags alone.'
    Reset-RemoteReleases
    $script:failPromotion=$true
    $rejected=$false
    try { Publish-CheckedRelease 'fixture/repository' '2.0.X' 'sha-master' @($checksum.FullName.Substring(0, $checksum.FullName.Length - 7)) 'Fixture' $false $true -Prefix ymb } catch { $rejected=$true }
    Assert $rejected 'A failed promotion must stop cleanup.'
    Assert (@($script:remoteReleases|Where-Object { $_.id -eq 1 -and -not $_.draft }).Count -eq 1) 'The previous published release must survive a failed promotion.'
    Assert (($script:remoteReleases|Where-Object id -EQ 1).tag_name.StartsWith('ymb-previous-')) 'A failed promotion must retain the old release under its backup tag.'
    Assert (@($script:commands|Where-Object {'DELETE' -cin $_}).Count -eq 0) 'A failed promotion must not delete previous assets.'
    Reset-RemoteReleases
    $draftConfig = Get-YmbReleaseConfig
    $draftConfig.draft = $true
    Publish-CheckedRelease 'fixture/repository' '2.0.X' 'sha-master' @($checksum.FullName.Substring(0, $checksum.FullName.Length - 7)) 'Fixture' $false $true -Config $draftConfig -Prefix ymb
    $script:remoteReleases.Add([pscustomobject]@{id=999;tag_name='ymb-previous-deadbeef';draft=$true})
    $script:remoteTags.Add([pscustomobject]@{name='ymb-previous-deadbeef';commit=@{sha='old-draft'}})
    Remove-ObsoleteReleases 'fixture/repository' @('2.0.X','1.9.X','2.10.X-pre') @() $draftConfig 'ymb'
    Assert (@($script:remoteReleases | Where-Object { $_.id -eq 1 -and -not $_.draft }).Count -eq 1) 'Draft publishing must keep the previous public release available.'
    Assert (@($script:remoteReleases | Where-Object { $_.draft -and $_.tag_name -ceq '2.0.X' }).Count -eq 1) 'The configured draft channel must survive cleanup.'
    Assert (@($script:remoteReleases | Where-Object id -EQ 999).Count -eq 0 -and @($script:remoteTags | Where-Object name -CEQ 'ymb-previous-deadbeef').Count -eq 0) 'Superseded drafts and their tags must not accumulate.'
    Reset-RemoteReleases
    Publish-YmbReleases $plan $testRoot 'fixture/repository'
    $created = @($script:commands | Where-Object { $_[0] -ceq 'release' -and $_[1] -ceq 'create' })
    Assert ($created.Count -eq 3) 'Publish one release per active series and type.'
    foreach ($command in $created) {
        Assert (@($command | Where-Object { $_ -like '*.sha256' }).Count -eq 0) 'GitHub assets must exclude local checksum sidecars.'
        Assert ($command[([array]::IndexOf($command, '--title')+1)] -match '^\d+\.\d+\.\d+$') 'The default YMB title must contain only the version.'
        Assert ('--generate-notes' -cnotin $command) 'Default notes must stay compact.'
    }
    Assert (@($script:notes | Where-Object { $_ -notmatch 'SHA-256[\s\S]*[0-9a-f]{64}' -or $_ -notmatch 'GenerateMod.bat' -or $_ -notmatch 'LICENSE' -or $_ -notmatch 'discord.gg/33Sqn6dTjf' }).Count -eq 0) 'YMB descriptions must include setup, licensing, community help, and checksums.'
    Assert (@($created | Where-Object { '--draft' -cnotin $_ }).Count -eq 0) 'Uploads must finish in drafts before moving release channels.'
    $promoted=@($script:commands|Where-Object {'--draft=false' -cin $_})
    Assert ('--latest=true' -cin ($promoted|Where-Object {'2.0.X' -cin $_})) 'master must explicitly remain latest.'
    Assert ('--prerelease' -cin $created[-1] -and '2.10.X-pre' -cin $promoted[-1]) 'The greatest prerelease must be published last.'
    Assert (@($script:remoteReleases|Where-Object {-not $_.draft -and $_.tag_name -cin $plan.tag}).Count -eq 3) 'Only completed channel releases should remain.'
    $firstDelete = @($script:commands|ForEach-Object -Begin {$i=0} -Process {if ('DELETE' -cin $_){$i};$i++})[0]
    $lastPromotion = @($script:commands|ForEach-Object -Begin {$i=0} -Process {if ('--draft=false' -cin $_){$i};$i++})[-1]
    Assert ($firstDelete -gt $lastPromotion) 'No previous release may be removed before every replacement is published.'
    Assert (@($script:remoteReleases | Where-Object tag_name -CEQ 'v1.18.0').Count -eq 1 -and @($script:remoteTags | Where-Object name -CEQ 'v1.18.0').Count -eq 1) 'Rust preview reconciliation must preserve releases owned by the legacy workflow.'
    Assert (@($script:remoteTags | Where-Object name -CEQ '0.1.X').Count -eq 0) 'Obsolete Rust release channels must still be removed.'
    $savedBranches = $script:mockBranches
    $script:mockBranches = @()
    Publish-YmbReleases @() $testRoot 'fixture/repository'
    Assert (@($script:remoteTags | Where-Object name -CMatch '^[0-9]+\.[0-9]+\.X').Count -eq 0) 'An empty plan must clean up the final deleted Rust channels.'
    Assert (@($script:remoteTags | Where-Object name -CEQ 'v1.18.0').Count -eq 1) 'An empty Rust plan must keep legacy stable tags.'
    $script:mockBranches = $savedBranches
} finally {
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    if ((Split-Path -Parent $testRoot) -cne $parent) { throw 'Test cleanup escaped the temporary folder.' }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
$global:LASTEXITCODE = 0
Write-Host 'YMB release policy and publication checks passed.'

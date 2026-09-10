<#
.SYNOPSIS
    Build, commit, push and publish a new HDD release — safely.

.DESCRIPTION
    Automates the release ritual and guards the two things that are easy to get wrong:

      1. Your API key. Building from source uses app/config.json, which holds the real
         key. A distributed exe must never contain it. This script swaps in the
         placeholder from config.example.json before building and restores your real
         config in a finally block, so it is restored even if the build fails.

      2. Version drift. It sets the version in both package.json files and derives the
         artifact name from it, so the exe filename always matches the version.

    Steps:
      0. preflight  — repo, branch, clean tree, real key present
      1. version    — write the new version into both package.json files
      2. build      — placeholder config -> npm run dist -> restore real config
      3. verify     — read config.json back out of the packaged asar
      4. commit     — commit the version bump
      5. push       — push to origin
      6. release    — gh release create with the exe attached (skipped if gh is absent)

.PARAMETER Version
    Semantic version to release, e.g. 0.1.0. npm and electron-builder cannot use the
    short tag form, so give the full three-part version:
        Version  0.1.0   ->  exe HDD-0.1.0.exe        release tag v0.1
        Version  0.0.1   ->  exe HDD-0.0.1.exe        release tag v0.0.1
        Version  1.0.0   ->  exe HDD-1.0.0.exe        release tag v1.0

.PARAMETER Tag
    Override the release tag (default: v<major>.<minor>, or v<version> when patch is 0).

.PARAMETER Notes
    Path to the release notes file (default: RELEASE_NOTES.md, resolved against the
    project root). Keep using the same file for every release — edit it before running
    the script; the published GitHub release keeps its own frozen copy.

.PARAMETER GenerateNotes
    Let GitHub generate the notes from the commits since the previous release instead
    of using a file. Combine with -NotesPrefix to control the heading.

.PARAMETER NotesPrefix
    Heading used by -GenerateNotes (default: "Changes in "). The tag is appended.

.PARAMETER AllowEmptyNotes
    Permit publishing with no notes at all. By default the script refuses, so releases
    never end up blank by accident.

.PARAMETER Final
    Publish as a normal release instead of a pre-release.

.PARAMETER SkipTests
    Skip the regression tests before building.

.PARAMETER NoPush
    Commit but do not push, and do not create a GitHub release.

.PARAMETER DryRun
    Validate and print the plan without changing anything.

.PARAMETER VerifyOnly
    Run only the artifact checks against the build already sitting in app\dist, then stop.
    No version bump, no build, no tests, no commit. Needs app\dist\win-unpacked, which the
    portable target creates during a build and step 3 deletes afterwards — so this is for
    inspecting a fresh unpacked build, and for testing the checks themselves.

.EXAMPLE
    .\release.ps1 -Version 0.1.0
    Bump to 0.1.0, build, verify, commit, push and publish v0.1 as a pre-release,
    using RELEASE_NOTES.md as the release notes.

.EXAMPLE
    .\release.ps1 -Version 0.2.0 -GenerateNotes
    Same, but let GitHub generate the notes from the commits since v0.1.

.EXAMPLE
    .\release.ps1 -Version 0.2.0 -Notes docs\NOTES-0.2.md
    Use a per-version notes file instead of the shared RELEASE_NOTES.md.

.EXAMPLE
    .\release.ps1 -Version 0.1.0 -DryRun
    Show what would happen, change nothing.

.EXAMPLE
    .\release.ps1 -Version 0.1.0 -VerifyOnly
    Re-run only the checks on the asar currently in app\dist.

.EXAMPLE
    .\release.ps1 -Version 1.0.0 -Final
    Publish the final 1.0.0 as a normal (non-pre-release) release.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version,

    [string]$Tag,
    [string]$Notes = 'RELEASE_NOTES.md',
    [switch]$GenerateNotes,
    [string]$NotesPrefix = 'Changes in ',
    [switch]$AllowEmptyNotes,
    [switch]$Final,
    [switch]$SkipTests,
    [switch]$NoPush,
    [switch]$DryRun,
    [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------- helpers
function Info  { param([string]$m) Write-Host $m -ForegroundColor Cyan }
function Ok    { param([string]$m) Write-Host "  [ok]   $m" -ForegroundColor Green }
function Warn  { param([string]$m) Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Fail  { param([string]$m) Write-Host "  [FAIL] $m" -ForegroundColor Red; exit 1 }
function Step  { param([string]$m) Write-Host "`n=== $m ===" -ForegroundColor White }

# Checks on what actually landed inside the packaged asar. Split out from step 3 so it can
# also be run on its own against an existing build (-VerifyOnly), which is how the checks
# themselves get tested — a check that cannot be shown to fail is not a check.
function Assert-PackagedContents {
    param([string]$AsarFile, [string]$RealKey)

    if (-not (Test-Path $AsarFile)) {
        Warn "no unpacked asar at $AsarFile — skipped the deep verification of the exe contents"
        return
    }
    $asarTool = Join-Path $root 'app\node_modules\@electron\asar\bin\asar.js'
    if (-not (Test-Path $asarTool)) {
        Warn "asar tool not available — skipped the deep verification of the exe contents"
        return
    }

    $tmp = Join-Path $env:TEMP ("hdd-verify-" + [guid]::NewGuid().ToString('N'))
    try {
        Push-Location (Join-Path $root 'app')
        try { node $asarTool extract $AsarFile $tmp 2>&1 | Out-Null } finally { Pop-Location }

        if ($RealKey) {
            $packedCfg = Get-Content (Join-Path $tmp 'config.json') -Raw
            if ($packedCfg.Contains($RealKey)) { Fail "SECURITY: the built exe contains your real API key. Do not distribute it!" }
            Ok "exe contains no real API key"
        } else {
            Warn "no API key on hand — skipped the key-leak check"
        }

        $packedLive = Get-Content (Join-Path $tmp 'www\live.html') -Raw
        if ($packedLive -notmatch 'radial-gradient\(ellipse 78vmin 58vmin at 50% 46%') { Warn "the fade mask looks unexpected" } else { Ok "fade mask present" }
        if ($packedLive -notmatch 'function pinBottom\(\)') { Warn "pinBottom() is missing (auto-scroll will not work)" } else { Ok "auto-scroll (pinBottom) present" }
        if ($packedLive -notmatch 'font-weight:\s*400\s*!important') { Warn "the font-weight override is missing (text will look blurry)" } else { Ok "font-weight override present" }

        # Every local module the app pulls in must actually be inside the asar. The list is
        # derived from the require() calls rather than hardcoded, because hardcoding is what
        # failed: build.files was not updated when main.js gained conversation.js and
        # personality.js, and the resulting exe died on startup with MODULE_NOT_FOUND.
        $missing = [System.Collections.Generic.List[string]]::new()
        foreach ($src in @('main.js', 'conversation.js', 'personality.js', 'store.js')) {
            $srcPath = Join-Path $tmp $src
            if (-not (Test-Path $srcPath)) {
                if (-not $missing.Contains("$src is not packaged")) { $missing.Add("$src is not packaged") }
                continue
            }
            foreach ($m in [regex]::Matches((Get-Content $srcPath -Raw), "require\(['""]\./([^'""]+)['""]\)")) {
                $dep = $m.Groups[1].Value
                $note = "$dep is not packaged (required by $src)"
                if (-not (Test-Path (Join-Path $tmp $dep)) -and -not $missing.Contains($note)) { $missing.Add($note) }
            }
        }
        if ($missing.Count) {
            Fail "the packaged app cannot start — modules it requires are missing from the asar: $($missing -join '; ')"
        }
        Ok "all required modules are inside the asar"

        # A published artifact must not redistribute the font from app/fonts/ (ADR-011).
        $packedFonts = Get-ChildItem (Join-Path $tmp 'www\assets\fonts') -ErrorAction SilentlyContinue |
            Where-Object { @('.ttf', '.otf', '.woff', '.woff2') -contains $_.Extension.ToLower() }
        if ($packedFonts) {
            Fail "the exe embeds font files ($($packedFonts.Name -join ', ')). Published artifacts must not redistribute them — check that HDD_NO_FONTS=1 reached prep."
        }
        Ok "no font files in the exe"
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- locate repo
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
if (-not (Test-Path (Join-Path $root 'app\package.json'))) {
    Fail "release.ps1 must live in the project root (expected app/package.json next to it). Looked in: $root"
}
$appPkgPath  = Join-Path $root 'app\package.json'
$rootPkgPath = Join-Path $root 'package.json'
$cfgPath     = Join-Path $root 'app\config.json'
$examplePath = Join-Path $root 'app\config.example.json'
$notesPath   = Join-Path $root $Notes

# ---------------------------------------------------------------- validate version
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Fail "Version must be a three-part semantic version, e.g. 0.1.0 (got '$Version')."
}
$parts = $Version -split '\.'
$short = if ($parts[2] -eq '0') { "$($parts[0]).$($parts[1])" } else { $Version }
if (-not $Tag) { $Tag = "v$short" }
$exeName = "HDD-$Version.exe"

# ---------------------------------------------------------------- verify-only
# Checking the artifact is the one step worth being able to repeat on its own: it needs no
# key, changes nothing, and is the only way to test the checks against a known-bad build.
if ($VerifyOnly) {
    Step "Verify the artifact (no build, no commit)"
    $knownKey = ''
    if (Test-Path $cfgPath) {
        $km = [regex]::Match((Get-Content $cfgPath -Raw), '"apiKey"\s*:\s*"([^"]*)"')
        if ($km.Success) { $knownKey = $km.Groups[1].Value }
    }
    Assert-PackagedContents -AsarFile (Join-Path $root 'app\dist\win-unpacked\resources\app.asar') -RealKey $knownKey
    Info "`nVerify-only run complete."
    exit 0
}

# ---------------------------------------------------------------- preflight
Step "0. Preflight"

if (-not (Test-Path (Join-Path $root '.git'))) { Fail "Not a git repository: $root" }
Ok "git repository"

if (-not (Test-Path $cfgPath)) { Fail "Missing $cfgPath. Copy app/config.example.json to app/config.json first." }

$realCfg = Get-Content $cfgPath -Raw
$realKeyMatch = [regex]::Match($realCfg, '"apiKey"\s*:\s*"([^"]*)"')
if (-not $realKeyMatch.Success) { Fail "app/config.json has no apiKey field." }
$realKey = $realKeyMatch.Groups[1].Value
if (-not $realKey) {
    Fail "app/config.json has an empty apiKey. Put your real key in before releasing."
}
# Compare against the placeholder rather than pattern-matching a key shape: this is
# exact and cannot be fooled by a differently shaped placeholder.
if (Test-Path $examplePath) {
    $exKeyMatch = [regex]::Match((Get-Content $examplePath -Raw), '"apiKey"\s*:\s*"([^"]*)"')
    if ($exKeyMatch.Success -and $exKeyMatch.Groups[1].Value -eq $realKey) {
        Fail "app/config.json still holds the PLACEHOLDER key from config.example.json. Put your real key in before releasing."
    }
}
if ($realKey -match 'REPLACE|YOUR_|PLACEHOLDER') {
    Fail "app/config.json looks like a placeholder ('$($realKey.Substring(0,[Math]::Min(24,$realKey.Length)))...'). Put your real key in before releasing."
}
Ok "real API key present in app/config.json (will be swapped out for the build)"

$branch = (git -C $root rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Warn "on branch '$branch', not 'main'" } else { Ok "on branch main" }

$dirty = git -C $root status --porcelain
if ($dirty) {
    Warn "working tree has uncommitted changes:"
    $dirty | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray }
    if (-not $DryRun) {
        $answer = Read-Host "  Continue anyway? These will be included in the release commit (y/N)"
        if ($answer -ne 'y') { Fail "aborted by user" }
    }
} else { Ok "working tree clean" }

$oldVersion = (Get-Content $appPkgPath -Raw | ConvertFrom-Json).version
Ok "version: $oldVersion -> $Version   (exe $exeName, tag $Tag)"

if (-not (Test-Path $notesPath)) { Warn "release notes not found: $Notes (the release will be created without notes)" }
else { Ok "release notes: $Notes" }

# ---------------------------------------------------------------- release notes mode
# Exactly one of: a notes file, GitHub-generated notes, or nothing (refused unless
# -AllowEmptyNotes). Deciding here means preflight can report it before anything is built.
$notesMode = $null
if ($GenerateNotes) {
    $notesMode = 'generate'
    if (Test-Path $notesPath) { Info "  -GenerateNotes wins over $Notes; the file will not be attached" }
    Ok "release notes: generated by GitHub ('$NotesPrefix$Tag')"
} elseif (Test-Path $notesPath) {
    $notesMode = 'file'
} else {
    if (-not $AllowEmptyNotes) {
        Fail @"
release notes not found: $Notes
        Create it (or point -Notes at an existing file), let GitHub write the notes with
        -GenerateNotes, or explicitly accept an empty release with -AllowEmptyNotes.
"@
    }
    $notesMode = 'none'
    Warn "publishing with no release notes (-AllowEmptyNotes given)"
}

function Get-GhExe {
    <#
        Resolve the gh CLI. Get-Command alone is not enough: a freshly installed gh
        lives on the machine PATH, but an already-running shell keeps its old PATH
        snapshot and will not see it.
    #>
    $cmd = Get-Command gh -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'GitHub CLI\gh.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI\gh.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\gh.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

$gh = Get-GhExe
if ($gh) { Ok "gh CLI found: $gh" }
else { Warn "gh CLI not installed — the script will stop after pushing; publish the release manually" }

if ($DryRun) {
    Info "`n--- DRY RUN: nothing will be changed ---"
    Info "  would write version $Version into app/package.json and package.json"
    Info "  would build with a placeholder key (your real key is preserved and restored)"
    Info "  would verify $exeName inside the packaged asar"
    if (-not $SkipTests) { Info "  would run the regression tests" }
    Info "  would commit the version bump and push to origin/$branch"
    if ($gh) { Info "  would create GitHub release $Tag $(if($Final){'(final)'}else{'(pre-release)'}) with $exeName attached" }
    else     { Info "  would print manual release instructions" }
    Info "`nDry run complete."
    exit 0
}

# ---------------------------------------------------------------- 1. version bump
Step "1. Version $oldVersion -> $Version"

function Set-JsonVersion {
    param([string]$Path, [string]$NewVersion)
    $raw = Get-Content $Path -Raw
    $updated = [regex]::Replace($raw, '("version"\s*:\s*")[^"]*(")', "`${1}$NewVersion`${2}", 1)
    if ($updated -eq $raw) { Fail "could not update 'version' in $Path" }
    Set-Content -Path $Path -Value $updated -Encoding UTF8 -NoNewline
}

<#
    Run a build with a placeholder API key in place, then ALWAYS restore the real
    config. Extracted into a function so the restoration guarantee can be tested by
    injecting a throw (see the -SelfTest of this script's development notes).
#>
function Invoke-WithPlaceholderConfig {
    param(
        [Parameter(Mandatory = $true)][string]$CfgPath,
        [Parameter(Mandatory = $true)][string]$ExamplePath,
        [Parameter(Mandatory = $true)][string]$RealKey,
        [Parameter(Mandatory = $true)][string]$RealRaw,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )
    try {
        if (-not (Test-Path $ExamplePath)) { Fail "Missing $ExamplePath — cannot build a key-free bundle." }
        Copy-Item $ExamplePath $CfgPath -Force
        if ((Get-Content $CfgPath -Raw).Contains($RealKey)) {
            Fail "placeholder swap failed: the real key is still in app/config.json"
        }
        & $Action
    }
    finally {
        Set-Content -Path $CfgPath -Value $RealRaw -Encoding UTF8 -NoNewline
    }
    return (Get-Content $CfgPath -Raw).Contains($RealKey)
}

Set-JsonVersion -Path $appPkgPath  -NewVersion $Version
Set-JsonVersion -Path $rootPkgPath -NewVersion $Version
Ok "app/package.json  version = $Version"
Ok "package.json      version = $Version"

# ---------------------------------------------------------------- 2. build with placeholder key
Step "2. Build (placeholder key -> dist -> restore real key)"

$keyRestored = $false
$keyRestored = Invoke-WithPlaceholderConfig -CfgPath $cfgPath -ExamplePath $examplePath `
    -RealKey $realKey -RealRaw $realCfg -Action {
        Ok "app/config.json swapped to the placeholder"

        if (-not $SkipTests) {
            Info "  running regression tests..."
            Push-Location $root
            try { npm test 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "tests failed — fix them before releasing" } }
            finally { Pop-Location }
            Ok "tests passed"
            # Baking is reproducible now, so a diff here means a source asset really
            # changed. Report it and let step 4 commit it: silently reverting would ship an
            # exe built from assets the repository does not describe.
            $rebaked = git -C $root status --porcelain -- MANIFEST.json assets/preview.html assets/tokens/fairy-palette.json
            if ($rebaked) {
                Warn "re-baking changed committed asset output (these will be committed):"
                $rebaked | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray }
            }
        }

        Info "  running npm run dist (this takes a few minutes)..."
        Push-Location (Join-Path $root 'app')
        try {
            # Published artifacts must not embed the font from app/fonts/ (ADR-011).
            # prep.cjs reads this and skips font registration entirely.
            $env:HDD_NO_FONTS = '1'
            npm run dist 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
            if ($LASTEXITCODE -ne 0) { throw "build failed" }
        } finally {
            Remove-Item Env:HDD_NO_FONTS -ErrorAction SilentlyContinue
            Pop-Location
        }
        Ok "build finished (fonts excluded)"
    }
if ($keyRestored) { Ok "your real API key was restored into app/config.json" }
else { Fail "COULD NOT restore app/config.json — put your real key back before running the app!" }

# ---------------------------------------------------------------- 3. verify the artifact
Step "3. Verify the artifact"

$exePath = Join-Path $root "app\dist\$exeName"
if (-not (Test-Path $exePath)) {
    $found = Get-ChildItem (Join-Path $root 'app\dist') -Filter '*.exe' -ErrorAction SilentlyContinue
    if ($found) { Fail "expected $exeName but found: $($found.Name -join ', ')" }
    else { Fail "no exe produced — check the build output above" }
}
$exeSizeMb = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
Ok "artifact: app/dist/$exeName  ($exeSizeMb MB)"

$asarFile = Join-Path $root 'app\dist\win-unpacked\resources\app.asar'
Assert-PackagedContents -AsarFile $asarFile -RealKey $realKey
Remove-Item (Join-Path $root 'app\dist\win-unpacked') -Recurse -Force -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- 4. commit
Step "4. Commit"

git -C $root add -A | Out-Null
$staged = git -C $root diff --cached --name-only
if (-not $staged) { Warn "nothing to commit (version already $Version?)" }
else {
    git -C $root commit -q -m "Release $Tag ($Version)"
    Ok "committed: Release $Tag ($Version)"
}
git -C $root log --oneline -1 | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray }

if ($NoPush) {
    Info "`n-NoPush given: stopping before push."
    Info "  artifact: app\dist\$exeName"
    Info "  publish manually: gh release create $Tag `"app\dist\$exeName`" --title `"HDD $Tag`" --notes-file $Notes $(if($Final){''}else{'--prerelease'})"
    exit 0
}

# ---------------------------------------------------------------- 5. push
Step "5. Push"

git -C $root push 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
if ($LASTEXITCODE -ne 0) { Fail "git push failed" }
Ok "pushed to origin/$branch"

# ---------------------------------------------------------------- 6. GitHub release
Step "6. GitHub release"

if (-not $gh) {
    Warn "gh CLI is not installed, so the release was not created automatically."
    Info "`n  Publish it manually — command to paste:"
    Write-Host ""
    Write-Host "    gh release create $Tag `"app\dist\$exeName`" --title `"HDD $Tag`" --notes-file $Notes $(if($Final){''}else{'--prerelease'})" -ForegroundColor Yellow
    Write-Host ""
    Info "  Or open:  https://github.com/KarinnKyou/Fairy/releases/new"
    Info "    1. Choose a tag: $Tag   (create it on publish, target: $branch)"
    Info "    2. Title:  HDD $Tag"
    Info "    3. Paste the contents of $Notes"
    Info "    4. $(if($Final){'Leave pre-release unchecked'}else{'Tick "Set as a pre-release"'})"
    Info "    5. Attach: app\dist\$exeName"
    Info "`n  To automate this next time:  winget install --id GitHub.cli   then  gh auth login"
    exit 0
}

$releaseArgs = @('release', 'create', $Tag, "app\dist\$exeName", '--title', "HDD $Tag")
switch ($notesMode) {
    'generate' { $releaseArgs += '--generate-notes' }
    'file'     { $releaseArgs += @('--notes-file', $Notes) }
    'none'     { $releaseArgs += @('--notes', '') }
}
if (-not $Final) { $releaseArgs += '--prerelease' }

& $gh @releaseArgs 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
if ($LASTEXITCODE -ne 0) {
    Warn "gh release create failed (already exists? not authenticated?). Publish manually:"
    $manual = "gh release create $Tag `"app\dist\$exeName`" --title `"HDD $Tag`""
    if ($notesMode -eq 'generate')     { $manual += ' --generate-notes' }
    elseif ($notesMode -eq 'file')     { $manual += " --notes-file $Notes" }
    if (-not $Final) { $manual += ' --prerelease' }
    Write-Host "    $manual" -ForegroundColor Yellow
    exit 1
}

Step "Done"
Ok "released $Tag $(if($Final){'(final)'}else{'(pre-release)'})"
Ok "artifact: app\dist\$exeName"
Ok "your real API key is back in app/config.json — the exe does not contain it"

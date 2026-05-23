param(
  [string]$Root = "D:\SirisLi\GitHub",
  [string]$Source = "fork-watch",
  [int]$SummaryLimit = 3000,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-TLiveConfig {
  $settings = @{}
  $configPath = Join-Path $HOME ".tlive\config.env"
  if (Test-Path -LiteralPath $configPath) {
    foreach ($line in Get-Content -LiteralPath $configPath) {
      $trimmed = $line.Trim()
      if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
      if ($trimmed -match "^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {
        $key = $Matches[1]
        $value = $Matches[2].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
          $value = $value.Substring(1, $value.Length - 2)
        }
        $settings[$key] = $value
      }
    }
  }
  if ($env:TL_CORE_URL) { $settings["TL_CORE_URL"] = $env:TL_CORE_URL }
  if ($env:TL_TOKEN) { $settings["TL_TOKEN"] = $env:TL_TOKEN }
  return $settings
}

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string[]]$GitArgs
  )

  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & git -C $Repo @GitArgs 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }

  if ($exitCode -ne 0) {
    $message = ($output | Out-String).Trim()
    if ($message -eq "") { $message = "git exited with code $exitCode" }
    throw $message
  }
  return ($output | Out-String).Trim()
}

function Try-Git {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string[]]$GitArgs
  )

  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & git -C $Repo @GitArgs 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }

  if ($exitCode -ne 0) { return "" }
  return ($output | Out-String).Trim()
}

function Test-GitRef {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Ref
  )

  $oldErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & git -C $Repo show-ref --verify --quiet $Ref *> $null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldErrorActionPreference
  }

  return $exitCode -eq 0
}

function Get-RemoteDefaultBranch {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$Remote
  )

  $symbolic = Try-Git -Repo $Repo -GitArgs @("symbolic-ref", "--quiet", "--short", "refs/remotes/$Remote/HEAD")
  if ($symbolic) { return ($symbolic -replace "^$Remote/", "") }

  $remoteInfo = Try-Git -Repo $Repo -GitArgs @("remote", "show", $Remote)
  foreach ($line in ($remoteInfo -split "`r?`n")) {
    if ($line -match "HEAD branch:\s+(.+)$") {
      $branch = $Matches[1].Trim()
      if ($branch -and $branch -ne "(unknown)") { return $branch }
    }
  }

  foreach ($candidate in @("main", "master")) {
    if (Test-GitRef -Repo $Repo -Ref "refs/remotes/$Remote/$candidate") { return $candidate }
  }

  return ""
}

function Resolve-LocalRef {
  param(
    [Parameter(Mandatory = $true)][string]$Repo
  )

  $current = Try-Git -Repo $Repo -GitArgs @("branch", "--show-current")
  if ($current -and (Test-GitRef -Repo $Repo -Ref "refs/heads/$current")) { return "refs/heads/$current" }

  foreach ($branch in @("main", "master")) {
    $localRef = "refs/heads/$branch"
    if (Test-GitRef -Repo $Repo -Ref $localRef) { return $localRef }
  }

  return "HEAD"
}

function Resolve-OriginRef {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$OriginBranch
  )

  $tracking = Try-Git -Repo $Repo -GitArgs @("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
  if ($tracking -and $tracking.StartsWith("origin/")) {
    $trackingRef = "refs/remotes/$tracking"
    if (Test-GitRef -Repo $Repo -Ref $trackingRef) { return $trackingRef }
  }

  $current = Try-Git -Repo $Repo -GitArgs @("branch", "--show-current")
  if ($current) {
    $currentOriginRef = "refs/remotes/origin/$current"
    if (Test-GitRef -Repo $Repo -Ref $currentOriginRef) { return $currentOriginRef }
  }

  if ($OriginBranch) {
    $defaultOriginRef = "refs/remotes/origin/$OriginBranch"
    if (Test-GitRef -Repo $Repo -Ref $defaultOriginRef) { return $defaultOriginRef }
  }

  foreach ($branch in @("main", "master")) {
    $originRef = "refs/remotes/origin/$branch"
    if (Test-GitRef -Repo $Repo -Ref $originRef) { return $originRef }
  }

  return ""
}

function Get-AheadBehind {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$LeftRef,
    [Parameter(Mandatory = $true)][string]$RightRef
  )

  $counts = Invoke-Git -Repo $Repo -GitArgs @("rev-list", "--left-right", "--count", "$LeftRef...$RightRef")
  $parts = $counts -split "\s+"
  if ($parts.Count -lt 2) { throw "cannot parse rev-list counts for $LeftRef...$RightRef" }

  return [pscustomobject]@{
    Left = [int]$parts[0]
    Right = [int]$parts[1]
  }
}

function Get-ForkStatus {
  param([Parameter(Mandatory = $true)][string]$Repo)

  $name = Split-Path -Leaf $Repo
  $remotes = Invoke-Git -Repo $Repo -GitArgs @("remote")
  if (($remotes -split "`r?`n") -notcontains "upstream") { return $null }
  if (($remotes -split "`r?`n") -notcontains "origin") { throw "missing origin remote" }

  Invoke-Git -Repo $Repo -GitArgs @("fetch", "origin", "--prune") | Out-Null
  Invoke-Git -Repo $Repo -GitArgs @("fetch", "upstream", "--prune") | Out-Null

  $upstreamBranch = Get-RemoteDefaultBranch -Repo $Repo -Remote "upstream"
  if (-not $upstreamBranch) { throw "cannot resolve upstream default branch" }
  $originBranch = Get-RemoteDefaultBranch -Repo $Repo -Remote "origin"
  if (-not $originBranch) { throw "cannot resolve origin default branch" }

  $upstreamRef = "refs/remotes/upstream/$upstreamBranch"
  if (-not (Test-GitRef -Repo $Repo -Ref $upstreamRef)) { throw "missing $upstreamRef after fetch" }

  $forkRef = "refs/remotes/origin/$originBranch"
  if (-not (Test-GitRef -Repo $Repo -Ref $forkRef)) { throw "missing $forkRef after fetch" }

  $localRef = Resolve-LocalRef -Repo $Repo
  $originRef = Resolve-OriginRef -Repo $Repo -OriginBranch $originBranch
  if (-not $originRef) { throw "cannot resolve origin comparison ref" }

  $localCounts = Get-AheadBehind -Repo $Repo -LeftRef $localRef -RightRef $originRef
  $forkCounts = Get-AheadBehind -Repo $Repo -LeftRef $forkRef -RightRef $upstreamRef
  $workingTreeState = if (Try-Git -Repo $Repo -GitArgs @("status", "--porcelain")) { "dirty" } else { "clean" }

  return [pscustomobject]@{
    Name = $name
    OriginAhead = $localCounts.Right
    LocalAhead = $localCounts.Left
    ForkAhead = $forkCounts.Left
    UpstreamAhead = $forkCounts.Right
    WorkingTreeState = $workingTreeState
    UpstreamBranch = "upstream/$upstreamBranch"
    OriginBranch = "origin/$originBranch"
    LocalRef = $localRef
    OriginRef = $originRef
  }
}

$config = Read-TLiveConfig
$coreUrl = if ($config["TL_CORE_URL"]) {
  $config["TL_CORE_URL"]
} elseif ($config["TL_PORT"]) {
  "http://localhost:$($config["TL_PORT"])"
} else {
  "http://localhost:4590"
}
$coreUrl = $coreUrl.TrimEnd("/")
$token = if ($config["TL_TOKEN"]) { $config["TL_TOKEN"] } else { "" }

if (-not (Test-Path -LiteralPath $Root)) {
  throw "Root path not found: $Root"
}

$repos = Get-ChildItem -LiteralPath $Root -Directory |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName ".git") } |
  Sort-Object Name

$lines = New-Object System.Collections.Generic.List[string]
$hasUpdates = $false
$hasErrors = $false

foreach ($repo in $repos) {
  try {
    $status = Get-ForkStatus -Repo $repo.FullName
    if ($null -eq $status) { continue }
    if ($status.UpstreamAhead -gt 0) { $hasUpdates = $true }
    $lines.Add($status.Name)
    $lines.Add(("  local vs origin: local +{0}, origin +{1}, {2}" -f $status.LocalAhead, $status.OriginAhead, $status.WorkingTreeState))
    $lines.Add(("  origin vs upstream: fork +{0}, upstream +{1}" -f $status.ForkAhead, $status.UpstreamAhead))
  } catch {
    $hasErrors = $true
    $lines.Add(("{0} check failed: {1}" -f $repo.Name, $_.Exception.Message))
  }
}

if ($lines.Count -eq 0) {
  $summary = "No repositories with upstream remote found under $Root."
} else {
  $summary = ($lines -join "`n")
}

if ($summary.Length -gt $SummaryLimit) {
  $summary = $summary.Substring(0, [Math]::Max(0, $SummaryLimit - 3)) + "..."
}

$severity = if ($hasErrors) { "warning" } elseif ($hasUpdates) { "info" } else { "info" }
$payload = @{
  tlive_hook_type = "external"
  source = $Source
  title = "GitHub fork updates"
  summary = $summary
  severity = $severity
}

if ($DryRun) {
  $payload | ConvertTo-Json -Depth 5
  exit 0
}

$headers = @{ "Content-Type" = "application/json" }
if ($token) { $headers["Authorization"] = "Bearer $token" }

Invoke-RestMethod `
  -Method Post `
  -Uri "$coreUrl/api/hooks/notify" `
  -Headers $headers `
  -Body ($payload | ConvertTo-Json -Depth 5) | Out-Null

Write-Host "Posted fork update summary to $coreUrl/api/hooks/notify"

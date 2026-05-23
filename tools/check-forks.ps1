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
    $exists = Try-Git -Repo $Repo -GitArgs @("show-ref", "--verify", "--quiet", "refs/remotes/$Remote/$candidate")
    if ($LASTEXITCODE -eq 0 -or $exists) { return $candidate }
  }

  return ""
}

function Resolve-CompareRef {
  param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [Parameter(Mandatory = $true)][string]$OriginBranch
  )

  if ($OriginBranch) {
    $originRef = "refs/remotes/origin/$OriginBranch"
    Try-Git -Repo $Repo -GitArgs @("show-ref", "--verify", "--quiet", $originRef) | Out-Null
    if ($LASTEXITCODE -eq 0) { return $originRef }
  }

  foreach ($branch in @("main", "master")) {
    $localRef = "refs/heads/$branch"
    Try-Git -Repo $Repo -GitArgs @("show-ref", "--verify", "--quiet", $localRef) | Out-Null
    if ($LASTEXITCODE -eq 0) { return $localRef }
  }

  $current = Try-Git -Repo $Repo -GitArgs @("branch", "--show-current")
  if ($current) { return "refs/heads/$current" }
  return "HEAD"
}

function Get-ForkStatus {
  param([Parameter(Mandatory = $true)][string]$Repo)

  $name = Split-Path -Leaf $Repo
  $remotes = Invoke-Git -Repo $Repo -GitArgs @("remote")
  if (($remotes -split "`r?`n") -notcontains "upstream") { return $null }

  Invoke-Git -Repo $Repo -GitArgs @("fetch", "upstream", "--prune") | Out-Null

  $upstreamBranch = Get-RemoteDefaultBranch -Repo $Repo -Remote "upstream"
  if (-not $upstreamBranch) { throw "cannot resolve upstream default branch" }
  $originBranch = Get-RemoteDefaultBranch -Repo $Repo -Remote "origin"

  $upstreamRef = "refs/remotes/upstream/$upstreamBranch"
  Try-Git -Repo $Repo -GitArgs @("show-ref", "--verify", "--quiet", $upstreamRef) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "missing $upstreamRef after fetch" }

  $baseRef = Resolve-CompareRef -Repo $Repo -OriginBranch $originBranch
  $counts = Invoke-Git -Repo $Repo -GitArgs @("rev-list", "--left-right", "--count", "$baseRef...$upstreamRef")
  $parts = $counts -split "\s+"
  $localAhead = [int]$parts[0]
  $upstreamAhead = [int]$parts[1]

  return [pscustomobject]@{
    Name = $name
    UpstreamAhead = $upstreamAhead
    LocalAhead = $localAhead
    UpstreamBranch = "upstream/$upstreamBranch"
    BaseRef = $baseRef
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
    $lines.Add(("{0} upstream +{1}, local +{2}" -f $status.Name, $status.UpstreamAhead, $status.LocalAhead))
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

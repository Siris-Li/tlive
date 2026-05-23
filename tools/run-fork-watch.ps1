param(
  [string]$Root = "D:\SirisLi\GitHub",
  [int]$CoreLeaseSeconds = 240,
  [int]$CoreWaitSeconds = 20
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TLiveHome = Join-Path $HOME ".tlive"
$LogDir = Join-Path $TLiveHome "logs"
$LogPath = Join-Path $LogDir "fork-watch.log"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CheckScript = Join-Path $ScriptDir "check-forks.ps1"

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-Log {
  param([Parameter(Mandatory = $true)][string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -LiteralPath $LogPath -Value "[$stamp] $Message"
}

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
  return $settings
}

function Get-CoreEndpoint {
  $config = Read-TLiveConfig
  $coreUrl = if ($config["TL_CORE_URL"]) {
    $config["TL_CORE_URL"]
  } elseif ($config["TL_PORT"]) {
    "http://localhost:$($config["TL_PORT"])"
  } else {
    "http://localhost:4590"
  }
  $headers = @{}
  if ($config["TL_TOKEN"]) {
    $headers["Authorization"] = "Bearer $($config["TL_TOKEN"])"
  }
  return @{
    Url = $coreUrl.TrimEnd("/")
    Headers = $headers
  }
}

function Test-CoreAvailable {
  $endpoint = Get-CoreEndpoint
  try {
    $resp = Invoke-WebRequest `
      -UseBasicParsing `
      -Method Get `
      -Uri "$($endpoint.Url)/api/status" `
      -Headers $endpoint.Headers `
      -TimeoutSec 3
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Ensure-Bridge {
  $tlive = (Get-Command tlive -ErrorAction Stop).Source
  Write-Log "Ensuring Bridge is running."
  $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $tlive start --runtime codex 2>&1
  foreach ($line in $output) { Write-Log "tlive start: $line" }
}

function Ensure-Core {
  if (Test-CoreAvailable) {
    Write-Log "Core already available."
    return
  }

  $tlive = (Get-Command tlive -ErrorAction Stop).Source
  Write-Log "Starting temporary Core lease for $CoreLeaseSeconds seconds."
  Start-Process `
    -WindowStyle Hidden `
    -FilePath powershell `
    -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $tlive,
      "powershell",
      "-NoProfile",
      "-Command",
      "Start-Sleep -Seconds $CoreLeaseSeconds"
    ) | Out-Null

  $deadline = (Get-Date).AddSeconds($CoreWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 1
    if (Test-CoreAvailable) {
      Write-Log "Temporary Core is available."
      return
    }
  }

  throw "Core did not become available within $CoreWaitSeconds seconds."
}

try {
  Write-Log "Fork watch started. Root=$Root"
  Ensure-Bridge
  Ensure-Core

  $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $CheckScript -Root $Root 2>&1
  $exitCode = $LASTEXITCODE
  foreach ($line in $output) { Write-Log "check-forks: $line" }

  if ($exitCode -ne 0) {
    throw "check-forks exited with code $exitCode"
  }

  Write-Log "Fork watch completed."
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  throw
}

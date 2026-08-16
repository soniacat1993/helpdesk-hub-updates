param(
  [Parameter(Mandatory=$true)][string]$AppRoot,
  [Parameter(Mandatory=$true)][string]$StagingDir,
  [Parameter(Mandatory=$true)][int]$ParentPid
)

$ErrorActionPreference = "Stop"
$allowed = @(
  "server.js",
  "public/app.js",
  "public/index.html",
  "public/style.css",
  "database/schema.sql",
  "Apply-AutoUpdate.ps1",
  "app-version.json"
)
$planPath = Join-Path $StagingDir "update-plan.json"
$plan = Get-Content $planPath -Raw | ConvertFrom-Json
if ($plan.version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid update version." }
foreach ($item in $plan.files) {
  if ($allowed -notcontains $item.path) { throw "Unapproved update file: $($item.path)" }
  if (-not (Test-Path (Join-Path $StagingDir $item.path))) { throw "Missing staged file: $($item.path)" }
}

Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = Join-Path $AppRoot "data\update-backups\automatic-$stamp"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
$copied = @()

try {
  foreach ($item in $plan.files) {
    $relative = [string]$item.path
    $source = Join-Path $StagingDir $relative
    $destination = Join-Path $AppRoot $relative
    $backup = Join-Path $backupDir $relative
    if (Test-Path $destination) {
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backup) | Out-Null
      Copy-Item $destination $backup -Force
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item $source $destination -Force
    $copied += $relative
  }

  $process = Start-Process node -ArgumentList "server.js" -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 4
  if ($process.HasExited) { throw "The updated app did not start." }
  Set-Content -Path (Join-Path $AppRoot "data\last-update-result.json") -Value (ConvertTo-Json @{ ok=$true; version=$plan.version; backup=$backupDir }) -Encoding UTF8
} catch {
  foreach ($relative in $copied) {
    $destination = Join-Path $AppRoot $relative
    $backup = Join-Path $backupDir $relative
    if (Test-Path $backup) { Copy-Item $backup $destination -Force }
  }
  Start-Process node -ArgumentList "server.js" -WorkingDirectory $AppRoot -WindowStyle Hidden | Out-Null
  Set-Content -Path (Join-Path $AppRoot "data\last-update-result.json") -Value (ConvertTo-Json @{ ok=$false; error=$_.Exception.Message; backup=$backupDir }) -Encoding UTF8
}

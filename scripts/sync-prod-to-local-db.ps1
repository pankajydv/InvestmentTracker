param(
    [string]$SshKeyPath = "configs/ssh-key-2026-05-06.key",
    [string]$RemoteUserHost = "ubuntu@92.4.90.130",
    [string]$RemoteDbPath = "/data/investments.db",
    [string]$LocalDbPath = "data/investments.db",
    [string]$LocalBackupDir = "data/exports",
    [bool]$BlockWhenLocalPortsActive = $true,
    [string]$LocalPorts = "3000,4000"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path $SshKeyPath)) {
    throw "SSH key not found: $SshKeyPath"
}
if (-not (Test-Path $LocalDbPath)) {
    throw "Local DB not found: $LocalDbPath"
}
if (-not (Test-Path $LocalBackupDir)) {
    New-Item -ItemType Directory -Path $LocalBackupDir -Force | Out-Null
}

$ts = Get-Date -Format "yyyyMMddTHHmmssZ"
$remoteTmp = "/tmp/prod-to-local-$ts.db"
$localDownloaded = "$LocalBackupDir/prod-to-local-$ts.db"
$localBackup = "$LocalBackupDir/investments.local-before-prod-sync-$ts.db"

Write-Host "=== WAL-aware production -> local DB sync ==="

if ($BlockWhenLocalPortsActive) {
    $ports = $LocalPorts -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $activePids = @()
    foreach ($port in $ports) {
        $matched = netstat -ano | Select-String ":$port" | Select-String "LISTENING" | ForEach-Object { ($_ -split "\s+")[-1] }
        if ($matched) {
            $activePids += $matched
        }
    }
    $activePids = $activePids | Where-Object { $_ -match '^\d+$' } | Select-Object -Unique
    if ($activePids.Count -gt 0) {
        throw "Local app appears active on ports [$LocalPorts] with PID(s): $($activePids -join ', '). Stop local app before replacing local DB."
    }
}

Write-Host "[1/7] Create WAL-aware production snapshot"
ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "set -e; sqlite3 $RemoteDbPath '.backup $remoteTmp'; ls -lh $remoteTmp"

Write-Host "[2/7] Hash production snapshot"
$remoteHash = ((ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "sha256sum $remoteTmp") -split '\s+')[0].ToLower()
Write-Host "REMOTE_HASH=$remoteHash"

Write-Host "[3/7] Download snapshot"
scp -o BatchMode=yes -o StrictHostKeyChecking=no -i $SshKeyPath "${RemoteUserHost}:$remoteTmp" "$localDownloaded"

Write-Host "[4/7] Verify downloaded hash"
$localDownloadedHash = (Get-FileHash $localDownloaded -Algorithm SHA256).Hash.ToLower()
Write-Host "LOCAL_DOWNLOADED_HASH=$localDownloadedHash"
if ($localDownloadedHash -ne $remoteHash) {
    throw "Downloaded snapshot hash mismatch. remote=$remoteHash local=$localDownloadedHash"
}

Write-Host "[5/7] Backup current local DB"
Copy-Item $LocalDbPath $localBackup -Force
Write-Host "LOCAL_BACKUP=$localBackup"

Write-Host "[6/7] Replace local DB and remove sidecars"
Copy-Item $localDownloaded $LocalDbPath -Force
Remove-Item -Force -ErrorAction SilentlyContinue "${LocalDbPath}-wal", "${LocalDbPath}-shm"

Write-Host "[7/7] Final local parity check"
$localFinalHash = (Get-FileHash $LocalDbPath -Algorithm SHA256).Hash.ToLower()
Write-Host "LOCAL_FINAL_HASH=$localFinalHash"
if ($localFinalHash -ne $remoteHash) {
    throw "Final local hash mismatch. remote=$remoteHash localFinal=$localFinalHash"
}

ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "rm -f $remoteTmp"

Write-Host "LOCAL_DB=$LocalDbPath"
Write-Host "DOWNLOADED_SNAPSHOT=$localDownloaded"
Write-Host "RESULT=SUCCESS"
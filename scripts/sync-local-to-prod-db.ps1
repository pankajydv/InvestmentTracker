param(
    [string]$SshKeyPath = "configs/ssh-key-2026-05-06.key",
    [string]$RemoteUserHost = "ubuntu@92.4.90.130",
    [string]$LocalDbPath = "data/investments.db",
    [string]$RemoteDbPath = "/data/investments.db",
    [string]$RemoteBackupDir = "/data/migration-backups",
    [string]$ContainerNamePattern = "investment-tracker",
    [bool]$RestartContainer = $true,
    [int]$HealthTimeoutSeconds = 90
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

$ts = Get-Date -Format "yyyyMMddTHHmmssZ"
$localSnapshot = "data/exports/investments.local-to-prod-$ts.db"
$remoteTmp = "/tmp/investments.local-to-prod-$ts.db"
$prodBackup = "$RemoteBackupDir/investments.pre-local-sync-$ts.db"

Write-Host "=== WAL-aware local -> production DB sync ==="

# Block if deployment activity is in progress.
$deployJobs = ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "pgrep -af '[d]ocker.*(build|pull|push|deploy)' || true"
if ($deployJobs -and $deployJobs.Trim().Length -gt 0) {
    throw "Active deployment process detected on production. Aborting.`n$deployJobs"
}

Write-Host "[1/8] Create WAL-aware local snapshot"
node -e "const Database=require('better-sqlite3');(async()=>{const db=new Database(process.argv[1],{readonly:true});await db.backup(process.argv[2]);db.close();console.log('BACKUP_OK')})().catch(e=>{console.error(e);process.exit(1)});" "$LocalDbPath" "$localSnapshot"
$localHash = (Get-FileHash $localSnapshot -Algorithm SHA256).Hash.ToLower()
Write-Host "LOCAL_SNAPSHOT=$localSnapshot"
Write-Host "LOCAL_HASH=$localHash"

Write-Host "[2/8] Upload snapshot"
scp -o BatchMode=yes -o StrictHostKeyChecking=no -i $SshKeyPath "$localSnapshot" "${RemoteUserHost}:$remoteTmp"

Write-Host "[3/8] Verify uploaded hash"
$remoteTmpHash = ((ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "sha256sum $remoteTmp") -split '\s+')[0].ToLower()
Write-Host "REMOTE_TMP_HASH=$remoteTmpHash"
if ($remoteTmpHash -ne $localHash) {
    throw "Upload hash mismatch. local=$localHash remoteTmp=$remoteTmpHash"
}

Write-Host "[4/8] Stop running app container (if any)"
$runningContainer = (ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "docker ps --filter 'name=$ContainerNamePattern' --format '{{.Names}}' | head -1").Trim()
if ($runningContainer) {
    ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "sudo docker stop $runningContainer"
    Write-Host "STOPPED_CONTAINER=$runningContainer"
} else {
    Write-Host "STOPPED_CONTAINER=none"
}

Write-Host "[5/8] WAL-aware production backup"
ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "set -e; sudo mkdir -p $RemoteBackupDir; sudo sqlite3 $RemoteDbPath '.backup $prodBackup'"
Write-Host "PROD_BACKUP=$prodBackup"

Write-Host "[6/8] Replace production DB and remove sidecars"
ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "set -e; sudo cp $remoteTmp $RemoteDbPath; sudo rm -f ${RemoteDbPath}-wal ${RemoteDbPath}-shm; sudo chmod 664 $RemoteDbPath"

Write-Host "[7/8] Final hash parity check"
$prodHash = ((ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "sha256sum $RemoteDbPath") -split '\s+')[0].ToLower()
Write-Host "PROD_HASH=$prodHash"
if ($prodHash -ne $localHash) {
    throw "Final parity mismatch. local=$localHash prod=$prodHash"
}

Write-Host "[8/8] Cleanup temp snapshot"
ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "rm -f $remoteTmp"

if ($RestartContainer -and $runningContainer) {
    Write-Host "Restarting container: $runningContainer"
    ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "sudo docker start $runningContainer"

    $port = (ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "docker port $runningContainer 8080 | head -1 | sed 's/.*://'").Trim()
    if ($port) {
        $deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
        $healthy = $false
        while ((Get-Date) -lt $deadline) {
            $health = ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "curl -fsS http://localhost:$port/api/auth/config 2>/dev/null || true"
            if ($health -and $health.Trim().Length -gt 0) {
                Write-Host "HEALTH_ENDPOINT=http://localhost:$port/api/auth/config"
                Write-Host "HEALTH_RESPONSE=$health"
                $healthy = $true
                break
            }
            Start-Sleep -Seconds 3
        }
        if (-not $healthy) {
            throw "Container restarted but health check timed out on port $port"
        }
    } else {
        Write-Host "WARN: Could not resolve mapped host port for $runningContainer"
    }
}

$latestBackup = (ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "ls -1t $RemoteBackupDir/investments.pre-local-sync-*.db | head -1").Trim()
$runningNow = ssh -o BatchMode=yes -o ConnectTimeout=15 -i $SshKeyPath $RemoteUserHost "docker ps --filter 'name=$ContainerNamePattern' --format '{{.Names}} {{.Status}} {{.Ports}}'"

Write-Host "LATEST_PROD_BACKUP=$latestBackup"
Write-Host "RUNNING=$runningNow"
Write-Host "RESULT=SUCCESS"
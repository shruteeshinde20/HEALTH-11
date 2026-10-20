<#
.SYNOPSIS
    Replaces the HEALTH-11 production database with a backup made by backup.ps1.

.DESCRIPTION
    Works with the production setup (compose.production.yml and .env.production),
    never with the development database.

    Everything in the production database now is replaced by the backup. So
    the script:
      1. checks the file is a PostgreSQL backup and asks you to type RESTORE;
      2. makes a safety backup of the current data first (backups folder);
      3. stops the website and the API, empties the database, loads the backup
         (stopping at the first error);
      4. starts the API again (it brings an older backup up to date with the
         migrations) and the website.
    If loading fails, the message names the safety backup to restore instead.

.PARAMETER BackupFile
    The .dump file to restore, for example backups\health11-20261020-101500.dump

.EXAMPLE
    .\scripts\restore.ps1 -BackupFile backups\health11-20261020-101500.dump
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BackupFile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeFile = Join-Path $root 'compose.production.yml'
$envFile = Join-Path $root '.env.production'
$composeArgs = @('compose', '-f', $composeFile, '--env-file', $envFile)
$containerFile = '/tmp/health11-restore.dump'

function Invoke-Compose {
    param([Parameter(Mandatory)][string[]]$Arguments)
    & docker @composeArgs @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed (docker compose $($Arguments[0]) ..., exit code $LASTEXITCODE)."
    }
}

# 1. Check the file and ask.
$backup = (Resolve-Path -LiteralPath $BackupFile).Path
$head = New-Object byte[] 5
$stream = [System.IO.File]::OpenRead($backup)
try { [void]$stream.Read($head, 0, 5) } finally { $stream.Dispose() }
if ([System.Text.Encoding]::ASCII.GetString($head) -ne 'PGDMP') {
    throw "$backup is not a PostgreSQL backup made by backup.ps1."
}
if (-not (Test-Path $envFile)) {
    throw 'No .env.production in the project folder. See README section 9.'
}
$running = & docker @composeArgs ps --status running --services
if ($LASTEXITCODE -ne 0 -or -not ($running -contains 'postgres')) {
    throw 'The production database is not running. Start it with: docker compose -f compose.production.yml --env-file .env.production up -d'
}

Write-Host ''
Write-Host "Restore: $backup"
Write-Host 'ALL data in the production HEALTH-11 database will be replaced by this backup.'
Write-Host 'The website is offline for a moment. (The development database is not touched.)'
$answer = Read-Host 'Type RESTORE (capital letters) to continue'
if ($answer -cne 'RESTORE') {
    Write-Host 'Nothing was changed.'
    return
}

# 2. Safety backup of what is there now.
$safety = & (Join-Path $PSScriptRoot 'backup.ps1') -Label 'before-restore' | Select-Object -Last 1
Write-Host "Safety backup of the current data: $safety"

# 3. Load the backup with the website and API stopped (no open connections).
Write-Host 'Stopping the website and the API ...'
Invoke-Compose -Arguments @('stop', 'web', 'backend')
$restored = $false
try {
    # docker compose cp needs a path without a drive letter: copy from the file's folder.
    Push-Location (Split-Path -Parent $backup)
    try {
        Invoke-Compose -Arguments @('cp', (Split-Path -Leaf $backup), "postgres:$containerFile")
    } finally {
        Pop-Location
    }
    Write-Host 'Loading the backup ...'
    Invoke-Compose -Arguments @('exec', '-T', 'postgres', 'sh', '-c',
        ("dropdb -U `$POSTGRES_USER --force --if-exists `$POSTGRES_DB" +
         " && createdb -U `$POSTGRES_USER `$POSTGRES_DB" +
         " && pg_restore -U `$POSTGRES_USER -d `$POSTGRES_DB --no-owner --exit-on-error $containerFile"))
    $restored = $true
} finally {
    & docker @composeArgs exec -T postgres rm -f $containerFile | Out-Null
    # 4. Start the API (runs the migrations) and the website again, even after an error.
    Write-Host 'Starting the API and the website ...'
    & docker @composeArgs start backend web | Out-Host
    if (-not $restored) {
        Write-Host ''
        Write-Host 'The restore FAILED. To go back to the data from before, run:'
        Write-Host "  .\scripts\restore.ps1 -BackupFile `"$safety`""
    }
}

Write-Host ''
Write-Host "Restore complete from $backup"
Write-Host 'Check that the site is back: docker compose -f compose.production.yml --env-file .env.production ps'

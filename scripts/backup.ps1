<#
.SYNOPSIS
    Backs up the HEALTH-11 production database to the backups folder.

.DESCRIPTION
    Works with the production setup (compose.production.yml and .env.production),
    never with the development database. The database container must be running.
    The backup is a PostgreSQL "custom format" file (pg_dump); it is checked
    with pg_restore --list before this script reports success.

    Backups hold all hospital data: keep them private. The backups folder is
    ignored by git. Trained AI models are not included; they can be trained
    again from the website after a restore.

.PARAMETER Label
    Optional word added to the file name, for example before-update.

.EXAMPLE
    .\scripts\backup.ps1
.EXAMPLE
    .\scripts\backup.ps1 -Label before-update
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9-]{1,40}$')]
    [string]$Label = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$composeArgs = @('compose', '-f', 'compose.production.yml', '--env-file', '.env.production')
$containerFile = '/tmp/health11-backup.dump'

function Invoke-Compose {
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$Quiet)
    if ($Quiet) {
        & docker @composeArgs @Arguments | Out-Null
    } else {
        & docker @composeArgs @Arguments | Out-Host
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed (docker compose $($Arguments[0]) ..., exit code $LASTEXITCODE)."
    }
}

Push-Location $root
try {
    if (-not (Test-Path '.env.production')) {
        throw 'No .env.production in the project folder. See README section 9.'
    }
    $running = & docker @composeArgs ps --status running --services
    if ($LASTEXITCODE -ne 0 -or -not ($running -contains 'postgres')) {
        throw 'The production database is not running. Start it with: docker compose -f compose.production.yml --env-file .env.production up -d'
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $name = if ($Label) { "health11-$stamp-$Label.dump" } else { "health11-$stamp.dump" }
    New-Item -ItemType Directory -Force -Path 'backups' | Out-Null
    $relative = "backups/$name"

    Write-Host "Backing up the production database to $relative ..."
    # $POSTGRES_USER and $POSTGRES_DB are read inside the container (the
    # backticks stop PowerShell from filling them in); no password is needed or shown.
    Invoke-Compose -Arguments @('exec', '-T', 'postgres', 'sh', '-c',
        "pg_dump -U `$POSTGRES_USER -d `$POSTGRES_DB --format=custom --no-owner --file=$containerFile")
    try {
        # Proves the file is a complete, readable backup.
        Invoke-Compose -Quiet -Arguments @('exec', '-T', 'postgres', 'pg_restore', '--list', $containerFile)
        Invoke-Compose -Quiet -Arguments @('cp', "postgres:$containerFile", $relative)
    } finally {
        & docker @composeArgs exec -T postgres rm -f $containerFile | Out-Null
    }

    $file = Get-Item $relative
    $head = New-Object byte[] 5
    $stream = [System.IO.File]::OpenRead($file.FullName)
    try { [void]$stream.Read($head, 0, 5) } finally { $stream.Dispose() }
    if ([System.Text.Encoding]::ASCII.GetString($head) -ne 'PGDMP') {
        throw "$relative is not a PostgreSQL backup file."
    }

    $sizeKb = [math]::Ceiling($file.Length / 1KB)
    Write-Host "Backup complete and checked: $($file.FullName) ($sizeKb KB)"
    # The path, for scripts that call this one.
    Write-Output $file.FullName
} finally {
    Pop-Location
}

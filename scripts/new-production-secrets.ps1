<#
.SYNOPSIS
    Fills POSTGRES_PASSWORD and JWT_SECRET_KEY in .env.production with new
    random values, without ever showing them.

.DESCRIPTION
    Creates .env.production from .env.production.example if it does not exist.
    Only EMPTY values are filled: once the production database has been
    created with a password, changing it here would lock the API out of it, so
    a value that is already set is never replaced.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$envFile = Join-Path $root '.env.production'
$example = Join-Path $root '.env.production.example'

function New-Secret {
    param([int]$Bytes)
    $buffer = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    # URL-safe letters only, so the value needs no quotes in the file.
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

if (-not (Test-Path $envFile)) {
    Copy-Item $example $envFile
    Write-Host 'Created .env.production from .env.production.example.'
}

$sizes = @{ 'POSTGRES_PASSWORD' = 32; 'JWT_SECRET_KEY' = 48 }
$lines = [System.IO.File]::ReadAllLines($envFile)
foreach ($name in @('POSTGRES_PASSWORD', 'JWT_SECRET_KEY')) {
    $index = -1
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match "^\s*$name\s*=") { $index = $i }
    }
    if ($index -lt 0) {
        $lines += "$name=$(New-Secret $sizes[$name])"
        Write-Host "$name added (new random value, not shown)."
    } elseif ($lines[$index] -match "^\s*$name\s*=\s*$") {
        $lines[$index] = "$name=$(New-Secret $sizes[$name])"
        Write-Host "$name filled in (new random value, not shown)."
    } else {
        Write-Host "$name already has a value: kept."
    }
}
# UTF-8 without a byte order mark, which Docker reads cleanly.
[System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'Saved .env.production. Add your AI key (GROQ_API_KEY) with: notepad .env.production'

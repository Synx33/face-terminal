# face-terminal Windows updater.
#
# Pulls the latest code from GitHub and replaces the installed copy, without
# touching .env (device IP/credentials, pinned via the dashboard's Settings
# panel) or the data directory (attendance DB, snapshots, backups, logs —
# which in any case lives entirely outside the install path, under
# C:\ProgramData\face-terminal, so this script never goes near it at all).
#
# Run any time from an elevated-or-not PowerShell (it self-elevates):
#   .\windows\update.ps1
#
# This is deliberately NOT a "git pull in place" — the installed copy at
# C:\Program Files\face-terminal isn't necessarily a git clone itself (older
# installs aren't), so this always fetches a completely fresh, disposable
# clone into a temp folder and copies just the code over, the same way
# install.ps1's first install does. Safe to run repeatedly.

[CmdletBinding()]
param(
    [string] $InstallPath = "$env:ProgramFiles\face-terminal",
    [string] $ServiceName = "face-terminal",
    [string] $RepoUrl     = "https://github.com/Synx33/face-terminal.git"
)

$ErrorActionPreference = "Stop"

function Test-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$current
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Same self-elevation as install.ps1/uninstall.ps1 — see install.ps1's
# comment for why the relaunch arguments need manual quoting like this.
function Assert-Admin-OrElevate {
    param([hashtable] $BoundParams)
    if (Test-Admin) { return }

    Write-Host "==> not running elevated — relaunching as Administrator (a Windows UAC prompt will appear)"
    $argList = @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    foreach ($key in $BoundParams.Keys) {
        $value = $BoundParams[$key]
        if ($value -is [string] -and $value.Contains('"')) {
            throw "The value for -$key contains a double-quote character, which this script can't safely pass through to an elevated relaunch. Run it from an already-elevated PowerShell instead."
        }
        $argList += "-$key"
        $argList += "`"$value`""
    }

    try {
        Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs | Out-Null
    } catch {
        throw "Elevation was cancelled or failed ($($_.Exception.Message)). This script needs Administrator rights to stop/start the service and write to Program Files — run it again and accept the UAC prompt, or open PowerShell as Administrator yourself first."
    }
    Write-Host "==> continuing in the elevated window that just opened — this one can be closed"
    exit 0
}

function Assert-Installed {
    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) {
        throw "No '$ServiceName' service found — face-terminal isn't installed yet. Run install.ps1 first, not this script."
    }
    if (-not (Test-Path $InstallPath)) {
        throw "Service '$ServiceName' exists but $InstallPath doesn't — installation looks broken. Run install.ps1 again to fix it."
    }
}

function Get-ConfiguredPort {
    $envPath = Join-Path $InstallPath ".env"
    if (Test-Path $envPath) {
        $line = Select-String -Path $envPath -Pattern '^PORT=(\d+)' -ErrorAction SilentlyContinue
        if ($line) { return [int]$line.Matches[0].Groups[1].Value }
    }
    return 3070
}

function Fetch-FreshClone {
    $tmp = Join-Path $env:TEMP "face-terminal-update-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    Write-Host "==> fetching latest code from $RepoUrl"
    & git clone --depth 1 --quiet $RepoUrl $tmp
    if ($LASTEXITCODE -ne 0) {
        throw "git clone failed — check this laptop has internet access to GitHub. (Is git installed? winget install -e --id Git.Git)"
    }
    return $tmp
}

# Overwrites everything in $InstallPath with $tmp's contents EXCEPT .env and
# data — same exclusion list as install.ps1's Copy-Source, so a fresh clone
# (which never has .env or data in the first place) can only ever add/update
# code, never remove or touch the two things that must survive an update.
function Overlay-Code {
    param([string] $Source, [string] $Dest)
    $exclude = @(".git", "data", ".env")
    Get-ChildItem -Path $Source -Force | Where-Object { $_.Name -notin $exclude } | ForEach-Object {
        $target = Join-Path $Dest $_.Name
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        if ($_.PSIsContainer) {
            Copy-Item $_.FullName $target -Recurse -Force
        } else {
            Copy-Item $_.FullName $target -Force
        }
    }
}

# ---- main -----------------------------------------------------------------
Assert-Admin-OrElevate -BoundParams $PSBoundParameters
Assert-Installed
$port = Get-ConfiguredPort
$tmp = Fetch-FreshClone

try {
    Write-Host "==> stopping $ServiceName"
    Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1

    Write-Host "==> updating code in $InstallPath (leaving .env and data untouched)"
    Overlay-Code -Source $tmp -Dest $InstallPath

    Write-Host "==> starting $ServiceName"
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name $ServiceName
    Write-Host "==> service status: $($svc.Status)"
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/stats" -UseBasicParsing -TimeoutSec 8
        Write-Host "==> /api/stats returned $($resp.StatusCode) $($resp.Content)"
    } catch {
        Write-Warning "dashboard did not respond yet (device discovery can take a few seconds) — check the log via the dashboard's Settings panel, or C:\ProgramData\face-terminal\logs\face-terminal.log"
    }
    Write-Host ""
    Write-Host "update complete. Attendance history, backups, and your device IP/credentials were not touched."
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

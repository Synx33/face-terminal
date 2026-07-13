# Reverse of install.ps1.
# Pass -Purge to also delete the data directory (attendance DB + snapshots).
#
#   Set-ExecutionPolicy -Scope Process Bypass; .\windows\uninstall.ps1
#   .\windows\uninstall.ps1 -Purge

[CmdletBinding()]
param(
    [string] $InstallPath = "$env:ProgramFiles\face-terminal",
    [string] $DataPath    = "$env:ProgramData\face-terminal",
    [string] $ServiceName = "face-terminal",
    [int]    $Port        = 3070,
    [switch] $Purge
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$current
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run from an elevated PowerShell."
    }
}

Assert-Admin

$nssmExe = Join-Path $InstallPath "nssm.exe"
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "==> stopping + removing service $ServiceName"
    if (Test-Path $nssmExe) {
        & $nssmExe stop $ServiceName confirm | Out-Null
        & $nssmExe remove $ServiceName confirm | Out-Null
    } else {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName | Out-Null
    }
}

$ruleName = "face-terminal TCP $Port"
Write-Host "==> removing firewall rule '$ruleName'"
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

if (Test-Path $InstallPath) {
    Write-Host "==> removing install dir $InstallPath"
    Remove-Item -Recurse -Force $InstallPath
}

if ($Purge) {
    if (Test-Path $DataPath) {
        Write-Host "==> --Purge: removing data dir $DataPath"
        Remove-Item -Recurse -Force $DataPath
    }
} else {
    Write-Host "==> kept data at $DataPath (pass -Purge to remove attendance history + snapshots)"
}

Write-Host "uninstalled."

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

function Test-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$current
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Same self-elevation as install.ps1 -- see the comment there for why the
# arguments have to be manually quoted like this (-Verb RunAs uses
# ShellExecute, which takes one flat command line, not an argv array).
function Assert-Admin-OrElevate {
    param([hashtable] $BoundParams)
    if (Test-Admin) { return }

    Write-Host "==> not running elevated -- relaunching as Administrator (a Windows UAC prompt will appear)"
    $argList = @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    foreach ($key in $BoundParams.Keys) {
        $value = $BoundParams[$key]
        # $PSBoundParameters only contains keys actually passed on the
        # command line -- a [switch] like -Purge shows up here as a
        # SwitchParameter($true) only when it was given, never as $false,
        # so re-adding just the flag name (no value token) reproduces it
        # correctly; anything else is a normal "-Name value" pair.
        if ($value -is [System.Management.Automation.SwitchParameter]) {
            $argList += "-$key"
            continue
        }
        if ($value -is [string] -and $value.Contains('"')) {
            throw "The value for -$key contains a double-quote character, which this script can't safely pass through to an elevated relaunch. Run it from an already-elevated PowerShell instead."
        }
        $argList += "-$key"
        $argList += "`"$value`""
    }

    try {
        Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs | Out-Null
    } catch {
        throw "Elevation was cancelled or failed ($($_.Exception.Message)). Run this script from an already-elevated PowerShell instead."
    }
    Write-Host "==> continuing in the elevated window that just opened -- this one can be closed"
    exit 0
}

Assert-Admin-OrElevate -BoundParams $PSBoundParameters

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

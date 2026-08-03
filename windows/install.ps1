# face-terminal Windows installer.
#
# Installs face-terminal as a Windows service using NSSM, opens the
# firewall for the dashboard port, and starts the service.
#
# Run from an elevated PowerShell:
#   Set-ExecutionPolicy -Scope Process Bypass; .\windows\install.ps1
#
# Defaults:
#   install path:  C:\Program Files\face-terminal
#   data path:     C:\ProgramData\face-terminal
#   service name:  face-terminal
#   port:          3070
#   device IP:     blank (auto-discovered by MAC on whatever network this
#                  laptop is on — pass -DeviceIp only if you want to skip
#                  discovery and pin it directly)
#
# Override any of the above with parameters:
#   .\windows\install.ps1 -Port 8080 -DeviceIp 10.0.0.50

[CmdletBinding()]
param(
    [string] $InstallPath = "$env:ProgramFiles\face-terminal",
    [string] $DataPath    = "$env:ProgramData\face-terminal",
    [string] $ServiceName = "face-terminal",
    [string] $ListenHost  = "0.0.0.0",
    [int]    $Port        = 3070,
    [string] $DeviceIp    = "",
    [string] $DeviceMac   = "BC:9B:5E:1A:1D:87",
    [string] $DeviceUser  = "admin",
    # No default on purpose — this is a real credential for a physical
    # access-control device, never hardcode it in a script that lives in
    # git history. Pass it explicitly: .\install.ps1 -DevicePass "..."
    [Parameter(Mandatory = $true)]
    [string] $DevicePass,
    [int]    $PollIntervalMs = 1500,
    [int]    $CheckinDebounceSeconds = 60
)

$ErrorActionPreference = "Stop"

function Test-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$current
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Registering a Windows service, opening a firewall port, and writing to
# C:\Program Files all require admin rights. Rather than just erroring out
# and telling whoever's running this to go reopen PowerShell as admin
# themselves, re-launch this exact script (same parameters) in a new,
# elevated PowerShell — Windows pops the standard UAC "Do you want to allow
# this app to make changes" prompt, they click Yes, and installation
# continues there. This process then exits since the elevated copy is doing
# the real work.
# $BoundParams must be passed in explicitly as the script's own
# $PSBoundParameters — a function has its own (separate, and here empty)
# $PSBoundParameters scope, it does not inherit the caller's automatically.
function Assert-Admin-OrElevate {
    param([hashtable] $BoundParams)
    if (Test-Admin) { return }

    Write-Host "==> not running elevated — relaunching as Administrator (a Windows UAC prompt will appear)"
    $scriptPath = $PSCommandPath

    $argList = @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", "`"$scriptPath`"")
    foreach ($key in $BoundParams.Keys) {
        $value = $BoundParams[$key]
        # -Verb RunAs launches via ShellExecute, which takes one flat command
        # line (not an argv array) — Start-Process just space-joins whatever
        # we hand it, so each value needs its own quotes here, and a literal
        # " inside a value (e.g. a device password) would break that quoting
        # silently. Fail loudly instead of mis-parsing the relaunch.
        if ($value -is [string] -and $value.Contains('"')) {
            throw "The value for -$key contains a double-quote character, which this installer can't safely pass through to an elevated relaunch. Remove it, or run this script from an already-elevated PowerShell instead."
        }
        $argList += "-$key"
        $argList += "`"$value`""
    }

    try {
        Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs | Out-Null
    } catch {
        throw "Elevation was cancelled or failed ($($_.Exception.Message)). This installer needs Administrator rights to register a Windows service and open a firewall port — run it again and accept the UAC prompt, or open PowerShell as Administrator yourself first."
    }
    Write-Host "==> continuing in the elevated window that just opened — this one can be closed"
    exit 0
}

# Runs a node:sqlite smoke test and reports success/failure purely via exit
# code — never trust a version-number cutoff for this. The exact Node
# version where node:sqlite went from "needs --experimental-sqlite" to
# unflagged isn't something to guess from memory, and passing an
# unrecognized flag to node is a hard startup error, so this has to be
# tested directly rather than assumed from `node --version`.
function Test-NodeSqlite {
    param([string] $NodePath, [string[]] $ExtraArgs)
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $NodePath @ExtraArgs -e "new (require('node:sqlite').DatabaseSync)(':memory:')" 2>$null 1>$null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $prevPref
    }
}

function Assert-Node {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        throw "Node.js not found. Install it first:`n  winget install -e --id OpenJS.NodeJS.LTS`nThen close this PowerShell window, open a new one (so it picks up the updated PATH), and re-run this installer."
    }
    $nodePath = $nodeCmd.Source
    $version = (& $nodePath --version).TrimStart('v')
    Write-Host "==> using Node.js $version at $nodePath"

    if (Test-NodeSqlite -NodePath $nodePath -ExtraArgs @()) {
        Write-Host "==> node:sqlite works, no extra flag needed"
        return [PSCustomObject]@{ Path = $nodePath; NeedsSqliteFlag = $false }
    }
    if (Test-NodeSqlite -NodePath $nodePath -ExtraArgs @("--experimental-sqlite")) {
        Write-Host "==> node:sqlite needs --experimental-sqlite on this Node version — will add it to the service"
        return [PSCustomObject]@{ Path = $nodePath; NeedsSqliteFlag = $true }
    }
    throw "Node.js $version doesn't support node:sqlite (tried with and without --experimental-sqlite). This app needs it. Install the latest Node.js LTS:`n  winget install -e --id OpenJS.NodeJS.LTS`nThen close this PowerShell window, open a new one, and re-run this installer."
}

function Ensure-NSSM {
    param([string] $Dest)
    $nssmExe = Join-Path $Dest "nssm.exe"
    if (Test-Path $nssmExe) {
        Write-Host "==> nssm already present at $nssmExe"
        return $nssmExe
    }
    Write-Host "==> downloading NSSM (Non-Sucking Service Manager) — needs internet access"
    try {
        $tmp = New-TemporaryFile
        $zip = "$($tmp.FullName).zip"
        Remove-Item $tmp.FullName -Force
        Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $zip -UseBasicParsing
        $extract = Join-Path $env:TEMP "nssm-install"
        if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $extract -Force
        $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
        $src = Join-Path $extract "nssm-2.24\$arch\nssm.exe"
        Copy-Item $src $nssmExe -Force
        Remove-Item $zip, $extract -Recurse -Force
    } catch {
        throw "Couldn't download NSSM from nssm.cc (needed to register the Windows service): $($_.Exception.Message)`nCheck this laptop has internet access, or manually download https://nssm.cc/release/nssm-2.24.zip and place nssm.exe at:`n  $nssmExe`nthen re-run this installer."
    }
    Write-Host "==> nssm installed at $nssmExe"
    return $nssmExe
}

function Copy-Source {
    param([string] $Dest)
    Write-Host "==> copying source to $Dest"
    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest | Out-Null }
    $repoRoot = Split-Path -Parent $PSScriptRoot
    # node_modules is intentionally NOT excluded — it's committed in the repo
    # (every dependency is pure JS, no native binaries, verified safe across
    # platforms) specifically so this install needs zero internet access
    # beyond the original git clone.
    $exclude = @(".git", "data", ".env")
    Get-ChildItem -Path $repoRoot -Force | Where-Object {
        $_.Name -notin $exclude
    } | ForEach-Object {
        $target = Join-Path $Dest $_.Name
        if ($_.PSIsContainer) {
            Copy-Item $_.FullName $target -Recurse -Force
        } else {
            Copy-Item $_.FullName $target -Force
        }
    }
}

function Install-Dependencies {
    param([string] $InstallPath)
    # node_modules ships committed in the repo (see Copy-Source) — if it's
    # already there and populated, this laptop needs zero internet access
    # for this step. Only fall back to `npm install` (which does need
    # internet) if it's somehow missing, e.g. a clone that dropped it.
    $nodeModules = Join-Path $InstallPath "node_modules"
    if ((Test-Path $nodeModules) -and (Get-ChildItem $nodeModules -ErrorAction SilentlyContinue | Select-Object -First 1)) {
        Write-Host "==> node_modules already present (bundled in the repo) — skipping npm install, no internet needed for this step"
        return
    }
    Write-Host "==> node_modules missing — falling back to npm install (needs internet access)"
    Push-Location $InstallPath
    try {
        & npm install --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE — check this laptop has internet access to the npm registry, or copy node_modules over manually from a machine that has it." }
    } finally {
        Pop-Location
    }
}

function Write-EnvFile {
    param([string] $InstallPath, [string] $DataPath)
    $envPath = Join-Path $InstallPath ".env"
    Write-Host "==> writing $envPath"
    @"
DEVICE_IP=$DeviceIp
DEVICE_MAC=$DeviceMac
DEVICE_PROTOCOL=http
DEVICE_USER=$DeviceUser
DEVICE_PASS=$DevicePass

PORT=$Port
FACE_TERMINAL_DATA=$DataPath\data
POLL_INTERVAL_MS=$PollIntervalMs
CHECKIN_DEBOUNCE_SECONDS=$CheckinDebounceSeconds

RECEIVER_IP=$ListenHost
"@ | Set-Content -Path $envPath -Encoding UTF8
}

function Setup-DataDir {
    param([string] $DataPath)
    Write-Host "==> preparing data dir $DataPath"
    New-Item -ItemType Directory -Force -Path "$DataPath\data"           | Out-Null
    New-Item -ItemType Directory -Force -Path "$DataPath\data\snapshots" | Out-Null
    New-Item -ItemType Directory -Force -Path "$DataPath\logs"          | Out-Null
}

function Register-Service {
    param(
        [string] $NssmExe,
        [string] $ServiceName,
        [string] $NodeExe,
        [bool]   $NeedsSqliteFlag,
        [string] $InstallPath,
        [string] $DataPath
    )
    $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "==> service $ServiceName exists, removing"
        & $NssmExe stop $ServiceName confirm | Out-Null
        & $NssmExe remove $ServiceName confirm | Out-Null
        Start-Sleep -Seconds 1
    }

    Write-Host "==> registering $ServiceName Windows service via nssm"
    if ($NeedsSqliteFlag) {
        & $NssmExe install $ServiceName $NodeExe "--experimental-sqlite" "--env-file=.env" "src\server.js" | Out-Null
    } else {
        & $NssmExe install $ServiceName $NodeExe "--env-file=.env" "src\server.js" | Out-Null
    }
    & $NssmExe set $ServiceName AppDirectory $InstallPath | Out-Null
    & $NssmExe set $ServiceName Description "face-terminal attendance dashboard (Hikvision DS-K1T343EWX)" | Out-Null
    & $NssmExe set $ServiceName Start SERVICE_AUTO_START | Out-Null
    & $NssmExe set $ServiceName AppStdout "$DataPath\logs\face-terminal.log" | Out-Null
    & $NssmExe set $ServiceName AppStderr "$DataPath\logs\face-terminal.log" | Out-Null
    & $NssmExe set $ServiceName AppRotateFiles 1 | Out-Null
    & $NssmExe set $ServiceName AppRotateBytes 10485760 | Out-Null
    & $NssmExe set $ServiceName AppExit Default Restart | Out-Null
    & $NssmExe set $ServiceName AppRestartDelay 3000 | Out-Null
}

function Open-Firewall {
    param([int] $Port)
    $ruleName = "face-terminal TCP $Port"
    Write-Host "==> adding firewall rule '$ruleName'"
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    # Scoped to Domain/Private only, not Public — deliberately: the dashboard
    # has no login/auth on any endpoint (see README), so widening this to
    # Public networks would mean anyone on an untrusted network (e.g. if
    # Windows ever miscategorizes this LAN) could reach it. That's a
    # judgment call for a human, not something to silently decide here —
    # see the Public-network warning this prints right after.
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -LocalPort $Port `
        -Protocol TCP -Action Allow -Profile Domain,Private | Out-Null
}

function Test-NetworkProfile {
    param([int] $Port)
    # Windows often defaults a brand-new network connection to "Public"
    # until a human explicitly marks it Private — very likely to happen at
    # a new install site connecting for the first time. The firewall rule
    # above only applies to Domain/Private, so on a Public-categorized
    # network the service runs fine locally but nobody else on the LAN can
    # reach the dashboard, with no obvious error message explaining why.
    $publicProfiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' }
    if (-not $publicProfiles) { return }
    Write-Host ""
    Write-Warning "This network ('$($publicProfiles[0].Name)') is set to Windows' 'Public' profile."
    Write-Warning "The firewall rule just added only opens the port on Domain/Private networks — other devices on this LAN won't be able to reach the dashboard until this is a Private network."
    Write-Warning "If this is genuinely the site's own trusted LAN (usually the case), mark it Private:"
    Write-Warning "  Set-NetConnectionProfile -InterfaceAlias `"$($publicProfiles[0].InterfaceAlias)`" -NetworkCategory Private"
    Write-Warning "The dashboard itself works fine locally on this laptop either way — this only affects reaching it from other machines."
    Write-Host ""
}

function Start-And-Verify {
    param([string] $ServiceName, [int] $Port)
    Write-Host "==> starting $ServiceName"
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name $ServiceName
    Write-Host "==> service status: $($svc.Status)"
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/stats" -UseBasicParsing -TimeoutSec 8
        Write-Host "==> /api/stats returned $($resp.StatusCode) $($resp.Content)"
    } catch {
        Write-Warning "dashboard did not respond yet (device discovery can take a few seconds) — check the log at $DataPath\logs\face-terminal.log"
    }
}

function Print-Summary {
    param([string] $InstallPath, [string] $DataPath, [string] $ServiceName, [int] $Port)
    $lanIp = (Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp -ErrorAction SilentlyContinue |
              Where-Object { $_.IPAddress -notlike "169.*" } | Select-Object -First 1).IPAddress
    if (-not $lanIp) { $lanIp = (hostname) }
    Write-Host ""
    Write-Host "face-terminal installed."
    Write-Host ""
    Write-Host "  install path:  $InstallPath"
    Write-Host "  data path:     $DataPath"
    Write-Host "  service:       Get-Service $ServiceName"
    Write-Host "  dashboard:     http://${lanIp}:$Port/"
    Write-Host "  log:           $DataPath\logs\face-terminal.log"
    Write-Host ""
    if ([string]::IsNullOrWhiteSpace($DeviceIp)) {
        Write-Host "Device IP wasn't pinned — it's auto-discovering the terminal on this"
        Write-Host "network by MAC address ($DeviceMac). If it's on a different subnet than"
        Write-Host "this laptop, open the dashboard's Settings panel and type its IP in directly."
    } else {
        Write-Host "Device IP pinned to $DeviceIp — change it any time in the dashboard's Settings panel."
    }
    Write-Host ""
    Write-Host "Service commands:"
    Write-Host "  Start-Service $ServiceName"
    Write-Host "  Stop-Service  $ServiceName"
    Write-Host "  Get-Service   $ServiceName"
}

# ---- main -----------------------------------------------------------------
Assert-Admin-OrElevate -BoundParams $PSBoundParameters
$node = Assert-Node
Copy-Source -Dest $InstallPath
Install-Dependencies -InstallPath $InstallPath
Setup-DataDir -DataPath $DataPath
Write-EnvFile -InstallPath $InstallPath -DataPath $DataPath
$nssmExe = Ensure-NSSM -Dest $InstallPath
Register-Service -NssmExe $nssmExe -ServiceName $ServiceName -NodeExe $node.Path -NeedsSqliteFlag $node.NeedsSqliteFlag `
                 -InstallPath $InstallPath -DataPath $DataPath
Open-Firewall -Port $Port
Test-NetworkProfile -Port $Port
Start-And-Verify -ServiceName $ServiceName -Port $Port
Print-Summary -InstallPath $InstallPath -DataPath $DataPath -ServiceName $ServiceName -Port $Port

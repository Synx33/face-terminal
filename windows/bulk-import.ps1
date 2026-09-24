# face-terminal bulk card import.
#
# Imports a local JSON file of {name, cardNo} entries straight into the
# running dashboard's card-only worker list -- the scripted equivalent of
# pasting a list into Workers -> "მასობრივი დამატება" by hand, useful when
# the list is too long to comfortably paste (hundreds of rows) or when it
# needs to be repeatable/scripted rather than a one-off manual paste.
#
# Deliberately reads its data from a LOCAL file path, never from this repo
# or anything committed to git -- a real site's employee roster is that
# site's own data, not something that belongs in a public GitHub repo
# alongside the application code. See README's "Bulk import" section.
#
# Usage (from an elevated-or-not PowerShell, run from the install folder):
#   .\windows\bulk-import.ps1 -DataFile "C:\path\to\entries.json" -AdminUser "admin" -AdminPass "..."
#
# entries.json shape: a plain JSON array, e.g.
#   [{"name": "გიორგი მაისურაძე", "cardNo": "4015874134"}, ...]

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $DataFile,
    [string] $DashboardUrl = "http://localhost:3070",
    [Parameter(Mandatory = $true)]
    [string] $AdminUser,
    [Parameter(Mandatory = $true)]
    [string] $AdminPass
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $DataFile)) {
    throw "Data file not found: $DataFile"
}

Write-Host "==> reading $DataFile"
$entries = Get-Content $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json
Write-Host "==> $($entries.Count) entries to import"

Write-Host "==> logging in to $DashboardUrl as $AdminUser"
$session = $null
try {
    Invoke-RestMethod -Uri "$DashboardUrl/api/auth/login" -Method Post `
        -ContentType "application/json" `
        -Body (@{ username = $AdminUser; password = $AdminPass } | ConvertTo-Json) `
        -SessionVariable session | Out-Null
} catch {
    throw "Login failed -- check the dashboard is running at $DashboardUrl and the admin username/password are correct. ($($_.Exception.Message))"
}

Write-Host "==> importing $($entries.Count) entries (this can take a few seconds for a large list)"
$body = @{ entries = $entries } | ConvertTo-Json -Depth 4
$result = Invoke-RestMethod -Uri "$DashboardUrl/api/employees/bulk-cards" -Method Post `
    -ContentType "application/json; charset=utf-8" `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
    -WebSession $session

Write-Host ""
Write-Host "Created: $($result.created.Count)"
Write-Host "Failed:  $($result.failed.Count)"
if ($result.failed.Count -gt 0) {
    Write-Host ""
    Write-Host "Failed rows:"
    foreach ($f in $result.failed) {
        Write-Host "  $($f.name) / $($f.cardNo) -- $($f.error)"
    }
}

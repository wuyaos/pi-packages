# pi-bootstrap.ps1
# Restore the latest trusted Pi agent archive from WebDAV on a new Windows machine.
#
# Security: this bootstrap helper does not run pi-sync's TypeScript archive path/link
# validation. Use it only with a trusted WebDAV endpoint and archives you trust.
#
# Recommended usage:
#   $env:PI_WEBDAV_URL  = "https://your-webdav.example/dav/pi"
#   $env:PI_WEBDAV_USER = "your-user"
#   $env:PI_WEBDAV_PASS = "your-app-password"
#   .\pi-bootstrap.ps1

param(
    [string]$WebdavUrl = $env:PI_WEBDAV_URL,
    [string]$User = $env:PI_WEBDAV_USER,
    [string]$Pass = $env:PI_WEBDAV_PASS,
    [string]$RemoteBaseDir = $(if ($env:PI_SYNC_REMOTE_BASE_DIR) { $env:PI_SYNC_REMOTE_BASE_DIR } else { "pibak" })
)

$ErrorActionPreference = "Stop"

if (-not $WebdavUrl -or -not $User -or -not $Pass) {
    Write-Host "Usage: .\pi-bootstrap.ps1 -WebdavUrl <url> -User <user> -Pass <pass>" -ForegroundColor Red
    Write-Host "Or set PI_WEBDAV_URL, PI_WEBDAV_USER, PI_WEBDAV_PASS." -ForegroundColor Yellow
    exit 1
}

$WebdavUrl = $WebdavUrl.TrimEnd('/')
$RemoteBaseDir = $RemoteBaseDir.Trim('/').Trim('\\')
if (-not $RemoteBaseDir) { $RemoteBaseDir = "pibak" }
$backupUrl = "$WebdavUrl/$RemoteBaseDir/pi"
$pair = "${User}:${Pass}"
$auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{ Authorization = "Basic $auth"; Depth = "1" }

Write-Host "[1/5] Listing Pi archives on WebDAV..." -ForegroundColor Cyan
$resp = Invoke-RestMethod -Uri "$backupUrl/" -Method PROPFIND -Headers $headers -ContentType "application/xml"
$hrefPattern = [regex]'(?i)<(?:[A-Za-z0-9_-]+:)?href>([^<]+)</(?:[A-Za-z0-9_-]+:)?href>'
$files = $hrefPattern.Matches([string]$resp) |
    ForEach-Object { [Uri]::UnescapeDataString($_.Groups[1].Value) } |
    Where-Object { $_ -match '-pi_\d{8}-\d{6}\.tar\.xz$' -or $_ -match 'pi_agent_.*\.tar\.xz$' } |
    Sort-Object -Descending

if ($files.Count -eq 0) {
    Write-Host "No Pi archives found under $RemoteBaseDir/pi/." -ForegroundColor Red
    exit 1
}

$name = [System.IO.Path]::GetFileName($files[0])
Write-Host "[2/5] Latest archive: $name" -ForegroundColor Green

$tempArchive = Join-Path $env:TEMP $name
$tempDir = Join-Path $env:TEMP "pi_restore_$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
    Write-Host "[3/5] Downloading..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "$backupUrl/$name" -Headers @{ Authorization = "Basic $auth" } -OutFile $tempArchive

    Write-Host "[4/5] Extracting..." -ForegroundColor Cyan
    tar -xf $tempArchive -C $tempDir
    if ($LASTEXITCODE -ne 0) { throw "tar extraction failed with exit code $LASTEXITCODE" }

    $agentDir = Join-Path $env:USERPROFILE ".pi\agent"
    New-Item -ItemType Directory -Force -Path $agentDir | Out-Null
    Get-ChildItem -LiteralPath $tempDir -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $agentDir -Recurse -Force
    }

    Write-Host "[5/5] Pi agent archive restored to $agentDir" -ForegroundColor Green
    Write-Host "Next: install/update packages from settings.json, then restart Pi." -ForegroundColor Cyan
} finally {
    Remove-Item $tempArchive -Force -ErrorAction SilentlyContinue
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

<#
.SYNOPSIS
    Install or update Equicord with the LanLink plugin built in.

.DESCRIPTION
    Replaces the Equicord file that the normal Equicord installer put on this PC
    (%APPDATA%\Equicord\equicord.asar) with the newest build from
    https://github.com/6uhrmittag/discord-voice-link/releases. That build is
    Equicord plus LanLink, made by GitHub Actions. Your Equicord settings,
    plugins and themes are not touched.

    Equicord must already be installed with its own installer.
    Discord is closed for the swap and started again afterwards.
    The first run keeps the original file as equicord.asar.official.bak;
    -Restore puts it back.
    Works in Windows PowerShell 5.1 and PowerShell 7.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -Restore
#>
[CmdletBinding()]
param(
    # Folder that holds equicord.asar.
    [string]$EquicordDir = (Join-Path $env:APPDATA 'Equicord'),
    [string]$Repo = '6uhrmittag/discord-voice-link',
    # Put the original Equicord file back.
    [switch]$Restore,
    # Don't ask before closing Discord.
    [switch]$Yes,
    # Don't close or start Discord (for tests, or if you closed it yourself).
    [switch]$NoDiscord
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$asar = Join-Path $EquicordDir 'equicord.asar'
$backup = Join-Path $EquicordDir 'equicord.asar.official.bak'

function Stop-Discord {
    if ($NoDiscord) { return $false }
    $running = @(Get-Process -Name 'Discord' -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return $false }
    if (-not $Yes) {
        $answer = Read-Host 'Discord is running and has to be closed for a moment (this ends a running call). Continue? [Y/n]'
        if ($answer -and $answer -notmatch '^[yYjJ]') { Write-Host 'Nothing changed.'; exit 0 }
    }
    Write-Host 'Closing Discord...'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
    return $true
}

function Start-Discord {
    if ($NoDiscord) { return }
    $update = Join-Path $env:LOCALAPPDATA 'Discord\Update.exe'
    if (Test-Path $update) {
        Write-Host 'Starting Discord...'
        Start-Process -FilePath $update -ArgumentList '--processStart', 'Discord.exe'
    } else {
        Write-Host 'Start Discord again by hand.'
    }
}

if (-not (Test-Path $asar)) {
    Write-Host "Equicord was not found in $EquicordDir."
    Write-Host 'Install Equicord first (https://equicord.org/download), start Discord once, then run this again.'
    exit 1
}

if ($Restore) {
    if (-not (Test-Path $backup)) { Write-Host 'No backup of the original Equicord file found. Run the Equicord installer to repair.'; exit 1 }
    $wasRunning = Stop-Discord
    Copy-Item -Path $backup -Destination $asar -Force
    Write-Host 'The original Equicord is back. LanLink is gone.'
    if ($wasRunning) { Start-Discord }
    exit 0
}

Write-Host "Looking for the newest LanLink build of $Repo..."
$headers = @{ 'User-Agent' = 'lanlink-install'; 'Accept' = 'application/vnd.github+json' }
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers
$asset = $release.assets | Where-Object { $_.name -eq 'desktop.asar' } | Select-Object -First 1
if (-not $asset) { throw "The release '$($release.name)' has no desktop.asar." }

$download = Join-Path $EquicordDir 'equicord.asar.download'
Write-Host "Downloading $($release.tag_name) ($([Math]::Round($asset.size / 1MB, 1)) MB)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $download -Headers @{ 'User-Agent' = 'lanlink-install' } -UseBasicParsing
if ((Get-Item $download).Length -ne $asset.size) {
    Remove-Item $download -Force
    throw 'The download is incomplete. Nothing was changed. Try again.'
}

$wasRunning = Stop-Discord
if (-not (Test-Path $backup)) { Copy-Item -Path $asar -Destination $backup }
Move-Item -Path $download -Destination $asar -Force

Write-Host ''
Write-Host "Installed $($release.tag_name)."
Write-Host 'Next: Discord -> Settings -> Equicord -> Plugins -> LanLink: switch it on, restart Discord,'
Write-Host 'then set the peer user ID and the shared secret. Allow Discord in the Windows Firewall prompt (Private networks).'
if ($wasRunning) { Start-Discord }

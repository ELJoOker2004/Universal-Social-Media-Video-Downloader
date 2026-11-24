param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.eljooker.social_video_downloader'
$installDir = Join-Path $env:LOCALAPPDATA 'UniversalSocialMediaVideoDownloader\NativeHost'
$manifestPath = Join-Path $installDir "$hostName.json"
$launcherPath = Join-Path $installDir 'host.exe'
$scriptPath = Join-Path $installDir 'host.ps1'

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'host.ps1') -Destination $scriptPath -Force
$compiledPath = Join-Path $installDir ('host-' + [Guid]::NewGuid().ToString('N') + '.exe')
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'host-launcher.cs') -OutputAssembly $compiledPath -OutputType ConsoleApplication
    if (Test-Path -LiteralPath $launcherPath) { Remove-Item -LiteralPath $launcherPath -Force }
    Move-Item -LiteralPath $compiledPath -Destination $launcherPath
} finally {
    if (Test-Path -LiteralPath $compiledPath) { Remove-Item -LiteralPath $compiledPath -Force }
}
$manifest = @{
    name = $hostName
    description = 'YouTube and TikTok download helper for Universal Social Media Video Downloader'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
foreach ($browserPath in @('Google\Chrome', 'Microsoft\Edge')) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\$browserPath\NativeMessagingHosts\$hostName")
    try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $key.Close() }
}
$legacyLauncher = Join-Path $installDir 'host.cmd'
if (Test-Path -LiteralPath $legacyLauncher -PathType Leaf) {
    Remove-Item -LiteralPath $legacyLauncher
}

Write-Host "Video helper installed for Chrome and Edge extension $ExtensionId."
Write-Host 'Refresh YouTube and TikTok tabs. If the browser still cannot find the host, restart the browser and refresh again.'
$wingetPackages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
$wingetYtDlp = if (Test-Path -LiteralPath $wingetPackages -PathType Container) {
    Get-ChildItem -LiteralPath $wingetPackages -Directory -Filter 'yt-dlp.yt-dlp_*' -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName 'yt-dlp.exe' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
}
if (!(Get-Command yt-dlp -CommandType Application -ErrorAction SilentlyContinue) -and !$wingetYtDlp) {
    Write-Warning 'Install yt-dlp and add it to PATH before using YouTube or TikTok downloads.'
}
if (!(Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue) -or
    !(Get-Command ffprobe -CommandType Application -ErrorAction SilentlyContinue)) {
    Write-Host 'FFmpeg is absent: TikTok sound-only and merged YouTube video downloads require FFmpeg and ffprobe.'
}

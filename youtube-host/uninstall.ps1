$ErrorActionPreference = 'Stop'
$hostName = 'com.eljooker.social_video_downloader'
$installDir = Join-Path $env:LOCALAPPDATA 'UniversalSocialMediaVideoDownloader\NativeHost'
$manifestPath = Join-Path $installDir "$hostName.json"
foreach ($browserPath in @('Google\Chrome', 'Microsoft\Edge')) {
    $registryPath = "HKCU:\Software\$browserPath\NativeMessagingHosts\$hostName"
    if (Test-Path $registryPath) {
        $registeredPath = (Get-Item $registryPath).GetValue('')
        if ($registeredPath -ne $manifestPath) { throw "The $browserPath helper points elsewhere; refusing to remove it." }
        Remove-Item -LiteralPath $registryPath
    }
}
foreach ($name in @("$hostName.json", 'host.exe', 'host.cmd', 'host.ps1')) {
    $file = Join-Path $installDir $name
    if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file }
}
if (Test-Path -LiteralPath $installDir -PathType Container) {
    $remaining = @(Get-ChildItem -LiteralPath $installDir -Force)
    if (!$remaining.Count) { Remove-Item -LiteralPath $installDir }
}
Write-Host 'Video helper uninstalled.'

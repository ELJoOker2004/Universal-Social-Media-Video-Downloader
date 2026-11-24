$ErrorActionPreference = 'Stop'
$script:inputStream = [Console]::OpenStandardInput()
$script:outputStream = [Console]::OpenStandardOutput()
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$env:PYTHONIOENCODING = 'utf-8'

function Read-Exact([int]$length) {
    $bytes = [byte[]]::new($length)
    $offset = 0
    while ($offset -lt $length) {
        $count = $script:inputStream.Read($bytes, $offset, $length - $offset)
        if ($count -eq 0) { throw 'Incomplete native message.' }
        $offset += $count
    }
    return ,$bytes
}

function Send-Response($payload) {
    $json = ConvertTo-Json -InputObject $payload -Depth 8 -Compress
    $bytes = $utf8.GetBytes($json)
    if ($bytes.Length -ge 1048576) { throw 'Native response is too large.' }
    $length = [BitConverter]::GetBytes([int]$bytes.Length)
    $script:outputStream.Write($length, 0, 4)
    $script:outputStream.Write($bytes, 0, $bytes.Length)
    $script:outputStream.Flush()
}

function Get-Formats($info, [bool]$canMerge) {
    $eligible = @($info.formats | Where-Object {
        [string]$_.format_id -match '^\d{1,5}$' -and
        $_.protocol -eq 'https' -and
        $_.has_drm -ne $true -and
        ![string]::IsNullOrWhiteSpace([string]$_.url)
    })
    $audioMp4 = @($eligible | Where-Object {
        $_.ext -eq 'm4a' -and $_.vcodec -eq 'none' -and $_.acodec -ne 'none'
    } | Sort-Object -Property @{Expression = { [double]$_.abr }; Descending = $true} | Select-Object -First 1)
    $audioMp4 = if ($audioMp4.Count) { $audioMp4[0] } else { $null }
    $videoOptions = @()
    $heights = @($eligible | Where-Object {
        $_.ext -eq 'mp4' -and $_.vcodec -ne 'none' -and [int]$_.height -ge 144
    } | ForEach-Object { [int]$_.height } | Sort-Object -Unique -Descending)

    foreach ($height in $heights) {
        $combined = @($eligible | Where-Object {
            $_.ext -eq 'mp4' -and [int]$_.height -eq $height -and
            $_.vcodec -ne 'none' -and $_.acodec -ne 'none'
        } | Sort-Object -Property @{Expression = { [double]$_.tbr }; Descending = $true} | Select-Object -First 1)
        if ($combined.Count) {
            $videoOptions += [pscustomobject]@{
                kind = 'video'; format = [string]$combined[0].format_id
                label = "${height}p MP4 (direct)"; height = $height; needsFfmpeg = $false
            }
        }
        if (!$canMerge -or !$audioMp4) { continue }
        $videoOnly = @($eligible | Where-Object {
            $_.ext -eq 'mp4' -and [int]$_.height -eq $height -and
            $_.vcodec -ne 'none' -and $_.acodec -eq 'none'
        } | Sort-Object -Property `
            @{Expression = { if ($_.vcodec -like 'avc1*') { 3 } elseif ($_.vcodec -like 'av01*') { 2 } else { 1 } }; Descending = $true}, `
            @{Expression = { [double]$_.tbr }; Descending = $true} | Select-Object -First 1)
        if ($videoOnly.Count) {
            $videoOptions += [pscustomobject]@{
                kind = 'video'; format = "$($videoOnly[0].format_id)+$($audioMp4.format_id)"
                label = "${height}p MP4 (merged)"; height = $height; needsFfmpeg = $true
            }
        }
    }

    $audioOptions = @()
    foreach ($extension in @('m4a', 'webm')) {
        $audio = @($eligible | Where-Object {
            $_.ext -eq $extension -and $_.vcodec -eq 'none' -and $_.acodec -ne 'none'
        } | Sort-Object -Property @{Expression = { [double]$_.abr }; Descending = $true} | Select-Object -First 1)
        if (!$audio.Count) { continue }
        $bitrate = [Math]::Round([double]$audio[0].abr)
        $audioOptions += [pscustomobject]@{
            kind = 'audio'; format = [string]$audio[0].format_id
            label = "$($extension.ToUpperInvariant()) audio ($bitrate kbps)"
            needsFfmpeg = $false
        }
    }
    return [pscustomobject]@{ video = @($videoOptions); audio = @($audioOptions) }
}

function Get-TikTokFormat($info) {
    $formats = @($info.formats | Where-Object {
        $_.ext -eq 'mp4' -and $_.protocol -eq 'https' -and
        $_.vcodec -ne 'none' -and $_.acodec -ne 'none' -and
        $_.has_drm -ne $true -and ![string]::IsNullOrWhiteSpace([string]$_.url)
    })
    if (!$formats.Count) { throw 'No downloadable TikTok video with audio was found.' }
    $h264 = @($formats | Where-Object { [string]$_.vcodec -match '^(h264|avc1)' })
    $pool = if ($h264.Count) { $h264 } else { $formats }
    $best = $pool | Sort-Object -Property `
        @{Expression = { [double]$_.tbr }; Descending = $true}, `
        @{Expression = { [double]$_.filesize }; Descending = $true} | Select-Object -First 1
    return [pscustomobject]@{
        kind = 'video'; format = [string]$best.format_id
        label = 'MP4 video'; needsFfmpeg = $false
    }
}

function Get-DownloadFolder([string]$platform) {
    $value = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'
    $root = if ($value) { [Environment]::ExpandEnvironmentVariables([string]$value) } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads' }
    return Join-Path $root $(if ($platform -eq 'tiktok') { 'TikTok' } else { 'YouTube' })
}

function Find-YtDlp {
    $command = Get-Command yt-dlp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    # WinGet can move its command alias during an update while Edge still has
    # its old PATH. Find the installed executable without requiring a restart.
    $packages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (Test-Path -LiteralPath $packages -PathType Container) {
        $candidate = Get-ChildItem -LiteralPath $packages -Directory -Filter 'yt-dlp.yt-dlp_*' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object { Join-Path $_.FullName 'yt-dlp.exe' } |
            Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
            Select-Object -First 1
        if ($candidate) { return $candidate }
    }
    return $null
}

function Convert-ProgressLine([string]$line, [string[]]$selectedFormats, [bool]$needsFfmpeg) {
    if ($line.StartsWith('FBDL_POSTPROCESS|', [StringComparison]::Ordinal)) {
        if ($needsFfmpeg -and $line.Contains('|started')) {
            return @{ type = 'progress'; phase = 'finishing'; percent = $null }
        }
        return $null
    }
    if (!$line.StartsWith('FBDL_PROGRESS|', [StringComparison]::Ordinal)) { return $null }
    try {
        $parts = $line.Split([char]'|', 3)
        $progress = $parts[2] | ConvertFrom-Json
        $phase = 'download'
        if ($needsFfmpeg) {
            if ($parts[1] -eq $selectedFormats[0]) { $phase = 'video' }
            elseif ($parts[1] -eq $selectedFormats[1]) { $phase = 'audio' }
        }
        $percent = if ($null -ne $progress._percent) {
            [Math]::Min(100.0, [Math]::Max(0.0, [Math]::Round([double]$progress._percent, 1)))
        } else { $null }
        return @{
            type = 'progress'; phase = $phase; percent = $percent
            downloadedBytes = if ($null -ne $progress.downloaded_bytes) { [long]$progress.downloaded_bytes } else { $null }
            totalBytes = if ($null -ne $progress.total_bytes) { [long]$progress.total_bytes } elseif ($null -ne $progress.total_bytes_estimate) { [long]$progress.total_bytes_estimate } else { $null }
            speed = if ($null -ne $progress.speed) { [double]$progress.speed } else { $null }
            eta = if ($null -ne $progress.eta) { [double]$progress.eta } else { $null }
        }
    } catch {
        # yt-dlp can add fields between releases; a malformed update must not stop the file.
        return $null
    }
}

try {
    $header = Read-Exact 4
    $length = [BitConverter]::ToInt32($header, 0)
    if ($length -lt 1 -or $length -gt 65536) { throw 'Invalid native message length.' }
    $request = ConvertFrom-Json -InputObject $utf8.GetString((Read-Exact $length))
    $platform = if ($null -eq $request.platform) { 'youtube' } else { [string]$request.platform }
    if ($platform -notin @('youtube', 'tiktok')) { throw 'Unknown video platform.' }
    $kind = if ($platform -eq 'tiktok' -and $request.PSObject.Properties['kind']) { [string]$request.kind } else { 'video' }
    if ($platform -eq 'youtube' -and [string]$request.videoId -notmatch '^[A-Za-z0-9_-]{11}$') { throw 'Invalid YouTube video ID.' }
    if ($platform -eq 'tiktok' -and [string]$request.videoId -notmatch '^\d{15,22}$') { throw 'Invalid TikTok video ID.' }
    if ($platform -eq 'tiktok' -and $kind -notin @('video', 'audio')) { throw 'Invalid TikTok download choice.' }
    if ($request.action -notin @('formats', 'download')) { throw 'Unknown download action.' }
    if ($platform -eq 'tiktok' -and $request.action -eq 'formats') { throw 'TikTok format listing is not supported.' }
    if ($platform -eq 'youtube' -and $request.action -eq 'download' -and
        [string]$request.format -notmatch '^\d{1,5}(?:\+\d{1,5})?$') { throw 'Invalid YouTube format.' }

    $ytDlp = Find-YtDlp
    if (!$ytDlp) { throw 'yt-dlp is not installed or is not on PATH. See README.md.' }
    $ffmpeg = Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $ffprobe = Get-Command ffprobe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $canMerge = [bool]($ffmpeg -and $ffprobe)
    $url = if ($platform -eq 'tiktok') {
        "https://www.tiktok.com/@/video/$($request.videoId)"
    } else {
        "https://www.youtube.com/watch?v=$($request.videoId)"
    }
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $metadata = & $ytDlp --ignore-config --no-playlist --no-warnings --quiet -J $url 2>$null }
    finally { $ErrorActionPreference = $previousErrorAction }
    if ($LASTEXITCODE -ne 0 -or !$metadata) { throw "yt-dlp could not read this $platform video. Update yt-dlp or try another video." }
    $info = ($metadata -join "`n") | ConvertFrom-Json
    if ([string]$info.id -ne [string]$request.videoId) { throw 'The site returned a different video.' }
    if ($info.is_live -eq $true) { throw 'Live streams are not supported.' }

    if ($request.action -eq 'formats') {
        $choices = Get-Formats $info $canMerge
        Send-Response @{ type = 'formats'; title = [string]$info.title; ffmpegAvailable = $canMerge; video = $choices.video; audio = $choices.audio }
    } else {
        if ($platform -eq 'tiktok') {
            $chosen = Get-TikTokFormat $info
            if ($kind -eq 'audio') {
                if (!$canMerge) { throw 'FFmpeg and ffprobe are required to save the full TikTok audio.' }
                $chosen.label = 'M4A audio'
                $chosen | Add-Member -NotePropertyName extractAudio -NotePropertyValue $true
            }
        } else {
            $choices = Get-Formats $info $canMerge
            $options = @($choices.video) + @($choices.audio)
            $chosen = @($options | Where-Object { $_.format -eq $request.format } | Select-Object -First 1)
            if (!$chosen.Count) { throw 'This format is no longer available. Reopen the quality menu.' }
            $chosen = $chosen[0]
        }
        $folder = Get-DownloadFolder $platform
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        $stage = Join-Path $tempRoot ('FBDL-YouTube-' + [Guid]::NewGuid().ToString('N'))
        $stageFull = [IO.Path]::GetFullPath($stage)
        if (![string]::Equals([IO.Path]::GetDirectoryName($stageFull), $tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($stageFull) -notmatch '^FBDL-YouTube-[a-f0-9]{32}$') { throw 'Invalid staging folder.' }
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        Send-Response @{ type = 'started'; title = [string]$info.title; label = [string]$chosen.label; folder = $folder }
        try {
            $arguments = @('--ignore-config', '--no-playlist', '--no-warnings', '--quiet', '--windows-filenames',
                '--http-chunk-size', '1M', '--no-part', '--no-continue', '--progress', '--newline',
                '--progress-delta', '0.5',
                '--progress-template', 'download:FBDL_PROGRESS|%(info.format_id)s|%(progress)j',
                '--progress-template', 'postprocess:FBDL_POSTPROCESS|%(progress.status)s',
                '-f', [string]$chosen.format, '-P', $stage, '-o', '%(title).150B [%(id)s].%(ext)s',
                '--print', 'after_move:FBDL_FILE|%(filepath)s')
            if ($chosen.needsFfmpeg) { $arguments += @('--merge-output-format', 'mp4') }
            if ($chosen.extractAudio) { $arguments += @('--extract-audio', '--audio-format', 'm4a') }
            $script:savedPath = $null
            $script:lastProgressSent = 0
            $script:lastPhase = $null
            $selectedFormats = ([string]$chosen.format).Split('+')
            $previousErrorAction = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                & $ytDlp @arguments $url 2>$null | ForEach-Object {
                    $line = [string]$_
                    if ($line.StartsWith('FBDL_FILE|', [StringComparison]::Ordinal)) {
                        $script:savedPath = $line.Substring('FBDL_FILE|'.Length)
                    } else {
                        $update = if ($chosen.extractAudio -and $line.StartsWith('FBDL_POSTPROCESS|started', [StringComparison]::Ordinal)) {
                            @{ type = 'progress'; phase = 'finishing'; percent = $null }
                        } else {
                            Convert-ProgressLine $line $selectedFormats ([bool]$chosen.needsFfmpeg)
                        }
                        if ($update) {
                            $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                            if ($update.phase -ne $script:lastPhase -or $update.percent -eq 100 -or
                                $now - $script:lastProgressSent -ge 500) {
                                $script:lastProgressSent = $now
                                $script:lastPhase = $update.phase
                                Send-Response $update
                            }
                        }
                    }
                }
            }
            finally { $ErrorActionPreference = $previousErrorAction }
            if ($LASTEXITCODE -ne 0) { throw 'yt-dlp could not download this format. Retry or update yt-dlp.' }
            if ($platform -eq 'tiktok') {
                # PowerShell 5 can decode yt-dlp's printed Unicode path differently
                # from the filename on disk. This fresh stage must contain one result.
                $extension = if ($chosen.extractAudio) { 'm4a' } else { 'mp4' }
                $matches = @(Get-ChildItem -LiteralPath $stageFull -File -Filter "*.$extension" |
                    Where-Object { $_.Name.EndsWith("[$($request.videoId)].$extension", [StringComparison]::OrdinalIgnoreCase) })
                if ($matches.Count -ne 1) { throw "yt-dlp finished but the TikTok $extension was not found." }
                $saved = $matches[0].FullName
            } else {
                if (!$script:savedPath) { throw 'yt-dlp did not report the completed file.' }
                $saved = [IO.Path]::GetFullPath($script:savedPath)
            }
            if (!$saved.StartsWith($stageFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
                !(Test-Path -LiteralPath $saved -PathType Leaf)) { throw 'yt-dlp finished but the file was not found.' }
            $name = [IO.Path]::GetFileName($saved)
            $destination = Join-Path $folder $name
            $index = 2
            while (Test-Path -LiteralPath $destination) {
                $name = '{0} ({1}){2}' -f [IO.Path]::GetFileNameWithoutExtension($saved), $index, [IO.Path]::GetExtension($saved)
                $destination = Join-Path $folder $name
                $index++
            }
            Move-Item -LiteralPath $saved -Destination $destination
            Send-Response @{ type = 'complete'; fileName = $name; folder = $folder }
        } finally {
            if (Test-Path -LiteralPath $stageFull -PathType Container) {
                Remove-Item -LiteralPath $stageFull -Recurse -Force
            }
        }
    }
} catch {
    try { Send-Response @{ type = 'error'; error = [string]$_.Exception.Message } } catch {}
}

# Universal Social Media Video Downloader

A Chrome and Edge extension that adds a download button to videos on Facebook, X (including legacy `twitter.com` links), Instagram, YouTube, and TikTok.

## Features

- **Download button** — a floating button appears over videos on Facebook, X, Instagram, YouTube, and TikTok
- **YouTube format menu** — choose a video quality with sound or an audio-only M4A/WebM download, with live progress in the menu and toolbar popup
- **TikTok video or sound** — save an identifiable public video as MP4, or extract its full sound as M4A, with progress beside the buttons and in the toolbar popup
- **X quality selection** — uses the highest-bitrate MP4 in the media metadata already loaded by X when available
- **Instagram quality selection** — uses the largest progressive MP4 in the post or Reel data already loaded by Instagram
- **Facebook source recovery** — tries direct player URLs, React data, intercepted CDN traffic, and inline page metadata
- **Chrome Downloads API** — saves Facebook, X, and Instagram MP4s to your Downloads folder; the existing Facebook path also has browser fallbacks

## Installation (Developer Mode)

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. For YouTube and TikTok on Windows, complete the [video helper setup](#video-helper-setup-windows) below.
6. Open a video and reload the page once after installing or updating the extension. A download button appears near the top-right corner of the player.

### Video helper setup (Windows)

YouTube's stream URLs are signed, and higher video qualities usually have separate video and audio streams. TikTok's browser player commonly uses a blob URL. The extension uses a small local helper to run [yt-dlp](https://github.com/yt-dlp/yt-dlp) for YouTube and TikTok. Facebook, X, and Instagram do not use this helper.

1. Install a current `yt-dlp` executable and make sure `yt-dlp` works in PowerShell. For full YouTube support, follow yt-dlp's [JavaScript runtime setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS) (Deno is recommended).
2. Install [`ffmpeg` and `ffprobe`](https://ffmpeg.org/download.html) on `PATH` for TikTok sound-only downloads and YouTube video qualities that need video and audio merged. Direct video-with-audio, original YouTube M4A/WebM audio-only, and TikTok MP4 downloads work without FFmpeg. This extension does not convert audio to MP3.
3. At `chrome://extensions` or `edge://extensions`, copy this unpacked extension's 32-character **ID**.
4. Open a regular PowerShell window through the Windows Start menu, navigate to this repository folder, and run:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\youtube-host\install.ps1 -ExtensionId YOUR_EXTENSION_ID
   ```

5. Refresh the YouTube or TikTok tab and click the download button. If it reports **Specified native messaging host not found**, check the registration from that same regular PowerShell window:

   ```powershell
   reg query "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.eljooker.social_video_downloader" /ve
   ```

   For Chrome, replace `Microsoft\Edge` with `Google\Chrome`. If the key is missing, rerun the installer from the regular PowerShell window. If it is present but the error continues, restart the browser and refresh the tab. After changing the helper files or moving the extension folder, run the installer again.

The installer compiles a small Windows launcher, copies the helper to your local app-data folder, and registers it for **your** extension ID in Chrome and Edge under `HKCU`. Run the installer again after updating the helper files. The helper saves files to `Downloads\YouTube` or `Downloads\TikTok`, outside the browser's download history. To remove it, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\youtube-host\uninstall.ps1`.

## How It Works

### Facebook

| Layer | Method |
|-------|--------|
| 1 | Direct `video.src` / `video.currentSrc` |
| 2 | React fiber traversal inside the page's MAIN world (`inject.js`) |
| 3 | Background service worker CDN interception via `webRequest` |
| 4 | Inline `<script>` tag scraping for `playable_url_quality_hd` / `hd_src` |

The Facebook path tries each layer in order and uses the first URL it finds.

### X

On `x.com` and `twitter.com`, the extension reads the video variants that X sends to its own player and selects the highest-bitrate complete MP4 for the clicked video. If that metadata is unavailable, it tries the video's direct MP4 source, then a matching MP4 URL observed from X's video CDN. Downloads use Chrome's Downloads API and are named `X_Video_<post ID>_<time>.mp4` when a post ID is available.

The X path downloads complete MP4 variants only. An HLS-only stream (`.m3u8` and its segments), an inaccessible post, or a video hosted on another service will show an error instead of saving an incomplete file. X can change its player and response format, so a page reload may be needed after an extension update.

### Instagram

On `instagram.com`, the extension reads `video_versions` or `video_url` from the post data Instagram has loaded in the page. It matches the clicked video by its poster, post code, or story ID, then selects the largest complete MP4. It can also use a direct video source or a matching page `og:video` URL. Downloads are named `IG_Video_<post code>_<time>.mp4` when a post code is available.

Posts, Reels, and stories work when Instagram provides a complete MP4 URL to the page. Live streams, DASH-only playback, inaccessible media, and partial byte-range URLs are not supported. Instagram changes its page data frequently, so reload the page after an extension update.

### YouTube

On a YouTube watch or Shorts page, click the button to see the formats yt-dlp found for that video. **Direct** MP4 choices already contain sound and need no FFmpeg. **Merged** MP4 choices combine separate video and audio streams and are shown only when FFmpeg and ffprobe are installed. Audio-only choices save the original M4A or WebM stream without conversion.

After choosing a format, progress appears in the page menu and in the extension's toolbar popup. The toolbar badge shows how many helper downloads are running, then a check or exclamation mark for the latest result. You can close or navigate away from the source tab while a download runs; keep the browser open until it finishes. The popup keeps recent YouTube and TikTok results, including failures after a browser or extension restart. Pin the extension to the toolbar if you want its badge visible at all times. The browser's Downloads page does not track these files because the local helper saves them directly.

Available qualities vary by video, and a listed stream can still fail if YouTube denies the download. Live streams are not supported.

### TikTok

On a public TikTok video page or a feed with an identifiable video, use the down-arrow button for an MP4 with audio or the speaker button for a sound-only M4A. The sound-only choice extracts the **full audio heard in the video**, including speech and effects, from the same selected stream; it does not fetch TikTok's separate music track. It requires FFmpeg and ffprobe. The helper selects the highest-bitrate H.264 MP4 with audio when one is available. Progress appears beside the buttons and in the toolbar popup. Files save to `Downloads\TikTok`; closing the source tab does not stop an active download while the browser remains open.

Photo carousels, live streams, private or inaccessible posts, and videos TikTok refuses to serve are not supported. If a player cannot be matched to a post ID, the extension leaves it alone instead of downloading a different video. TikTok changes its site and media access frequently, so an updated `yt-dlp` or extension may be needed.

Run the local checks with `node --test tests/*.test.js`.

## Project Structure

```
├── manifest.json     # Extension manifest (MV3)
├── background.js     # Service worker — CDN interception & downloads
├── content.js        # Facebook button and download orchestration
├── inject.js         # Facebook MAIN-world extraction
├── x-content.js      # X button and download orchestration
├── x-inject.js       # X MAIN-world MP4 variant extraction
├── ig-content.js     # Instagram button and download orchestration
├── ig-inject.js      # Instagram MAIN-world MP4 extraction
├── yt-content.js     # YouTube quality and audio-only menu
├── tt-content.js     # TikTok video/sound buttons and download status
├── popup.*           # Toolbar download progress and history
├── youtube-host/     # Shared Windows video helper, executable launcher, installer
├── content.css       # Button styles
├── tests/            # X, Instagram, YouTube, and TikTok checks
└── icons/            # Extension icons (16, 48, 128 px)
```

## Permissions

| Permission | Reason |
|-----------|--------|
| `downloads` | Trigger file downloads via the Chrome Downloads API |
| `webRequest` | Intercept CDN video URLs before they're played |
| `nativeMessaging` | Ask the locally installed helper for YouTube and TikTok downloads |
| `*://*.facebook.com/*` | Inject scripts and intercept requests on Facebook |
| `*://*.fbcdn.net/*` | Intercept Facebook's video CDN traffic |
| `https://x.com/*`, `https://*.x.com/*`, `https://twitter.com/*`, `https://*.twitter.com/*` | Add the button and read X's loaded media metadata |
| `https://video.twimg.com/*`, `https://video-s.twimg.com/*` | Observe and download X MP4 video files |
| `https://instagram.com/*`, `https://*.instagram.com/*` | Add the button and read Instagram's loaded media metadata |
| `https://youtube.com/*`, `https://*.youtube.com/*` | Add the YouTube format menu to watch and Shorts pages |
| `https://tiktok.com/*`, `https://*.tiktok.com/*` | Add the TikTok download button to identifiable videos |

## License

MIT

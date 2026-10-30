# FB, X & Instagram Video Downloader

A Chrome extension that adds a download button to videos on Facebook, X (including legacy `twitter.com` links), and Instagram.

## Features

- **One-click download** — a floating button appears over videos on Facebook, X, and Instagram
- **X quality selection** — uses the highest-bitrate MP4 in the media metadata already loaded by X when available
- **Instagram quality selection** — uses the largest progressive MP4 in the post or Reel data already loaded by Instagram
- **Facebook source recovery** — tries direct player URLs, React data, intercepted CDN traffic, and inline page metadata
- **Chrome Downloads API** — saves the selected MP4 to your Downloads folder; the existing Facebook path also has browser fallbacks

## Installation (Developer Mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Open a video on Facebook, X, or Instagram and reload the page once after installing or updating the extension. A download button appears near the top-right corner of the player.

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
├── content.css       # Button styles
├── tests/            # X and Instagram parser and background checks
└── icons/            # Extension icons (16, 48, 128 px)
```

## Permissions

| Permission | Reason |
|-----------|--------|
| `downloads` | Trigger file downloads via the Chrome Downloads API |
| `webRequest` | Intercept CDN video URLs before they're played |
| `*://*.facebook.com/*` | Inject scripts and intercept requests on Facebook |
| `*://*.fbcdn.net/*` | Intercept Facebook's video CDN traffic |
| `https://x.com/*`, `https://*.x.com/*`, `https://twitter.com/*`, `https://*.twitter.com/*` | Add the button and read X's loaded media metadata |
| `https://video.twimg.com/*`, `https://video-s.twimg.com/*` | Observe and download X MP4 video files |
| `https://instagram.com/*`, `https://*.instagram.com/*` | Add the button and read Instagram's loaded media metadata |

## License

MIT

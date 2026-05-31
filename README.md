# FB Video Downloader

A Chrome extension that adds a one-click download button to every Facebook video — always grabbing the highest quality available.

## Features

- **One-click download** — a floating button appears on every Facebook video
- **HD-first** — tries to fetch the highest quality stream before falling back to SD
- **Four-layer URL resolution** — direct `src`, React fiber traversal, background CDN interception, and page HTML scraping so it works across all Facebook video formats (Watch, Reels, Stories, Feed)
- **No pop-ups, no redirects** — downloads go straight to your Downloads folder via the Chrome Downloads API

## Installation (Developer Mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Navigate to any Facebook video — a download button appears in the top-right corner of the player

## How It Works

| Layer | Method |
|-------|--------|
| 1 | Direct `video.src` / `video.currentSrc` |
| 2 | React fiber traversal inside the page's MAIN world (`inject.js`) |
| 3 | Background service worker CDN interception via `webRequest` |
| 4 | Inline `<script>` tag scraping for `playable_url_quality_hd` / `hd_src` |

The extension tries each layer in order and uses the first URL it finds, prioritising HD over SD.

## Project Structure

```
├── manifest.json     # Extension manifest (MV3)
├── background.js     # Service worker — CDN interception & downloads
├── content.js        # Content script — button injection & download orchestration
├── inject.js         # MAIN-world script — React fiber traversal
├── content.css       # Button styles
└── icons/            # Extension icons (16, 48, 128 px)
```

## Permissions

| Permission | Reason |
|-----------|--------|
| `downloads` | Trigger file downloads via the Chrome Downloads API |
| `webRequest` | Intercept CDN video URLs before they're played |
| `*://*.facebook.com/*` | Inject scripts and intercept requests on Facebook |
| `*://*.fbcdn.net/*` | Intercept Facebook's video CDN traffic |

## License

MIT

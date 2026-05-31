/* ===== FB Video Downloader — Background Service Worker ===== */

// Per-tab store of intercepted CDN video URLs
const videoUrls = new Map();

// ── Network interception — very permissive to catch all video CDN reqs ──
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    if (!maybeVideo(url)) return;

    if (!videoUrls.has(details.tabId)) videoUrls.set(details.tabId, []);
    const list = videoUrls.get(details.tabId);

    const base = url.split('?')[0];
    if (list.some((u) => u.url.split('?')[0] === base)) return;

    list.push({ url, ts: Date.now(), quality: guessQuality(url) });
    if (list.length > 120) list.splice(0, list.length - 120);
  },
  { urls: ['*://*.fbcdn.net/*', '*://*.facebook.com/video/*'] }
);

function maybeVideo(url) {
  // Very permissive: catch anything that could be a video
  if (/\.mp4/i.test(url)) return true;
  if (/\/v\/t\d+/i.test(url)) return true;        // /v/t42... /v/t39...
  if (/\/video[s]?\//i.test(url)) return true;
  if (/bytestart/i.test(url)) return true;          // range requests for video
  if (/efg=/i.test(url)) return true;               // encoded video params
  if (/video/i.test(url)) return true;               // any url with "video"
  return false;
}

function guessQuality(url) {
  if (/[_=](hd|720|1080|1280|1920)/i.test(url)) return 'hd';
  if (/bytestart=0/i.test(url)) return 'hd'; // initial request often HD
  return 'sd';
}

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => videoUrls.delete(tabId));

// ── Message handler ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === 'download') {
    const url = msg.url;
    if (!url) { reply({ success: false, error: 'No URL' }); return true; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    chrome.downloads.download(
      { url, filename: `FB_Video_${stamp}.mp4`, conflictAction: 'uniquify' },
      (id) => {
        if (chrome.runtime.lastError) {
          console.warn('[FBDL] downloads API error:', chrome.runtime.lastError.message);
          reply({ success: false, error: chrome.runtime.lastError.message });
        } else {
          reply({ success: true, downloadId: id });
        }
      }
    );
    return true;
  }

  if (msg.action === 'getVideoUrls') {
    const tid = sender.tab?.id;
    const list = tid ? (videoUrls.get(tid) || []) : [];
    const sorted = [...list].sort((a, b) => {
      if (a.quality === 'hd' && b.quality !== 'hd') return -1;
      if (b.quality === 'hd' && a.quality !== 'hd') return 1;
      return b.ts - a.ts;
    });
    reply({ urls: sorted.map((u) => u.url) });
    return true;
  }
});

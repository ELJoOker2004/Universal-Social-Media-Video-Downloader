/* ===== Universal Social Media Video Downloader — Background Service Worker ===== */

// Per-tab store of intercepted CDN video URLs
const videoUrls = new Map();
const xVideoUrls = new Map();

function isFacebookPage(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'facebook.com' || host.endsWith('.facebook.com');
  } catch (_) { return false; }
}

function isXPage(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'x.com' || host.endsWith('.x.com') ||
      host === 'twitter.com' || host.endsWith('.twitter.com');
  } catch (_) { return false; }
}

function xMediaId(url) {
  const match = url.match(/\/(?:ext_tw_video|amplify_video|tweet_video|dm_video)(?:_thumb)?\/(\d{5,})(?:\/|$)/i);
  return match ? match[1] : null;
}

function isXMp4(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'video.twimg.com' || parsed.hostname === 'video-s.twimg.com') &&
      parsed.pathname.toLowerCase().endsWith('.mp4');
  } catch (_) { return false; }
}

function isInstagramPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'instagram.com' || parsed.hostname.endsWith('.instagram.com'));
  } catch (_) { return false; }
}

function isInstagramMp4(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return parsed.protocol === 'https:' &&
      (host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') ||
        host === 'fbcdn.net' || host.endsWith('.fbcdn.net')) &&
      parsed.pathname.toLowerCase().endsWith('.mp4') &&
      !parsed.searchParams.has('bytestart') && !parsed.searchParams.has('byteend');
  } catch (_) { return false; }
}

function xPixels(url) {
  const match = new URL(url).pathname.match(/\/(\d+)x(\d+)\//);
  return match ? Number(match[1]) * Number(match[2]) : 0;
}

// ── Network interception — very permissive to catch all video CDN reqs ──
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.initiator && !isFacebookPage(details.initiator)) return;
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

// X's player may request a complete MP4 even when the video element uses a blob URL.
// Keep only complete MP4 URLs, indexed by the media ID visible in its poster URL.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !isXMp4(details.url)) return;
    if (details.initiator && !isXPage(details.initiator)) return;
    const mediaId = xMediaId(details.url);
    if (!mediaId) return;
    if (!xVideoUrls.has(details.tabId)) xVideoUrls.set(details.tabId, []);
    const list = xVideoUrls.get(details.tabId);
    if (list.some((entry) => entry.url === details.url)) return;
    list.push({ url: details.url, mediaId, pixels: xPixels(details.url), ts: Date.now() });
    if (list.length > 200) list.splice(0, list.length - 200);
  },
  { urls: ['https://video.twimg.com/*', 'https://video-s.twimg.com/*'] }
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
chrome.tabs.onRemoved.addListener((tabId) => {
  videoUrls.delete(tabId);
  xVideoUrls.delete(tabId);
});

// ── Message handler ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.action === 'download') {
    const url = msg.url;
    if (!url) { reply({ success: false, error: 'No URL' }); return true; }

    const fromX = msg.platform === 'x';
    const fromInstagram = msg.platform === 'instagram';
    if (fromX && (!isXPage(sender.url) || !isXMp4(url))) {
      reply({ success: false, error: 'Invalid X video URL' });
      return true;
    }
    if (fromInstagram && (!isInstagramPage(sender.url) || !isInstagramMp4(url))) {
      reply({ success: false, error: 'Invalid Instagram video URL' });
      return true;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tweetId = fromX && /^\d{5,}$/.test(msg.tweetId || '') ? `${msg.tweetId}_` : '';
    const shortcode = fromInstagram && /^[A-Za-z0-9_-]{5,20}$/.test(msg.shortcode || '') ? `${msg.shortcode}_` : '';
    chrome.downloads.download(
      { url, filename: fromX ? `X_Video_${tweetId}${stamp}.mp4` :
        fromInstagram ? `IG_Video_${shortcode}${stamp}.mp4` : `FB_Video_${stamp}.mp4`, conflictAction: 'uniquify' },
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

  if (msg.action === 'getXVideoUrls') {
    if (!isXPage(sender.url) || !/^\d{5,}$/.test(msg.mediaId || '')) {
      reply({ urls: [] });
      return true;
    }
    const list = xVideoUrls.get(sender.tab?.id) || [];
    const matches = list.filter((entry) => entry.mediaId === msg.mediaId)
      .sort((a, b) => b.pixels - a.pixels || b.ts - a.ts);
    reply({ urls: matches.map((entry) => entry.url) });
    return true;
  }
});

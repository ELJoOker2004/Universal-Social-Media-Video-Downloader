/* ===== Universal Social Media Video Downloader — Background Service Worker ===== */

// Per-tab store of intercepted CDN video URLs
const videoUrls = new Map();
const xVideoUrls = new Map();
const downloadJobs = [];
const downloadPorts = new Map();
const DOWNLOAD_HOST = 'com.eljooker.social_video_downloader';
const DOWNLOAD_JOBS_KEY = 'youtubeJobs'; // Preserve existing history across updates.
const DOWNLOAD_ACTIVE_STATES = new Set(['preparing', 'downloading', 'finishing']);
let downloadSaveQueue = Promise.resolve();

const downloadReady = chrome.storage?.local?.get
  ? chrome.storage.local.get(DOWNLOAD_JOBS_KEY).then((stored) => {
    const previous = Array.isArray(stored[DOWNLOAD_JOBS_KEY]) ? stored[DOWNLOAD_JOBS_KEY] : [];
    for (const old of previous.slice(0, 20)) {
      if (!old || typeof old !== 'object' || typeof old.id !== 'string') continue;
      const job = { ...old, platform: old.platform === 'tiktok' ? 'tiktok' : 'youtube' };
      if (DOWNLOAD_ACTIVE_STATES.has(job.state)) {
        job.state = 'error';
        job.error = `The browser or extension stopped before the result was confirmed. Check Downloads\\${job.platform === 'tiktok' ? 'TikTok' : 'YouTube'}.`;
        job.updatedAt = Date.now();
      }
      downloadJobs.push(job);
    }
    persistDownloadJobs();
    updateDownloadBadge();
  }).catch((error) => console.warn('[FBDL] Could not load download jobs:', error))
  : Promise.resolve();

function publicDownloadJob(job) {
  const { port, legacyPort, lastPersistedAt, ...record } = job;
  return record;
}

function trimDownloadJobs() {
  while (downloadJobs.length > 20) {
    let removable = -1;
    for (let index = downloadJobs.length - 1; index >= 0; index--) {
      if (!DOWNLOAD_ACTIVE_STATES.has(downloadJobs[index].state)) {
        removable = index;
        break;
      }
    }
    if (removable < 0) break;
    downloadJobs.splice(removable, 1);
  }
}

function persistDownloadJobs() {
  if (!chrome.storage?.local?.set) return;
  const records = downloadJobs.slice(0, 20).map(publicDownloadJob);
  downloadSaveQueue = downloadSaveQueue.catch(() => {}).then(() =>
    chrome.storage.local.set({ [DOWNLOAD_JOBS_KEY]: records }));
  downloadSaveQueue.catch((error) => console.warn('[FBDL] Could not save download jobs:', error));
}

function updateDownloadBadge() {
  if (!chrome.action) return;
  const active = downloadJobs.filter((job) => DOWNLOAD_ACTIVE_STATES.has(job.state));
  const latest = downloadJobs[0];
  const text = active.length ? String(active.length) :
    latest?.state === 'complete' ? '✓' : latest?.state === 'error' ? '!' : '';
  const color = active.length ? '#1565c0' : latest?.state === 'error' ? '#c62828' : '#2e7d32';
  const platform = latest?.platform === 'tiktok' ? 'TikTok' : 'YouTube';
  const title = active.length ? `${active.length} download${active.length === 1 ? '' : 's'} in progress` :
    latest?.state === 'complete' ? `${platform} download saved` :
      latest?.state === 'error' ? `${platform} download failed` : 'Universal Social Media Video Downloader';
  for (const operation of [
    chrome.action.setBadgeBackgroundColor({ color }),
    chrome.action.setBadgeText({ text }),
    chrome.action.setTitle({ title }),
  ]) operation?.catch?.(() => {});
}

function publishDownloadJob(job, forcePersist = false) {
  job.updatedAt = Date.now();
  const record = publicDownloadJob(job);
  if (forcePersist || job.updatedAt - (job.lastPersistedAt || 0) >= 1000) {
    job.lastPersistedAt = job.updatedAt;
    persistDownloadJobs();
  }
  updateDownloadBadge();
  if (Number.isInteger(job.tabId)) {
    chrome.tabs.sendMessage?.(job.tabId, { action: 'downloadJobUpdate', job: record })?.catch?.(() => {});
  }
  chrome.runtime.sendMessage?.({ action: 'downloadJobUpdate', job: record })?.catch?.(() => {});
  try { job.legacyPort?.postMessage(record.state === 'complete'
    ? { type: 'complete', fileName: record.fileName, folder: record.folder }
    : record.state === 'error' ? { type: 'error', error: record.error }
      : { type: record.state === 'preparing' ? 'started' : 'progress', ...record }); } catch (_) {}
}

function finishDownloadJob(job, state, fields = {}) {
  if (!downloadPorts.has(job.id)) return;
  Object.assign(job, fields, { state, phase: null, percent: state === 'complete' ? 100 : job.percent });
  downloadPorts.delete(job.id);
  publishDownloadJob(job, true);
  try { job.port?.disconnect(); } catch (_) {}
  job.port = null;
  job.legacyPort = null;
}

async function startDownloadJob(message, sender, platform, legacyPort = null) {
  await downloadReady;
  const pageId = platform === 'youtube' ? youtubeVideoIdFromPage(sender?.url) : tiktokVideoIdFromPage(sender?.url);
  const id = platform === 'youtube' ? pageId : message?.videoId;
  const kind = platform === 'tiktok'
    ? Object.prototype.hasOwnProperty.call(message || {}, 'kind') ? message.kind : 'video'
    : null;
  const validTikTok = platform === 'tiktok' && isTikTokPage(sender?.url) &&
    /^\d{15,22}$/.test(id || '') && (!pageId || pageId === id) &&
    (kind === 'video' || kind === 'audio');
  const validYouTube = platform === 'youtube' && id && message?.videoId === id &&
    /^\d{1,5}(?:\+\d{1,5})?$/.test(message.format || '');
  if ((!validTikTok && !validYouTube) || !Number.isInteger(sender?.tab?.id)) {
    return { success: false, error: 'Invalid video or format.' };
  }
  if (downloadPorts.size >= 3) {
    return { success: false, error: 'Three downloads are already running. Try again after one finishes.' };
  }
  const label = platform === 'tiktok' ? (kind === 'audio' ? 'M4A audio' : 'MP4 video') :
    typeof message.label === 'string' && /^[\w ().+-]{1,80}$/.test(message.label)
      ? message.label : `Format ${message.format}`;
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    platform, kind, videoId: id, tabId: sender.tab.id,
    title: platform === 'tiktok' ? (kind === 'audio' ? 'TikTok sound' : 'TikTok video') : 'YouTube video', label,
    state: 'preparing', phase: null, percent: null,
    downloadedBytes: null, totalBytes: null, speed: null, eta: null,
    fileName: null, folder: null, error: null,
    startedAt: Date.now(), updatedAt: Date.now(),
    port: null, legacyPort, lastPersistedAt: 0,
  };
  downloadJobs.unshift(job);
  trimDownloadJobs();
  let nativePort;
  try {
    nativePort = chrome.runtime.connectNative(DOWNLOAD_HOST);
    job.port = nativePort;
    downloadPorts.set(job.id, nativePort);
    nativePort.onMessage.addListener((response) => {
      if (!downloadPorts.has(job.id)) return;
      if (response?.type === 'started') {
        job.title = typeof response.title === 'string' ? response.title.slice(0, 200) : job.title;
        job.label = typeof response.label === 'string' ? response.label.slice(0, 80) : job.label;
        job.state = 'downloading';
        publishDownloadJob(job, true);
      } else if (response?.type === 'progress') {
        job.state = response.phase === 'finishing' ? 'finishing' : 'downloading';
        job.phase = ['video', 'audio', 'download', 'finishing'].includes(response.phase) ? response.phase : 'download';
        job.percent = Number.isFinite(response.percent) ? Math.max(0, Math.min(100, response.percent)) : null;
        for (const field of ['downloadedBytes', 'totalBytes', 'speed', 'eta']) {
          job[field] = Number.isFinite(response[field]) && response[field] >= 0 ? response[field] : null;
        }
        publishDownloadJob(job);
      } else if (response?.type === 'complete') {
        finishDownloadJob(job, 'complete', {
          fileName: String(response.fileName || '').slice(0, 260),
          folder: String(response.folder || '').slice(0, 400),
        });
      } else if (response?.type === 'error') {
        finishDownloadJob(job, 'error', { error: String(response.error || 'Download failed.').slice(0, 300) });
      }
    });
    nativePort.onDisconnect.addListener(() => {
      if (downloadPorts.has(job.id)) {
        const detail = chrome.runtime.lastError?.message;
        finishDownloadJob(job, 'error', { error: detail
          ? `Download helper disconnected: ${detail}` : 'Download helper disconnected before the download finished.' });
      }
    });
    nativePort.postMessage({ action: 'download', platform, videoId: id,
      ...(platform === 'youtube' ? { format: message.format } : { kind }) });
    publishDownloadJob(job, true);
    return { success: true, jobId: job.id };
  } catch (error) {
    if (nativePort) downloadPorts.set(job.id, nativePort);
    else downloadPorts.set(job.id, null);
    finishDownloadJob(job, 'error', { error: `Download helper unavailable: ${error.message || 'connection failed'}` });
    return { success: false, error: job.error };
  }
}

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

function youtubeVideoIdFromPage(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (parsed.protocol !== 'https:' ||
        (host !== 'youtube.com' && !host.endsWith('.youtube.com'))) return null;
    const id = parsed.pathname === '/watch'
      ? parsed.searchParams.get('v')
      : parsed.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1];
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
  } catch (_) { return null; }
}

function isTikTokPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'tiktok.com' || parsed.hostname.endsWith('.tiktok.com'));
  } catch (_) { return false; }
}

function tiktokVideoIdFromPage(url) {
  if (!isTikTokPage(url)) return null;
  try {
    return new URL(url).pathname.match(/^\/@[^/]+\/video\/(\d{15,22})(?:\/|$)/)?.[1] || null;
  } catch (_) { return null; }
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
  for (const job of downloadJobs) {
    if (job.tabId === tabId) job.tabId = null;
  }
});

// ── Message handler ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.action === 'startYoutubeDownload') {
    startDownloadJob(msg, sender, 'youtube').then(reply).catch((error) =>
      reply({ success: false, error: error.message || 'Could not start the YouTube download.' }));
    return true;
  }

  if (msg?.action === 'startTikTokDownload') {
    startDownloadJob(msg, sender, 'tiktok').then(reply).catch((error) =>
      reply({ success: false, error: error.message || 'Could not start the TikTok download.' }));
    return true;
  }

  if (msg?.action === 'getDownloadJobs' || msg?.action === 'getYoutubeJobs') {
    downloadReady.then(() => reply({ jobs: downloadJobs.map(publicDownloadJob) }));
    return true;
  }

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

// Format discovery belongs to the page. Downloads belong to the service worker:
// a tab closing must not disconnect the native host while it writes a file.
chrome.runtime.onConnect?.addListener((port) => {
  if (port.name !== 'fbdl-youtube') return;
  const pageVideoId = youtubeVideoIdFromPage(port.sender?.url);
  let nativePort = null;
  let requested = false;
  let finished = false;
  let isFormatRequest = false;

  function send(message) {
    try { port.postMessage(message); } catch (_) {}
  }

  port.onMessage.addListener((message) => {
    if (requested) return;
    requested = true;
    if (!pageVideoId || message?.videoId !== pageVideoId ||
        !['formats', 'download'].includes(message.action)) {
      finished = true;
      send({ type: 'error', error: 'Invalid YouTube video or format.' });
      return;
    }
    if (message.action === 'download') {
      // Content scripts already open before an extension reload can still start
      // a job. Their port observes results but no longer owns the download.
      startDownloadJob(message, port.sender, 'youtube', port).then((result) => {
        if (!result.success) send({ type: 'error', error: result.error });
      }).catch((error) => send({ type: 'error', error: error.message }));
      return;
    }
    isFormatRequest = true;
    try {
      nativePort = chrome.runtime.connectNative(DOWNLOAD_HOST);
      nativePort.onMessage.addListener((response) => {
        if (finished) return;
        if (['formats', 'error'].includes(response?.type)) finished = true;
        send(response);
      });
      nativePort.onDisconnect.addListener(() => {
        if (!finished) {
          const detail = chrome.runtime.lastError?.message;
          finished = true;
          send({ type: 'error', error: detail
            ? `YouTube helper unavailable: ${detail}`
            : 'YouTube helper unavailable. See the setup steps in README.md.' });
        }
      });
      nativePort.postMessage({ action: 'formats', videoId: pageVideoId });
    } catch (error) {
      finished = true;
      send({ type: 'error', error: `YouTube helper unavailable: ${error.message || 'connection failed'}` });
    }
  });

  port.onDisconnect.addListener(() => {
    if (isFormatRequest) {
      try { nativePort?.disconnect(); } catch (_) {}
    }
    // A legacy page may disconnect while its background job is running.
    for (const job of downloadJobs) {
      if (job.legacyPort === port) job.legacyPort = null;
    }
  });
});

/* ===== FB Video Downloader — Page-context script (MAIN world) =====
   Intercepts fetch / XHR to capture Facebook video source URLs and
   exposes them to the content-script via window.postMessage.           */

(function () {
  'use strict';

  const TAG = '[FBDL-inject]';

  // Store: array of { hd, sd, videoId, ts }
  const store = [];

  // ── Helpers ──────────────────────────────────────────────────
  function cleanUrl(raw) {
    if (!raw) return null;
    let u = raw
      .replace(/\\\//g, '/')
      .replace(/\\\\u0025/g, '%')
      .replace(/\\u0025/g, '%')
      .replace(/&amp;/g, '&');
    u = u.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
    // Remove trailing backslashes
    u = u.replace(/\\+$/, '');
    try { new URL(u); return u; } catch { return null; }
  }

  // ── All regex patterns we look for ─────────────────────────
  const HD_PATTERNS = [
    /"playable_url_quality_hd"\s*:\s*"(https?[^"]+)"/g,
    /"browser_native_hd_url"\s*:\s*"(https?[^"]+)"/g,
    /"hd_src"\s*:\s*"(https?[^"]+)"/g,
    /"hd_src_no_ratelimit"\s*:\s*"(https?[^"]+)"/g,
  ];
  const SD_PATTERNS = [
    /"playable_url"\s*:\s*"(https?[^"]+)"/g,
    /"browser_native_sd_url"\s*:\s*"(https?[^"]+)"/g,
    /"sd_src"\s*:\s*"(https?[^"]+)"/g,
    /"sd_src_no_ratelimit"\s*:\s*"(https?[^"]+)"/g,
    /"progressive_url"\s*:\s*"(https?[^"]+)"/g,
  ];
  // Generic patterns for any video URL in JSON
  const GENERIC_PATTERNS = [
    /"base_url"\s*:\s*"(https?:\/\/[^"]*?fbcdn\.net[^"]*?\.mp4[^"]*)"/g,
    /"url"\s*:\s*"(https?:\/\/[^"]*?fbcdn\.net[^"]*?video[^"]*)"/g,
    /"src"\s*:\s*"(https?:\/\/[^"]*?fbcdn\.net[^"]*?\.mp4[^"]*)"/g,
  ];

  function extractVideos(text) {
    const results = [];
    const idRe = /"video_id"\s*:\s*"(\d+)"/g;
    const altIdRe = /"videoId"\s*:\s*"(\d+)"/g;

    // Collect all video IDs with positions
    const ids = [];
    let m;
    while ((m = idRe.exec(text)) !== null) ids.push({ id: m[1], pos: m.index });
    while ((m = altIdRe.exec(text)) !== null) ids.push({ id: m[1], pos: m.index });

    // Collect all URLs
    const allUrls = [];
    for (const re of HD_PATTERNS) {
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const u = cleanUrl(m[1]);
        if (u) allUrls.push({ url: u, pos: m.index, quality: 'hd' });
      }
    }
    for (const re of SD_PATTERNS) {
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const u = cleanUrl(m[1]);
        if (u) allUrls.push({ url: u, pos: m.index, quality: 'sd' });
      }
    }
    for (const re of GENERIC_PATTERNS) {
      re.lastIndex = 0;
      while ((m = re.exec(text)) !== null) {
        const u = cleanUrl(m[1]);
        if (u) allUrls.push({ url: u, pos: m.index, quality: 'sd' });
      }
    }

    // Also look for progressive array entries (Facebook DASH player)
    const progRe = /"progressive"\s*:\s*\[([\s\S]*?)\]/g;
    while ((m = progRe.exec(text)) !== null) {
      const block = m[1];
      const urlRe = /"url"\s*:\s*"(https?[^"]+)"/g;
      const qualRe = /"quality"\s*:\s*"(\w+)"/g;
      let um, qm;
      const blockUrls = [];
      while ((um = urlRe.exec(block)) !== null) {
        const u = cleanUrl(um[1]);
        if (u) blockUrls.push({ url: u, pos: m.index });
      }
      while ((qm = qualRe.exec(block)) !== null) {
        const idx = blockUrls.findIndex((bu) => Math.abs(bu.pos - m.index) < block.length);
        // just add them all
      }
      // Last entry in progressive array is usually highest quality
      for (const bu of blockUrls) {
        allUrls.push({ ...bu, quality: 'sd' });
      }
      if (blockUrls.length > 0) {
        allUrls.push({ ...blockUrls[blockUrls.length - 1], quality: 'hd' });
      }
    }

    if (allUrls.length === 0) return results;

    // Group by nearest video_id
    const groups = new Map();
    for (const entry of allUrls) {
      let bestId = null;
      let bestDist = Infinity;
      for (const { id, pos } of ids) {
        const dist = Math.abs(entry.pos - pos);
        if (dist < bestDist) { bestDist = dist; bestId = id; }
      }
      const key = bestId || ('auto_' + Math.floor(entry.pos / 5000));
      if (!groups.has(key)) groups.set(key, { hd: null, sd: null, videoId: bestId });
      const g = groups.get(key);
      if (entry.quality === 'hd' && !g.hd) g.hd = entry.url;
      if (entry.quality === 'sd' && !g.sd) g.sd = entry.url;
    }

    for (const g of groups.values()) {
      if (g.hd || g.sd) results.push({ ...g, ts: Date.now() });
    }
    return results;
  }

  function ingest(text) {
    if (!text || text.length < 50) return;
    // Broad check — look for any sign of video data
    if (
      !text.includes('playable_url') &&
      !text.includes('browser_native') &&
      !text.includes('hd_src') &&
      !text.includes('sd_src') &&
      !text.includes('progressive') &&
      !text.includes('video_id') &&
      !text.includes('.mp4')
    ) return;

    const vids = extractVideos(text);
    for (const v of vids) store.push(v);
    if (store.length > 300) store.splice(0, store.length - 300);
    if (vids.length) {
      console.log(TAG, 'captured', vids.length, 'video URLs, store size:', store.length);
      window.postMessage({ type: 'FBDL_URLS_UPDATED', count: store.length }, '*');
    }
  }

  // ── Intercept fetch ─────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (...a) {
    return _fetch.apply(this, a).then((resp) => {
      try {
        resp.clone().text().then((t) => { try { ingest(t); } catch(_){} }).catch(() => {});
      } catch (_) {}
      return resp;
    }).catch((err) => { throw err; });
  };

  // ── Intercept XHR ──────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...a) {
    this.__url = a[1];
    return _open.apply(this, a);
  };
  XMLHttpRequest.prototype.send = function (...a) {
    this.addEventListener('load', function () {
      try { ingest(this.responseText); } catch (_) {}
    });
    return _send.apply(this, a);
  };

  // ── React-fiber extraction (best-effort) ───────────────────
  function fiberVideoData(el) {
    const key = Object.keys(el).find(
      (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!key) return null;
    let f = el[key], d = 0;
    while (f && d++ < 50) {
      try {
        const p = f.memoizedProps || f.pendingProps || {};
        const hit = dig(p, 4);
        if (hit) return hit;
      } catch (_) {}
      f = f.return;
    }
    return null;
  }

  function dig(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth <= 0) return null;
    // Avoid huge arrays
    if (Array.isArray(obj) && obj.length > 50) return null;
    const hdK = ['playable_url_quality_hd','browser_native_hd_url','hd_src','hdSrc'];
    const sdK = ['playable_url','browser_native_sd_url','sd_src','sdSrc','playableUrl','progressive_url'];
    let hd = null, sd = null, vid = null;
    for (const k of hdK) if (typeof obj[k] === 'string' && obj[k].startsWith('http')) { hd = obj[k]; break; }
    for (const k of sdK) if (typeof obj[k] === 'string' && obj[k].startsWith('http')) { sd = obj[k]; break; }
    for (const k of ['video_id','videoId','videoID','id']) {
      if (obj[k] && /^\d+$/.test(String(obj[k]))) { vid = String(obj[k]); break; }
    }
    if (hd || sd) return { hd, sd, videoId: vid };
    try {
      const keys = Object.keys(obj);
      for (let i = 0; i < Math.min(keys.length, 30); i++) {
        const v = obj[keys[i]];
        if (v && typeof v === 'object') {
          const r = dig(v, depth - 1);
          if (r) return r;
        }
      }
    } catch(_){}
    return null;
  }

  // ── Message handling from content-script ───────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;

    if (e.data.type === 'FBDL_REQUEST_DOWNLOAD') {
      const { requestId, selector } = e.data;
      let result = { hd: null, sd: null };

      try {
        const vid = selector ? document.querySelector(selector) : null;
        if (vid) {
          const fiber = fiberVideoData(vid);
          if (fiber) {
            result.hd = fiber.hd;
            result.sd = fiber.sd;
            if (fiber.videoId) {
              const hit = store.find((s) => s.videoId === fiber.videoId);
              if (hit) { result.hd = result.hd || hit.hd; result.sd = result.sd || hit.sd; }
            }
          }
        }
      } catch (_) {}

      // Fallback: most recent entry
      if (!result.hd && !result.sd && store.length > 0) {
        const last = store[store.length - 1];
        result.hd = last.hd;
        result.sd = last.sd;
      }

      console.log(TAG, 'download request result:', result.hd ? 'HD' : result.sd ? 'SD' : 'NONE');
      window.postMessage({ type: 'FBDL_DOWNLOAD_RESULT', requestId, result }, '*');
    }

    if (e.data.type === 'FBDL_GET_ALL') {
      window.postMessage(
        { type: 'FBDL_ALL_RESULT', requestId: e.data.requestId, videos: store.slice(-30) },
        '*'
      );
    }

    // Ping — used by content script to check if inject.js is alive
    if (e.data.type === 'FBDL_PING') {
      window.postMessage({ type: 'FBDL_PONG' }, '*');
    }
  });

  // ── Initial page scan ─────────────────────────────────────
  function scanPage() {
    console.log(TAG, 'scanning page scripts...');
    let found = 0;
    document.querySelectorAll('script:not([src])').forEach((s) => {
      try {
        const t = s.textContent;
        if (t && t.length > 100) { ingest(t); found++; }
      } catch (_) {}
    });
    console.log(TAG, 'scanned', found, 'scripts, store size:', store.length);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanPage);
  } else {
    setTimeout(scanPage, 500);
  }

  // Re-scan periodically for SPAs
  setInterval(scanPage, 8000);

  console.log(TAG, 'initialized');
})();

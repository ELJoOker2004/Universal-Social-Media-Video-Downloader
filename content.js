/* ===== FB Video Downloader — Content Script ===== */

(function () {
  'use strict';

  const TAG = '[FBDL]';
  const pendingCb = new Map();
  let injectAlive = false;

  // ── Inject.js communication ────────────────────────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'FBDL_PONG') injectAlive = true;
    if (e.data.type === 'FBDL_URLS_UPDATED') injectAlive = true;
    if (e.data.type === 'FBDL_DOWNLOAD_RESULT' || e.data.type === 'FBDL_ALL_RESULT') {
      const cb = pendingCb.get(e.data.requestId);
      if (cb) { pendingCb.delete(e.data.requestId); cb(e.data); }
    }
  });

  // Ping + fallback injection
  setTimeout(() => {
    window.postMessage({ type: 'FBDL_PING' }, '*');
    setTimeout(() => {
      if (!injectAlive) {
        console.log(TAG, 'MAIN world not detected, injecting via script tag');
        try {
          const s = document.createElement('script');
          s.src = chrome.runtime.getURL('inject.js');
          (document.head || document.documentElement).appendChild(s);
          s.onload = () => s.remove();
        } catch (e) { console.warn(TAG, 'fallback inject failed', e); }
      } else {
        console.log(TAG, 'MAIN world inject alive ✓');
      }
    }, 1500);
  }, 1000);

  function askPage(type, extra, timeout = 5000) {
    return new Promise((resolve) => {
      const rid = `r_${Date.now()}_${Math.random()}`;
      const timer = setTimeout(() => { pendingCb.delete(rid); resolve(null); }, timeout);
      pendingCb.set(rid, (data) => { clearTimeout(timer); resolve(data); });
      window.postMessage({ type, requestId: rid, ...extra }, '*');
    });
  }

  // ── SVG icons ──────────────────────────────────────────────
  const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
    viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>`;

  const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
    viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"
    stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>`;

  const CROSS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"
    viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"
    stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`;

  // ── Fixed overlay — lives outside Facebook's DOM tree ──────
  const overlay = document.createElement('div');
  overlay.id = 'fbdl-overlay';
  document.documentElement.appendChild(overlay);

  // Track videos → button elements
  const tracked = new Map(); // video element → { btn, id }
  let idCounter = 0;

  const DEFAULT_BUTTON_TOP_INSET = 8;
  // Facebook places the Reels sound control in the video's top-right corner.
  // Keep the download button in the same corner, but on the next control row.
  const REELS_BUTTON_TOP_INSET = 64;

  function isReelsView() {
    return /\/(?:reel|reels)(?:\/|$)/i.test(window.location.pathname);
  }

  // ── Create download button (fixed position, in overlay) ────
  function createBtn(video) {
    const wrap = document.createElement('div');
    wrap.className = 'fbdl-fixed-wrap';

    const btn = document.createElement('div');
    btn.className = 'fbdl-btn';
    btn.setAttribute('role', 'button');
    btn.setAttribute('title', 'Download this video (HD)');
    btn.innerHTML = ICON_SVG;
    wrap.appendChild(btn);

    // Capture-phase click with aggressive event stopping
    const handler = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      console.log(TAG, 'download button clicked');
      onDownload(video, btn);
      return false;
    };
    btn.addEventListener('click', handler, true);
    btn.addEventListener('mousedown', (ev) => { ev.stopPropagation(); ev.stopImmediatePropagation(); }, true);
    btn.addEventListener('mouseup', (ev) => { ev.stopPropagation(); ev.stopImmediatePropagation(); }, true);
    btn.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); ev.stopImmediatePropagation(); }, true);
    btn.addEventListener('pointerup', (ev) => { ev.stopPropagation(); ev.stopImmediatePropagation(); }, true);

    return wrap;
  }

  // ── Position updater — runs every animation frame ──────────
  function updatePositions() {
    for (const [video, state] of tracked) {
      // Remove if video is gone
      if (!document.contains(video)) {
        state.btn.remove();
        tracked.delete(video);
        continue;
      }
      const r = video.getBoundingClientRect();
      const visible = r.width > 120 && r.height > 80 &&
                      r.bottom > 0 && r.top < window.innerHeight;
      if (visible) {
        const topInset = isReelsView()
          ? REELS_BUTTON_TOP_INSET
          : DEFAULT_BUTTON_TOP_INSET;
        state.btn.style.top = (r.top + topInset) + 'px';
        state.btn.style.left = (r.right - 54) + 'px';
        state.btn.style.display = '';
      } else {
        state.btn.style.display = 'none';
      }
    }
    requestAnimationFrame(updatePositions);
  }
  requestAnimationFrame(updatePositions);

  // ── Video scanner ──────────────────────────────────────────
  function scan() {
    document.querySelectorAll('video').forEach((v) => {
      if (tracked.has(v)) return;
      const r = v.getBoundingClientRect();
      if (r.width < 100 || r.height < 60) return;

      const id = ++idCounter;
      v.setAttribute('data-fbdl-id', id);
      const btn = createBtn(v);
      overlay.appendChild(btn);
      tracked.set(v, { btn, id });
    });
  }

  scan();
  new MutationObserver(scan).observe(document.body || document.documentElement, {
    childList: true, subtree: true,
  });
  setInterval(scan, 2000);

  // ── Page HTML scan (content-script layer) ──────────────────
  function scanPageHtml() {
    const found = { hd: null, sd: null };
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const t = s.textContent;
        if (!t || t.length < 50) continue;
        if (!t.includes('fbcdn.net') && !t.includes('playable_url') && !t.includes('hd_src')) continue;

        const hdP = [/"playable_url_quality_hd"\s*:\s*"(https?[^"]+)"/, /"browser_native_hd_url"\s*:\s*"(https?[^"]+)"/, /"hd_src"\s*:\s*"(https?[^"]+)"/];
        const sdP = [/"playable_url"\s*:\s*"(https?[^"]+)"/, /"browser_native_sd_url"\s*:\s*"(https?[^"]+)"/, /"sd_src"\s*:\s*"(https?[^"]+)"/];

        for (const p of hdP) { const m = t.match(p); if (m && !found.hd) found.hd = cleanUrl(m[1]); }
        for (const p of sdP) { const m = t.match(p); if (m && !found.sd) found.sd = cleanUrl(m[1]); }
        if (found.hd && found.sd) break;
      }
    } catch (_) {}
    return found;
  }

  function cleanUrl(raw) {
    if (!raw) return null;
    let u = raw.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    u = u.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    try { new URL(u); return u; } catch { return null; }
  }

  // ── Download logic (4 layers) ──────────────────────────────
  async function onDownload(video, btn) {
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.classList.add('fbdl-loading');

    let url = null;

    // Layer 1 — Direct src
    url = directSrc(video);
    if (url) console.log(TAG, 'L1: direct src');

    // Layer 2 — inject.js (React fiber + intercepted store)
    if (!url) {
      const tag = video.getAttribute('data-fbdl-id') || 'v' + Date.now();
      video.setAttribute('data-fbdl', tag);
      const resp = await askPage('FBDL_REQUEST_DOWNLOAD', { selector: `video[data-fbdl="${tag}"]` });
      if (resp?.result) {
        url = resp.result.hd || resp.result.sd;
        if (url) console.log(TAG, 'L2: inject.js', resp.result.hd ? 'HD' : 'SD');
      }
    }

    // Layer 3 — Background CDN intercept
    if (!url) {
      try {
        const bgResp = await new Promise((res) => chrome.runtime.sendMessage({ action: 'getVideoUrls' }, res));
        if (bgResp?.urls?.length) { url = bgResp.urls[0]; console.log(TAG, 'L3: background CDN'); }
      } catch (_) {}
    }

    // Layer 4 — Scan page HTML
    if (!url) {
      const scraped = scanPageHtml();
      url = scraped.hd || scraped.sd;
      if (url) console.log(TAG, 'L4: page HTML');
    }

    if (!url) { console.warn(TAG, 'no URL found'); showResult(btn, false); return; }
    console.log(TAG, 'downloading:', url.substring(0, 100));

    // Download attempt 1: chrome.downloads API
    let ok = false;
    try {
      const r = await new Promise((res) => chrome.runtime.sendMessage({ action: 'download', url }, res));
      ok = !!r?.success;
    } catch (_) {}

    // Download attempt 2: anchor click
    if (!ok) {
      try {
        const a = document.createElement('a');
        a.href = url; a.download = `FB_Video_${Date.now()}.mp4`;
        a.style.display = 'none'; document.body.appendChild(a);
        a.click(); setTimeout(() => a.remove(), 500);
        ok = true;
      } catch (_) {}
    }

    // Download attempt 3: new tab
    if (!ok) { try { window.open(url, '_blank'); ok = true; } catch (_) {} }

    showResult(btn, ok);
  }

  function directSrc(video) {
    for (const s of [video.src, video.currentSrc]) {
      if (s && !s.startsWith('blob:') && s.startsWith('http')) return s;
    }
    return null;
  }

  function showResult(btn, ok) {
    btn.classList.remove('fbdl-loading');
    btn.dataset.busy = '0';
    if (ok) {
      btn.classList.add('fbdl-success'); btn.innerHTML = CHECK_SVG;
      setTimeout(() => { btn.classList.remove('fbdl-success'); btn.innerHTML = ICON_SVG; }, 2500);
    } else {
      btn.classList.add('fbdl-error'); btn.innerHTML = CROSS_SVG;
      setTimeout(() => { btn.classList.remove('fbdl-error'); btn.innerHTML = ICON_SVG; }, 2500);
    }
  }

  console.log(TAG, 'content script initialized');
})();

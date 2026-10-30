/* Add a download control to Instagram post, Reel and story videos. */
(function () {
  'use strict';

  const DOWNLOAD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ERROR_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const pending = new Map();
  const tracked = new Map();

  function validMp4(url) {
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

  function shortcode(url) {
    return String(url || '').match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,20})(?:[/?#]|$)/)?.[1] || null;
  }

  function visible(video) {
    const rect = video.getBoundingClientRect();
    return rect.width > 120 && rect.height > 80 && rect.bottom > 0 &&
      rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  }

  function videoContext(video) {
    const article = video.closest('article');
    const dialog = video.closest('[role="dialog"]');
    const container = article || dialog;
    const ownLink = video.closest('a[href*="/reel/"], a[href*="/p/"], a[href*="/tv/"]');
    const permalink = article?.querySelector('time')?.closest('a');
    let code = shortcode(ownLink?.getAttribute('href')) || shortcode(permalink?.getAttribute('href'));
    if (!code && container) {
      const codes = new Set([...container.querySelectorAll('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]')]
        .map((link) => shortcode(link.getAttribute('href'))).filter(Boolean));
      if (codes.size === 1) code = [...codes][0];
    }
    const videos = container ? [...container.querySelectorAll('video')] : [...document.querySelectorAll('video')].filter(visible);
    const singleVideo = videos.length === 1;
    if (!code && singleVideo && (dialog || !article)) code = shortcode(location.pathname);
    const storyId = location.pathname.match(/^\/stories\/[^/]+\/(\d{5,})(?:\/|$)/)?.[1] || null;
    return { code, storyId, singleVideo };
  }

  function postersNear(video) {
    const urls = [video.poster, video.getAttribute('poster')];
    video.parentElement?.querySelectorAll('img').forEach((image, index) => {
      if (index < 5) urls.push(image.currentSrc, image.src);
    });
    return [...new Set(urls.filter(Boolean))];
  }

  function askPage(posters, code, storyId, singleVideo, duration) {
    return new Promise((resolve) => {
      const requestId = `ig_${Date.now()}_${Math.random()}`;
      const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, 3000);
      pending.set(requestId, (url) => { clearTimeout(timer); resolve(url); });
      window.postMessage({ type: 'FBDL_IG_GET_VIDEO', requestId, posters, code, storyId, singleVideo, duration }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'FBDL_IG_VIDEO_RESULT') return;
    const callback = pending.get(event.data.requestId);
    if (callback) {
      pending.delete(event.data.requestId);
      callback(event.data.url);
    }
  });

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => resolve(chrome.runtime.lastError ? null : reply));
      } catch (_) { resolve(null); }
    });
  }

  function showResult(button, success, error) {
    button.disabled = false;
    button.classList.remove('fbdl-loading');
    button.classList.add(success ? 'fbdl-success' : 'fbdl-error');
    button.innerHTML = success ? CHECK_ICON : ERROR_ICON;
    button.title = success ? 'Download started' : (error || 'No downloadable MP4 found for this video');
    setTimeout(() => {
      button.classList.remove('fbdl-success', 'fbdl-error');
      button.innerHTML = DOWNLOAD_ICON;
      button.title = 'Download this Instagram video';
    }, 3000);
  }

  async function download(video, button) {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('fbdl-loading');
    const { code, storyId, singleVideo } = videoContext(video);
    let url = await askPage(postersNear(video), code, storyId, singleVideo, video.duration);
    if (!validMp4(url)) url = null;
    if (!url) url = [video.currentSrc, video.src].find(validMp4) || null;
    if (!url && singleVideo && code && shortcode(location.pathname) === code) {
      url = [...document.querySelectorAll('meta[property="og:video"], meta[property="og:video:secure_url"]')]
        .map((meta) => meta.content).find(validMp4) || null;
    }
    if (!url) { showResult(button, false); return; }
    const response = await sendMessage({ action: 'download', platform: 'instagram', url, shortcode: code });
    showResult(button, !!response?.success, response?.error || 'Download failed');
  }

  const overlay = document.createElement('div');
  overlay.id = 'fbdl-overlay';
  overlay.dataset.platform = 'instagram';
  document.documentElement.appendChild(overlay);

  function scan() {
    document.querySelectorAll('video').forEach((video) => {
      if (tracked.has(video)) return;
      const rect = video.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 60) return;
      const wrap = document.createElement('div');
      wrap.className = 'fbdl-fixed-wrap';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fbdl-btn';
      button.setAttribute('aria-label', 'Download this Instagram video');
      button.title = 'Download this Instagram video';
      button.innerHTML = DOWNLOAD_ICON;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        download(video, button);
      }, true);
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
        button.addEventListener(type, (event) => event.stopPropagation(), true);
      }
      wrap.appendChild(button);
      overlay.appendChild(wrap);
      tracked.set(video, wrap);
    });
  }

  function updatePositions() {
    for (const [video, wrap] of tracked) {
      if (!document.contains(video)) {
        wrap.remove();
        tracked.delete(video);
        continue;
      }
      const rect = video.getBoundingClientRect();
      const inView = visible(video);
      wrap.style.display = inView ? '' : 'none';
      if (inView) {
        const inset = /^\/(?:reel|reels|stories)\//.test(location.pathname) ? 64 : 8;
        wrap.style.top = `${Math.max(8, rect.top + inset)}px`;
        wrap.style.left = `${Math.min(innerWidth - 50, Math.max(8, rect.right - 50))}px`;
      }
    }
    requestAnimationFrame(updatePositions);
  }

  scan();
  new MutationObserver(scan).observe(document.body || document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 2000);
  requestAnimationFrame(updatePositions);
})();

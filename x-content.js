/* Add a download control to videos on X and legacy twitter.com pages. */
(function () {
  'use strict';

  const DOWNLOAD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ERROR_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const pending = new Map();
  const tracked = new Map();

  function mediaIdFromUrl(url) {
    const match = String(url || '').match(/\/(?:ext_tw_video|amplify_video|tweet_video|dm_video)(?:_thumb)?\/(\d{5,})(?:\/|$)/i);
    return match ? match[1] : null;
  }

  function validMp4(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' &&
        (parsed.hostname === 'video.twimg.com' || parsed.hostname === 'video-s.twimg.com') &&
        parsed.pathname.toLowerCase().endsWith('.mp4');
    } catch (_) { return false; }
  }

  function statusId(href) {
    return String(href || '').match(/\/status\/(\d{5,})(?:[/?#]|$)/)?.[1] || null;
  }

  function tweetContext(video) {
    const article = video.closest('article');
    let tweetId = statusId(article?.querySelector('time')?.closest('a')?.getAttribute('href'));
    if (!tweetId && article) {
      const ids = new Set([...article.querySelectorAll('a[href*="/status/"]')]
        .map((link) => statusId(link.getAttribute('href'))).filter(Boolean));
      if (ids.size === 1) tweetId = [...ids][0];
    }
    if (!tweetId && !article) tweetId = statusId(location.pathname);
    return { tweetId, singleVideo: !article || article.querySelectorAll('video').length === 1 };
  }

  function askPage(poster, tweetId, singleVideo) {
    return new Promise((resolve) => {
      const requestId = `x_${Date.now()}_${Math.random()}`;
      const timer = setTimeout(() => { pending.delete(requestId); resolve(null); }, 3000);
      pending.set(requestId, (url) => { clearTimeout(timer); resolve(url); });
      window.postMessage({ type: 'FBDL_X_GET_VIDEO', requestId, poster, tweetId, singleVideo }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'FBDL_X_VIDEO_RESULT') return;
    const callback = pending.get(event.data.requestId);
    if (callback) {
      pending.delete(event.data.requestId);
      callback(event.data.url);
    }
  });

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          resolve(chrome.runtime.lastError ? null : reply);
        });
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
      button.title = 'Download this X video';
    }, 3000);
  }

  async function download(video, button) {
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('fbdl-loading');
    const poster = video.poster || video.getAttribute('poster') || '';
    const { tweetId, singleVideo } = tweetContext(video);

    // X's own media metadata contains the full MP4 rendition ladder. Its highest
    // bitrate MP4 takes precedence over the stream currently playing in the tab.
    let url = await askPage(poster, tweetId, singleVideo);
    if (!validMp4(url)) url = null;
    if (!url) url = [video.currentSrc, video.src].find(validMp4) || null;
    if (!url) {
      const mediaId = mediaIdFromUrl(poster);
      if (mediaId) {
        const response = await sendMessage({ action: 'getXVideoUrls', mediaId });
        url = response?.urls?.find(validMp4) || null;
      }
    }
    if (!url) { showResult(button, false); return; }

    const response = await sendMessage({ action: 'download', platform: 'x', url, tweetId });
    showResult(button, !!response?.success, response?.error || 'Download failed');
  }

  const overlay = document.createElement('div');
  overlay.id = 'fbdl-overlay';
  overlay.dataset.platform = 'x';
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
      button.setAttribute('aria-label', 'Download this X video');
      button.title = 'Download this X video';
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
      const visible = rect.width > 120 && rect.height > 80 && rect.bottom > 0 &&
        rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      wrap.style.display = visible ? '' : 'none';
      if (visible) {
        wrap.style.top = `${Math.max(8, rect.top + 8)}px`;
        wrap.style.left = `${Math.min(innerWidth - 50, rect.right - 50)}px`;
      }
    }
    requestAnimationFrame(updatePositions);
  }

  scan();
  new MutationObserver(scan).observe(document.body || document.documentElement, { childList: true, subtree: true });
  setInterval(scan, 2000);
  requestAnimationFrame(updatePositions);
})();

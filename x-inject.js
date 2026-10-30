/* X page context: collect the MP4 variants already returned to X's own player. */
(function () {
  'use strict';

  if (window.__fbdlXInstalled) return;
  window.__fbdlXInstalled = true;

  const media = [];
  const MAX_MEDIA = 300;

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

  function posterKey(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname === 'pbs.twimg.com' ? parsed.origin + parsed.pathname.replace(/:(?:small|medium|large|orig)$/, '') : null;
    } catch (_) { return null; }
  }

  function addMedia(item, tweetId) {
    const variants = item.video_info?.variants || item.variants;
    if (!Array.isArray(variants)) return;
    const best = variants
      .filter((variant) => (variant.content_type || variant.type) === 'video/mp4' && validMp4(variant.url || variant.src))
      .sort((a, b) => (Number(b.bitrate ?? b.bit_rate) || 0) - (Number(a.bitrate ?? a.bit_rate) || 0))[0];
    if (!best) return;

    const url = best.url || best.src;
    const rawId = String(item.id_str || item.media_key || '');
    const mediaId = /^\d{5,}$/.test(rawId) ? rawId : rawId.match(/_(\d{5,})$/)?.[1] || mediaIdFromUrl(url);
    const poster = posterKey(item.media_url_https || item.preview_image_url || item.poster_url);
    const bitrate = Number(best.bitrate ?? best.bit_rate) || 0;
    const id = /^\d{5,}$/.test(String(tweetId || '')) ? String(tweetId) : null;
    const existing = media.find((entry) => entry.tweetId === id &&
      ((mediaId && entry.mediaId === mediaId) || (!mediaId && entry.url === url)));
    if (existing) {
      if (bitrate >= existing.bitrate) Object.assign(existing, { url, bitrate, poster: poster || existing.poster, ts: Date.now() });
      return;
    }

    media.push({ url, bitrate, mediaId, poster, tweetId: id, ts: Date.now() });
    if (media.length > MAX_MEDIA) media.splice(0, media.length - MAX_MEDIA);
  }

  function ingest(payload) {
    const seen = new WeakSet();
    const stack = [{ value: payload, tweetId: null }];
    let visited = 0;
    while (stack.length && visited++ < 50000) {
      const { value, tweetId } = stack.pop();
      if (typeof value === 'string') {
        // X cards can contain a JSON string nested in a GraphQL response.
        if (value.length < 500000 && value.startsWith('{') && value.includes('variants')) {
          try { stack.push({ value: JSON.parse(value), tweetId }); } catch (_) {}
        }
        continue;
      }
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);

      let currentTweetId = tweetId;
      if ((value.legacy || value.extended_entities || value.attachments) &&
          /^\d{5,}$/.test(String(value.rest_id || value.id_str || ''))) {
        currentTweetId = String(value.rest_id || value.id_str);
      }
      addMedia(value, currentTweetId);
      for (const child of Object.values(value)) stack.push({ value: child, tweetId: currentTweetId });
    }
  }

  function ingestText(text) {
    if (!text || text.length > 10000000 || !text.includes('variants')) return;
    try { ingest(JSON.parse(text)); } catch (_) {}
  }

  function isXApi(url) {
    try {
      const parsed = new URL(url, location.href);
      return (parsed.hostname === 'x.com' || parsed.hostname.endsWith('.x.com') ||
        parsed.hostname === 'twitter.com' || parsed.hostname.endsWith('.twitter.com')) &&
        (parsed.pathname.startsWith('/i/api/') || parsed.pathname.startsWith('/graphql/') ||
          parsed.pathname.startsWith('/2/'));
    } catch (_) { return false; }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    return originalFetch.apply(this, args).then((response) => {
      if (isXApi(requestUrl) && response.ok &&
          (response.headers?.get('content-type') || '').includes('json')) {
        try { response.clone().text().then(ingestText).catch(() => {}); } catch (_) {}
      }
      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...args) {
    this.__fbdlXUrl = args[1];
    return originalOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isXApi(this.__fbdlXUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType === 'json') ingest(this.response);
          else if (!this.responseType || this.responseType === 'text') ingestText(this.responseText);
        } catch (_) {}
      });
    }
    return originalSend.apply(this, args);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'FBDL_X_GET_VIDEO') return;
    const { requestId, poster, tweetId, singleVideo } = event.data;
    if (typeof requestId !== 'string') return;
    const wantedId = mediaIdFromUrl(poster);
    const wantedPoster = posterKey(poster);
    let candidates = wantedId ? media.filter((entry) => entry.mediaId === wantedId) : [];
    if (!candidates.length && wantedPoster) candidates = media.filter((entry) => entry.poster === wantedPoster);

    if (!candidates.length && singleVideo && /^\d{5,}$/.test(String(tweetId || ''))) {
      const tweetMedia = media.filter((entry) => entry.tweetId === tweetId);
      const uniqueIds = new Set(tweetMedia.map((entry) => entry.mediaId || entry.url));
      if (uniqueIds.size === 1) candidates = tweetMedia;
    }
    candidates.sort((a, b) => b.bitrate - a.bitrate || b.ts - a.ts);
    window.postMessage({ type: 'FBDL_X_VIDEO_RESULT', requestId, url: candidates[0]?.url || null }, '*');
  });

  // Some X pages hydrate the first post from JSON script tags before the fetch hook runs.
  function scanInitialScripts() {
    document.querySelectorAll('script[type="application/json"]').forEach((script) => ingestText(script.textContent));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanInitialScripts, { once: true });
  else scanInitialScripts();
})();

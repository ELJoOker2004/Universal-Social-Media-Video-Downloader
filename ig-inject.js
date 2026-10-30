/* Instagram page context: read progressive MP4 URLs from loaded post data. */
(function () {
  'use strict';

  if (window.__fbdlInstagramInstalled) return;
  window.__fbdlInstagramInstalled = true;

  const media = [];
  const scannedScripts = new WeakSet();
  const MAX_MEDIA = 300;

  function cleanUrl(raw) {
    return typeof raw === 'string' ? raw.replace(/&amp;/g, '&').replace(/\\+u0026/gi, '&').replace(/\\\//g, '/') : null;
  }

  function validMp4(url) {
    try {
      const parsed = new URL(cleanUrl(url));
      const host = parsed.hostname;
      return parsed.protocol === 'https:' &&
        (host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') ||
          host === 'fbcdn.net' || host.endsWith('.fbcdn.net')) &&
        parsed.pathname.toLowerCase().endsWith('.mp4') &&
        !parsed.searchParams.has('bytestart') && !parsed.searchParams.has('byteend');
    } catch (_) { return false; }
  }

  function posterKey(url) {
    try {
      const parsed = new URL(cleanUrl(url));
      return parsed.protocol === 'https:' ? parsed.origin + parsed.pathname : null;
    } catch (_) { return null; }
  }

  function shortcode(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{5,20}$/.test(value) ? value : null;
  }

  function mediaId(value) {
    return String(value || '').match(/^(\d{5,})(?:_|$)/)?.[1] || null;
  }

  function addMedia(item, inheritedCode) {
    const versions = Array.isArray(item.video_versions) ? item.video_versions : [];
    const candidates = versions
      .filter((version) => validMp4(version.url))
      .map((version) => ({
        url: cleanUrl(version.url),
        pixels: (Number(version.width) || 0) * (Number(version.height) || 0),
        bandwidth: Number(version.bandwidth || version.bitrate) || 0,
      }));
    if (validMp4(item.video_url)) candidates.push({ url: cleanUrl(item.video_url), pixels: 0, bandwidth: 0 });
    if (!candidates.length) return;
    candidates.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth);
    const best = candidates[0];

    const code = shortcode(item.code) || shortcode(item.shortcode) || inheritedCode;
    const id = mediaId(item.pk || item.id || item.id_str);
    const posters = [item.display_url, item.thumbnail_src, item.video_cover_image_url,
      ...(item.image_versions2?.candidates || []).map((candidate) => candidate.url)]
      .map(posterKey).filter(Boolean);
    const duration = Number(item.video_duration || item.duration) || 0;
    const existing = media.find((entry) => (id && entry.id === id) ||
      (code && entry.code === code && posters.some((poster) => entry.posters.includes(poster))) ||
      (!id && !posters.length && entry.url === best.url));
    if (existing) {
      if (best.pixels >= existing.pixels || existing.url === best.url) {
        Object.assign(existing, { url: best.url, pixels: best.pixels, bandwidth: best.bandwidth, ts: Date.now() });
      }
      existing.code = code || existing.code;
      existing.duration = duration || existing.duration;
      existing.posters = [...new Set([...existing.posters, ...posters])];
      return;
    }
    media.push({ url: best.url, pixels: best.pixels, bandwidth: best.bandwidth,
      code, id, posters, duration, ts: Date.now() });
    if (media.length > MAX_MEDIA) media.splice(0, media.length - MAX_MEDIA);
  }

  function ingest(payload) {
    const seen = new WeakSet();
    const stack = [{ value: payload, code: null }];
    let visited = 0;
    while (stack.length && visited++ < 80000) {
      const { value, code } = stack.pop();
      if (typeof value === 'string') {
        if (value.length < 1000000 && /^[\[{]/.test(value) &&
            (value.includes('video_versions') || value.includes('video_url'))) {
          try { stack.push({ value: JSON.parse(value), code }); } catch (_) {}
        }
        continue;
      }
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      const currentCode = shortcode(value.code) || shortcode(value.shortcode) || code;
      addMedia(value, currentCode);
      for (const child of Object.values(value)) stack.push({ value: child, code: currentCode });
    }
  }

  function ingestText(text) {
    if (!text || text.length > 20000000 ||
        (!text.includes('video_versions') && !text.includes('video_url'))) return;
    const body = text.startsWith('for (;;);') ? text.slice(9) : text;
    try { ingest(JSON.parse(body)); } catch (_) {}
  }

  function isMediaApi(url) {
    try {
      const parsed = new URL(url, location.href);
      return (parsed.hostname === 'instagram.com' || parsed.hostname.endsWith('.instagram.com')) &&
        /^\/(?:graphql|api|ajax)\//.test(parsed.pathname);
    } catch (_) { return false; }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    return originalFetch.apply(this, args).then((response) => {
      if (isMediaApi(requestUrl) && response.ok) {
        try { response.clone().text().then(ingestText).catch(() => {}); } catch (_) {}
      }
      return response;
    });
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...args) {
    this.__fbdlInstagramUrl = args[1];
    return originalOpen.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isMediaApi(this.__fbdlInstagramUrl)) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType === 'json') ingest(this.response);
          else if (!this.responseType || this.responseType === 'text') ingestText(this.responseText);
        } catch (_) {}
      });
    }
    return originalSend.apply(this, args);
  };

  function scanScripts() {
    document.querySelectorAll('script:not([src])').forEach((script) => {
      if (scannedScripts.has(script)) return;
      const text = script.textContent;
      if (!text) return;
      scannedScripts.add(script);
      if (!text.includes('video_versions') && !text.includes('video_url')) return;
      if (script.type === 'application/json' || /^[\[{]/.test(text)) {
        ingestText(text);
        return;
      }
      // Older pages can wrap the same JSON in a ScheduledServerJS.handle call.
      const marker = 'ScheduledServerJS.handle(';
      const start = text.indexOf(marker);
      if (start < 0) return;
      const first = text.indexOf('{', start + marker.length);
      if (first < 0) return;
      let depth = 0, quoted = false, escaped = false;
      for (let i = first; i < text.length; i++) {
        const char = text[i];
        if (escaped) { escaped = false; continue; }
        if (quoted && char === '\\') { escaped = true; continue; }
        if (char === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        if (char === '{') depth++;
        if (char === '}' && --depth === 0) { ingestText(text.slice(first, i + 1)); break; }
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scanScripts, { once: true });
  else scanScripts();
  setInterval(scanScripts, 5000);

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'FBDL_IG_GET_VIDEO') return;
    const { requestId, posters, code, storyId, singleVideo, duration } = event.data;
    if (typeof requestId !== 'string') return;
    const wantedPosters = new Set((Array.isArray(posters) ? posters : []).map(posterKey).filter(Boolean));
    let candidates = media.filter((entry) => entry.posters.some((poster) => wantedPosters.has(poster)));
    if (!candidates.length && /^\d{5,}$/.test(String(storyId || ''))) {
      candidates = media.filter((entry) => entry.id === storyId);
    }
    if (!candidates.length && singleVideo && shortcode(code)) {
      const postMedia = media.filter((entry) => entry.code === code);
      const distinct = new Set(postMedia.map((entry) => entry.id || entry.url));
      if (distinct.size === 1) candidates = postMedia;
      else if (Number(duration) > 0) {
        const byDuration = postMedia.filter((entry) => entry.duration > 0 && Math.abs(entry.duration - duration) < 0.5);
        if (new Set(byDuration.map((entry) => entry.id || entry.url)).size === 1) candidates = byDuration;
      }
    }
    candidates.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth || b.ts - a.ts);
    window.postMessage({ type: 'FBDL_IG_VIDEO_RESULT', requestId, url: candidates[0]?.url || null }, '*');
  });
})();

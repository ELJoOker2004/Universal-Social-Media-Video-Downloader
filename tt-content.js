/* TikTok video and sound buttons. The background worker owns the native download. */
(function () {
  'use strict';

  const DOWNLOAD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const AUDIO_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>`;
  const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  const ERROR_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="7" x2="12" y2="13"/><circle cx="12" cy="17" r="1" fill="#fff" stroke="none"/></svg>`;
  const ACTIVE_STATES = new Set(['preparing', 'downloading', 'finishing']);
  const tracked = new Map();
  const overlay = document.createElement('div');
  overlay.id = 'fbdl-overlay';
  overlay.dataset.platform = 'tiktok';
  document.documentElement.appendChild(overlay);
  let knownJobs = [];

  function pageVideoId() {
    const match = location.pathname.match(/^\/@[^/]+\/video\/(\d{15,22})(?:\/|$)/);
    return match?.[1] || null;
  }

  function videoIdFor(video) {
    const wrapper = video.closest('[id^="xgwrapper-"]');
    const wrapperId = wrapper?.id.match(/^xgwrapper-\d+-(\d{15,22})$/)?.[1] || null;
    const pageId = pageVideoId();
    if (pageId && wrapperId && pageId !== wrapperId) return null;
    if (wrapperId) return wrapperId;
    // A post page with one player is unambiguous even if TikTok changes its wrapper.
    return pageId && document.querySelectorAll('video').length === 1 ? pageId : null;
  }

  function visible(video) {
    const rect = video.getBoundingClientRect();
    const heightOnScreen = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
    return rect.width > 120 && rect.height > 80 &&
      heightOnScreen >= Math.min(80, rect.height * 0.25) &&
      rect.right > 0 && rect.left < innerWidth;
  }

  function sendRequest(request, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish({ success: false, error: 'The extension did not respond.' }), timeoutMs);
      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      }
      try {
        chrome.runtime.sendMessage(request, (response) => {
          finish(chrome.runtime.lastError
            ? { success: false, error: chrome.runtime.lastError.message }
            : response || { success: false, error: 'No response from the extension.' });
        });
      } catch (error) {
        finish({ success: false, error: error.message || 'Could not contact the extension.' });
      }
    });
  }

  function showStatus(entry, text, error = false) {
    entry.panel.hidden = false;
    entry.status.textContent = text;
    entry.status.classList.toggle('fbdl-tt-error', error);
  }

  function idleIcon(kind) { return kind === 'audio' ? AUDIO_ICON : DOWNLOAD_ICON; }
  function idleTitle(kind) { return kind === 'audio'
    ? 'Save full TikTok sound only (M4A; requires FFmpeg)' : 'Download this TikTok video'; }

  function renderJob(entry, job) {
    if (job.platform !== 'tiktok' || job.videoId !== entry.videoId) return;
    if (entry.jobId && entry.jobId !== job.id) return;
    entry.jobId = job.id;
    const active = ACTIVE_STATES.has(job.state);
    const kind = job.kind === 'audio' ? 'audio' : 'video';
    entry.kind = kind;
    entry.busy = active;
    for (const [choice, button] of Object.entries(entry.buttons)) {
      const selected = choice === kind;
      button.disabled = active;
      button.classList.toggle('fbdl-loading', active && selected);
      button.classList.toggle('fbdl-success', selected && job.state === 'complete');
      button.classList.toggle('fbdl-error', selected && job.state === 'error');
      button.innerHTML = selected && job.state === 'complete' ? CHECK_ICON :
        selected && job.state === 'error' ? ERROR_ICON : idleIcon(choice);
      button.title = active && selected ? 'TikTok download in progress' : idleTitle(choice);
    }
    entry.meter.hidden = !active && job.state !== 'complete';
    if (Number.isFinite(job.percent) && job.state !== 'finishing') entry.meter.value = job.percent;
    else if (job.state === 'complete') entry.meter.value = 100;
    else entry.meter.removeAttribute('value');

    if (job.state === 'complete') showStatus(entry, `Saved: ${job.fileName || (kind === 'audio' ? 'TikTok sound' : 'TikTok video')}`);
    else if (job.state === 'error') showStatus(entry, job.error || 'Download failed.', true);
    else if (job.state === 'finishing') showStatus(entry, kind === 'audio' ? 'Extracting full audio…' : 'Finishing the file…');
    else if (job.state === 'downloading') {
      const percent = Number.isFinite(job.percent) ? ` ${job.percent.toFixed(0)}%` : '';
      showStatus(entry, `Downloading TikTok ${kind}${percent}…`);
    } else showStatus(entry, `Preparing TikTok ${kind}…`);

    if (!active) {
      const finishedId = job.id;
      setTimeout(() => {
        if (entry.jobId !== finishedId || !document.contains(entry.wrap)) return;
        entry.panel.hidden = true;
        for (const [choice, button] of Object.entries(entry.buttons)) {
          button.classList.remove('fbdl-success', 'fbdl-error');
          button.innerHTML = idleIcon(choice);
        }
        entry.jobId = null;
      }, 10000);
    }
  }

  async function download(entry, kind) {
    if (entry.busy || !visible(entry.video)) return;
    const id = videoIdFor(entry.video);
    if (!id || id !== entry.videoId) return;
    entry.busy = true;
    entry.jobId = null;
    entry.kind = kind;
    for (const [choice, button] of Object.entries(entry.buttons)) {
      button.disabled = true;
      button.classList.toggle('fbdl-loading', choice === kind);
      button.classList.remove('fbdl-success', 'fbdl-error');
      button.innerHTML = idleIcon(choice);
    }
    entry.meter.hidden = false;
    entry.meter.removeAttribute('value');
    showStatus(entry, `Starting TikTok ${kind} download…`);
    const result = await sendRequest({ action: 'startTikTokDownload', videoId: id, kind });
    if (!result.success) {
      entry.jobId = null;
      renderJob(entry, { platform: 'tiktok', videoId: id, kind, id: `error-${Date.now()}`,
        state: 'error', error: result.error || 'Could not start the download.' });
      return;
    }
    entry.jobId = result.jobId;
    const response = await sendRequest({ action: 'getDownloadJobs' }, 5000);
    const job = Array.isArray(response.jobs) ? response.jobs.find((item) => item.id === result.jobId) : null;
    if (job) renderJob(entry, job);
    else showStatus(entry, 'Download started. Check the toolbar popup for progress.');
  }

  function addButton(video, id) {
    const wrap = document.createElement('div');
    wrap.className = 'fbdl-fixed-wrap';
    wrap.style.display = 'none';
    const actions = document.createElement('div');
    actions.className = 'fbdl-tt-actions';
    actions.setAttribute('role', 'group');
    actions.setAttribute('aria-label', 'TikTok download choices');
    const buttons = {};
    for (const [kind, label] of [
      ['video', 'Download this TikTok video'],
      ['audio', 'Save sound only from this TikTok video'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fbdl-btn';
      button.setAttribute('aria-label', label);
      button.title = idleTitle(kind);
      button.innerHTML = idleIcon(kind);
      buttons[kind] = button;
      actions.appendChild(button);
    }
    const panel = document.createElement('div');
    panel.className = 'fbdl-tt-panel';
    panel.hidden = true;
    const status = document.createElement('p');
    status.className = 'fbdl-tt-status';
    status.setAttribute('role', 'status');
    const meter = document.createElement('progress');
    meter.max = 100;
    meter.hidden = true;
    meter.setAttribute('aria-label', 'TikTok download progress');
    panel.append(status, meter);
    wrap.append(actions, panel);
    overlay.appendChild(wrap);
    const entry = { video, videoId: id, wrap, buttons, panel, status, meter, jobId: null, busy: false };
    for (const [kind, button] of Object.entries(buttons)) {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        download(entry, kind);
      });
    }
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
      wrap.addEventListener(type, (event) => event.stopPropagation());
    }
    const active = knownJobs.find((job) => job.platform === 'tiktok' &&
      job.videoId === id && ACTIVE_STATES.has(job.state));
    if (active) renderJob(entry, active);
    tracked.set(video, entry);
  }

  function scan() {
    for (const [video, entry] of tracked) {
      if (!document.contains(video) || videoIdFor(video) !== entry.videoId) {
        entry.wrap.remove();
        tracked.delete(video);
      }
    }
    document.querySelectorAll('video').forEach((video) => {
      if (tracked.has(video)) return;
      const id = videoIdFor(video);
      if (id) addButton(video, id);
    });
  }

  function position() {
    for (const [video, entry] of tracked) {
      const rect = video.getBoundingClientRect();
      const shown = document.contains(video) && visible(video);
      entry.wrap.style.display = shown ? '' : 'none';
      if (shown) {
        entry.wrap.style.top = `${Math.max(8, rect.top + 8)}px`;
        entry.wrap.style.left = `${Math.min(innerWidth - 98, Math.max(8, rect.right - 98))}px`;
      }
    }
    requestAnimationFrame(position);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action !== 'downloadJobUpdate' || message.job?.platform !== 'tiktok') return;
    knownJobs = [message.job, ...knownJobs.filter((job) => job.id !== message.job.id)];
    for (const entry of tracked.values()) renderJob(entry, message.job);
  });

  sendRequest({ action: 'getDownloadJobs' }, 5000).then((response) => {
    knownJobs = Array.isArray(response.jobs) ? response.jobs : [];
    for (const entry of tracked.values()) {
      const active = knownJobs.find((job) => job.platform === 'tiktok' &&
        job.videoId === entry.videoId && ACTIVE_STATES.has(job.state));
      if (active) renderJob(entry, active);
    }
  });
  scan();
  document.addEventListener('visibilitychange', scan);
  setInterval(scan, 700);
  requestAnimationFrame(position);
})();

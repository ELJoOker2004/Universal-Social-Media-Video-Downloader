/* YouTube download menu. Format discovery and downloads run in the local helper. */
(function () {
  'use strict';

  const DOWNLOAD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
  const overlay = document.createElement('div');
  overlay.id = 'fbdl-overlay';
  overlay.dataset.platform = 'youtube';
  const wrap = document.createElement('div');
  wrap.className = 'fbdl-fixed-wrap';
  wrap.style.display = 'none';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'fbdl-btn';
  button.setAttribute('aria-label', 'Choose YouTube download quality');
  button.title = 'Choose YouTube download quality';
  button.innerHTML = DOWNLOAD_ICON;
  wrap.appendChild(button);
  overlay.appendChild(wrap);
  document.documentElement.appendChild(overlay);

  let video = null;
  let menu = null;
  let pageUrl = location.href;
  let busy = false;
  let activeJobId = null;

  function videoId() {
    const parsed = new URL(location.href);
    const id = parsed.pathname === '/watch'
      ? parsed.searchParams.get('v')
      : parsed.pathname.match(/^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1];
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
  }

  function visible(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 120 && rect.height > 80 && rect.bottom > 0 &&
      rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  }

  function activeVideo() {
    if (!videoId()) return null;
    if (location.pathname.startsWith('/shorts/')) {
      const candidates = [...document.querySelectorAll('ytd-reel-video-renderer video.html5-main-video')].filter(visible);
      return candidates.find((item) => item.closest('ytd-reel-video-renderer[is-active]')) ||
        candidates.sort((a, b) => {
          const center = (item) => Math.abs(item.getBoundingClientRect().top + item.getBoundingClientRect().height / 2 - innerHeight / 2);
          return center(a) - center(b);
        })[0] || null;
    }
    const player = document.querySelector('#movie_player video.html5-main-video');
    return player && visible(player) ? player : null;
  }

  function closeMenu() {
    if (busy) return;
    menu?.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
  }

  function callHelper(request, onStarted) {
    return new Promise((resolve) => {
      let port;
      let done = false;
      let timeout;
      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        try { port?.disconnect(); } catch (_) {}
        resolve(result);
      }
      try {
        port = chrome.runtime.connect({ name: 'fbdl-youtube' });
        port.onMessage.addListener((response) => {
          if (response?.type === 'started') onStarted?.();
          else if (['formats', 'complete', 'error'].includes(response?.type)) finish(response);
        });
        port.onDisconnect.addListener(() => finish({ type: 'error', error: 'YouTube helper disconnected.' }));
        port.postMessage(request);
        if (request.action === 'formats') {
          timeout = setTimeout(() => finish({ type: 'error', error: 'Timed out while checking YouTube formats.' }), 90000);
        }
      } catch (_) {
        finish({ type: 'error', error: 'Could not connect to the YouTube helper.' });
      }
    });
  }

  function addText(parent, tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function setStatus(text, error = false) {
    if (!menu) return;
    const status = menu.querySelector('.fbdl-yt-status');
    status.textContent = text;
    status.classList.toggle('fbdl-yt-error', error);
  }

  function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '';
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB'];
    let amount = value / 1024;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function renderJob(job) {
    if (!menu || job.videoId !== videoId()) return;
    activeJobId = job.id;
    const box = menu.querySelector('.fbdl-yt-progress');
    const meter = box.querySelector('progress');
    const details = box.querySelector('.fbdl-yt-progress-details');
    box.hidden = job.state === 'error';
    if (Number.isFinite(job.percent) && job.state !== 'finishing') meter.value = job.percent;
    else meter.removeAttribute('value');
    if (job.state === 'complete') {
      setStatus(`Saved: ${job.fileName || 'YouTube download'}`);
      details.textContent = job.folder || 'Downloads\\YouTube';
      meter.value = 100;
    } else if (job.state === 'error') {
      setStatus(job.error || 'Download failed. Try again.', true);
      details.textContent = '';
    } else if (job.state === 'finishing') {
      setStatus(job.label?.includes('(merged)') ? 'Combining video and audio...' : 'Finishing file...');
      details.textContent = 'You can close this tab while the browser stays open.';
    } else if (job.state === 'downloading') {
      const phase = job.phase === 'video' ? 'video stream' : job.phase === 'audio' ? 'audio stream' : 'file';
      const percent = Number.isFinite(job.percent) ? ` ${job.percent.toFixed(0)}%` : '';
      setStatus(`Downloading ${phase}${percent}...`);
      const parts = [];
      if (Number.isFinite(job.downloadedBytes)) {
        const total = Number.isFinite(job.totalBytes) ? ` of ${formatBytes(job.totalBytes)}` : '';
        parts.push(`${formatBytes(job.downloadedBytes)}${total}`);
      }
      if (Number.isFinite(job.speed) && job.speed > 0) parts.push(`${formatBytes(job.speed)}/s`);
      if (Number.isFinite(job.eta)) parts.push(`${Math.ceil(job.eta)}s left`);
      details.textContent = parts.join(' · ') || 'You can close this tab while the browser stays open.';
    } else {
      setStatus(`Preparing ${job.label || 'download'}...`);
      details.textContent = 'You can close this tab while the browser stays open.';
    }
  }

  function sendRequest(request, timeoutMs) {
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

  async function getJobs() {
    const response = await sendRequest({ action: 'getDownloadJobs' }, 5000);
    return Array.isArray(response.jobs) ? response.jobs : [];
  }

  function addChoices(parent, heading, choices, currentId) {
    if (!choices.length) return;
    addText(parent, 'h3', 'fbdl-yt-heading', heading);
    for (const choice of choices) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'fbdl-yt-choice';
      item.textContent = choice.label;
      item.title = choice.needsFfmpeg ? 'FFmpeg combines video and audio' : 'Downloads as one stream';
      item.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (busy) return;
        busy = true;
        parent.querySelectorAll('.fbdl-yt-choice').forEach((button) => { button.disabled = true; });
        setStatus(`Preparing ${choice.label}...`);
        const result = await sendRequest({
          action: 'startYoutubeDownload', videoId: currentId, format: choice.format, label: choice.label,
        }, 15000);
        busy = false;
        parent.querySelectorAll('.fbdl-yt-choice').forEach((button) => { button.disabled = false; });
        if (result.success) {
          activeJobId = result.jobId;
          const jobs = await getJobs();
          const job = jobs.find((entry) => entry.id === result.jobId);
          if (job) renderJob(job);
          else setStatus(`Started ${choice.label}. You can close this tab while the browser stays open.`);
        } else {
          setStatus(result.error || 'Could not start the download.', true);
        }
        if (videoId() !== currentId) closeMenu();
      });
      parent.appendChild(item);
    }
  }

  async function openMenu() {
    if (busy) return;
    const currentId = videoId();
    if (!currentId || !video) return;
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'fbdl-yt-menu';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'YouTube download choices');
    addText(menu, 'h2', 'fbdl-yt-title', 'YouTube download');
    const status = addText(menu, 'p', 'fbdl-yt-status', 'Checking available formats...');
    status.setAttribute('role', 'status');
    const progressBox = addText(menu, 'div', 'fbdl-yt-progress', '');
    progressBox.hidden = true;
    const meter = document.createElement('progress');
    meter.max = 100;
    meter.setAttribute('aria-label', 'YouTube download progress');
    progressBox.appendChild(meter);
    addText(progressBox, 'small', 'fbdl-yt-progress-details', '');
    wrap.appendChild(menu);
    button.setAttribute('aria-expanded', 'true');
    const menuForRequest = menu;
    const result = await callHelper({ action: 'formats', videoId: currentId });
    if (menu !== menuForRequest || videoId() !== currentId) return;
    if (result.type !== 'formats') {
      setStatus(result.error || 'Could not list YouTube formats.', true);
      return;
    }
    menu.querySelector('.fbdl-yt-title').textContent = result.title || 'YouTube download';
    const videoChoices = Array.isArray(result.video) ? result.video : [];
    const audioChoices = Array.isArray(result.audio) ? result.audio : [];
    setStatus(videoChoices.length || audioChoices.length ? 'Choose a format:' : 'No downloadable formats available.',
      !videoChoices.length && !audioChoices.length);
    addChoices(menu, 'Video with audio', videoChoices, currentId);
    addChoices(menu, 'Audio only', audioChoices, currentId);
    if (!result.ffmpegAvailable) {
      addText(menu, 'p', 'fbdl-yt-note', 'Higher video qualities need FFmpeg to combine video and audio.');
    }
    const jobs = await getJobs();
    if (menu !== menuForRequest || videoId() !== currentId) return;
    const lastJob = jobs.find((entry) => entry.videoId === currentId);
    if (lastJob) renderJob(lastJob);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action !== 'downloadJobUpdate' || !menu) return;
    if (message.job?.videoId !== videoId()) return;
    if (activeJobId && message.job.id !== activeJobId) return;
    renderJob(message.job);
  });

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    if (menu) closeMenu();
    else openMenu();
  });
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    wrap.addEventListener(type, (event) => event.stopPropagation());
  }
  document.addEventListener('pointerdown', (event) => {
    if (menu && !wrap.contains(event.target)) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  function scan() {
    if (pageUrl !== location.href) {
      pageUrl = location.href;
      closeMenu();
      activeJobId = null;
    }
    video = activeVideo();
    if (!video) wrap.style.display = 'none';
  }

  function position() {
    if (video && document.contains(video) && visible(video)) {
      const rect = video.getBoundingClientRect();
      wrap.style.display = '';
      wrap.style.top = `${Math.max(8, rect.top + 8)}px`;
      wrap.style.left = `${Math.min(innerWidth - 50, Math.max(8, rect.right - 50))}px`;
    } else {
      wrap.style.display = 'none';
    }
    requestAnimationFrame(position);
  }

  scan();
  document.addEventListener('yt-navigate-finish', scan);
  setInterval(scan, 700);
  requestAnimationFrame(position);
})();

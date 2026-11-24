(function () {
  'use strict';
  const container = document.getElementById('jobs');
  let jobs = [];

  function bytes(value) {
    if (!Number.isFinite(value) || value < 0) return '';
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB'];
    let amount = value / 1024;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
    return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
  }

  function detail(job) {
    if (job.state === 'complete') return job.fileName ||
      `Saved to Downloads\\${job.platform === 'tiktok' ? 'TikTok' : 'YouTube'}`;
    if (job.state === 'error') return job.error || 'Download failed.';
    if (job.state === 'finishing') return job.platform === 'tiktok'
      ? job.kind === 'audio' ? 'Extracting full audio…' : 'Finishing the file…'
      : 'Combining streams and finishing the file…';
    if (job.state === 'preparing') return job.platform === 'tiktok'
      ? 'Finding the video…' : 'Checking the selected format…';
    const phase = job.phase === 'video' ? 'Video stream' : job.phase === 'audio' ? 'Audio stream' : 'Downloading';
    const parts = [phase];
    if (Number.isFinite(job.percent)) parts.push(`${job.percent.toFixed(0)}%`);
    if (Number.isFinite(job.downloadedBytes)) {
      parts.push(Number.isFinite(job.totalBytes)
        ? `${bytes(job.downloadedBytes)} of ${bytes(job.totalBytes)}` : bytes(job.downloadedBytes));
    }
    if (Number.isFinite(job.speed) && job.speed > 0) parts.push(`${bytes(job.speed)}/s`);
    if (Number.isFinite(job.eta)) parts.push(`${Math.ceil(job.eta)}s left`);
    return parts.join(' · ');
  }

  function render() {
    container.replaceChildren();
    if (!jobs.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No downloads yet.';
      container.appendChild(empty);
      return;
    }
    for (const job of jobs.slice(0, 10)) {
      const item = document.createElement('article');
      item.className = `job ${job.state === 'complete' ? 'complete' : job.state === 'error' ? 'error' : ''}`;
      const head = document.createElement('div');
      head.className = 'job-head';
      const title = document.createElement('span');
      title.className = 'job-title';
      title.textContent = job.title || (job.platform === 'tiktok'
        ? job.kind === 'audio' ? 'TikTok sound' : 'TikTok video' : 'YouTube video');
      const state = document.createElement('span');
      state.className = 'job-state';
      state.textContent = job.state === 'complete' ? 'Saved' : job.state === 'error' ? 'Failed' : 'In progress';
      head.append(title, state);
      item.appendChild(head);
      const label = document.createElement('div');
      label.className = 'job-label';
      label.textContent = `${job.platform === 'tiktok' ? 'TikTok' : 'YouTube'} · ${job.label || 'Video'}`;
      item.appendChild(label);
      if (job.state !== 'error') {
        const meter = document.createElement('progress');
        meter.max = 100;
        meter.setAttribute('aria-label', 'Download progress');
        if (job.state === 'complete') meter.value = 100;
        else if (Number.isFinite(job.percent) && job.state !== 'finishing') meter.value = job.percent;
        item.appendChild(meter);
      }
      const information = document.createElement('div');
      information.className = 'job-detail';
      information.textContent = detail(job);
      item.appendChild(information);
      container.appendChild(item);
    }
  }

  chrome.runtime.sendMessage({ action: 'getDownloadJobs' }, (response) => {
    if (chrome.runtime.lastError) {
      container.textContent = 'Could not load download status.';
      return;
    }
    jobs = Array.isArray(response?.jobs) ? response.jobs : [];
    render();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action !== 'downloadJobUpdate' || !message.job) return;
    jobs = [message.job, ...jobs.filter((job) => job.id !== message.job.id)];
    render();
  });
})();

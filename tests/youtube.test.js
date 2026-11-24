const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

function port(name, url) {
  const onMessage = event();
  const onDisconnect = event();
  const sent = [];
  return {
    name, sender: url ? { url, tab: { id: 7 } } : undefined,
    onMessage, onDisconnect, sent, disconnected: false,
    postMessage(message) { sent.push(message); },
    disconnect() { this.disconnected = true; onDisconnect.emit(); },
  };
}

function background(initialJobs = []) {
  const onConnect = event();
  const onMessage = event();
  const onRemoved = event();
  const nativePorts = [];
  const storage = { youtubeJobs: initialJobs };
  const chrome = {
    webRequest: { onBeforeRequest: event() },
    tabs: { onRemoved, sendMessage: async () => {} },
    action: {
      setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {},
    },
    storage: { local: {
      async get() { return { youtubeJobs: storage.youtubeJobs }; },
      async set(value) { Object.assign(storage, value); },
    } },
    runtime: {
      onMessage, onConnect, sendMessage: async () => {},
      connectNative(name) {
        assert.equal(name, 'com.eljooker.social_video_downloader');
        const native = port(name);
        nativePorts.push(native);
        return native;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), { chrome, URL, Date, console });
  function send(message, url = 'https://www.youtube.com/watch?v=abcdefghijk') {
    return new Promise((resolve) => onMessage.emit(message, { url, tab: { id: 7 } }, resolve));
  }
  return { chrome, onConnect, onRemoved, nativePorts, storage, send };
}

test('YouTube requests are bound to the current watch or Shorts video', async () => {
  const app = background();
  for (const [url, request] of [
    ['https://www.youtube.com/watch?v=abcdefghijk', { videoId: 'wrongid123', format: '18' }],
    ['https://www.youtube.com.evil.example/watch?v=abcdefghijk', { videoId: 'abcdefghijk', format: '18' }],
    ['https://www.youtube.com/watch?v=abcdefghijk', { videoId: 'abcdefghijk', format: '../18' }],
  ]) {
    const response = await app.send({ action: 'startYoutubeDownload', ...request }, url);
    assert.equal(response.success, false);
  }
  assert.equal(app.nativePorts.length, 0);

  const response = await app.send({ action: 'startYoutubeDownload', videoId: 'abcdefghijk', format: '136+140', label: '720p MP4 (merged)' },
    'https://www.youtube.com/shorts/abcdefghijk');
  assert.equal(response.success, true);
  assert.equal(app.nativePorts[0].sent[0].format, '136+140');
});

test('closing the source tab does not disconnect an active YouTube download', async () => {
  const app = background();
  const response = await app.send({ action: 'startYoutubeDownload', videoId: 'abcdefghijk', format: '18', label: '360p MP4 (direct)' });
  assert.equal(response.success, true);
  const native = app.nativePorts[0];
  native.onMessage.emit({ type: 'started', title: 'Test video', label: '360p MP4 (direct)' });
  native.onMessage.emit({ type: 'progress', phase: 'download', percent: 42.5, downloadedBytes: 425, totalBytes: 1000, speed: 100, eta: 6 });
  app.onRemoved.emit(7);
  assert.equal(native.disconnected, false);
  native.onMessage.emit({ type: 'complete', fileName: 'Test video.mp4', folder: 'C:\\Downloads\\YouTube' });
  const jobs = await app.send({ action: 'getYoutubeJobs' });
  assert.equal(jobs.jobs[0].state, 'complete');
  assert.equal(jobs.jobs[0].fileName, 'Test video.mp4');
  assert.equal(jobs.jobs[0].tabId, null);
});

test('a lost native connection is shown as failed after a worker restart', async () => {
  const app = background();
  await app.send({ action: 'startYoutubeDownload', videoId: 'abcdefghijk', format: '18' });
  app.nativePorts[0].onMessage.emit({ type: 'started', title: 'Test video' });
  const old = await app.send({ action: 'getYoutubeJobs' });
  const restarted = background(old.jobs);
  const current = await restarted.send({ action: 'getYoutubeJobs' });
  assert.equal(current.jobs[0].state, 'error');
  assert.match(current.jobs[0].error, /browser or extension stopped/);
});

test('a legacy content port can close without cancelling its background job', async () => {
  const app = background();
  const client = port('fbdl-youtube', 'https://www.youtube.com/watch?v=abcdefghijk');
  app.onConnect.emit(client);
  client.onMessage.emit({ action: 'download', videoId: 'abcdefghijk', format: '18' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.nativePorts.length, 1);
  client.disconnect();
  assert.equal(app.nativePorts[0].disconnected, false);
  app.nativePorts[0].onMessage.emit({ type: 'complete', fileName: 'video.mp4' });
  const jobs = await app.send({ action: 'getYoutubeJobs' });
  assert.equal(jobs.jobs[0].state, 'complete');
});

test('YouTube menu and toolbar popup are registered without page-world injection', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert(manifest.permissions.includes('nativeMessaging'));
  assert(manifest.permissions.includes('storage'));
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert(manifest.content_scripts.some((entry) => entry.js.includes('yt-content.js') &&
    entry.matches.includes('https://*.youtube.com/*')));
  assert(!manifest.content_scripts.some((entry) => entry.js.includes('yt-content.js') && entry.world === 'MAIN'));
});

test('native helper reports stream progress and merge status', { skip: process.platform !== 'win32' }, () => {
  const script = String.raw`
$path=(Resolve-Path 'youtube-host/host.ps1').Path
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Convert-ProgressLine'},$true)
Invoke-Expression $fn.Extent.Text
$video=Convert-ProgressLine 'FBDL_PROGRESS|299|{"status":"downloading","_percent":43.2,"downloaded_bytes":432,"total_bytes":1000,"speed":125,"eta":5}' @('299','140') $true
$audio=Convert-ProgressLine 'FBDL_PROGRESS|140|{"status":"downloading","_percent":25,"downloaded_bytes":100,"total_bytes_estimate":400}' @('299','140') $true
$merge=Convert-ProgressLine 'FBDL_POSTPROCESS|started' @('299','140') $true
@{video=$video;audio=$audio;merge=$merge} | ConvertTo-Json -Depth 4 -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'],
    { cwd: root, input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.trim());
  assert.equal(data.video.phase, 'video');
  assert.equal(data.video.percent, 43.2);
  assert.equal(data.video.totalBytes, 1000);
  assert.equal(data.audio.phase, 'audio');
  assert.equal(data.audio.totalBytes, 400);
  assert.equal(data.merge.phase, 'finishing');
});

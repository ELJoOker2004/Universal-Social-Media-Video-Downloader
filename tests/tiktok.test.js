const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const VIDEO_ID = '6718335390845095173';

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

function background(initialJobs = []) {
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
      onMessage, onConnect: event(), sendMessage: async () => {},
      connectNative(name) {
        assert.equal(name, 'com.eljooker.social_video_downloader');
        const port = { sent: [], disconnected: false, onMessage: event(), onDisconnect: event(),
          postMessage(message) { this.sent.push(message); },
          disconnect() { this.disconnected = true; this.onDisconnect.emit(); } };
        nativePorts.push(port);
        return port;
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'),
    { chrome, URL, Date, console });
  function send(message, url = `https://www.tiktok.com/@scout2015/video/${VIDEO_ID}`) {
    return new Promise((resolve) => onMessage.emit(message, { url, tab: { id: 9 } }, resolve));
  }
  return { send, onRemoved, nativePorts, storage };
}

test('TikTok download requests require a TikTok page and the matching post ID', async () => {
  const app = background();
  for (const [url, id] of [
    [`https://www.tiktok.com.evil.example/@scout2015/video/${VIDEO_ID}`, VIDEO_ID],
    [`https://www.tiktok.com/@scout2015/video/${VIDEO_ID}`, '6718335390845095174'],
    ['https://www.tiktok.com/foryou', 'not-a-video-id'],
  ]) {
    const response = await app.send({ action: 'startTikTokDownload', videoId: id }, url);
    assert.equal(response.success, false);
  }
  assert.equal(app.nativePorts.length, 0);

  const response = await app.send({ action: 'startTikTokDownload', videoId: VIDEO_ID },
    'https://www.tiktok.com/foryou');
  assert.equal(response.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.nativePorts[0].sent[0])),
    { action: 'download', platform: 'tiktok', videoId: VIDEO_ID, kind: 'video' });
});

test('TikTok sound-only requests are passed to the helper and marked as audio', async () => {
  const app = background();
  for (const kind of ['music', '', null, 1]) {
    const response = await app.send({ action: 'startTikTokDownload', videoId: VIDEO_ID, kind });
    assert.equal(response.success, false);
  }
  assert.equal(app.nativePorts.length, 0);

  const response = await app.send({ action: 'startTikTokDownload', videoId: VIDEO_ID, kind: 'audio' });
  assert.equal(response.success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(app.nativePorts[0].sent[0])),
    { action: 'download', platform: 'tiktok', videoId: VIDEO_ID, kind: 'audio' });
  const before = await app.send({ action: 'getDownloadJobs' });
  assert.equal(before.jobs[0].kind, 'audio');
  assert.equal(before.jobs[0].label, 'M4A audio');

  app.nativePorts[0].onMessage.emit({ type: 'progress', phase: 'finishing', percent: null });
  const during = await app.send({ action: 'getDownloadJobs' });
  assert.equal(during.jobs[0].state, 'finishing');
  app.nativePorts[0].onMessage.emit({ type: 'complete', fileName: 'Test clip.m4a', folder: 'C:\\Downloads\\TikTok' });
  const after = await app.send({ action: 'getDownloadJobs' });
  assert.equal(after.jobs[0].fileName, 'Test clip.m4a');
  assert.equal(after.jobs[0].state, 'complete');
});

test('TikTok progress survives closing the source tab and is recorded in the popup history', async () => {
  const app = background();
  const response = await app.send({ action: 'startTikTokDownload', videoId: VIDEO_ID });
  const native = app.nativePorts[0];
  native.onMessage.emit({ type: 'started', title: 'Test clip', label: 'MP4 video' });
  native.onMessage.emit({ type: 'progress', phase: 'download', percent: 45,
    downloadedBytes: 450, totalBytes: 1000, speed: 100, eta: 5 });
  app.onRemoved.emit(9);
  assert.equal(native.disconnected, false);
  native.onMessage.emit({ type: 'complete', fileName: 'Test clip.mp4', folder: 'C:\\Downloads\\TikTok' });
  const result = await app.send({ action: 'getDownloadJobs' });
  assert.equal(result.jobs[0].platform, 'tiktok');
  assert.equal(result.jobs[0].state, 'complete');
  assert.equal(result.jobs[0].percent, 100);
  assert.equal(result.jobs[0].fileName, 'Test clip.mp4');
  assert.equal(result.jobs[0].tabId, null);
});

test('interrupted TikTok history points to the TikTok download folder', async () => {
  const app = background([{ id: 'previous', platform: 'tiktok', state: 'downloading',
    videoId: VIDEO_ID, startedAt: 1 }]);
  const result = await app.send({ action: 'getDownloadJobs' });
  assert.equal(result.jobs[0].state, 'error');
  assert.match(result.jobs[0].error, /Downloads\\TikTok/);
});

test('TikTok is registered in its own isolated content script', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const script = manifest.content_scripts.find((entry) => entry.js.includes('tt-content.js'));
  assert(script);
  assert(script.matches.includes('https://*.tiktok.com/*'));
  assert.notEqual(script.world, 'MAIN');
  assert(manifest.content_scripts.some((entry) => entry.js.includes('yt-content.js')));
});

test('native helper prefers an H.264 MP4 with audio over silent or H.265 options',
  { skip: process.platform !== 'win32' }, () => {
    const script = String.raw`
$path=(Resolve-Path 'youtube-host/host.ps1').Path
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-TikTokFormat'},$true)
Invoke-Expression $fn.Extent.Text
$info=[pscustomobject]@{formats=@(
  [pscustomobject]@{format_id='silent';ext='mp4';protocol='https';vcodec='h264';acodec='none';tbr=9000;url='https://cdn.example/silent'},
  [pscustomobject]@{format_id='h265';ext='mp4';protocol='https';vcodec='h265';acodec='aac';tbr=5000;url='https://cdn.example/h265'},
  [pscustomobject]@{format_id='h264';ext='mp4';protocol='https';vcodec='h264';acodec='aac';tbr=2000;url='https://cdn.example/h264'}
)}
$chosen=Get-TikTokFormat $info
$silentError=$false
try { Get-TikTokFormat ([pscustomobject]@{formats=@($info.formats[0])}) | Out-Null } catch { $silentError=$true }
@{chosen=$chosen.format;silentError=$silentError} | ConvertTo-Json -Compress
`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert(result.stdout.trim(), JSON.stringify({ stdout: result.stdout, stderr: result.stderr }));
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.chosen, 'h264');
    assert.equal(data.silentError, true);
  });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const videoUrl = (id, quality) => `https://scontent-cdg2-1.cdninstagram.com/v/t50/${id}_${quality}.mp4?oh=signed&oe=expiry`;
const posterUrl = (id) => `https://scontent-cdg2-1.cdninstagram.com/v/t51/${id}.jpg?size=small`;

function mediaItem(id, code, versions) {
  return {
    pk: id,
    code,
    video_versions: versions,
    image_versions2: { candidates: [{ url: posterUrl(id) }] },
  };
}

function version(url, width, height) {
  return { url, width, height };
}

function instagramPage(payload, scripts = []) {
  const listeners = [];
  const messages = [];
  const browserWindow = {
    addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
    postMessage(data) {
      messages.push(data);
      for (const listener of listeners) listener({ source: browserWindow, data });
    },
    fetch: async () => ({
      ok: true,
      clone: () => ({ text: async () => JSON.stringify(payload) }),
    }),
  };
  function FakeXHR() {}
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.send = function () {};
  const context = {
    window: browserWindow,
    XMLHttpRequest: FakeXHR,
    document: { readyState: 'complete', querySelectorAll: () => scripts },
    location: { href: 'https://www.instagram.com/' },
    URL,
    setInterval: () => 1,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'ig-inject.js'), 'utf8'), context);
  return {
    async load(url = 'https://www.instagram.com/graphql/query') {
      await browserWindow.fetch(url);
      await new Promise((resolve) => setImmediate(resolve));
    },
    ask(data) {
      browserWindow.postMessage({ type: 'FBDL_IG_GET_VIDEO', requestId: 'test', ...data });
      return messages.filter((message) => message.type === 'FBDL_IG_VIDEO_RESULT').at(-1)?.url;
    },
  };
}

test('Instagram selects the highest-resolution MP4 for the clicked post', async () => {
  const a = '1111111111';
  const b = '2222222222';
  const page = instagramPage({ data: { posts: [
    mediaItem(a, 'Cabc123xy', [
      version(videoUrl(a, 'low'), 480, 854),
      version(videoUrl(a, 'high'), 1080, 1920),
    ]),
    mediaItem(b, 'Cdef456xy', [version(videoUrl(b, 'high'), 1080, 1920)]),
  ] } });
  await page.load();
  assert.equal(page.ask({ posters: [posterUrl(a) + '&extra=1'], code: 'Cdef456xy', singleVideo: true }), videoUrl(a, 'high'));
  assert.equal(page.ask({ posters: [posterUrl(b)], singleVideo: false }), videoUrl(b, 'high'));
  assert.equal(page.ask({ code: 'Cabc123xy', singleVideo: true }), videoUrl(a, 'high'));
  assert.equal(page.ask({ code: 'Cabc123xy', singleVideo: false }), null);
});

test('Instagram carousel matching refuses an ambiguous shortcode', async () => {
  const a = '3333333333';
  const b = '4444444444';
  const page = instagramPage({ code: 'Ccarousel1', carousel_media: [
    mediaItem(a, null, [version(videoUrl(a, 'high'), 1080, 1080)]),
    mediaItem(b, null, [version(videoUrl(b, 'high'), 1080, 1080)]),
  ] });
  await page.load();
  assert.equal(page.ask({ code: 'Ccarousel1', singleVideo: true }), null);
  assert.equal(page.ask({ posters: [posterUrl(b)], code: 'Ccarousel1', singleVideo: true }), videoUrl(b, 'high'));
});

test('Instagram matches a story by its media ID', async () => {
  const id = '5555555555';
  const page = instagramPage({ stories: [mediaItem(id, null, [version(videoUrl(id, 'high'), 720, 1280)])] });
  await page.load('https://www.instagram.com/api/v1/feed/reels_media/');
  assert.equal(page.ask({ storyId: id, singleVideo: false }), videoUrl(id, 'high'));
});

test('Instagram reads initial ScheduledServerJS JSON scripts', () => {
  const id = '6666666666';
  const script = {
    type: 'application/json',
    textContent: JSON.stringify({ require: [['ScheduledServerJS', 'handle', null, [
      { __bbox: { result: mediaItem(id, 'Creel1234', [version(videoUrl(id, 'high'), 1080, 1920)]) } },
    ]]] }),
  };
  const page = instagramPage(null, [script]);
  assert.equal(page.ask({ posters: [posterUrl(id)], singleVideo: false }), videoUrl(id, 'high'));
});

test('Instagram rejects partial MP4 ranges and external video URLs', async () => {
  const id = '7777777777';
  const page = instagramPage(mediaItem(id, 'Creject12', [
    version(videoUrl(id, 'partial') + '&bytestart=0&byteend=1000', 1080, 1920),
    version('https://evil.example/clip.mp4', 1080, 1920),
  ]));
  await page.load();
  assert.equal(page.ask({ posters: [posterUrl(id)], code: 'Creject12', singleVideo: true }), null);
});

test('Instagram restores escaped query separators in a signed video URL', async () => {
  const id = '7878787878';
  const escaped = videoUrl(id, 'high').replace('&oe=', '&amp;oe=');
  const page = instagramPage(mediaItem(id, 'Cescaped1', [version(escaped, 1080, 1920)]));
  await page.load();
  assert.equal(page.ask({ posters: [posterUrl(id)], singleVideo: false }), videoUrl(id, 'high'));
});

test('background accepts Instagram CDN MP4s and preserves other platforms', () => {
  let onMessage;
  const downloads = [];
  const networkListeners = [];
  const chrome = {
    webRequest: { onBeforeRequest: { addListener: (listener) => networkListeners.push(listener) } },
    tabs: { onRemoved: { addListener: () => {} } },
    runtime: { onMessage: { addListener: (listener) => { onMessage = listener; } }, lastError: null },
    downloads: { download: (options, callback) => { downloads.push(options); callback(downloads.length); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), { chrome, URL, Date, console });
  const ask = (msg, senderUrl = 'https://www.instagram.com/reel/Creel1234/') => {
    let result;
    onMessage(msg, { url: senderUrl, tab: { id: 7 } }, (reply) => { result = reply; });
    return result;
  };
  const url = videoUrl('8888888888', 'high');
  assert.equal(ask({ action: 'download', platform: 'instagram', url, shortcode: 'Creel1234' }).success, true);
  assert.match(downloads[0].filename, /^IG_Video_Creel1234_/);
  assert.equal(ask({ action: 'download', platform: 'instagram', url }, 'https://evil.example/').success, false);
  assert.equal(ask({ action: 'download', platform: 'instagram', url: url + '&byteend=1000' }).success, false);
  assert.equal(ask({ action: 'download', platform: 'instagram', url: 'https://scontent.cdninstagram.com.evil.example/clip.mp4' }).success, false);
  networkListeners[0]({ tabId: 7, initiator: 'https://www.instagram.com', url: 'https://scontent.fbcdn.net/video.mp4' });
  assert.equal(ask({ action: 'getVideoUrls' }).urls.length, 0);
  assert.equal(ask({ action: 'download', url: 'https://scontent.fbcdn.net/clip.mp4' }, 'https://www.facebook.com/').success, true);
  assert.match(downloads[1].filename, /^FB_Video_/);
  assert.equal(downloads.length, 2);
});

test('manifest registers Instagram without removing Facebook or X', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert(manifest.content_scripts.some((entry) => entry.js.includes('ig-inject.js') && entry.world === 'MAIN'));
  assert(manifest.content_scripts.some((entry) => entry.js.includes('ig-content.js')));
  assert(manifest.content_scripts.some((entry) => entry.js.includes('x-content.js')));
  assert(manifest.content_scripts.some((entry) => entry.js.includes('content.js')));
});

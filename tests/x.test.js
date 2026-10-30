const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const videoUrl = (id, size) => `https://video.twimg.com/ext_tw_video/${id}/pu/vid/${size}/clip.mp4?tag=1`;
const posterUrl = (id) => `https://pbs.twimg.com/ext_tw_video_thumb/${id}/pu/img/poster.jpg?name=small`;

function mediaItem(id, variants) {
  return { id_str: id, media_url_https: posterUrl(id), video_info: { variants } };
}

function mp4(url, bitrate) {
  return { content_type: 'video/mp4', url, bitrate };
}

function xPage(payload) {
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
      headers: { get: () => 'application/json' },
      clone: () => ({ text: async () => JSON.stringify(payload) }),
    }),
  };
  function FakeXHR() {}
  FakeXHR.prototype.open = function () {};
  FakeXHR.prototype.send = function () {};
  const context = {
    window: browserWindow,
    XMLHttpRequest: FakeXHR,
    document: { readyState: 'complete', querySelectorAll: () => [] },
    location: { href: 'https://x.com/home' },
    URL,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'x-inject.js'), 'utf8'), context);
  return {
    async load(url = 'https://x.com/i/api/graphql/example') {
      await browserWindow.fetch(url);
      await new Promise((resolve) => setImmediate(resolve));
    },
    ask(data) {
      browserWindow.postMessage({ type: 'FBDL_X_GET_VIDEO', requestId: 'test', ...data });
      return messages.filter((message) => message.type === 'FBDL_X_VIDEO_RESULT').at(-1)?.url;
    },
  };
}

test('X selects the highest-bitrate complete MP4 for the clicked video', async () => {
  const first = '1010101010';
  const second = '2020202020';
  const payload = { data: { posts: [
    { rest_id: '1111111111', legacy: { extended_entities: { media: [mediaItem(first, [
      mp4(videoUrl(first, '320x180'), 320000),
      { content_type: 'application/x-mpegURL', url: `https://video.twimg.com/ext_tw_video/${first}/pu/pl/stream.m3u8` },
      mp4(videoUrl(first, '1280x720'), 2176000),
    ])] } } },
    { rest_id: '2222222222', legacy: { extended_entities: { media: [mediaItem(second, [
      mp4(videoUrl(second, '1920x1080'), 5000000),
    ])] } } },
  ] } };
  const page = xPage(payload);
  await page.load();
  assert.equal(page.ask({ poster: posterUrl(first), tweetId: '2222222222', singleVideo: true }), videoUrl(first, '1280x720'));
  assert.equal(page.ask({ poster: posterUrl(second), singleVideo: false }), videoUrl(second, '1920x1080'));
  assert.equal(page.ask({ tweetId: '1111111111', singleVideo: true }), videoUrl(first, '1280x720'));
  assert.equal(page.ask({ tweetId: '1111111111', singleVideo: false }), null);
  assert.equal(page.ask({ poster: posterUrl('3030303030'), singleVideo: false }), null);
});

test('X ignores playlists and MP4 URLs outside its video CDN', async () => {
  const id = '3030303030';
  const page = xPage({ rest_id: '3333333333', legacy: { extended_entities: { media: [mediaItem(id, [
    { content_type: 'application/x-mpegURL', url: `https://video.twimg.com/ext_tw_video/${id}/pu/pl/stream.m3u8` },
    mp4(`https://video.twimg.com.evil.example/ext_tw_video/${id}/pu/vid/1280x720/clip.mp4`, 5000000),
  ])] } } });
  await page.load();
  assert.equal(page.ask({ poster: posterUrl(id), tweetId: '3333333333', singleVideo: true }), null);
});

test('X also observes API responses on api.x.com', async () => {
  const id = '8080808080';
  const page = xPage({ rest_id: '8888888888', legacy: { extended_entities: { media: [
    mediaItem(id, [mp4(videoUrl(id, '1280x720'), 2176000)]),
  ] } } });
  await page.load('https://api.x.com/graphql/TweetResultByRestId');
  assert.equal(page.ask({ poster: posterUrl(id), singleVideo: false }), videoUrl(id, '1280x720'));
});

test('X reads MP4 variants nested in a card JSON string', async () => {
  const id = '9090909090';
  const card = JSON.stringify({ media: { id_str: id, preview_image_url: posterUrl(id), variants: [
    { content_type: 'video/mp4', url: videoUrl(id, '640x360'), bit_rate: 832000 },
  ] } });
  const page = xPage({ rest_id: '9999999999', legacy: { card: { binding_values: [
    { key: 'unified_card', value: { string_value: card } },
  ] } } });
  await page.load();
  assert.equal(page.ask({ poster: posterUrl(id), singleVideo: false }), videoUrl(id, '640x360'));
});

test('X tweet fallback refuses ambiguous media', async () => {
  const ids = ['4040404040', '5050505050'];
  const page = xPage({ rest_id: '4444444444', legacy: { extended_entities: { media: ids.map((id) =>
    mediaItem(id, [mp4(videoUrl(id, '640x360'), 832000)])) } } });
  await page.load();
  assert.equal(page.ask({ tweetId: '4444444444', singleVideo: true }), null);
});

test('background only downloads X MP4s requested from X pages and matches CDN fallbacks by media ID', () => {
  const networkListeners = [];
  let onMessage;
  const downloads = [];
  const chrome = {
    webRequest: { onBeforeRequest: { addListener: (listener) => networkListeners.push(listener) } },
    tabs: { onRemoved: { addListener: () => {} } },
    runtime: { onMessage: { addListener: (listener) => { onMessage = listener; } }, lastError: null },
    downloads: { download: (options, callback) => { downloads.push(options); callback(1); } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), { chrome, URL, Date, console });
  const ask = (msg, url = 'https://x.com/user/status/1111111111') => {
    let response;
    onMessage(msg, { url, tab: { id: 7 } }, (value) => { response = value; });
    return response;
  };
  const id = '6060606060';
  networkListeners[1]({ tabId: 7, url: videoUrl(id, '320x180') });
  networkListeners[1]({ tabId: 7, url: videoUrl(id, '1280x720') });
  networkListeners[1]({ tabId: 7, url: videoUrl('7070707070', '1920x1080') });
  const urls = ask({ action: 'getXVideoUrls', mediaId: id }).urls;
  assert.deepEqual(Array.from(urls), [videoUrl(id, '1280x720'), videoUrl(id, '320x180')]);
  assert.equal(ask({ action: 'getXVideoUrls', mediaId: id }, 'https://example.com').urls.length, 0);
  assert.equal(ask({ action: 'download', platform: 'x', url: videoUrl(id, '1280x720'), tweetId: '1111111111' }).success, true);
  assert.match(downloads[0].filename, /^X_Video_1111111111_/);
  assert.equal(ask({ action: 'download', platform: 'x', url: `https://video.twimg.com/ext_tw_video/${id}/pu/pl/stream.m3u8` }).success, false);
  assert.equal(ask({ action: 'download', platform: 'x', url: videoUrl(id, '1280x720') }, 'https://example.com').success, false);
  assert.equal(downloads.length, 1);
});

test('manifest registers X and Facebook separately', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert(manifest.content_scripts.some((entry) => entry.js.includes('x-inject.js') && entry.world === 'MAIN'));
  assert(manifest.content_scripts.some((entry) => entry.js.includes('x-content.js')));
  assert(manifest.content_scripts.some((entry) => entry.js.includes('inject.js') && entry.world === 'MAIN'));
  assert(manifest.host_permissions.includes('https://video.twimg.com/*'));
});

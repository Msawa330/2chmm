// 2chmm要約リーダー (standalone) service worker
// 起動を速くするため：
// - アプリ本体はネットワーク優先だが、2.5秒で応答が無ければキャッシュから出す（遅い回線で固まらない）
// - 記事JSONはキャッシュ優先で即表示
// - 一覧データ(data/index.json)はページ側がキャッシュ即表示＋裏で更新するので、ここでは素通しする
const SHELL = 'shell-v3';
const DATA = 'data-2chmm';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function shellFetch(request) {
  return caches.open(SHELL).then(async (cache) => {
    let timer;
    try {
      const res = await Promise.race([
        fetch(request),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 2500); }),
      ]);
      clearTimeout(timer);
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    } catch (err) {
      clearTimeout(timer);
      const hit = await cache.match(request);
      if (hit) return hit;
      return fetch(request);
    }
  });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // 外部画像などはそのまま
  if (url.pathname.endsWith('data/index.json')) return; // ページ側でキャッシュ管理する
  if (url.pathname.includes('/data/articles/')) {
    // 記事本文はキャッシュ優先（無ければ取得して保存）
    e.respondWith(caches.open(DATA).then(async (cache) => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res && res.ok) cache.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // 本体はネットワーク優先（2.5秒でキャッシュに切替）
  e.respondWith(shellFetch(e.request));
});

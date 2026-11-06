// 2chmm要約リーダー (standalone) service worker
// アプリ本体はネットワーク優先（データ更新をすぐ反映）、記事JSONはキャッシュ優先で高速表示。
const VERSION = 'v1';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // 外部画像などはそのまま
  if (url.pathname.endsWith('data/index.json')) {
    // 一覧データはネットワーク優先（更新チェック）
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request)));
    return;
  }
  if (url.pathname.includes('/data/articles/')) {
    // 記事本文はキャッシュ優先（無ければ取得して保存）
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    })));
    return;
  }
  // 本体はネットワーク優先・失敗時キャッシュ
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

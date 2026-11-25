// Офлайн-режим: приложение и загруженные библиотеки/нейросеть кэшируются на телефоне.
const VERSION = 'revizor-v2';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/db.js', 'js/recognize.js', 'js/io.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const CDN = ['cdn.jsdelivr.net', 'unpkg.com', 'storage.googleapis.com', 'tessdata.projectnaptha.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'revizor-cdn').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    // свои файлы: сначала сеть (чтобы обновления приходили), без сети — кэш
    e.respondWith(fetch(req.url, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
  } else if (CDN.includes(url.hostname)) {
    // библиотеки и модель нейросети: из кэша, иначе скачать и запомнить
    e.respondWith(caches.open('revizor-cdn').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === 'opaque') c.put(req, r.clone());
      return r;
    }));
  }
});

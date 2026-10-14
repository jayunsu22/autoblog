/* 필름현장관리자 앱 설치용 서비스워커 (2026-10-15).
   폰에 '앱 설치'를 하려면 서비스워커가 있어야 해서 둔다. 아무것도 저장(캐시)하지 않고
   항상 인터넷에서 새로 받는다 — 관리자 화면이 옛 버전으로 남는 일이 없게. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function () { /* 그대로 인터넷으로 (respondWith 안 함) */ });

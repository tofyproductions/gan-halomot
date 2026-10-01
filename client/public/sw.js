// client/public/sw.js
//
// Push-only. NO fetch handler, NO caching — see the comment at the top of
// client/index.html for why a caching service worker is explicitly banned in
// this app (it traps non-technical staff on a stale build after a deploy).
// This worker exists for exactly two events and nothing else.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON */ }
  const title = data.title || 'גן החלומות';
  const body = data.body || '';
  const url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      data: { url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) { client.focus(); if ('navigate' in client) client.navigate(url); return; }
      }
      // A brand-new window is sent home by the app's fresh-tab gate (a closed
      // tab reopened on a deep link). A notification the person just tapped
      // on their own device is not that case — mark it so the gate lets the
      // link through. The gate strips the marker again.
      const marked = url + (url.includes('?') ? '&' : '?') + 'from=push';
      if (self.clients.openWindow) return self.clients.openWindow(marked);
    })
  );
});

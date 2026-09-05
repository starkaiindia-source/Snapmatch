/* ============================================================================
   Mobile Parts Finder · sw.js — the service worker
   ----------------------------------------------------------------------------
   Two jobs, and deliberately no more:

     1. Exist, with a fetch handler. Chrome will not offer to install a site
        without one, which is the whole reason this file was added.
     2. Keep the app openable when the network is not, by answering a
        navigation from a cached shell instead of the browser's error page.

   NETWORK FIRST, ALWAYS

     A service worker is the one piece of a static site that can outlive a
     deploy. A cache-first worker on a site that ships several times a day
     serves yesterday's JavaScript against today's data, and the user cannot
     clear it — they do not know it is there. So the network is asked first
     for everything, every time, and the cache is only ever a fallback for a
     request that FAILED. A stale shell can therefore appear when offline, and
     never when online.

   WHAT IS NEVER CACHED

     /api/*        access, entitlement, events, billing, config. Serving a
                   remembered answer to "is this user subscribed" is how a
                   cancelled account keeps its features, and a remembered
                   /api/access is a stale entitlement by definition.
     anything      that is not a same-origin GET. Cross-origin (Firebase,
                   Google, fonts) is left entirely alone — their own caching
                   is better than anything guessed at here.

   REMOVING IT

     Bump VERSION to invalidate every cache. To retire the worker entirely,
     replace this file's body with self.registration.unregister() — the
     browser fetches sw.js again on navigation, so that reaches everyone.
   ========================================================================== */
'use strict';

var VERSION = 'mpf-v1';
var SHELL = VERSION + '-shell';

/* The smallest set that can paint something useful offline, and a CLOSED set:
   nothing is added at runtime. A worker that cached every same-origin GET it
   saw would, on this site, quietly fill a phone's storage quota with some part
   of 4,933 pre-rendered model pages. This list is a few hundred KB and cannot
   grow.

   The catalogue itself is deliberately absent: ~280 KB that changes with every
   import, and a remembered copy of it is a parts catalogue quietly out of
   date — the one thing this site must never serve. Offline therefore gets the
   shell and an empty catalogue, which is honest, rather than yesterday's
   fitment data presented as today's. */
var SHELL_URLS = [
  '/',
  '/assets/styles.css',
  '/assets/components.css',
  '/assets/brand/logo.svg',
  '/src/data/debug.js',
  '/src/data/dataset.js',
  '/src/ui/icons.js',
  '/src/ui/product-art.js',
  '/src/ui/components.js',
  '/src/app.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      /* addAll rejects the whole install if any one URL 404s; these are
         warm-ups, not requirements, so each is allowed to fail on its own. */
      return Promise.all(SHELL_URLS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k.indexOf(VERSION) === 0 ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;      /* leave third parties alone */
  if (url.pathname.indexOf('/api/') === 0) return;      /* never a remembered entitlement */

  /* A navigation: try the network, fall back to the cached shell so the app
     opens rather than showing the browser's offline page. */
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('/');
        });
      })
    );
    return;
  }

  /* Everything else: the network, and the cache only if the network fails.
     Nothing is written here — the cache is exactly SHELL_URLS and stays that
     size — so a miss simply becomes the browser's own failure, which is the
     correct answer for a resource we never promised to hold. */
  e.respondWith(
    fetch(req).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || Response.error();
      });
    })
  );
});

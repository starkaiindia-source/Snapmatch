/* ============================================================================
   Mobile Parts Finder · sw.js — the service worker
   ----------------------------------------------------------------------------
   Keeps what a visitor has already downloaded on their phone until THEY clear
   it, so a page they have seen costs this site no request at all.

   WHY
     Vercel Hobby counts every request that reaches it, and paused the whole
     site on 3 November 2026 at a million a month. The browser's own HTTP cache
     cannot help with pages (they must be revalidated, or a deploy never
     reaches anyone) and gives up files whenever it likes. Cache Storage is
     kept until the user clears the site's data, and this worker decides when
     to ask the network again.

   WHAT IS KEPT, AND WHEN THE NETWORK IS ASKED AGAIN

     app      /assets/app.js and app.css. Kept per APP_VERSION, which
              scripts/build-web-bundle.js writes below from their contents. A
              deploy that changes them changes this file, the browser installs
              the new worker, and it fetches the new pair once. Nothing else
              ever asks the network for them.
     pages    every page visited. Shown from the phone at once; if the copy is
              older than PAGE_FRESH, fetched again in the background for next
              time. Pulling to refresh (a reload) always asks the network.
     media    images, icons, the manifest, fonts. Shown from the phone; looked
              at again after MEDIA_FRESH in the background.
     data     the catalogue JSON and enriched model records. Shown from the
              phone; fetched again in the background after DATA_FRESH, so a
              new import reaches a visitor on their next view after that.

     Only app is ever replaced wholesale, and only by its newer version. The
     other three are never deleted by this worker: a background refresh
     replaces one entry with its newer copy, and a failed one keeps the old.

   NEVER TOUCHED
     /api/*, /__/auth/* (sign-in), /admin, /i/ and /o/ (bills and payments),
     anything that is not a same-origin GET. A remembered entitlement or bill
     status is wrong by definition.

   UPDATES OF THIS FILE
     pwa.js registers it with updateViaCache:'all' and vercel.json gives it an
     hour of HTTP cache, so a visitor asks for sw.js at most once an hour, not
     on every page. A deploy therefore reaches everyone within an hour.

     To retire the worker, replace this body with
     self.registration.unregister().
   ========================================================================== */
'use strict';

var APP_VERSION = 'a4e62f57d2';   /* written by scripts/build-web-bundle.js */
var APP = 'mpf-app-' + APP_VERSION;
var PAGES = 'mpf-pages';
var MEDIA = 'mpf-media';
var DATA = 'mpf-data';

var APP_URLS = ['/assets/app.js', '/assets/app.css'];
var HOUR = 3600 * 1000;
var PAGE_FRESH = 24 * HOUR;
var MEDIA_FRESH = 30 * 24 * HOUR;
var DATA_FRESH = HOUR;

var MEDIA_EXT = /\.(png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|webmanifest)$/i;
var DATA_PATH = /^\/assets\/(dataset|search-index)\.json$|^\/assets\/models-active\/[^/]+\.json$/;
var HANDS_OFF = /^\/(api|__|admin|i|o)(\/|$)/;

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(APP).then(function (c) {
      /* 'reload' skips the HTTP cache: the point is the NEW pair. */
      return Promise.all(APP_URLS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' }));
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        /* Older app versions, and the shell cache of the worker before this
           one. Pages, media and data are the visitor's, and stay. */
        var stale = (k.indexOf('mpf-app-') === 0 && k !== APP) || k.indexOf('mpf-v') === 0;
        return stale ? caches.delete(k) : null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function age(res) {
  var at = Date.parse(res.headers.get('date') || '');
  return isNaN(at) ? Infinity : Date.now() - at;
}

function keepable(res) {
  return res && res.ok && res.type === 'basic' && !res.redirected;
}

/* Network, and store a good answer under `key` (default: the request).
   Resolves the response either way. The request itself is what goes out: a
   navigation must keep its own redirect handling, or a 308 answered on its
   behalf is refused by the browser. */
function fetchInto(cacheName, req, key) {
  return fetch(req).then(function (res) {
    if (keepable(res)) {
      var copy = res.clone();
      caches.open(cacheName).then(function (c) { return c.put(key || req, copy); }).catch(function () {});
    }
    return res;
  });
}

/* The phone's copy at once; the network only when there is none, or in the
   background once the copy is older than `fresh`. */
function fromPhone(e, cacheName, req, fresh, key) {
  return caches.open(cacheName).then(function (c) {
    return c.match(key || req).then(function (hit) {
      if (!hit) return fetchInto(cacheName, req, key);
      if (age(hit) > fresh) {
        /* Media sits in the browser's HTTP cache for a year too (vercel.json),
           so its refresh must go past that copy to see a changed file. */
        var again = cacheName === MEDIA ? new Request(req.url, { cache: 'no-cache' }) : req;
        e.waitUntil(fetchInto(cacheName, again, key || req).catch(function () {}));
      }
      return hit;
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  if (HANDS_OFF.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    /* A page is kept by its path alone: ?utm_source=… is the same page. */
    var key = new Request(url.origin + url.pathname);
    var reload = req.cache === 'reload' || req.cache === 'no-cache';
    if (reload) {
      e.respondWith(fetchInto(PAGES, req, key).catch(function () {
        return caches.match(key).then(function (hit) { return hit || caches.match('/'); });
      }));
      return;
    }
    e.respondWith(fromPhone(e, PAGES, req, PAGE_FRESH, key).catch(function () {
      return caches.match('/').then(function (hit) { return hit || Response.error(); });
    }));
    return;
  }

  if (APP_URLS.indexOf(url.pathname) > -1 && !url.search) {
    e.respondWith(caches.open(APP).then(function (c) {
      return c.match(url.pathname).then(function (hit) {
        return hit || fetchInto(APP, req, url.pathname);
      });
    }));
    return;
  }

  if (DATA_PATH.test(url.pathname)) {
    e.respondWith(fromPhone(e, DATA, req, DATA_FRESH));
    return;
  }

  if (MEDIA_EXT.test(url.pathname)) {
    e.respondWith(fromPhone(e, MEDIA, req, MEDIA_FRESH));
    return;
  }

  /* Anything else (old /src/ scripts named by a page kept from before the
     bundle, robots.txt, sitemaps): the browser's own handling. */
});

/* ============================================================================
   Mobile Parts Finder · analytics.js — the visitor analytics collector
   ----------------------------------------------------------------------------
   Records meaningful events and posts them to /api/events in batches.

   ----------------------------------------------------------------------------
   THE RULE THIS FILE OBEYS ABOVE ALL OTHERS: IT CANNOT BREAK THE SITE

   Analytics is the least important thing on this page. A shop owner looking up
   a part must never see a slower page, a failed search or a console full of
   errors because a tracking call went wrong. So:

     · every public method is wrapped and swallows its own errors
     · nothing is awaited by any caller — track() returns immediately
     · a failed POST is dropped, not retried into a loop
     · with the endpoint unreachable the queue is capped and then discarded
     · no event is sent from a page that has not finished loading

   If this whole file were deleted the site would work identically. That is the
   design, not a happy accident.

   ----------------------------------------------------------------------------
   WHAT IT SENDS, AND WHAT IT REFUSES TO

   Only the event types the server allowlists, and only the metadata fields
   each type declares — the server drops anything else, and this end does not
   bother sending it.

   NO fingerprinting. The session id is `crypto.randomUUID()` — a random string
   this browser generates for itself and stores in sessionStorage. It is not
   derived from the screen size, the fonts, the canvas, the user agent or
   anything else about the device, and it is deliberately per-TAB-session
   rather than permanent: it identifies a visit, not a person.

   NO page content, no form values, no keystrokes, no scroll depth, no mouse
   movement. A search TERM is sent, because "what are shops looking for" is the
   business question the whole catalogue exists to answer — and it is redacted
   server-side for anything resembling a phone number or an email.

   ----------------------------------------------------------------------------
   WHY IT BATCHES

   Typing "samsung galaxy m21" fires a search on every keystroke. Sending
   eighteen events for one search would cost eighteen requests, eighteen
   Firestore writes and a top-search-terms list full of "sam", "sams",
   "samsu". So a search is debounced here — the browser knows when typing has
   stopped and the server does not — and everything else rides along in the
   same flush.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var ENDPOINT = '/api/events';
  var SESSION_KEY = 'mpf.analytics.session';
  var VISITED_KEY = 'mpf.analytics.visited';

  /* How long a batch waits for company before being sent. Long enough to
     collect a burst, short enough that a visitor who leaves has already had
     their events sent. */
  var FLUSH_MS = 2500;

  /* A search is only recorded once the typing stops. */
  var SEARCH_DEBOUNCE_MS = 900;

  /* The most events held while offline before the oldest are dropped. A queue
     that grows without limit is a memory leak on a page left open all day. */
  var MAX_QUEUE = 40;

  var queue = [];
  var flushTimer = null;
  var searchTimer = null;
  var enabled = true;
  var started = false;

  /* --------------------------------------------------------------- session

     A random id per browsing session, in sessionStorage so it ends when the
     tab does. Nothing about the device goes into it. */
  function sessionId() {
    try {
      var existing = sessionStorage.getItem(SESSION_KEY);
      if (existing) return existing;

      var id = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID().replace(/-/g, '')
        : randomFallback();
      sessionStorage.setItem(SESSION_KEY, id);
      return id;
    } catch (e) {
      /* Private mode refuses storage. The visit is then simply anonymous with
         no session at all, which is a fine outcome and not an error. */
      return null;
    }
  }

  function randomFallback() {
    var out = '';
    var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    if (global.crypto && global.crypto.getRandomValues) {
      var bytes = new Uint8Array(24);
      global.crypto.getRandomValues(bytes);
      for (var i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
      return out;
    }
    /* No crypto at all: an old browser. Math.random is not a security
       primitive and this is not a security decision — a session id only needs
       to be unlikely to collide. */
    for (var j = 0; j < 24; j++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }

  /* ---------------------------------------------------------------- sending */

  function flush(useBeacon) {
    if (!queue.length || !enabled) return;

    var events = queue.splice(0, queue.length);
    var payload = JSON.stringify({
      events: events,
      sessionId: sessionId(),
      source: 'web'
    });

    /* On the way out of the page, sendBeacon is the only thing that survives
       the navigation. It cannot carry an Authorization header, so those events
       arrive anonymous — which is the right trade against losing them. */
    if (useBeacon && global.navigator && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
        return;
      } catch (e) { /* fall through to fetch */ }
    }

    tokenHeader().then(function (headers) {
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: headers,
        body: payload,
        keepalive: true
      });
    }).catch(function () {
      /* Dropped on purpose. Re-queueing a failed batch is how a broken
         endpoint turns into a request loop that makes the site slower the
         longer it stays broken. */
    });
  }

  /**
   * The Authorization header when a user is signed in.
   *
   * Attribution is a nicety: an event with no token is recorded anonymously
   * and still counted. So a token that takes a moment must not delay the
   * batch, and a token that fails must not lose it.
   */
  function tokenHeader() {
    var plain = { 'Content-Type': 'application/json' };
    if (!SM.fb || !SM.fb.isConfigured || !SM.fb.isConfigured()) {
      return Promise.resolve(plain);
    }
    if (!SM.fb.user || !SM.fb.user()) return Promise.resolve(plain);

    return SM.fb.idToken().then(function (token) {
      if (!token) return plain;
      return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    }, function () { return plain; });
  }

  function schedule() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      flush(false);
    }, FLUSH_MS);
  }

  /* ------------------------------------------------------------------- api */

  var analytics = {
    /**
     * Records one event. Returns immediately and never throws.
     *
     * @param {string} eventType must be on the server's allowlist
     * @param {object} [metadata] only the fields that type declares survive
     */
    track: function (eventType, metadata) {
      try {
        if (!enabled || !started || typeof eventType !== 'string') return;

        queue.push({ eventType: eventType, metadata: metadata || {} });
        /* Oldest first: a queue that has overflowed is one where the recent
           events are the interesting ones. */
        while (queue.length > MAX_QUEUE) queue.shift();

        schedule();
      } catch (e) { /* analytics must never surface */ }
    },

    /**
     * A search, debounced until the typing stops.
     *
     * @param {string} query
     * @param {object} detail { searchType, matchedResultCount, categoryId, brandId }
     */
    trackSearch: function (query, detail) {
      try {
        if (!enabled || !started) return;
        var q = String(query || '').trim();
        if (q.length < 2) return;

        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          var d = detail || {};
          var count = Number(d.matchedResultCount);

          analytics.track('model_search', {
            searchQuery: q,
            searchType: d.searchType || 'free_text',
            matchedResultCount: Number.isFinite(count) ? count : 0,
            categoryId: d.categoryId,
            brandId: d.brandId
          });

          /* A search that found nothing is the one that feeds the
             missing-model queue, so it is its own event rather than a flag on
             the one above — the server queries by type. */
          if (Number.isFinite(count) && count === 0) {
            analytics.track('search_zero_result', {
              searchQuery: q,
              searchType: d.searchType || 'free_text',
              categoryId: d.categoryId
            });
          }
        }, SEARCH_DEBOUNCE_MS);
      } catch (e) { /* never surface */ }
    },

    /** Sends whatever is queued now rather than waiting for the timer. */
    flush: function () {
      try { clearTimeout(flushTimer); flushTimer = null; flush(false); }
      catch (e) { /* never surface */ }
    },

    /** The current session id, or null when storage is unavailable. */
    sessionId: sessionId,

    /**
     * Switches collection off for this browser.
     *
     * Not wired to a UI control yet — it is here so that when a preference or
     * a consent banner is added, the off switch already exists and is one line
     * to call rather than a refactor.
     */
    disable: function () { enabled = false; queue.length = 0; },
    enabled: function () { return enabled; },

    /**
     * Called once, after the app has mounted.
     *
     * Deliberately not on script load: an event sent while the page is still
     * assembling competes with the requests that draw it, and the first visit
     * event should mean "someone is looking at this", not "a script parsed".
     */
    start: function () {
      try {
        if (started) return;
        started = true;

        /* first_visit against return_visit is decided by one flag in
           localStorage — not by a device fingerprint, and not by anything that
           would identify this browser anywhere else. */
        var returning = false;
        try {
          returning = localStorage.getItem(VISITED_KEY) === '1';
          localStorage.setItem(VISITED_KEY, '1');
        } catch (e) { /* private mode: every visit reads as a first visit */ }

        var referrerHost = '';
        try {
          if (document.referrer) {
            var url = new URL(document.referrer);
            /* The host only, and never our own — a full referrer URL can carry
               a search term or a token from the site someone came from. */
            if (url.host !== location.host) referrerHost = url.host;
          }
        } catch (e) { /* unparseable referrer */ }

        analytics.track(returning ? 'return_visit' : 'first_visit', {
          landingPath: location.pathname,
          referrerHost: referrerHost
        });

        /* Anything still queued when the tab closes goes out on a beacon. */
        global.addEventListener('pagehide', function () { flush(true); });
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') flush(true);
        });
      } catch (e) { /* never surface */ }
    }
  };

  SM.analytics = analytics;
})(window);

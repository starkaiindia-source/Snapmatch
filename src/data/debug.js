/* ============================================================================
   Mobile Parts Finder · debug.js — diagnostics you can turn on from a phone
   ----------------------------------------------------------------------------
   Sign-in fails differently on a shop owner's Android than it does on a
   developer's laptop, and "it sends me back to the login page" is all the
   detail a bug report ever carries. This is how the rest of the detail gets
   collected: the auth and payment paths log every step through SM.debug, and
   the log is written only when someone asks for it.

   TURNING IT ON
     Add ?debug=1 to the URL, or run  localStorage['mpf.debug'] = '1'
     Off again: ?debug=0, or remove the key.
     The choice sticks, so it survives the redirect to Google and back — which
     is the whole point, since the interesting part happens on the return trip.

   WHAT IT MUST NEVER LOG
     ID tokens, the Razorpay key secret, webhook secrets, session cookies.
     Nothing here reads them, and nothing that calls it passes them. A uid, an
     email and an error code are enough to follow a sign-in from end to end,
     and none of the three is a credential.

   SM.debug.tail() returns the entries as an array so they can be read off a
   phone that has no console — the ring buffer is kept whether logging is on or
   off, so a failure that has already happened can still be inspected.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var KEY = 'mpf.debug';
  var RING = 200;
  var ring = [];

  function readFlag() {
    try {
      var q = String(global.location.search || '');
      if (/[?&]debug=1/.test(q)) { localStorage.setItem(KEY, '1'); return true; }
      if (/[?&]debug=0/.test(q)) { localStorage.removeItem(KEY); return false; }
      return localStorage.getItem(KEY) === '1';
    } catch (e) { return false; }        /* private mode: stay quiet */
  }

  var on = readFlag();

  /* Timestamps are relative to page load. Wall-clock time tells you nothing
     about a race; "auth resolved 2,400 ms after boot" tells you everything. */
  var t0 = (global.performance && performance.now) ? performance.now() : Date.now();
  function since() {
    var t = (global.performance && performance.now) ? performance.now() : Date.now();
    return Math.round(t - t0);
  }

  function record(scope, msg, data) {
    var entry = { t: since(), scope: scope, msg: msg };
    if (data !== undefined) entry.data = data;
    ring.push(entry);
    if (ring.length > RING) ring.shift();
    return entry;
  }

  SM.debug = {
    get enabled() { return on; },

    /** Normal step in a flow. Silent unless debugging is on. */
    log: function (scope, msg, data) {
      var e = record(scope, msg, data);
      if (on) console.log('[' + scope + ' +' + e.t + 'ms]', msg, data === undefined ? '' : data);
    },

    /** Something went wrong. ALWAYS printed — a real failure is not noise. */
    warn: function (scope, msg, data) {
      var e = record(scope, msg, data);
      console.warn('[' + scope + ' +' + e.t + 'ms]', msg, data === undefined ? '' : data);
    },

    /** Everything recorded this page load, oldest first. */
    tail: function (n) { return ring.slice(-(n || RING)); },

    /** One block of text to paste into a bug report. */
    dump: function () {
      return ring.map(function (e) {
        return '+' + e.t + 'ms [' + e.scope + '] ' + e.msg +
          (e.data === undefined ? '' : ' ' + JSON.stringify(e.data));
      }).join('\n');
    },

    set: function (v) {
      on = !!v;
      try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); }
      catch (e) { /* private mode */ }
      return on;
    }
  };

  if (on) console.log('[debug] Mobile Parts Finder diagnostics on — SM.debug.dump() to copy the log');
})(window);

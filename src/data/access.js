/* ============================================================================
   Mobile Parts Finder · access.js — the browser's view of what it may do
   ----------------------------------------------------------------------------
   One place the whole app asks "is this account free or paid, and how many
   free searches are left today".

   ----------------------------------------------------------------------------
   THIS FILE DECIDES NOTHING

   It caches an answer the SERVER gave and hands it to whatever is drawing a
   button. Every limit it reports is also enforced in api/access.js, on data
   the browser never receives:

     · a free search is spent by POSTing to the server, which counts it against
       the uid in Firestore. Editing `state.access` here does not create a
       credit, because the credit is not stored here.
     · a group's member list arrives already cut to the tier. The withheld
       names are not in the response, so there is no variable to change and no
       DOM node to unhide.
     · the tier comes from the stored subscription, read server side.

   So the worst an edit in the console achieves is a wrong-looking counter and
   a search that comes back 429 anyway.

   ----------------------------------------------------------------------------
   IT FOLLOWS THE ACCOUNT, NOT THE DEVICE

   `reset()` runs on every sign-in and sign-out, so signing out and signing in
   as somebody else does not inherit the previous account's counter or its
   tier. Nothing about entitlement is kept in localStorage for the same reason
   the server does not trust one: it is the thing being limited.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* What we last heard from the server. `null` means "not asked yet", which is
     NOT the same as "free" — a screen that treats an unanswered question as a
     denial paints a paywall over a subscriber's page for as long as the
     request takes. */
  var state = null;
  var inFlight = null;
  var listeners = [];

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { /* a listener must not break access */ }
    });
  }

  /* Authorization header when signed in, plain when not. A signed-out visitor
     is a legitimate caller here — they get the free view. */
  function headers() {
    var plain = { 'Content-Type': 'application/json' };
    if (!SM.fb || !SM.fb.isConfigured() || !SM.fb.user()) return Promise.resolve(plain);
    return SM.fb.idToken().then(function (token) {
      if (!token) return plain;
      return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    }, function () { return plain; });
  }

  var access = {
    /** The last known answer, or null before the first one arrives. */
    get: function () { return state; },

    /** True only when the server has SAID so. Unknown is not paid. */
    isPaid: function () { return !!(state && state.paid); },

    /**
     * Not paid, as far as the server is concerned.
     *
     * Includes a signed-out visitor: they are certainly not a subscriber, and
     * the paid features should be gated for them too. Requiring `signedIn`
     * here let anyone see the whole group filter simply by signing out, which
     * is the opposite of a restriction.
     *
     * Still false before the first answer arrives — an unanswered question is
     * not a denial, and treating it as one paywalls a subscriber for as long
     * as the request takes.
     */
    isFree: function () { return !!(state && !state.paid); },

    /** Signed in AND not paid — the account that has a daily allowance. */
    isMeteredAccount: function () { return !!(state && state.signedIn && !state.paid); },

    /** Free searches left today, or null for a paid account / unknown. */
    remaining: function () {
      return state && !state.paid ? state.dailySearchesRemaining : null;
    },

    onChange: function (fn) {
      listeners.push(fn);
      if (state) fn(state);
      return function () {
        var i = listeners.indexOf(fn);
        if (i > -1) listeners.splice(i, 1);
      };
    },

    /**
     * Asks the server. Repeat calls while one is in flight share it, so a page
     * that paints three panels does not send three requests.
     */
    refresh: function () {
      if (inFlight) return inFlight;
      inFlight = headers().then(function (h) {
        return fetch('/api/access', { headers: h });
      }).then(function (r) {
        return r.json().catch(function () { return null; });
      }).then(function (data) {
        inFlight = null;
        if (data && typeof data.tier === 'string') { state = data; emit(); }
        return state;
      }).catch(function (err) {
        inFlight = null;
        /* Unreachable is not "free". Leaving the last known answer in place
           means a dropped request does not paywall a subscriber mid-session. */
        SM.debug.warn('access', 'refresh failed', { message: err && err.message });
        return state;
      });
      return inFlight;
    },

    /**
     * Spends one free search.
     *
     * The credit is spent HERE, once, when a search is actually run — never
     * while typing. Autocomplete does not call this.
     *
     * @returns {Promise<{allowed:boolean, access:object|null, limitReached:boolean}>}
     *          Resolves for a refusal too: being out of searches is an outcome
     *          the caller renders, not an exception it has to catch.
     */
    consumeSearch: function () {
      /* A paid account is not metered and does not need a round trip. The
         server agrees independently, so this is a saved request rather than a
         decision — a browser that lied about being paid would still be metered
         by the next thing it asked for. */
      if (access.isPaid()) return Promise.resolve({ allowed: true, access: state, limitReached: false });

      return headers().then(function (h) {
        return fetch('/api/access', { method: 'POST', headers: h, body: '{}' });
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          if (data && data.access) { state = data.access; emit(); }
          return {
            allowed: r.ok,
            access: state,
            limitReached: r.status === 429,
            needsSignIn: r.status === 401
          };
        });
      }).catch(function (err) {
        /* FAILS CLOSED. The server could not be reached, so the search cannot
           be metered — and a search that cannot be metered must not run.

           Allowing it would make "turn the network off after the page loads"
           an unlimited-search bypass, which is exactly the kind of hole the
           limit exists to close. The catalogue is cached, so the page would
           otherwise happily keep answering.

           The cost is that a genuine outage stops free searching. Paid
           accounts are unaffected: isPaid() returns above without a request. */
        SM.debug.warn('access', 'consume failed, refusing the search', { message: err && err.message });
        return { allowed: false, access: state, limitReached: false, offline: true };
      });
    },

    /**
     * A group's members, cut to this account's tier by the server.
     *
     * @returns {Promise<{members:Array, memberCount:number, lockedCount:number,
     *                    locked:boolean, partCode:string|null}|null>}
     */
    groupMembers: function (groupId) {
      return headers().then(function (h) {
        return fetch('/api/device-parts?groupId=' + encodeURIComponent(groupId), { headers: h });
      }).then(function (r) {
        if (!r.ok) return null;
        return r.json();
      }).then(function (data) {
        if (!data) return null;
        if (data.access) { state = data.access; emit(); }
        return data.group || null;
      }).catch(function (err) {
        SM.debug.warn('access', 'group members unavailable', { groupId: groupId, message: err && err.message });
        return null;
      });
    },

    /** Forgets everything. Called on sign-in and sign-out — see the header. */
    reset: function () {
      state = null;
      inFlight = null;
      emit();
    }
  };

  SM.access = access;
})(window);

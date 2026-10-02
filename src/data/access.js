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

   ----------------------------------------------------------------------------
   AN ANSWER BELONGS TO WHOEVER ASKED

   The server answers the caller it can see. A request with no ID token is a
   signed-out visitor, and the truthful answer to that is "free" — so a request
   sent one moment before Firebase finishes restoring a session comes back
   free for a shop that has paid.

   That is exactly what happened to a yearly subscriber on 2 October 2026. The
   page asked as soon as the catalogue loaded, `SM.fb.user()` was still null
   because the auth SDK was still reading IndexedDB, the request went out with
   no Authorization header, and the signed-out answer was then kept as that
   subscriber's tier for the rest of the page. Opening a group sent them to
   the Plans page they had already paid on.

   Three rules close it, and each holds without the other two:

     1. A request WAITS for the session this browser expects. If the local
        session says someone is signed in, nothing is sent until Firebase has
        said who. A visitor with no session is not made to wait, and is not
        made to download the sign-in SDK to be told they are a visitor.
     2. An answer is kept only if the account that ASKED is still the account
        on the page when it lands. Anything else is dropped and asked again.
     3. A change of account — a session restored, a sign-in, a sign-out —
        throws the held answer away and asks as the new one.

   And a token the server could not verify (401) is not a verdict on the
   account. It is refreshed once and retried; if that fails too the state
   stays UNKNOWN, which gates nothing and unlocks nothing.
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
  /* modelId -> the in-flight or settled promise for its group list. */
  var deviceCache = Object.create(null);
  /* Bumped by reset(). An answer that was asked for before the last reset is
     an answer about the previous account, wherever it is in its round trip. */
  var epoch = 0;
  /* The uid the auth listener last acted on. `undefined` until it has heard
     anything at all, so the first announcement — including "nobody" — counts. */
  var watchedUid;

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { /* a listener must not break access */ }
    });
  }

  var PLAIN = { 'Content-Type': 'application/json' };

  /** The uid Firebase has on the page right now, or null. */
  function currentUid() {
    var u = SM.fb && SM.fb.user ? SM.fb.user() : null;
    return u ? u.uid : null;
  }

  /* Does this browser remember being signed in? A HINT, read from the local
     session, and it decides one thing only: whether to wait for Firebase
     before asking. It grants nothing — what comes back is still decided by
     the server from the token, or the absence of one. */
  function sessionExpected() {
    try { return !!(SM.session && SM.session.get().signedIn); }
    catch (e) { return false; }
  }

  /**
   * Who a request is about to be sent as, and the headers that say so.
   *
   * @param {boolean} [forceToken]  mint a new ID token rather than reuse the
   *        cached one — the retry after the server refused the last one
   * @returns {Promise<{uid:string|null, headers:object}>}
   */
  function caller(forceToken) {
    var anonymous = { uid: null, headers: PLAIN };
    if (!SM.fb) return Promise.resolve(anonymous);

    var settled;
    if (SM.fb.phase && SM.fb.phase() === 'loading') {
      /* Firebase has not answered yet. With no remembered session this is
         almost certainly a visitor, and they get the free view now; if a user
         does turn up, the auth listener below asks again as them. */
      if (!sessionExpected()) return Promise.resolve(anonymous);
      settled = SM.fb.whenResolved();
    } else {
      settled = Promise.resolve(SM.fb.user ? SM.fb.user() : null);
    }

    return settled.then(function (user) {
      if (!user) return anonymous;
      return SM.fb.idToken(!!forceToken).then(function (token) {
        /* Signed in but no token could be had. Sent as the account anyway, so
           the answer is still filed against the right uid. */
        if (!token) return { uid: user.uid, headers: PLAIN };
        return {
          uid: user.uid,
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
        };
      });
    }, function () { return anonymous; });
  }

  /**
   * One request to the entitlement API, sent as whoever is signed in.
   *
   * A 401 on a request that carried a token means the server could not verify
   * it — expired between the cache and the wire, a clock that is out, a
   * session revoked elsewhere. A new token is minted and the request repeated
   * ONCE. It is never read as "this account is free".
   *
   * @returns {Promise<{res:Response, data:object|null, who:{uid:string|null}}>}
   */
  function call(path, init, retried) {
    return caller(retried).then(function (who) {
      var options = { headers: who.headers };
      if (init && init.method) options.method = init.method;
      if (init && init.body) options.body = init.body;

      return fetch(path, options).then(function (res) {
        if (res.status === 401 && who.uid && !retried) {
          SM.debug.warn('access', 'token refused, refreshing it and retrying', { path: path });
          return call(path, init, true);
        }
        return res.json().catch(function () { return null; }).then(function (data) {
          return { res: res, data: data, who: who };
        });
      });
    });
  }

  /**
   * Keeps an answer, if it is an answer about the account on the page.
   *
   * @returns {boolean} whether it was kept
   */
  function accept(next, who, ticket) {
    if (!next || typeof next.tier !== 'string') return false;
    /* reset() ran while this was in flight: it describes the previous account. */
    if (ticket !== epoch) return false;
    /* The account changed while this was in flight — most often a session
       restored a moment after an anonymous request left. */
    if (who.uid !== currentUid()) return false;
    /* A token went out and the server still answered as if nobody was there.
       That is the server failing to recognise the caller, not a tier. */
    if (who.uid && next.signedIn === false) return false;
    state = next;
    emit();
    return true;
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
      var ticket = epoch;

      var mine = call('/api/access').then(function (r) {
        if (inFlight === mine) inFlight = null;
        if (ticket !== epoch) return state;            /* superseded by reset() */

        if (r.who.uid !== currentUid()) {
          /* Asked as one identity, answered for another. Ask again as the
             account that is actually here. */
          SM.debug.log('access', 'identity changed while asking — asking again');
          return access.refresh();
        }
        if (!accept(r.data, r.who, ticket) && r.who.uid) {
          SM.debug.warn('access', 'no usable answer for this account',
                        { status: r.res.status });
        }
        return state;
      }).catch(function (err) {
        if (inFlight === mine) inFlight = null;
        /* Unreachable is not "free". Leaving the last known answer in place
           means a dropped request does not paywall a subscriber mid-session. */
        SM.debug.warn('access', 'refresh failed', { message: err && err.message });
        return state;
      });
      inFlight = mine;
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

      var ticket = epoch;
      return call('/api/access', { method: 'POST', body: '{}' }).then(function (r) {
        var data = r.data || {};
        accept(data.access, r.who, ticket);
        return {
          allowed: r.res.ok,
          access: state,
          limitReached: r.res.status === 429,
          needsSignIn: r.res.status === 401
        };
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
      var ticket = epoch;
      return call('/api/device-parts?groupId=' + encodeURIComponent(groupId)).then(function (r) {
        if (!r.res.ok || !r.data) return null;
        accept(r.data.access, r.who, ticket);
        return r.data.group || null;
      }).catch(function (err) {
        SM.debug.warn('access', 'group members unavailable', { groupId: groupId, message: err && err.message });
        return null;
      });
    },

    /**
     * Every group that fits one device, per category, cut to this account's
     * tier by the server.
     *
     * THIS REPLACED A LOCAL LOOKUP. The map of device -> groups used to be in
     * assets/dataset.json, which is one unauthenticated GET, and inverting it
     * handed anybody the full member list of all 3,384 groups. The bundle now
     * carries per-category COUNTS only, and the ids — with the members, for a
     * subscriber — come from here.
     *
     * Cached per model for the life of the page: opening a group, going back,
     * and opening it again is one request, not three. The cache is dropped by
     * reset(), which runs on every sign-in and sign-out, so a free account
     * cannot read a subscriber's answer out of it after a handover at the
     * counter.
     *
     * @returns {Promise<{categories:Array}|{unavailable:true}|null>}
     *          null  — the server has no such device
     *          unavailable — it could not answer; NOT the same as "no parts",
     *          and the caller must not render one as the other.
     */
    deviceGroups: function (modelId) {
      if (!modelId) return Promise.resolve(null);
      if (deviceCache[modelId]) return deviceCache[modelId];

      var ticket = epoch;
      var cache = deviceCache;
      var req = call('/api/device-parts?modelId=' + encodeURIComponent(modelId)).then(function (r) {
        var data = r.data;
        accept(data && data.access, r.who, ticket);
        /* Answered for an identity that is no longer the one on the page. The
           member lists in it were cut to THAT caller's tier, so it must not
           stay in the cache to be served to this one. */
        if (r.who.uid !== currentUid() && cache[modelId] === req) delete cache[modelId];
        if (r.res.status === 404) return null;
        if (!r.res.ok) {
          /* Forget it, so a retry after the outage is a real request rather
             than the cached failure. */
          if (cache[modelId] === req) delete cache[modelId];
          SM.debug.warn('access', 'device parts unavailable',
                        { modelId: modelId, status: r.res.status, error: data && data.error });
          return { unavailable: true, status: r.res.status };
        }
        return (data && data.device) || null;
      }).catch(function (err) {
        if (cache[modelId] === req) delete cache[modelId];
        SM.debug.warn('access', 'device parts request failed',
                      { modelId: modelId, message: err && err.message });
        return { unavailable: true, status: 0 };
      });

      deviceCache[modelId] = req;
      return req;
    },

    /** Drops one device's cached answer, so a retry is a real request. */
    forgetDevice: function (modelId) {
      if (modelId) delete deviceCache[modelId];
    },

    /** Forgets everything. Called on sign-in and sign-out — see the header. */
    reset: function () {
      state = null;
      inFlight = null;
      /* Every request already on its way was asked as the previous account. */
      epoch++;
      /* The per-device answers were cut to the PREVIOUS account's tier. Keeping
         them across a sign-out would leave a subscriber's member lists in
         memory for whoever signs in next on a shared counter machine. */
      deviceCache = Object.create(null);
      emit();
    }
  };

  /* ------------------------------------------------ the account, whoever it is

     Rule 3 from the header. Firebase announces every change of account here —
     a session restored after the page loaded, a sign-in, a sign-out — and the
     answer this module holds is about whoever was there before.

     Registering costs nothing: onChange only records the listener, it does not
     load the SDK. A token refresh for the SAME account announces the same uid
     and is ignored, so this fires once per change of person, not once an
     hour. */
  if (SM.fb && SM.fb.onChange) {
    SM.fb.onChange(function (user) {
      var uid = user ? user.uid : null;
      if (uid === watchedUid) return;
      var first = watchedUid === undefined;
      watchedUid = uid;

      if (first && state === null) {
        /* Firebase's first word, and nothing is held yet. A request already in
           flight either waited for this session and is about to be sent as it,
           or left anonymously and will be refused by rule 2 when it lands —
           there is nothing to throw away. All that is needed is that a
           signed-in account has a question outstanding at all. */
        if (uid && !inFlight) access.refresh();
        return;
      }
      /* The first word being "nobody" changes nothing that was asked
         anonymously — that answer is already the right one. */
      if (first && !uid && !state.signedIn) return;

      SM.debug.log('access', 'account changed — asking again', { signedIn: !!uid });
      access.reset();
      access.refresh();
    });
  }

  SM.access = access;
})(window);

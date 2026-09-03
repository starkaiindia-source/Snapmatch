/* ============================================================================
   Mobile Parts Finder · firebase.js — real Firebase Authentication
   ----------------------------------------------------------------------------
   Identity for the billing system. Every call to /api/* that can move money or
   grant access carries a Firebase ID token from here, and the server decides
   who the caller is by verifying it. A uid sent in a request body would be a
   free subscription for anyone who can open dev tools, so this is the only way
   the app names a user.

   CONFIGURATION
     Nothing is hardcoded here. The config comes from /api/firebase-config,
     which reads it from the Vercel environment:

       FIREBASE_PROJECT_ID       mobilepartsfinder
       FIREBASE_API_KEY
       FIREBASE_APP_ID
       FIREBASE_MESSAGING_SENDER_ID    (optional)
       FIREBASE_STORAGE_BUCKET         (derived from the project id if unset)
       FIREBASE_MEASUREMENT_ID         (optional)

     Values come from
       Firebase console -> Project settings -> General -> Your apps -> SDK setup

     They are PUBLIC by design: they identify the project to the browser and
     the SDK cannot reach it without them. What protects the data is Firestore
     rules and the authorised-domain list, not secrecy. The service-account
     key — the dangerous one — stays on the server and never appears here.

     Also add www.mobilepartsfinder.com under
       Authentication -> Settings -> Authorised domains
     or the Google popup closes immediately with auth/unauthorized-domain.

   UNCONFIGURED IS A STATE, NOT A CRASH
     With the config blank, isConfigured() returns false and the UI says so
     plainly. It does not fall back to a fake sign-in: a pretend identity would
     let the app show a subscription that no payment backs.

   The SDK is loaded on first use rather than on page load — most visits never
   sign in, and it is ~200 KB they should not have to pay for.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* ------------------------------------------------------------------ config
     Fetched from /api/firebase-config, which reads it from the Vercel
     environment. Nothing is hardcoded here.

     Being plain about what this is: the Firebase web config is NOT a secret.
     Every value in it ships to every visitor by design — the SDK cannot reach
     the project without it, and `apiKey` is a project identifier rather than a
     credential. Keeping it in the environment means one place to change and
     nothing to edit in source; what actually protects the data is Firestore
     Security Rules and the authorised-domain list.

     The genuinely dangerous credential is the service-account key the billing
     functions use. That never leaves the server. */
  var config = null;
  var configLoad = null;
  var configState = { checked: false, configured: false, missing: [] };

  function loadConfig() {
    if (configLoad) return configLoad;
    configLoad = fetch('/api/firebase-config')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        configState.checked = true;
        configState.configured = !!d.configured;
        configState.missing = d.missing || [];
        if (d.configured) config = d.config;
        return config;
      })
      .catch(function (err) {
        /* A failed fetch is "not configured", not a crash: the rest of the
           site — catalogue, search, browsing — works without Firebase, and
           should not go down because sign-in is unavailable. */
        configState.checked = true;
        configState.configured = false;
        configState.missing = ['/api/firebase-config unreachable'];
        console.warn('[firebase] config unavailable:', err && err.message);
        return null;
      });
    return configLoad;
  }

  var SDK_VERSION = '10.14.1';
  var SDK = [
    'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-auth-compat.js'
  ];

  var loading = null;
  var listeners = [];
  var currentUser = null;

  /* Synchronous, so every existing caller keeps working. It answers from the
     config already fetched at boot; before that it is honestly false. */
  function isConfigured() {
    return !!(config && config.apiKey && config.projectId);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* Loads the SDK once and wires the auth listener. Repeat calls share the
     same promise, so two buttons pressed together do not load it twice. */
  function ready() {
    if (loading) return loading;

    /* One place initialises Firebase, once. Config first, then the SDK, then
       initializeApp — and only if no app exists, because a second
       initializeApp with the same name throws. */
    loading = loadConfig().then(function (cfg) {
      if (!cfg) {
        var e = new Error('firebase-not-configured');
        e.code = 'unconfigured';
        e.missing = configState.missing;
        throw e;
      }
      return SDK.reduce(function (chain, src) {
        return chain.then(function () { return loadScript(src); });
      }, Promise.resolve());
    }).then(function () {
      var fb = global.firebase;
      if (!fb) throw new Error('firebase sdk did not load');
      if (!fb.apps.length) fb.initializeApp(config);

      fb.auth().onAuthStateChanged(function (user) {
        currentUser = user || null;
        listeners.forEach(function (fn) {
          try { fn(currentUser); } catch (e) { /* a listener must not break auth */ }
        });
      });
      return fb;
    }).catch(function (err) {
      loading = null;                       /* let a later attempt retry */
      throw err;
    });

    return loading;
  }

  SM.fb = {
    isConfigured: isConfigured,
    /* Read-only view for diagnostics. Never the source of truth — `config` is. */
    configState: configState,
    projectId: function () { return config ? config.projectId : null; },
    loadConfig: loadConfig,
    app: function () { return global.firebase && global.firebase.apps[0]; },
    ready: ready,

    /** Google sign-in. Opens the real account chooser. */
    signIn: function () {
      return ready().then(function (fb) {
        var provider = new fb.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        return fb.auth().signInWithPopup(provider).then(function (result) {
          return result.user;
        });
      });
    },

    signOut: function () {
      return ready().then(function (fb) { return fb.auth().signOut(); });
    },

    user: function () { return currentUser; },

    /**
     * A fresh ID token for the Authorization header.
     *
     * `getIdToken(false)` returns the cached token and refreshes it only when
     * it is close to expiring, so this is cheap to call before every request —
     * which is the point. Holding one token for the life of the page means a
     * long session starts failing with 401s an hour in.
     */
    idToken: function () {
      return ready().then(function (fb) {
        var u = fb.auth().currentUser;
        if (u) return u.getIdToken(false);

        /* currentUser is null until onAuthStateChanged has fired once, and
           restoring a session from IndexedDB takes a moment. The local profile
           says "signed in" the instant the page loads, so a subscriber who
           clicks Subscribe straight away would otherwise get a null token and
           a "could not start payment" for a session that is perfectly valid.
           Wait for the first auth callback instead of guessing. */
        return new Promise(function (resolve) {
          var settled = false;
          var off = fb.auth().onAuthStateChanged(function (user) {
            if (settled) return;
            settled = true;
            off();
            resolve(user ? user.getIdToken(false) : null);
          });
          /* Never hang the button: if auth says nothing at all, treat it as
             signed out and let the caller ask for a sign-in. */
          setTimeout(function () {
            if (settled) return;
            settled = true;
            off();
            resolve(null);
          }, 8000);
        });
      });
    },

    /** Fires on sign-in, sign-out and token refresh. Returns an unsubscribe. */
    onChange: function (fn) {
      listeners.push(fn);
      if (currentUser) fn(currentUser);
      return function () {
        var i = listeners.indexOf(fn);
        if (i > -1) listeners.splice(i, 1);
      };
    },

    /** Wakes the SDK so a returning session is restored without a click. */
    restore: function () {
      return ready().then(function (fb) {
        return new Promise(function (resolve) {
          var off = fb.auth().onAuthStateChanged(function (u) { off(); resolve(u || null); });
        });
      }).catch(function () { return null; });
    }
  };
})(window);

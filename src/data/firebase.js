/* ============================================================================
   Mobile Parts Finder · firebase.js — real Firebase Authentication
   ----------------------------------------------------------------------------
   Identity for the billing system. Every call to /api/* that can move money or
   grant access carries a Firebase ID token from here, and the server decides
   who the caller is by verifying it. A uid sent in a request body would be a
   free subscription for anyone who can open dev tools, so this is the only way
   the app names a user.

   CONFIGURATION
     Fill in FIREBASE_CONFIG below from
       Firebase console -> Project settings -> General -> Your apps -> SDK setup
     Those values are PUBLIC by design. They identify the project to the
     browser; what protects the data is Firestore rules and the authorised-
     domain list, not secrecy. The service-account key — the dangerous one —
     stays on the server and never appears in this directory.

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

  /* Two of these are fixed by the project id and are filled in. The other two
     come from the console and are the only thing left to paste:
       Firebase console -> Project settings -> General -> Your apps -> SDK setup

     All four are PUBLIC. They identify the project to the browser; what
     protects the data is Firestore rules and the authorised-domain list, not
     secrecy. The dangerous credential is the service-account key, and that
     lives in the Vercel environment, never in this directory. */
  var FIREBASE_CONFIG = {
    apiKey: '',                                     /* <-- paste */
    authDomain: 'mobilepartsfinder.firebaseapp.com',
    projectId: 'mobilepartsfinder',
    appId: ''                                       /* <-- paste */
  };

  var SDK_VERSION = '10.14.1';
  var SDK = [
    'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/firebase-auth-compat.js'
  ];

  var loading = null;
  var listeners = [];
  var currentUser = null;

  function isConfigured() {
    return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.authDomain && FIREBASE_CONFIG.projectId);
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
    if (!isConfigured()) return Promise.reject(new Error('firebase-not-configured'));
    if (loading) return loading;

    loading = SDK.reduce(function (chain, src) {
      return chain.then(function () { return loadScript(src); });
    }, Promise.resolve()).then(function () {
      var fb = global.firebase;
      if (!fb) throw new Error('firebase sdk did not load');
      if (!fb.apps.length) fb.initializeApp(FIREBASE_CONFIG);

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
    config: FIREBASE_CONFIG,

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
        if (!u) return null;
        return u.getIdToken(false);
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
      if (!isConfigured()) return Promise.resolve(null);
      return ready().then(function (fb) {
        return new Promise(function (resolve) {
          var off = fb.auth().onAuthStateChanged(function (u) { off(); resolve(u || null); });
        });
      }).catch(function () { return null; });
    }
  };
})(window);

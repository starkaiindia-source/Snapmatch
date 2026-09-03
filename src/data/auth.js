/* ============================================================================
   Mobile Parts Finder · auth.js — Google Sign-In + shop profile store
   ----------------------------------------------------------------------------
   GOING LIVE
     Set GOOGLE_CLIENT_ID below to an OAuth 2.0 Web client ID from
     Google Cloud Console (APIs & Services -> Credentials), with the deployed
     origin added under "Authorised JavaScript origins", e.g.
        https://www.mobilepartsfinder.com
     The moment that constant is filled in, SM.auth.signIn() loads Google
     Identity Services and opens the real account chooser showing the Google
     accounts already signed in on the device. Nothing else needs changing.

   WITHOUT A CLIENT ID
     There is no way to reach the device's Google accounts, so signIn() opens
     a clearly-labelled demo chooser instead. It never presents itself as
     Google's own UI.

   TOKEN VERIFICATION
     GIS returns a signed JWT credential. A production build must send that
     credential to a backend and verify its signature, `aud` and `iss` against
     Google's public keys before trusting it — see SM.auth.verifyEndpoint.
     Profiles are stored locally here because this build has no server.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  /* ---------------------------------------------------------------- storage
     The rebrand renamed every key snapmatch.* -> mpf.*. Carry anything saved
     under an old key across once so a returning browser keeps its theme,
     recent searches, shop profile and subscription. auth.js loads before
     api.js and app.js, so this runs before the first read. Safe to delete a
     release or two from now. */
  (function migrateStorageKeys() {
    var moved = {
      'snapmatch.theme':       'mpf.theme',
      'snapmatch.recent.v1':   'mpf.recent.v1',
      'snapmatch.profiles.v1': 'mpf.profiles.v1',
      'snapmatch.session.v2':  'mpf.session.v2'
    };
    try {
      Object.keys(moved).forEach(function (old) {
        var v = localStorage.getItem(old);
        if (v === null) return;
        if (localStorage.getItem(moved[old]) === null) localStorage.setItem(moved[old], v);
        localStorage.removeItem(old);
      });
    } catch (e) { /* private mode */ }
  }());

  var GOOGLE_CLIENT_ID = '';                 /* <-- paste the client ID here */
  var VERIFY_ENDPOINT = '';                  /* <-- backend token verifier    */
  var GSI_SRC = 'https://accounts.google.com/gsi/client';

  var PROFILE_KEY = 'mpf.profiles.v1';

  function readStore() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function writeStore(s) {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(s)); } catch (e) { /* private mode */ }
  }

  /* base64url JWT payload -> object (display only; never a substitute for
     server-side signature verification) */
  function decodeJwt(tok) {
    try {
      var p = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(atob(p).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')));
    } catch (e) { return null; }
  }

  var gsiLoading = null;
  function loadGsi() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve(true);
    if (gsiLoading) return gsiLoading;
    gsiLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = GSI_SRC; s.async = true; s.defer = true;
      s.onload = function () { resolve(true); };
      s.onerror = function () { reject(new Error('Could not reach Google Sign-In.')); };
      document.head.appendChild(s);
    });
    return gsiLoading;
  }

  SM.auth = {
    configured: function () { return !!GOOGLE_CLIENT_ID; },
    clientId: GOOGLE_CLIENT_ID,
    verifyEndpoint: VERIFY_ENDPOINT,

    /* Opens the real Google account chooser when configured.
       Resolves with { sub, email, name, picture } or rejects:
         code 'unconfigured' | 'cancelled' | 'network' | 'failed'          */
    signInWithGoogle: function () {
      if (!GOOGLE_CLIENT_ID) {
        var e = new Error('Google Sign-In is not configured yet.');
        e.code = 'unconfigured';
        return Promise.reject(e);
      }
      return loadGsi().then(function () {
        return new Promise(function (resolve, reject) {
          var settled = false;
          google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            auto_select: false,
            cancel_on_tap_outside: true,
            callback: function (res) {
              settled = true;
              var claims = decodeJwt(res.credential);
              if (!claims || !claims.sub) {
                var er = new Error('Google returned an unreadable response.');
                er.code = 'failed'; reject(er); return;
              }
              /* production: POST res.credential to VERIFY_ENDPOINT and let the
                 server confirm the signature before trusting these claims */
              resolve({
                sub: claims.sub, email: claims.email, name: claims.name || '',
                picture: claims.picture || '', credential: res.credential
              });
            }
          });
          google.accounts.id.prompt(function (n) {
            if (settled) return;
            if (n.isNotDisplayed && n.isNotDisplayed()) {
              var e1 = new Error('Google could not show the account chooser.');
              e1.code = 'failed'; reject(e1);
            } else if (n.isSkippedMoment && n.isSkippedMoment()) {
              var e2 = new Error('Sign-in cancelled.');
              e2.code = 'cancelled'; reject(e2);
            }
          });
        });
      }, function () {
        var e = new Error('Could not reach Google Sign-In. Check your connection.');
        e.code = 'network';
        return Promise.reject(e);
      });
    },

    /* profile store — swap these three for backend calls when a server exists */
    findProfile: function (sub) { return readStore()[sub] || null; },
    saveProfile: function (sub, profile) {
      var s = readStore();
      s[sub] = Object.assign({}, s[sub], profile, { sub: sub, updatedAt: Date.now() });
      writeStore(s);
      return s[sub];
    },
    allProfiles: function () { return readStore(); }
  };
})(window);

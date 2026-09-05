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

  /* The stand-in account chooser is a DEVELOPMENT aid. It exists so the account
     screens can be built before an OAuth client ID is issued — but on a public
     host it would let any visitor sign in as a made-up shop and, with no
     payment backend wired up, activate a subscription for nothing.

     So it is confined to localhost. On a real domain an unconfigured sign-in
     says so and does nothing, which is the honest failure. */
  function isLocalHost() {
    var h = global.location && global.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /\.local$/.test(h || '');
  }
  SM.isLocalHost = isLocalHost;

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

  /* True when a provider's error text is a pasted HTTP response rather than a
     sentence — a URL, a status line, or a JSON body. Firebase forwards these
     verbatim, and they have been landing on the account page as a wall of
     quoted Google error JSON. Nobody who reads that page can act on it, and a
     message nobody can act on is worse than a short one, because it reads as
     the site being broken in a way that is somehow the reader's problem. */
  function rawProviderNoise(msg) {
    if (!msg) return false;
    return /https?:\/\//.test(msg) || /http status/i.test(msg) ||
           /"error"\s*:/.test(msg) || /UNAUTHENTICATED|PERMISSION_DENIED/.test(msg);
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
      /* Firebase Authentication is the real path and takes precedence the
         moment it is configured. It hands back a verified ID token, which is
         what every billing endpoint requires — the GIS path below only ever
         produced claims this app decoded for itself, which proves nothing to
         a server. */
      if (SM.fb && SM.fb.isConfigured()) {
        return SM.fb.signIn().then(function (user) {
          /* A redirect sign-in resolves to null: the browser is on its way to
             Google and the result lands on the next page load. Anything that
             looks like a failure here would be wrong. */
          if (!user) {
            var pending = new Error('redirecting to Google');
            pending.code = 'redirecting';
            throw pending;
          }
          return {
            sub: user.uid,
            email: user.email || '',
            name: user.displayName || '',
            picture: user.photoURL || '',
            emailVerified: !!user.emailVerified
          };
        }, function (err) {
          var code = err && err.code;
          var host = (global.location && global.location.hostname) || 'this domain';

          /* Name the domain. "This domain is not on the authorised list" is
             true and useless — the fix is one paste into one console field, and
             whoever reads this needs to know WHICH host to paste. It bites
             hardest on Vercel preview URLs, which change with every deployment
             and are never on the list. */
          var message =
            code === 'auth/popup-closed-by-user' || code === 'auth/user-cancelled'
              ? 'Sign-in cancelled'
          : code === 'auth/unauthorized-domain'
              ? 'Google sign-in is not allowed from ' + host + '. Add it under ' +
                'Firebase console → Authentication → Settings → Authorised domains, ' +
                'or open the site on its own domain instead of this preview URL.'
          : code === 'auth/operation-not-allowed'
              ? 'Google sign-in is switched off for this Firebase project. Enable ' +
                'the Google provider under Authentication → Sign-in method.'
          : code === 'auth/network-request-failed'
              ? 'Could not reach Google. Check the connection and try again.'
          /* Google accepted the person and then refused the SITE. Firebase's
             own message for this is a pasted HTTP response — a URL, a status
             code and a JSON body — which went straight onto the page in front
             of shop owners who can do nothing with it, and does not say the one
             thing that matters: nothing is wrong with their Google account, so
             retrying and re-retrying cannot help.

             It means the project's Google OAuth client is no longer usable —
             its secret was rotated or the client was deleted in Google Cloud,
             leaving Firebase holding a credential Google now rejects. Only the
             owner can fix that, in the console. The raw response stays in the
             debug log for whoever is doing it. */
          : code === 'auth/invalid-credential' || code === 'auth/internal-error'
              ? 'Google sign-in is not working on this site at the moment — the ' +
                'problem is with the site, not your Google account. The owner ' +
                'needs to reconnect Google sign-in in the Firebase console.'
          : rawProviderNoise(err && err.message)
              ? 'Google sign-in failed. Please try again.'
          : (err && err.message) || 'Google sign-in failed.';

          /* Whatever is shown, the untouched original is still recoverable. */
          SM.debug.warn('auth', 'google sign-in failed', {
            code: code || null, raw: (err && err.message) || null
          });

          var e = new Error(message);
          e.code = (code === 'auth/popup-closed-by-user' || code === 'auth/user-cancelled')
            ? 'cancelled' : 'failed';
          e.authCode = code || null;
          throw e;
        });
      }

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

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

   SIGN-IN USES A POPUP, INCLUDING ON PHONES
     The redirect flow keeps its pending state in storage belonging to
     `authDomain` — a different origin from the site — and mobile browsers
     partition or discard that. The user picked their Google account, came
     back, and the app found no session: the bounce-to-login bug. A popup never
     leaves the page, so nothing has to survive the trip. Redirect remains the
     fallback for browsers that cannot open one, and its result is now awaited
     during initialisation rather than raced.

     To make redirect same-origin as well, set FIREBASE_AUTH_DOMAIN to the
     site's own host. vercel.json proxies /__/auth/* to the Firebase auth
     domain, which is what makes that work. It is optional; the popup path does
     not need it.

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

  /* ------------------------------------------------------------- auth phase

     Three states, and every screen must respect them:

        'loading'         Firebase has not answered yet. NOT the same as signed
                          out, and treating it as signed out is the entire
                          mobile bug: the page painted the sign-in form while a
                          perfectly good session was still being restored, and
                          the user read that as "it sent me back to login".
        'authenticated'   a user is present
        'unauthenticated' Firebase has answered, and there is nobody

     Nothing may make a protected-route decision while this says 'loading'. */
  var phase = 'loading';
  var phaseWaiters = [];

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    SM.debug.log('auth', 'phase -> ' + next, currentUser ? { uid: currentUser.uid } : undefined);
    var waiting = phaseWaiters;
    phaseWaiters = [];
    waiting.forEach(function (fn) { try { fn(currentUser); } catch (e) { /* never break auth */ } });
  }

  /* Nothing is announced — not the phase, not a listener callback — until
     initialisation has checked for a pending redirect result.

     Without this hold, a compat SDK that reports "no user" before it has
     processed the return from Google publishes a signed-out state one tick
     before the real one, and every screen listening has already repainted as
     signed out. On a phone that IS the bug: choose the account, come back,
     read "Sign in to Mobile Parts Finder". */
  var initSettled = false;

  /* Result of the redirect sign-in that brought this page load into existence,
     if there was one. Kept so the app can tell "came back from Google with a
     user" apart from "was already signed in" — and so a redirect that failed
     can say why instead of silently looking like a sign-out. */
  var redirectOutcome = { checked: false, user: null, error: null };

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
      SM.debug.log('auth', 'config loaded', { projectId: cfg.projectId, authDomain: cfg.authDomain });
      return SDK.reduce(function (chain, src) {
        return chain.then(function () { return loadScript(src); });
      }, Promise.resolve());
    }).then(function () {
      var fb = global.firebase;
      if (!fb) throw new Error('firebase sdk did not load');
      /* Exactly one app, ever. A second initializeApp with the same name
         throws, and two apps would mean two auth states disagreeing. */
      if (!fb.apps.length) fb.initializeApp(config);

      /* Survive a tab close, not just a reload — a shop signs in once at the
         counter and expects to stay signed in. */
      var persisted = Promise.resolve();
      try {
        persisted = fb.auth().setPersistence(fb.auth.Auth.Persistence.LOCAL)
          .catch(function (err) {
            /* Some privacy modes refuse IndexedDB. Session persistence still
               carries the user through this visit, which is far better than
               failing the sign-in outright. */
            SM.debug.warn('auth', 'LOCAL persistence refused, falling back', { code: err && err.code });
            return fb.auth().setPersistence(fb.auth.Auth.Persistence.SESSION).catch(function () {});
          });
      } catch (e) { /* older SDK: persistence is already LOCAL by default */ }

      function announce() {
        setPhase(currentUser ? 'authenticated' : 'unauthenticated');
        listeners.forEach(function (fn) {
          try { fn(currentUser); } catch (e) { /* a listener must not break auth */ }
        });
      }

      /* Resolves the first time Firebase reports an auth state — the moment
         "signed in as X" or "nobody" stops being a guess. */
      var sawFirstState = null;
      var firstState = new Promise(function (resolve) { sawFirstState = resolve; });

      fb.auth().onAuthStateChanged(function (user) {
        currentUser = user || null;
        sawFirstState();
        /* Held, not dropped: the value is kept and announced below the moment
           initialisation finishes. */
        if (initSettled) announce();
      });

      /* A redirect sign-in finishes HERE, on the next page load, not in the
         call that started it — and it is AWAITED, which the previous version
         did not do.

         That omission is what made the phone bounce back to the sign-in page:
         boot raced getRedirectResult, painted "signed out" first because that
         is what the auth state said at that instant, and the arriving user
         never repainted the screen the person was looking at. Waiting for it
         costs one promise and removes the race entirely. */
      return persisted.then(function () {
        return fb.auth().getRedirectResult().then(function (result) {
          redirectOutcome.checked = true;
          redirectOutcome.user = (result && result.user) || null;
          if (redirectOutcome.user) {
            SM.debug.log('auth', 'returned from Google redirect', { uid: redirectOutcome.user.uid });
          } else {
            SM.debug.log('auth', 'no pending redirect result');
          }
        }, function (err) {
          redirectOutcome.checked = true;
          redirectOutcome.error = err || null;
          if (err && err.code && err.code !== 'auth/no-auth-event') {
            SM.debug.warn('auth', 'redirect result failed', { code: err.code, message: err.message });
          }
        });
      }).then(function () {
        /* Both conditions, not one. getRedirectResult already waits on the
           SDK's own initialisation, so the first auth state has normally
           arrived by here — but "normally" is not a guarantee to build a
           sign-in on, and announcing one tick early is the whole bug. The
           timeout is only so a listener that never fires cannot hang ready()
           for ever; whenResolved has its own, longer floor. */
        return Promise.race([
          firstState,
          new Promise(function (r) { setTimeout(r, 8000); })
        ]);
      }).then(function () {
        /* Whatever the auth state is now, it is the real one: any redirect has
           been consumed and currentUser already reflects it. */
        initSettled = true;
        announce();
        return fb;
      });
    }).catch(function (err) {
      loading = null;                       /* let a later attempt retry */
      /* An SDK that never loaded is not "still loading". Leaving the phase at
         'loading' would hang every screen waiting on it for ever. */
      initSettled = true;
      setPhase('unauthenticated');
      SM.debug.warn('auth', 'initialisation failed', { code: err && err.code, message: err && err.message });
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

    /**
     * Google sign-in.
     *
     * POPUP FIRST, ON EVERY DEVICE. This used to force a redirect on anything
     * with a coarse pointer and a narrow screen, and that is what broke sign-in
     * on phones.
     *
     * The reason is not the redirect itself, it is where the redirect state is
     * kept. `authDomain` is mobilepartsfinder.firebaseapp.com while the site is
     * on mobilepartsfinder.com, so the SDK parks the pending sign-in in storage
     * belonging to a THIRD-PARTY origin. Mobile Chrome, Safari and anything with
     * third-party storage partitioning discard it. The user picks their Google
     * account, comes back, getRedirectResult() finds nothing, and the app can
     * only conclude they are signed out — which is exactly the reported bug:
     * choose the account, land back on the sign-in page.
     *
     * A popup never leaves the page, so nothing has to survive a navigation and
     * no third-party storage is involved. It opens reliably here because it is
     * called straight out of the button's click handler, which is what browsers
     * require. Redirect stays as the fallback for the cases where a popup
     * genuinely cannot open, and it works properly now that the result is
     * awaited during initialisation.
     *
     * A redirect resolves to null — the real result arrives via
     * getRedirectResult after the page reloads.
     */
    signIn: function () {
      return ready().then(function (fb) {
        var provider = new fb.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });

        SM.debug.log('auth', 'sign-in requested', {
          strategy: 'popup',
          coarse: !!(global.matchMedia && global.matchMedia('(pointer:coarse)').matches),
          width: global.innerWidth
        });

        return fb.auth().signInWithPopup(provider).then(function (result) {
          SM.debug.log('auth', 'popup sign-in succeeded', { uid: result.user && result.user.uid });
          return result.user;
        }, function (err) {
          var code = err && err.code;

          /* The user shut the window. That is an answer, not a fault, and
             falling back to a redirect would drag them somewhere they just
             declined to go. */
          if (code === 'auth/popup-closed-by-user' ||
              code === 'auth/user-cancelled') throw err;

          /* Popup-shaped failures only. Anything else — an unauthorised
             domain, a disabled provider, no network — would fail identically
             after a redirect, and retrying via redirect would replace a clear
             error with a mysterious round trip. */
          if (code === 'auth/popup-blocked' ||
              code === 'auth/cancelled-popup-request' ||
              code === 'auth/operation-not-supported-in-this-environment' ||
              code === 'auth/web-storage-unsupported') {
            SM.debug.warn('auth', 'popup unavailable, falling back to redirect', { code: code });
            return fb.auth().signInWithRedirect(provider).then(function () { return null; });
          }
          SM.debug.warn('auth', 'sign-in failed', { code: code, message: err && err.message });
          throw err;
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

        /* currentUser is null until auth has resolved, and restoring a session
           from IndexedDB — or finishing a redirect — takes a moment. The local
           profile says "signed in" the instant the page loads, so a subscriber
           who presses Subscribe straight away would otherwise get a null token
           and a "could not start payment" for a session that is perfectly
           valid. Wait for the real answer instead of guessing. */
        return SM.fb.whenResolved().then(function (user) {
          return user ? user.getIdToken(false) : null;
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

    /* ------------------------------------------------------------ auth phase

       What every guard and every screen should ask before deciding anything.
       'loading' is a real answer and means "do not decide yet" — it is not a
       quieter way of saying signed out. */
    phase: function () { return phase; },

    /**
     * Resolves once Firebase has definitively answered, with the user or null.
     *
     * Everything that must not run against a half-restored session waits here:
     * route guards, the account screen, the first profile read. Repeat calls
     * after resolution return immediately, so it is cheap to await anywhere.
     *
     * The timeout is a floor, not a normal path. If the SDK never answers at
     * all — offline behind a captive portal, a blocked gstatic.com — the app
     * must still become usable rather than sit on a spinner for ever. Treating
     * that as signed out is honest: no token can be obtained, so nothing that
     * needs one could work anyway.
     */
    whenResolved: function (timeoutMs) {
      if (phase !== 'loading') return Promise.resolve(currentUser);

      /* Kick initialisation off if nobody has. Its failure path sets the phase,
         so a rejection here still settles the wait below. */
      ready().catch(function () { /* setPhase already ran */ });

      return new Promise(function (resolve) {
        var settled = false;
        var done = function (u) { if (!settled) { settled = true; resolve(u || null); } };
        phaseWaiters.push(done);
        setTimeout(function () {
          if (settled) return;
          SM.debug.warn('auth', 'auth never resolved, treating as signed out', { after: timeoutMs || 12000 });
          setPhase('unauthenticated');
          done(null);
        }, timeoutMs || 12000);
      });
    },

    /**
     * How this page load got its user, when it got one from Google.
     * `{ checked, user, error }` — `checked` is false until initialisation has
     * looked. Used to tell "just came back from the account chooser" apart from
     * "was already signed in", which are the same state and different journeys.
     */
    redirectResult: function () { return redirectOutcome; },

    /** Wakes the SDK so a returning session is restored without a click. */
    restore: function () {
      return this.whenResolved().catch(function () { return null; });
    }
  };
})(window);

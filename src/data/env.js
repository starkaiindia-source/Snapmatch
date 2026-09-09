/* ============================================================================
   Mobile Parts Finder · env.js — which browser is this, really?
   ----------------------------------------------------------------------------
   WHY THIS FILE EXISTS

   The site is advertised on Instagram. A Reel's "See details" does not hand the
   visitor to Chrome; it opens Instagram's own embedded browser, and Facebook,
   Messenger, ChatGPT and a dozen others do the same. Inside one of those,
   "Continue with Google" is not reliable and frequently cannot work at all:
   Google refuses OAuth in embedded WebViews (disallowed_useragent), popups are
   often unavailable, and third-party storage is partitioned or absent, so even
   a redirect that completes has nowhere to keep the session.

   That is not something the app can code around. The only real answer is to
   notice the situation and offer the visitor a way out of it — so detection
   lives here, once, as a service, rather than as a user-agent test copied into
   whichever file needed one that week.

   ----------------------------------------------------------------------------
   HOW IT DECIDES

   Never on one string match. Four passes, in this order:

     1. NAMED IN-APP BROWSERS. Tokens that only ever appear inside an embedded
        browser — FBAN, Instagram, Line, MicroMessenger. A hit here is certain.

     2. DEFINITE WEBVIEW MARKERS. Android's "; wv" token, and the "Version/x.x
        + Chrome/" pairing that only System WebView emits. These outrank the
        browser names below because a WebView's user agent also says "Chrome/",
        so testing for Chrome first would classify every embedded Android
        browser as a real one — which it did, until the test matrix caught it.

     3. REAL BROWSERS. Chrome, Safari, Edge, Firefox, Opera, Samsung Internet,
        identified positively. A hit here means NOT in-app, and it is checked
        before the heuristics below so that a normal visitor can never be
        mistaken for an embedded one. Showing a real Chrome user a modal telling
        them to open Chrome is worse than showing an Instagram user nothing.

     4. WEAK HEURISTICS, for the embedded browsers nobody has named: a Chromium
        UA with no Chrome brand behind it, an iOS WebKit UA with no Safari
        token. Each is weak on its own, so they are only reached once pass 3
        has ruled out every browser we can name.

   api/_lib/env-detect.test.js runs this file against real user-agent strings
   from every environment above. Detection like this rots as apps change their
   agents; the matrix is what makes that visible.

   The result is cached for the life of the page. A user agent does not change
   under a running document, and re-deriving it per call invites callers to
   treat it as cheap and put it in a render path.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var nav = global.navigator || {};
  var UA = String(nav.userAgent || '');

  /* --------------------------------------------------------------- platform */
  function isIOS() {
    /* iPadOS 13+ reports itself as a Mac. The touch-point count is what tells
       an iPad apart from a trackpad Mac. */
    return /iPad|iPhone|iPod/.test(UA) ||
      (/Macintosh/.test(UA) && (nav.maxTouchPoints || 0) > 1);
  }
  function isAndroid() { return /Android/i.test(UA); }

  /* --------------------------------------------- 1. named in-app browsers

     Each entry is a token that does not occur in a standalone browser's user
     agent. `name` is shown to nobody — it exists for the debug log, which is
     where a report of "the popup appeared for me in X" gets diagnosed. */
  var IN_APP = [
    { name: 'Instagram',     re: /Instagram/i },
    { name: 'Facebook',      re: /FBAN|FBAV|FB_IAB|FBIOS|FBDV|FB4A/i },
    { name: 'Messenger',     re: /Messenger|MessengerLite|FBMD/i },
    { name: 'Threads',       re: /Barcelona/i },
    { name: 'ChatGPT',       re: /ChatGPT|OpenAI/i },
    { name: 'TikTok',        re: /musical_ly|Bytedance|BytedanceWebview|TikTok/i },
    { name: 'WeChat',        re: /MicroMessenger/i },
    { name: 'Line',          re: /\bLine\//i },
    { name: 'Snapchat',      re: /Snapchat/i },
    { name: 'LinkedIn',      re: /LinkedInApp/i },
    { name: 'Pinterest',     re: /Pinterest/i },
    { name: 'Twitter',       re: /Twitter/i },
    { name: 'Telegram',      re: /Telegram/i },
    { name: 'WhatsApp',      re: /WhatsApp/i },
    { name: 'Google App',    re: /\bGSA\/|GoogleApp/i },
    { name: 'Amazon',        re: /Amazon|AmazonWebAppPlatform/i },
    { name: 'KakaoTalk',     re: /KAKAOTALK/i },
    { name: 'Naver',         re: /NAVER\(inapp/i },
    { name: 'Electron',      re: /Electron/i }
  ];

  /* --------------------------------------------------- 2. the real browsers

     Order matters: every Chromium browser also says "Chrome", and Chrome on
     iOS says "CriOS" while also saying "Safari". So the specific names are
     tested first and the generic ones last. */
  var BROWSERS = [
    { name: 'Edge',             re: /\bEdg(?:e|A|iOS)?\// },
    { name: 'Opera',            re: /\bOPR\/|\bOpera\//i },
    { name: 'Samsung Internet', re: /SamsungBrowser\//i },
    { name: 'Firefox',          re: /\bFirefox\/|\bFxiOS\//i },
    { name: 'Brave',            re: /\bBrave\//i },
    { name: 'Vivaldi',          re: /\bVivaldi\//i },
    { name: 'DuckDuckGo',       re: /\bDuckDuckGo\//i },
    { name: 'UC Browser',       re: /\bUCBrowser\//i },
    { name: 'Chrome',           re: /\bCriOS\/|\bChrome\//i },
    { name: 'Safari',           re: /\bSafari\// }
  ];

  function namedInApp() {
    for (var i = 0; i < IN_APP.length; i++) {
      if (IN_APP[i].re.test(UA)) return IN_APP[i].name;
    }
    return null;
  }

  function namedBrowser() {
    for (var i = 0; i < BROWSERS.length; i++) {
      if (BROWSERS[i].re.test(UA)) return BROWSERS[i].name;
    }
    return null;
  }

  /* ------------------------------------------------- 3. WebView heuristics

     Only consulted when no browser above matched, so these can be as generous
     as the signal deserves without endangering a normal visitor. */
  /* Android System WebView appends "; wv" to the platform token and Chrome
     never does. It is a documented marker, not a heuristic, so it is checked
     BEFORE the browser names — a WebView's user agent also carries "Chrome/",
     and letting the generic browser pass see it first classifies every
     embedded Android browser as Chrome. That is exactly what it did, and it is
     the one case the matrix caught. */
  function definiteWebView() {
    if (/;\s*wv[;)]/i.test(UA)) return 'android-webview';
    /* Android WebView also reports "Version/x.x" alongside "Chrome/", which
       Chrome itself does not. Belt for the OEM builds that drop the wv token. */
    if (isAndroid() && /\bVersion\/\d/.test(UA) && /\bChrome\//.test(UA)) {
      return 'android-webview-version';
    }
    return null;
  }

  function looksLikeWebView() {
    /* An Android UA claiming Chrome while User-Agent Client Hints report no
       Chrome brand. A real Chrome puts "Google Chrome" in brands; a WebView
       dressed as Chrome does not. The check is skipped entirely where the API
       is absent, which is most of iOS — a missing signal must not be read as a
       positive one. */
    if (isAndroid() && nav.userAgentData && Array.isArray(nav.userAgentData.brands)) {
      var brands = nav.userAgentData.brands.map(function (b) { return String(b.brand || ''); }).join(' ');
      if (brands && !/Google Chrome|Chromium|Microsoft Edge|Opera|Samsung/i.test(brands)) {
        return 'android-chromeless';
      }
    }

    /* iOS: everything is WebKit, so "Safari" in the UA is what separates the
       real browser from an app hosting WKWebView. An embedded view omits it.
       standalone === true is a home-screen PWA, which is ours and is fine. */
    if (isIOS() && !/\bSafari\//.test(UA) && nav.standalone !== true) {
      return 'ios-webview';
    }

    return null;
  }

  /* One derivation, cached. */
  var snapshot = null;
  function detect() {
    if (snapshot) return snapshot;

    var app = namedInApp();
    var definite = app ? null : definiteWebView();
    var browser = (app || definite) ? null : namedBrowser();
    var webview = definite || ((app || browser) ? null : looksLikeWebView());

    snapshot = {
      userAgent: UA,
      ios: isIOS(),
      android: isAndroid(),
      /* The app hosting the WebView, where it could be named. */
      inAppName: app,
      /* The standalone browser, where one was positively identified. */
      browserName: browser,
      /* Why the heuristics fired, when they did. Debug only. */
      webviewHint: webview,
      inApp: !!(app || webview),
      /* A home-screen install of THIS site is not an in-app browser — it is
         the site, and Google sign-in works in it. */
      standalone: nav.standalone === true ||
        !!(global.matchMedia && global.matchMedia('(display-mode: standalone)').matches)
    };

    if (snapshot.standalone) snapshot.inApp = false;

    if (SM.debug) {
      SM.debug.log('env', 'browser environment', {
        inApp: snapshot.inApp, app: app, browser: browser, hint: webview,
        ios: snapshot.ios, android: snapshot.android
      });
    }
    return snapshot;
  }

  /* ------------------------------------------------------- external browser

     Getting OUT of an embedded browser is the whole point, and what is
     possible depends entirely on the platform.

     ANDROID — an Intent URI is the supported mechanism, and the only one.
     `package=com.android.chrome` asks for Chrome by name;
     S.browser_fallback_url is read by the system when Chrome is absent, so a
     device without it lands in whatever browser it does have rather than on an
     error. Both halves are part of the intent scheme, not a trick.

     iOS — there is no equivalent. An app cannot force another app to open a
     URL without the user's involvement. googlechromes:// opens Chrome IF it is
     installed, and nothing happens if it is not, which is why the caller is
     told to keep its own instructions on screen. Pretending otherwise would be
     the "unsafe or unsupported hack" this is meant to avoid.

     The CURRENT URL is used, in full. Campaign and referral parameters are the
     reason a visitor is here at all, and dropping them on the way out would
     lose the attribution for the ad that brought them. */
  function currentUrl() {
    return global.location ? global.location.href : '';
  }

  function openExternal(url) {
    var target = url || currentUrl();
    var e = detect();

    if (e.android) {
      var bare = target.replace(/^https?:\/\//, '');
      var intent = 'intent://' + bare + '#Intent;scheme=https;' +
        'package=com.android.chrome;' +
        'S.browser_fallback_url=' + encodeURIComponent(target) + ';end';
      if (SM.debug) SM.debug.log('env', 'opening via android intent');
      try {
        global.location.href = intent;
        return { attempted: true, method: 'intent' };
      } catch (err) {
        if (SM.debug) SM.debug.warn('env', 'intent failed', { message: err && err.message });
      }
    }

    if (e.ios) {
      /* https -> googlechromes, http -> googlechrome. Chrome's own documented
         scheme. Silent no-op when Chrome is not installed. */
      var scheme = /^https:/i.test(target)
        ? target.replace(/^https:/i, 'googlechromes:')
        : target.replace(/^http:/i, 'googlechrome:');
      if (SM.debug) SM.debug.log('env', 'opening via ios chrome scheme');
      try {
        global.location.href = scheme;
        return { attempted: true, method: 'ios-scheme' };
      } catch (err2) {
        if (SM.debug) SM.debug.warn('env', 'ios scheme failed', { message: err2 && err2.message });
      }
    }

    /* Last resort, and it is a real one on desktop embedded browsers: ask for
       a new top-level context. Many in-app browsers answer this by handing the
       URL to the system browser. */
    try {
      var w = global.open(target, '_blank', 'noopener');
      if (w) return { attempted: true, method: 'window.open' };
    } catch (err3) { /* blocked; fall through */ }

    return { attempted: false, method: null };
  }

  /* Copying the address is the honest fallback for iOS without Chrome: the
     visitor can paste it into Safari themselves, which always works. */
  function copyUrl(url) {
    var target = url || currentUrl();
    if (nav.clipboard && nav.clipboard.writeText) {
      return nav.clipboard.writeText(target).then(function () { return true; },
                                                  function () { return false; });
    }
    return Promise.resolve(false);
  }

  SM.env = {
    detect: detect,
    isInApp: function () { return detect().inApp; },
    inAppName: function () { return detect().inAppName; },
    browserName: function () { return detect().browserName; },
    isIOS: function () { return detect().ios; },
    isAndroid: function () { return detect().android; },
    currentUrl: currentUrl,
    openExternal: openExternal,
    copyUrl: copyUrl,

    /* Whether Google sign-in can be expected to work where we are standing.
       Google refuses OAuth from embedded WebViews outright, so this is not a
       guess about popups — it is the documented policy. */
    googleAuthLikelyBlocked: function () { return detect().inApp; }
  };
})(window);

/* ============================================================================
   Mobile Parts Finder · env-detect.test.js
   ----------------------------------------------------------------------------
   Runs src/data/env.js — the real file, not a copy — against real user-agent
   strings from every environment it claims to recognise.

   WHY IT LIVES HERE

   `npm test` is `node --test api/_lib/*.test.js`, so this directory is where
   the runner looks. The subject is browser code rather than an API library,
   which is the one thing odd about its address; the alternative is a detection
   layer with no test at all, and user-agent detection is exactly the kind of
   code that rots silently. Instagram ships a new agent, the token moves, and
   nobody finds out until a visitor cannot sign in.

   The file is loaded in a vm context with a stubbed window, so this exercises
   the shipped module including its ordering — which is what the Android
   WebView case is here to pin down. A WebView's agent also contains "Chrome/",
   so a browser-name check that ran before the "; wv" marker classified every
   embedded Android browser as real Chrome. This test caught that.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'data', 'env.js'), 'utf8'
);

/** Loads the module against one user agent and returns its verdict. */
function detect(userAgent, navExtra) {
  const navigator = Object.assign({ userAgent, maxTouchPoints: 0 }, navExtra || {});
  const win = {
    navigator,
    location: { href: 'https://www.mobilepartsfinder.com/finder?utm_source=ig&utm_campaign=reel' },
    matchMedia: () => ({ matches: false }),
    open: () => null,
    SM: { debug: { log() {}, warn() {} } }
  };
  vm.createContext(win);
  /* The module closes over `window`; the context object is the window here. */
  vm.runInContext(SRC.replace('})(window);', '})(this);'), win);
  return { env: win.SM.env, snapshot: win.SM.env.detect() };
}

/* --------------------------------------------------------------- in-app ---
   Every one of these must be recognised as embedded. A false negative here is
   a visitor sent into a Google sign-in that cannot complete. */
const EMBEDDED = {
  'Instagram iOS':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 322.0.0.30.111 (iPhone14,3; iOS 17_4; en_US)',
  'Instagram Android':
    'Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 302.0.0.23.113',
  'Facebook iOS':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A360 [FBAN/FBIOS;FBAV/440.0.0.35.111;FBBV/1234]',
  'Facebook Android':
    'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/440.0.0.29.113;]',
  'Messenger iOS':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/MessengerForiOS;FBAV/430.0.0.28.111]',
  'Android System WebView':
    'Mozilla/5.0 (Linux; Android 11; RMX2020 Build/RP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.85 Mobile Safari/537.36',
  'iOS WKWebView':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  'WeChat':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 MicroMessenger/8.0.42 Mobile/15E148 Safari/604.1',
  'TikTok':
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36 musical_ly_2022803040 JsSdk/2.0 BytedanceWebview/d8a21c6',
  'Snapchat':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Snapchat/12.62.0.44'
};

/* -------------------------------------------------------------- browsers ---
   None of these may ever be told to "open in Chrome". A false positive here is
   worse than the bug it is guarding against: it interrupts a visitor whose
   sign-in would have worked perfectly. */
const REAL = {
  'Chrome Android':
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
  'Chrome desktop':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Chrome iOS':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  'Safari iOS':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  'Safari macOS':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Edge':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91',
  'Firefox desktop':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Firefox Android':
    'Mozilla/5.0 (Android 13; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
  'Opera':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0',
  'Samsung Internet':
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36'
};

test('every embedded browser is recognised as in-app', () => {
  for (const [name, ua] of Object.entries(EMBEDDED)) {
    const { snapshot } = detect(ua);
    assert.equal(snapshot.inApp, true,
      name + ' should be in-app (browser=' + snapshot.browserName +
      ' app=' + snapshot.inAppName + ' hint=' + snapshot.webviewHint + ')');
  }
});

test('no real browser is ever mistaken for an in-app one', () => {
  for (const [name, ua] of Object.entries(REAL)) {
    const { snapshot } = detect(ua);
    assert.equal(snapshot.inApp, false,
      name + ' must not be in-app (hint=' + snapshot.webviewHint + ')');
    assert.ok(snapshot.browserName, name + ' should be identified by name');
  }
});

test('a home-screen install is the site, not an in-app browser', () => {
  /* An iOS PWA has no Safari token — the same signal that identifies a
     WKWebView. standalone is what tells them apart, and getting this wrong
     would show the "open in your browser" sheet inside our own installed app. */
  const { snapshot } = detect(EMBEDDED['iOS WKWebView'], { standalone: true });
  assert.equal(snapshot.inApp, false);
  assert.equal(snapshot.standalone, true);
});

test('Android WebView is not read as Chrome', () => {
  /* The regression this suite exists for. The agent contains "Chrome/", so
     any check that asks "is this Chrome?" before "is this a WebView?" gets the
     wrong answer. */
  const { snapshot } = detect(EMBEDDED['Android System WebView']);
  assert.equal(snapshot.inApp, true);
  assert.equal(snapshot.browserName, null);
  assert.equal(snapshot.webviewHint, 'android-webview');
});

test('platform detection separates Android from iOS', () => {
  assert.equal(detect(EMBEDDED['Instagram Android']).snapshot.android, true);
  assert.equal(detect(EMBEDDED['Instagram Android']).snapshot.ios, false);
  assert.equal(detect(EMBEDDED['Instagram iOS']).snapshot.ios, true);
  assert.equal(detect(EMBEDDED['Instagram iOS']).snapshot.android, false);
});

test('an iPad reporting itself as a Mac is still iOS', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15';
  assert.equal(detect(ua, { maxTouchPoints: 5 }).snapshot.ios, true);
  assert.equal(detect(ua, { maxTouchPoints: 0 }).snapshot.ios, false);
});

test('googleAuthLikelyBlocked tracks the in-app verdict', () => {
  assert.equal(detect(EMBEDDED.Instagram_iOS || EMBEDDED['Instagram iOS']).env.googleAuthLikelyBlocked(), true);
  assert.equal(detect(REAL['Chrome Android']).env.googleAuthLikelyBlocked(), false);
});

test('the external-browser URL keeps campaign parameters', () => {
  /* A visitor arrives from a Reel with utm parameters attached. Losing them on
     the way to the external browser loses the attribution for the ad that paid
     to bring them, so currentUrl must hand over the whole address. */
  const { env } = detect(REAL['Chrome Android']);
  const url = env.currentUrl();
  assert.match(url, /utm_source=ig/);
  assert.match(url, /utm_campaign=reel/);
});

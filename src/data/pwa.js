/* ============================================================================
   Mobile Parts Finder · pwa.js — installing the app, and sharing it
   ----------------------------------------------------------------------------
   ONE PLACE that knows whether this browser can install the site, whether it
   already has, and how to share a link. The header, the sign-in flow and the
   sheets all read it; none of them touch a browser API themselves.

   THE INSTALL PROMPT IS NOT OURS TO SUMMON

     Chrome fires `beforeinstallprompt` when IT decides the site qualifies, and
     the deferred event can be used exactly once, only from a real user
     gesture. So: catch it, keep it, and show the button only while it is
     actually in hand. Every other browser — Firefox, and every iOS browser,
     which are all Safari underneath — never fires it, and there is no way to
     ask. Those get instructions instead of a button that cannot work.

     Nothing here fakes a prompt, and nothing pretends to be browser chrome.
     A dialog that imitates the system one is how a site teaches people to
     trust dialogs that imitate the system one.

   ALREADY INSTALLED

     display-mode: standalone (and navigator.standalone, which is how iOS says
     the same thing) means the app IS the window this is running in. Offering
     to install it there is offering something already had.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var deferred = null;          /* the BeforeInstallPromptEvent, while it lasts */
  var installed = false;        /* appinstalled has fired this session */
  var listeners = [];

  var SHARE_URL = 'https://www.mobilepartsfinder.com/';
  var SHARE_TITLE = 'Mobile Parts Finder';
  var SHARE_TEXT = 'Find which spare parts fit any phone — compatibility groups ' +
                   'for 4,900+ mobile models, with the master model and part code for each.';

  function emit() {
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) { /* a listener must not break the next one */ }
    });
  }

  /* Running as an installed app rather than in a browser tab. */
  function standalone() {
    try {
      if (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) return true;
      if (global.matchMedia && global.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
    } catch (e) { /* older browsers */ }
    return !!(global.navigator && global.navigator.standalone);   /* iOS */
  }

  /* iOS has no install prompt at all — Safari's own Share ▸ Add to Home Screen
     is the only route, and every browser on iOS is Safari underneath, so
     "Chrome on iPhone" cannot install either. Worth telling people rather than
     leaving them with a button that does nothing. */
  function isIOS() {
    var ua = (global.navigator && global.navigator.userAgent) || '';
    if (/iPad|iPhone|iPod/.test(ua)) return true;
    /* iPadOS 13+ reports itself as a Mac; a touch-capable "Mac" is an iPad. */
    return /Macintosh/.test(ua) && (global.navigator.maxTouchPoints || 0) > 1;
  }

  SM.pwa = {
    /** A real, unused install prompt is in hand. */
    canInstall: function () { return !!deferred && !installed && !standalone(); },

    /** The app is already installed, or we are running inside it. */
    isInstalled: function () { return installed || standalone(); },

    isStandalone: standalone,
    isIOS: isIOS,

    /** True where the browser could install but has not offered yet, or never
        will — the case that needs instructions rather than a button. */
    needsManualInstall: function () {
      return !this.isInstalled() && !deferred && isIOS();
    },

    /**
     * Fires the browser's own install prompt. MUST be called from a user
     * gesture — Chrome rejects it otherwise, and the deferred event is then
     * spent either way, so it is cleared whatever the answer.
     *
     * Resolves 'accepted' | 'dismissed' | 'unavailable'.
     */
    install: function () {
      if (!deferred) return Promise.resolve('unavailable');
      var evt = deferred;
      deferred = null;                       /* single use, by specification */
      emit();
      var done = evt.prompt();
      return Promise.resolve(done).then(function () {
        return evt.userChoice;
      }).then(function (choice) {
        var outcome = (choice && choice.outcome) || 'dismissed';
        SM.debug.log('pwa', 'install prompt answered', { outcome: outcome });
        return outcome;
      }, function (err) {
        SM.debug.warn('pwa', 'install prompt failed', { message: err && err.message });
        return 'unavailable';
      });
    },

    /** The phone's own share sheet is available. */
    canShareNatively: function () {
      return !!(global.navigator && typeof global.navigator.share === 'function');
    },

    shareData: function () {
      return { title: SHARE_TITLE, text: SHARE_TEXT, url: SHARE_URL };
    },

    /**
     * Hands the link to the system share sheet.
     * Resolves 'shared' | 'dismissed' | 'unavailable' — the caller opens its
     * own fallback for 'unavailable' and does nothing for 'dismissed', since
     * a share the user backed out of is not an error to report.
     */
    share: function () {
      if (!this.canShareNatively()) return Promise.resolve('unavailable');
      return global.navigator.share(this.shareData()).then(function () {
        return 'shared';
      }, function (err) {
        /* AbortError is the user closing the sheet — an outcome, not a fault. */
        if (err && err.name === 'AbortError') return 'dismissed';
        SM.debug.warn('pwa', 'native share failed', { name: err && err.name });
        return 'unavailable';
      });
    },

    /** Re-render hook for anything that draws an install or share control. */
    onChange: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i > -1) listeners.splice(i, 1);
      };
    },

    /**
     * Registers the service worker and starts listening. Called once at boot.
     *
     * The worker is what makes the site installable at all — Chrome will not
     * offer to install a site with no fetch handler — and it is deliberately
     * network-first, so it cannot serve a stale build. See sw.js.
     */
    init: function () {
      global.addEventListener('beforeinstallprompt', function (e) {
        /* Chrome would otherwise show its own mini-infobar; taking the event
           means the site decides where the offer appears. */
        e.preventDefault();
        deferred = e;
        SM.debug.log('pwa', 'install prompt available');
        emit();
      });

      global.addEventListener('appinstalled', function () {
        installed = true;
        deferred = null;
        SM.debug.log('pwa', 'app installed');
        try { localStorage.setItem('mpf.pwa.installed', '1'); } catch (e) { /* private mode */ }
        emit();
      });

      /* Leaving the browser tab for the installed window counts as installed
         for this session too, so the button does not linger. */
      try {
        if (global.matchMedia) {
          global.matchMedia('(display-mode: standalone)').addEventListener('change', emit);
        }
      } catch (e) { /* Safari < 14 has no addEventListener here */ }

      if (!('serviceWorker' in global.navigator)) return;
      /* file:// and the single-file dist build have no origin to scope to. */
      if (global.location.protocol !== 'https:' && global.location.hostname !== 'localhost') return;

      global.addEventListener('load', function () {
        /* updateViaCache:'none' — the browser caches sw.js like any other
           script, and a cached worker keeps serving its own old shell after a
           deploy has replaced it. Revalidating the worker script itself is the
           difference between shipping a fix and shipping it to people who
           already have the site. */
        global.navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(function (reg) {
          SM.debug.log('pwa', 'service worker registered', { scope: reg.scope });
        }, function (err) {
          /* Not fatal: the site works, it simply cannot be installed. */
          SM.debug.warn('pwa', 'service worker registration failed', { message: err && err.message });
        });
      });
    }
  };
})(window);

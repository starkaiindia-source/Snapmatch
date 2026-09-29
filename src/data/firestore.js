/* ============================================================================
   Mobile Parts Finder · firestore.js — the Firestore read layer
   ----------------------------------------------------------------------------
   The repository between the UI and Cloud Firestore. Screens never touch the
   SDK; they call SM.store, and this decides where an answer comes from.

   ----------------------------------------------------------------------------
   WHAT COMES FROM WHERE, AND WHY

   The catalogue — 4,933 devices, 3,340 groups, brands, categories — is served
   as one CDN file and NOT read from Firestore. That is a deliberate split, not
   leftover mock data:

     · it is the same real export, byte for byte, that the importer writes to
       Firestore; nothing about it is invented
     · browsing and search touch thousands of records. As Firestore reads that
       is thousands of billed operations per session and a network round trip
       per keystroke; as one 211 KB cached file it is zero reads and instant
     · it is public data. Reads that need no permission gain nothing from
       going through a permission system

   Firestore owns what the CDN cannot: anything per-user, anything writable,
   and anything paid.

     users/{uid}                    the signed-in shop's own profile
     subscriptions, payments        billing history, written only by the server
     groupDetails/{groupId}         PAID — part number and member list
     deviceGroups/{deviceId}        PAID — which groups a device belongs to

   The paid collections are closed to unsubscribed clients by the rules in
   firestore.rules, so this layer cannot read them for a visitor even if a bug
   asked it to. The paywall is in the database, not in this file.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var FIRESTORE_SDK = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js';
  var dbLoad = null;

  /* ====================================================== EVERY READ EXPIRES

     THE BUG THIS EXISTS TO KILL: "Finishing sign-in..." for ever.

     A Firestore call can fail in a way the SDK never reports. When the Google
     Cloud project itself refuses the API — billing switched off, the API
     disabled, the database deleted — firestore.googleapis.com answers

         403 PERMISSION_DENIED: This API method requires billing to be enabled

     to every single request. The SDK does not surface that. It classifies a
     failed WebChannel as a transient connection problem and retries with
     backoff, for ever, and the promise returned by .get() NEVER SETTLES. Not
     resolved, not rejected: pending until the tab is closed.

     Measured on the live site, 2026-09-28, while billing was disabled on the
     project: catalog/meta — a document the rules let anyone read — was still
     pending after 30 seconds with no error of any kind.

     Everything downstream of such a call is therefore unreachable. That is the
     whole production failure: sign-in with Google genuinely SUCCEEDED, the
     Firebase user was real, and then initializeAuthenticatedUser awaited
     loadProfile() and stopped. identitySettled stayed false, so the account
     screen repainted "Finishing sign-in... / Checking your Google account."
     and had nothing left that could ever change it. Every recovery path the
     app already has — the offline branch, the outage message, the retry —
     hangs off a .catch that could not run, because nothing ever rejected.

     A deadline turns that back into an ordinary error. 'deadline-exceeded' is
     already one of the codes SM.isBackendOutage treats as "the database
     refused, not your phone" (src/data/api.js), so a timeout lands in the
     outage wording that was written for exactly this incident rather than in
     "check your connection", which was false for it.

     This does NOT paper over an outage. Nothing is faked, no read is answered
     from nowhere: a call that cannot complete now says so, in bounded time, to
     a caller that knows what to do about it. */
  var DEADLINE_MS = 10000;

  /* Uploading a photo is not a lookup — it is megabytes over whatever
     connection a counter in a shop has. Holding it to a reader's deadline
     would cancel legitimate slow uploads. */
  var DEADLINE_UPLOAD_MS = 60000;

  /* ====================================================== RETRY, BUT BRIEFLY

     Firebase's own guidance is to retry DEADLINE_EXCEEDED with exponential
     backoff, and that is right for the failure it describes: a slow round
     trip, a dropped connection, a moment of backend pressure. A second
     attempt costs a second and usually works.

     WHAT MUST NOT BE RETRIED, and why it is worth being strict about:

       permission-denied   the rules said no. Asking again asks the same
                           question and gets the same answer, and hiding it
                           behind three attempts turns a configuration fault
                           into a mystery slow failure. It needs a person, not
                           a retry.
       not-found           an answer, not a failure.
       unauthenticated     the token is wrong. A retry cannot mint a better one.
       resource-exhausted  the quota is spent. Retrying is what spent it.

     And the budget is small on purpose. Every attempt is time somebody spends
     looking at a spinner, and the total has to stay inside the identity gate's
     ceiling or the gate fires first and the retries were pointless. Three
     attempts at 6s, 4s and 3s with 0.5s and 1s between them is 14.5s worst
     case, against a 22s gate.

     It is honestly a small loss for a PERMANENTLY dead backend — the reader
     waits 14.5s for the error rather than 6s. That is the price of recovering
     automatically from the transient case, which is the common one. */
  var TRANSIENT = {
    'deadline-exceeded': 1,
    'unavailable': 1,
    'internal': 1,
    'aborted': 1
  };

  /* Only the read the sign-in blocks on. Retrying a browse query would spend a
     reader's time on a page they can simply reload. */
  var RETRY_PLAN = {
    loadProfile: { deadlines: [6000, 4000, 3000], backoff: [500, 1000] }
  };

  function withRetry(name, invoke, plan) {
    var attempt = 0;

    function run() {
      /* A FRESH call each time. Re-awaiting the same promise would re-await
         the same hang. */
      return deadline(invoke(), name + ' (attempt ' + (attempt + 1) + ')',
                      plan.deadlines[attempt])
        .catch(function (err) {
          var code = err && err.code;
          var isLast = attempt >= plan.deadlines.length - 1;
          if (isLast || !TRANSIENT[code]) throw err;

          var wait = plan.backoff[Math.min(attempt, plan.backoff.length - 1)];
          attempt++;
          SM.debug.warn('firestore', name + ' failed, retrying', {
            code: code, nextAttempt: attempt + 1, afterMs: wait
          });
          return new Promise(function (r) { setTimeout(r, wait); }).then(run);
        });
    }

    return run();
  }

  function deadline(promise, label, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        SM.debug.warn('firestore', label + ' timed out', { after: ms });
        /* Shaped like a Firestore rejection, because that is what every caller
           is already written to read. */
        var err = new Error('firestore ' + label + ' did not answer within ' + ms + 'ms');
        err.code = 'deadline-exceeded';
        err.timedOut = true;
        reject(err);
      }, ms);

      promise.then(function (v) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(e);
      });
    });
  }

  /* Loads the Firestore SDK on first use. Most visits never sign in and never
     need it, so it is not part of the boot payload. */
  function store() {
    if (dbLoad) return dbLoad;
    dbLoad = SM.fb.ready().then(function (fb) {
      if (fb.firestore) return fb.firestore();
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = FIRESTORE_SDK;
        s.async = true;
        s.onload = function () { resolve(global.firebase.firestore()); };
        s.onerror = function () { reject(new Error('firestore sdk failed to load')); };
        document.head.appendChild(s);
      });
    }).catch(function (err) {
      dbLoad = null;              /* let a later attempt retry */
      throw err;
    });
    return dbLoad;
  }

  /* Firestore hands back Timestamps; the UI wants epoch milliseconds. Doing it
     here means no screen has to know Firestore's types exist. */
  function ms(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (v.seconds != null) return v.seconds * 1000;
    return null;
  }

  /* What set(doc, {merge:true}) leaves behind: plain objects merge key by
     key, everything else — strings, numbers, arrays, Timestamps — replaces. */
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
  }
  function mergeDeep(base, patch) {
    var out = Object.assign({}, base);
    Object.keys(patch).forEach(function (k) {
      out[k] = isPlainObject(patch[k]) && isPlainObject(out[k])
        ? mergeDeep(out[k], patch[k])
        : patch[k];
    });
    return out;
  }

  /* ------------------------------------------------ this device's profile copy

     localStorage, keyed by uid, stamped with when it was read — so a new tab,
     or tomorrow morning's first visit, does not have to read users/{uid} to
     draw the same shop it drew last time. It was per-tab at first; shops open
     the site in a new tab constantly, and every one of those was a read.

     It is a copy of what Firestore said, never a source: nothing is written
     here that did not come back from the database or go into it. It holds the
     same non-secret shop details mpf.profiles.v1 has always held on this
     device, and nothing about access — the server decides that on every paid
     request. One slot only, tied to one uid: another account never reads it,
     and signing out deletes it. */
  var PROFILE_CACHE_KEY = 'mpf.profile.cache.v1';
  var profileCache = {
    get: function (uid, maxAgeMs) {
      try {
        var c = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || 'null');
        if (!c || c.uid !== uid || !c.profile) return null;
        var age = Date.now() - c.at;
        if (!(age >= 0 && age < maxAgeMs)) return null;
        return { profile: c.profile, ageMs: age };
      } catch (e) { return null; }
    },
    put: function (uid, profile) {
      try {
        localStorage.setItem(PROFILE_CACHE_KEY,
          JSON.stringify({ uid: uid, at: Date.now(), profile: profile }));
      } catch (e) { /* private mode: every load simply reads */ }
    },
    drop: function () {
      try {
        localStorage.removeItem(PROFILE_CACHE_KEY);
        /* The per-tab copy the first version of this kept. */
        sessionStorage.removeItem(PROFILE_CACHE_KEY);
      } catch (e) { /* private mode */ }
    }
  };

  SM.store = {
    available: function () { return SM.fb.isConfigured(); },

    /** Forgets this device's copy of the profile — on sign-out, and whenever
        the server may have changed the document behind the browser's back. */
    forgetProfile: function () { profileCache.drop(); },

    /**
     * Starts fetching the Firestore SDK without reading anything.
     *
     * The first profile read pays for the SDK download on top of the read. A
     * caller that knows a read is coming — "Continue with Google" pressed, a
     * signed-in page loading — calls this first, so the download overlaps the
     * account chooser or the catalogue download instead of following it. No
     * document is touched, so it costs nothing in Firestore.
     */
    warm: function () {
      return store().then(function () { return true; }, function () { return false; });
    },

    /* ------------------------------------------------------------- profile */

    /* ------------------------------------------------------- profile identity

       users/{uid} is the ONE record for a Google account. The Firebase UID is
       the document id, so the same Gmail on a second device reads the same
       document — identity follows the account, never the browser.

       loadProfile is what the app asks after every sign-in. localStorage is a
       cache in front of it, never the source: a profile that only ever lived
       in a browser is a new user on every other device, which is exactly the
       bug this replaces. */

    /* Old documents used shopName/proprietor/mobile; newer ones use the
       mobileShopName/proprietorName/mobileNumber names the checkout reads.
       Both are accepted so existing records keep working, and nothing is
       rewritten just for having the older shape. */
    normaliseProfile: function (d) {
      if (!d) return null;
      var shop = d.mobileShopName || d.shopName || '';
      var prop = d.proprietorName || d.proprietor || '';
      var mob  = d.mobileNumber || d.mobile || '';
      return {
        uid: d.uid || null,
        email: d.email || '',
        googleDisplayName: d.googleDisplayName || d.googleName || '',
        googlePhotoURL: d.googlePhotoURL || '',
        profilePhotoURL: d.profilePhotoURL || d.photo || '',
        profilePhotoPath: d.profilePhotoPath || null,
        mobileShopName: shop,
        proprietorName: prop,
        mobileNumber: mob,
        mobileNumberE164: d.mobileNumberE164 || '',
        country: d.country || d.countryName || '',
        countryCode: d.countryCode || '',
        address: d.address || null,
        /* Recomputed from the fields rather than trusted, so a stale
           profileCompleted:true on a record missing a number cannot wave an
           incomplete profile through to checkout. */
        profileCompleted: !!(shop && prop && mob),
        displayName: d.displayName || d.googleDisplayName || d.googleName || '',
        authProvider: d.authProvider || 'google',
        accountStatus: d.accountStatus || 'active',
        /* Server-owned, read-only here. The client renders these; it never
           writes them, and the rules would reject it if it tried. */
        subscriptionStatus: d.subscriptionStatus || d.activeSubscriptionStatus || 'none',
        subscriptionPlan: d.subscriptionPlan || d.currentPlanId || null,
        currentPlanId: d.currentPlanId || d.subscriptionPlan || null,
        subscriptionStartedAt: ms(d.subscriptionStartedAt),
        subscriptionExpiresAt: ms(d.subscriptionExpiresAt),
        createdAt: ms(d.createdAt),
        updatedAt: ms(d.updatedAt),
        lastLoginAt: ms(d.lastLoginAt)
      };
    },

    /**
     * The authoritative profile for a UID, or null if this account is new.
     *
     * `opts.maxAgeMs` lets a caller accept this tab's own recent copy instead
     * of a document read. Boot passes it, so moving between the app and the
     * pre-rendered pages — each a full page load — costs one read per session
     * rather than one per page. Every other caller omits it and reads fresh,
     * and a fresh read refreshes the copy. Only a profile that EXISTS is kept:
     * "no document" is the new-account answer, and caching it would hide the
     * profile the sign-up form is about to create.
     */
    loadProfile: function (uid, opts) {
      var self = this;
      var maxAge = opts && opts.maxAgeMs;
      if (maxAge) {
        var hit = profileCache.get(uid, maxAge);
        if (hit) {
          SM.debug.log('profile', 'users/' + uid + ' from this tab’s copy', { ageMs: hit.ageMs });
          return Promise.resolve(hit.profile);
        }
      }
      return store().then(function (db) {
        return db.collection('users').doc(uid).get();
      }).then(function (snap) {
        SM.debug.log('profile', 'read users/' + uid,
                     { exists: snap.exists, complete: snap.exists ? !!snap.data().profileCompleted : false });
        var p = snap.exists ? self.normaliseProfile(snap.data()) : null;
        if (p) profileCache.put(uid, p); else profileCache.drop(uid);
        return p;
      }, function (err) {
        SM.debug.warn('profile', 'read users/' + uid + ' FAILED',
                      { code: err && err.code, message: err && err.message });
        throw err;
      });
    },

    /* Fields the CLIENT is allowed to write. Deliberately identical to
       WRITABLE_PROFILE in api/_lib/store.js: two lists that drift apart is how
       a field ends up saved on one path and dropped on the other.

       Nothing about a subscription appears here. Those fields belong to the
       server, the security rules reject them from a browser, and a client that
       could grant itself a plan is the whole attack the billing design exists
       to prevent. */
    WRITABLE: ['mobileShopName', 'proprietorName', 'mobileNumber', 'mobileNumberE164',
               'country', 'countryCode', 'address', 'profilePhotoURL', 'profilePhotoPath'],

    /**
     * Creates or updates users/{uid}.
     *
     * merge:true and an explicit field list, so writing a profile can never
     * blank a subscription the server owns, and an absent field stays absent
     * rather than being written as an empty string. A missing mobile number is
     * a real state — it means "ask this user for it" — and inventing one would
     * put a fabricated number on a real invoice.
     */
    saveProfile: function (uid, patch, googleUser) {
      var doc = { uid: uid, updatedAt: Date.now() };
      this.WRITABLE.forEach(function (k) {
        var v = patch[k];
        if (v === undefined || v === null) return;
        /* An empty string is not a correction, it is an absent field. Writing
           one would blank a detail the shop entered on another device — and a
           form that opened without being seeded sends nothing BUT empties. */
        if (typeof v === 'string' && v.trim() === '') return;
        /* Same for an address object whose parts are all blank: {} over a
           stored address is a deletion nobody asked for. */
        if (k === 'address' && typeof v === 'object') {
          var hasAny = Object.keys(v).some(function (part) {
            return typeof v[part] === 'string' && v[part].trim() !== '';
          });
          if (!hasAny) return;
        }
        doc[k] = v;
      });

      if (googleUser) {
        doc.email = googleUser.email || '';
        doc.authProvider = 'google';
        /* Google's name and picture go in their own fields. The shop's own
           details are typed by hand and must never be overwritten by them. */
        if (googleUser.displayName) doc.googleDisplayName = googleUser.displayName;
        if (googleUser.photoURL) doc.googlePhotoURL = googleUser.photoURL;
      }
      doc.profileCompleted = !!(doc.mobileShopName && doc.proprietorName && doc.mobileNumber);

      var self = this;
      return store().then(function (db) {
        var ref = db.collection('users').doc(uid);
        return ref.get().then(function (snap) {
          /* createdAt is written once and never again — an update must not
             restamp the day the shop joined. */
          if (!snap.exists) doc.createdAt = Date.now();
          SM.debug.log('profile', snap.exists ? 'updating users/' + uid : 'creating users/' + uid,
                       { fields: Object.keys(doc) });
          /* The stored result is the document read above with this write
             merged over it, which is exactly what set(..., {merge:true}) does —
             so it is computed here instead of paying a second read for it. */
          var merged = mergeDeep(snap.exists ? snap.data() : {}, doc);
          return ref.set(doc, { merge: true }).then(function () { return merged; });
        });
      }).then(function (stored) {
        SM.debug.log('profile', 'firestore write ok', { uid: uid });
        var p = self.normaliseProfile(stored);
        profileCache.put(uid, p);
        return p;
      }, function (err) {
        /* Loud on purpose. A rejected profile write is how a shop ends up
           signed in with no record anywhere, and it used to happen silently. */
        SM.debug.warn('profile', 'firestore write FAILED', {
          uid: uid, code: err && err.code, message: err && err.message
        });
        throw err;
      });
    },

    /* -------------------------------------------------------------- storage

       The profile photo, and nothing else. Firestore stores the URL; the bytes
       go to Storage, because a base64 image inside a document counts against
       the 1 MB document limit and is re-downloaded on every profile read.

       Uploads land in users/{uid}/profile/, which is the path the Storage
       rules key ownership on — a shop can write inside its own folder and
       nowhere else. */
    uploadProfilePhoto: function (uid, file) {
      if (!file) return Promise.reject(new Error('no file'));
      if (!/^image\//.test(file.type)) {
        return Promise.reject(new Error('That file is not an image'));
      }
      if (file.size > 5 * 1024 * 1024) {
        return Promise.reject(new Error('Image is larger than 5 MB'));
      }

      return SM.fb.ready().then(function (fb) {
        if (fb.storage) return fb;
        return new Promise(function (resolve, reject) {
          var el = document.createElement('script');
          el.src = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage-compat.js';
          el.async = true;
          el.onload = function () { resolve(global.firebase); };
          el.onerror = function () { reject(new Error('storage sdk failed to load')); };
          document.head.appendChild(el);
        });
      }).then(function (fb) {
        /* One file per shop, overwritten on change. Keeping every upload would
           accumulate orphans nothing ever points at. */
        var ext = (file.type.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
        var path = 'users/' + uid + '/profile/photo.' + ext;
        var ref = fb.storage().ref(path);
        return ref.put(file, { contentType: file.type })
          .then(function () { return ref.getDownloadURL(); })
          .then(function (url) { return { url: url, path: path }; });
      });
    },

    /* ---------------------------------------------------------------- paid */

    /**
     * Which groups a device belongs to, per category — the paid answer.
     * Rules refuse this without an active subscription, so a rejection here is
     * the paywall working rather than an error to paper over.
     *
     * @returns {Promise<{byCategory:Object}|null>} null when not subscribed
     */
    deviceGroups: function (deviceId) {
      return store().then(function (db) {
        return db.collection('deviceGroups').doc(deviceId).get();
      }).then(function (snap) {
        return snap.exists ? snap.data() : null;
      }).catch(function (err) {
        if (err && err.code === 'permission-denied') return null;
        throw err;
      });
    },

    /**
     * Part number and full member list for one group. Paid, same as above.
     * @returns {Promise<object|null>} null when not subscribed
     */
    groupDetail: function (groupId) {
      return store().then(function (db) {
        return db.collection('groupDetails').doc(groupId).get();
      }).then(function (snap) {
        return snap.exists ? snap.data() : null;
      }).catch(function (err) {
        if (err && err.code === 'permission-denied') return null;
        throw err;
      });
    },

    /** Several groups at once, for a device page that lists all its parts. */
    groupDetails: function (groupIds) {
      if (!groupIds || !groupIds.length) return Promise.resolve([]);
      return store().then(function (db) {
        /* Firestore has no multi-get in the compat SDK, and `in` caps at 30,
           so this fans out. Callers pass a device's groups — single digits —
           not the whole catalogue. */
        return Promise.all(groupIds.slice(0, 60).map(function (id) {
          return db.collection('groupDetails').doc(id).get()
            .then(function (s) { return s.exists ? Object.assign({ id: id }, s.data()) : null; })
            .catch(function (e) {
              if (e && e.code === 'permission-denied') return null;
              throw e;
            });
        }));
      }).then(function (rows) { return rows.filter(Boolean); });
    },

    /* ------------------------------------------------------------ catalogue

       Compatibility groups, read straight from Firestore and paged with a
       cursor. A page costs `limit` document reads — twelve, not the 3,340 a
       whole-collection fetch would bill — and the composite indexes deployed
       from firestore.indexes.json are what make the filters cheap:

         categoryId + groupNo
         masterBrandId + groupNo
         categoryId + masterBrandId + groupNo

       Cursors rather than offsets, because Firestore has no OFFSET that skips
       for free: page 10 of an offset query still reads pages 1-9. startAfter
       resumes exactly where the last page stopped.

       Only the PUBLIC preview lives in /groups — no part number, no member
       list — so this query is readable by a signed-out visitor and cannot leak
       the paid half whatever it asks for. */
    listGroups: function (opts) {
      opts = opts || {};
      return store().then(function (db) {
        var q = db.collection('groups');

        if (opts.categoryId && opts.categoryId !== 'all') q = q.where('categoryId', '==', opts.categoryId);
        if (opts.brandId && opts.brandId !== 'all') q = q.where('masterBrandId', '==', opts.brandId);

        /* Sorting has to line up with an index that exists, so an unknown sort
           falls back to groupNo rather than throwing FAILED_PRECONDITION at a
           reader who just opened the page. */
        if (opts.sort === 'most') q = q.orderBy('memberCount', 'desc').orderBy('groupNo');
        else if (opts.sort === 'least') q = q.orderBy('memberCount', 'asc').orderBy('groupNo');
        else q = q.orderBy('groupNo');

        if (opts.cursor) q = q.startAfter(opts.cursor);
        return q.limit((opts.limit || 12) + 1).get();
      }).then(function (snap) {
        var docs = snap.docs;
        var limit = opts.limit || 12;
        /* One extra row is fetched purely to answer "is there more?" without a
           second count query, and dropped before returning. */
        var hasMore = docs.length > limit;
        var page = hasMore ? docs.slice(0, limit) : docs;

        return {
          items: page.map(function (d) {
            var g = d.data();
            return {
              groupId: d.id,
              groupNumber: g.groupNo,
              serialNumber: g.serialNo || g.groupNo,
              categoryId: g.categoryId,
              categoryName: g.categoryName,
              masterModelId: g.masterModelId,
              masterModelName: g.masterModelName,
              masterBrandId: g.masterBrandId,
              compatibleCount: g.memberCount,
              /* Read through rather than nulled. These used to be hard-coded
                 null here because the collection genuinely did not carry them;
                 it does now, and returning null for a field that is present is
                 how the finder showed "not listed" over data it had. Still
                 defaulted, so a document written by the older importer — which
                 had no part code — reads as absent rather than undefined. */
              partCode: g.partCode || null,
              oemPartNo: g.oemPartNo || null,
              compatibleDeviceIds: g.memberIds || null,
              memberNames: g.memberNames || null,
              createdOn: null
            };
          }),
          cursor: page.length ? page[page.length - 1] : null,
          hasMore: hasMore
        };
      });
    },

    /* One group's public preview. */
    group: function (groupId) {
      return store().then(function (db) {
        return db.collection('groups').doc(groupId).get();
      }).then(function (snap) { return snap.exists ? snap.data() : null; });
    },

    /* ------------------------------------------------------------- history */

    /** The shop's own recent searches. Owner-only by rule. */
    /* This one, pushSearch and check all promise never to throw, and they mean
       it — so each puts the deadline INSIDE its own catch. The blanket wrapper
       at the foot of this file would sit outside it and turn a timeout into
       exactly the rejection these methods exist to absorb. They are listed in
       SELF_BOUNDED there. */
    recentSearches: function (uid, limit) {
      return deadline(store().then(function (db) {
        return db.collection('users').doc(uid).collection('recent')
          .orderBy('at', 'desc').limit(limit || 10).get();
      }).then(function (snap) {
        return snap.docs.map(function (d) {
          var x = d.data();
          return { id: d.id, modelId: x.modelId, query: x.query, at: ms(x.at) };
        });
      }), 'recentSearches', DEADLINE_MS)
        .catch(function () { return []; });   /* history is a nicety, never a blocker */
    },

    pushSearch: function (uid, modelId, query) {
      return deadline(store().then(function (db) {
        return db.collection('users').doc(uid).collection('recent').doc(modelId).set({
          modelId: modelId, query: query || '', at: Date.now()
        });
      }), 'pushSearch', DEADLINE_MS)
        .catch(function () { /* losing a history row must not break a search */ });
    },

    /* -------------------------------------------------------------- health */

    /**
     * One cheap read that proves the whole chain: config -> SDK -> project ->
     * rules. Used by the diagnostics rather than guessing from a blank screen.
     */
    check: function () {
      return deadline(store().then(function (db) {
        return db.collection('catalog').doc('meta').get();
      }).then(function (snap) {
        return {
          ok: true,
          projectId: SM.fb.projectId(),
          catalogMeta: snap.exists ? snap.data() : null,
          imported: snap.exists
        };
      }), 'check', DEADLINE_MS)
        .catch(function (err) {
          /* A diagnostics call that throws is a diagnostics call nobody can
             use while the thing it diagnoses is broken. A timeout is a RESULT
             here — and the most informative one this function can return,
             because a backend that never answers is precisely what it is for. */
          return { ok: false, code: err && err.code, message: err && err.message };
        });
    }
  };

  /* ------------------------------------------------- the deadline, applied

     Wrapping the object rather than each method is deliberate. A per-call-site
     timeout is one someone forgets to add to the next method, and the method
     they forget is the one that strands a screen — which is precisely how this
     outage reached production with recovery code already written for it. Here
     there is nothing to remember: every asynchronous door out of this module
     goes through the same clock.

     `available` and `normaliseProfile` are pure and synchronous, and a
     non-thenable return is passed through untouched, so a future synchronous
     helper needs no maintenance here either. */
  (function applyDeadlines() {
    var SYNC = { available: 1, normaliseProfile: 1, forgetProfile: 1 };

    /* Already bounded, inside their own catch. Wrapping them again would put a
       rejection outside the handler that exists to absorb it, and these three
       promise their callers that they never throw. */
    var SELF_BOUNDED = { recentSearches: 1, pushSearch: 1, check: 1, warm: 1 };

    var LONGER = { uploadProfilePhoto: DEADLINE_UPLOAD_MS };

    Object.keys(SM.store).forEach(function (name) {
      var fn = SM.store[name];
      if (typeof fn !== 'function' || SYNC[name] || SELF_BOUNDED[name]) return;

      SM.store[name] = function () {
        var self = this === undefined ? SM.store : SM.store;
        var args = arguments;

        /* A method that throws synchronously must still reject rather than
           explode in the caller's stack — callers here only ever .catch. */
        var invoke = function () {
          try { return fn.apply(self, args); }
          catch (e) { return Promise.reject(e); }
        };

        var plan = RETRY_PLAN[name];
        if (plan) return withRetry(name, invoke, plan);

        var out = invoke();
        if (!out || typeof out.then !== 'function') return out;
        return deadline(out, name, LONGER[name] || DEADLINE_MS);
      };
    });
  })();
})(window);

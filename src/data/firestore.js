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

  SM.store = {
    available: function () { return SM.fb.isConfigured(); },

    /* ------------------------------------------------------------- profile */

    /** The signed-in shop's own record. Rules allow only its owner. */
    getUser: function (uid) {
      return store().then(function (db) {
        return db.collection('users').doc(uid).get();
      }).then(function (snap) {
        if (!snap.exists) return null;
        var d = snap.data();
        return Object.assign({}, d, {
          subscriptionStartedAt: ms(d.subscriptionStartedAt),
          subscriptionExpiresAt: ms(d.subscriptionExpiresAt),
          updatedAt: ms(d.updatedAt)
        });
      });
    },

    /**
     * Creates or updates the shop profile.
     * Subscription fields are deliberately not writable here — the rules
     * reject them, and a client that could grant itself a plan is the whole
     * attack the billing design exists to prevent.
     */
    saveUser: function (uid, profile) {
      var SAFE = ['displayName', 'shopName', 'proprietor', 'country', 'mobile',
                  'dial', 'address', 'photoUrl', 'location', 'email'];
      var patch = {};
      SAFE.forEach(function (k) { if (profile[k] !== undefined) patch[k] = profile[k]; });
      patch.updatedAt = Date.now();

      return store().then(function (db) {
        return db.collection('users').doc(uid).set(patch, { merge: true });
      }).then(function () { return patch; });
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

    /* ------------------------------------------------------------- history */

    /** The shop's own recent searches. Owner-only by rule. */
    recentSearches: function (uid, limit) {
      return store().then(function (db) {
        return db.collection('users').doc(uid).collection('recent')
          .orderBy('at', 'desc').limit(limit || 10).get();
      }).then(function (snap) {
        return snap.docs.map(function (d) {
          var x = d.data();
          return { id: d.id, modelId: x.modelId, query: x.query, at: ms(x.at) };
        });
      }).catch(function () { return []; });   /* history is a nicety, never a blocker */
    },

    pushSearch: function (uid, modelId, query) {
      return store().then(function (db) {
        return db.collection('users').doc(uid).collection('recent').doc(modelId).set({
          modelId: modelId, query: query || '', at: Date.now()
        });
      }).catch(function () { /* losing a history row must not break a search */ });
    },

    /* -------------------------------------------------------------- health */

    /**
     * One cheap read that proves the whole chain: config -> SDK -> project ->
     * rules. Used by the diagnostics rather than guessing from a blank screen.
     */
    check: function () {
      return store().then(function (db) {
        return db.collection('catalog').doc('meta').get();
      }).then(function (snap) {
        return {
          ok: true,
          projectId: SM.fb.projectId(),
          catalogMeta: snap.exists ? snap.data() : null,
          imported: snap.exists
        };
      }).catch(function (err) {
        return { ok: false, code: err && err.code, message: err && err.message };
      });
    }
  };
})(window);

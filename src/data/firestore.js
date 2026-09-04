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
        subscriptionStatus: d.subscriptionStatus || d.activeSubscriptionStatus || 'none',
        currentPlanId: d.currentPlanId || null,
        subscriptionStartedAt: ms(d.subscriptionStartedAt),
        subscriptionExpiresAt: ms(d.subscriptionExpiresAt),
        createdAt: ms(d.createdAt),
        updatedAt: ms(d.updatedAt)
      };
    },

    /** The authoritative profile for a UID, or null if this account is new. */
    loadProfile: function (uid) {
      var self = this;
      return store().then(function (db) {
        return db.collection('users').doc(uid).get();
      }).then(function (snap) {
        return snap.exists ? self.normaliseProfile(snap.data()) : null;
      });
    },

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
      var W = ['mobileShopName', 'proprietorName', 'mobileNumber', 'mobileNumberE164',
               'country', 'countryCode', 'address', 'profilePhotoURL', 'profilePhotoPath'];
      var doc = { uid: uid, updatedAt: Date.now() };
      W.forEach(function (k) {
        var v = patch[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') doc[k] = v;
      });

      if (googleUser) {
        doc.email = googleUser.email || '';
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
          return ref.set(doc, { merge: true });
        }).then(function () { return ref.get(); });
      }).then(function (snap) { return self.normaliseProfile(snap.data()); });
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
              /* the paid half is not in this collection at all */
              partCode: null,
              compatibleDeviceIds: null,
              memberNames: null,
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

/* ============================================================================
   Mobile Parts Finder · admin-api.js — the admin app's only way to data
   ----------------------------------------------------------------------------
   Every byte the admin UI displays comes through here, and here talks only to
   /api/admin/*.

   ----------------------------------------------------------------------------
   THIS FILE HOLDS NO FIRESTORE HANDLE, AND THAT IS THE POINT

   The customer app reads Firestore directly, because a shop reading its own
   profile is exactly what the security rules are for. The admin app cannot do
   that: every admin collection is `allow read, write: if false` in
   firestore.rules, so an administrator's browser — holding an ordinary
   Firebase ID token like anyone else's — cannot read one document of it.

   So there is no SDK call in this file to get wrong, no rule to write
   carefully, and no path by which a UI bug exposes a collection. The server
   checks the role on every request and sends back only what that role may see.

   ----------------------------------------------------------------------------
   IDENTITY IS THE SAME FIREBASE SESSION AS THE MAIN SITE

   Not a second login. An administrator signs in with the same Google account
   they use as a customer; what makes the session an admin's is a record on the
   server. That is why there is no admin password anywhere — there is nothing
   for one to protect.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});
  var ADM = (SM.adm = SM.adm || {});

  /**
   * One authenticated request.
   *
   * The token is fetched fresh for every call. `getIdToken(false)` returns the
   * cached one until it is close to expiring, so this is cheap — and holding a
   * single token for the life of the page is how a long admin session starts
   * answering 401 an hour in.
   */
  function request(path, options) {
    options = options || {};

    return SM.fb.idToken().then(function (token) {
      if (!token) {
        var e = new Error('signin-required');
        e.status = 401;
        throw e;
      }
      return fetch(path, {
        method: options.method || 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.ok) return data;

        /* The server's own message where there is one. A 409 from the
           missing-model workflow says exactly which transition was refused,
           and replacing that with "request failed" throws away the only useful
           sentence in the response. */
        var err = new Error(data.error || ('http ' + res.status));
        err.status = res.status;
        err.data = data;
        throw err;
      });
    });
  }

  /** Turns an object into a query string, dropping empty values. */
  function qs(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (key) {
      var value = params[key];
      if (value === undefined || value === null || value === '' || value === 'all') return;
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  ADM.api = {
    /* Who am I, and what may I do. The first call the app makes, and the only
       thing that decides whether it renders at all. */
    session: function () { return request('/api/admin/session'); },

    users: function (params) { return request('/api/admin/users' + qs(params)); },
    user: function (uid) { return request('/api/admin/user' + qs({ uid: uid })); },

    metrics: function (days) { return request('/api/admin/metrics' + qs({ days: days })); },

    missingModels: function (params) {
      return request('/api/admin/missing-models' + qs(params));
    },
    updateMissingModel: function (body) {
      return request('/api/admin/missing-models', { method: 'POST', body: body });
    },

    admins: function () { return request('/api/admin/admins'); },
    setAdminRole: function (body) {
      return request('/api/admin/admins', { method: 'POST', body: body });
    },

    audit: function (params) { return request('/api/admin/audit' + qs(params)); },

    ai: function (params) { return request('/api/admin/ai' + qs(params)); },
    aiAction: function (body) { return request('/api/admin/ai', { method: 'POST', body: body }); }
  };

  ADM.request = request;
  ADM.qs = qs;
})(window);

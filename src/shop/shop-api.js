/* ============================================================================
   Mobile Parts Finder · shop-api.js — Quick Billing's browser half of /api/shop
   ----------------------------------------------------------------------------
   Every request carries the signed-in user's Firebase ID token and nothing
   else that says who they are; the server takes the shop from the token.

   The same two rules src/data/access.js learned the hard way:
     · wait for Firebase to finish restoring the session before asking, or a
       returning shop's first request goes out with no token and is refused
     · a 401 is "mint a fresh token and ask once more", never "signed out"

   XMLHttpRequest rather than fetch, because a product photo is uploaded in
   the same request as the product and the form shows its progress — fetch
   still cannot report upload progress.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  function failure(status, data) {
    var e = new Error((data && data.error) || ('http-' + status));
    e.status = status;
    e.data = data || {};
    e.code = e.data.error || ('http-' + status);
    return e;
  }

  function token(force) {
    if (!SM.fb || !SM.fb.whenResolved) return Promise.resolve(null);
    return SM.fb.whenResolved().then(function (user) {
      return user ? SM.fb.idToken(!!force) : null;
    });
  }

  function qs(o) {
    return Object.keys(o).filter(function (k) { return o[k] != null && o[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }

  /**
   * @param {string} section  state | category | product | moves | bill | bills
   * @param {{body?:object, query?:object, onProgress?:function(number), timeout?:number}} [opts]
   * @returns {Promise<object>} the parsed reply; rejects with {status, code, data}
   */
  function request(section, opts, retried) {
    opts = opts || {};
    return token(retried).then(function (tok) {
      if (!tok) throw failure(401, { error: 'signed-out' });
      var q = opts.query ? qs(opts.query) : '';
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(opts.body ? 'POST' : 'GET', '/api/shop/' + section + (q ? '?' + q : ''));
        xhr.setRequestHeader('Authorization', 'Bearer ' + tok);
        if (opts.body) xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = opts.timeout || 30000;
        if (opts.onProgress && xhr.upload) {
          xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) opts.onProgress(Math.min(1, e.loaded / e.total));
          };
        }
        xhr.onload = function () {
          var data = null;
          try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
          if (xhr.status === 401 && !retried) { resolve(request(section, opts, true)); return; }
          if (xhr.status >= 200 && xhr.status < 300) resolve(data || {});
          else reject(failure(xhr.status, data));
        };
        xhr.onerror = function () { reject(failure(0, { error: 'network' })); };
        xhr.ontimeout = function () { reject(failure(0, { error: 'timeout' })); };
        xhr.send(opts.body ? JSON.stringify(opts.body) : null);
      });
    });
  }

  /** True for a failure where the request may never have arrived — worth repeating. */
  function retryable(err) {
    return !!err && (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504);
  }

  /**
   * A request that is safe to repeat (it carries its own idempotency id), sent
   * again on a dropped connection or a server hiccup: 1s, 2s, then 4s apart.
   */
  function withRetry(section, opts, attempts) {
    var left = attempts == null ? 3 : attempts;
    return request(section, opts).catch(function (err) {
      if (!retryable(err) || left <= 0) throw err;
      var wait = 1000 * Math.pow(2, 3 - left);
      return new Promise(function (r) { setTimeout(r, wait); })
        .then(function () { return withRetry(section, opts, left - 1); });
    });
  }

  /** A random id for an idempotent write: `prefix` + 24 hex characters. */
  function newId(prefix) {
    var a = new Uint8Array(12);
    (global.crypto || global.msCrypto).getRandomValues(a);
    var s = '';
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return (prefix || '') + s;
  }

  /**
   * A photo from the file picker, shrunk in the browser to at most 900px on
   * its long side and re-encoded as JPEG. A phone camera's 4 MB original
   * becomes ~100 KB, which uploads in a second on 4G and is all a product
   * thumbnail or a label ever needs.
   *
   * @returns {Promise<{type:string, data:string, preview:string}>}
   */
  function prepareImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || 'image/')) { reject(failure(400, { error: 'image-type' })); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var max = 900;
        var scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * scale));
        var h = Math.max(1, Math.round(img.naturalHeight * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var g = canvas.getContext('2d');
        g.fillStyle = '#fff';                 /* a transparent PNG gets a white ground, not black */
        g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
        resolve({ type: 'image/jpeg', data: dataUrl.split(',')[1], preview: dataUrl });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(failure(400, { error: 'image-data' })); };
      img.src = url;
    });
  }

  SM.shopApi = {
    state: function () { return request('state'); },
    category: function (body) { return request('category', { body: body }); },
    product: function (body, onProgress) {
      return withRetry('product', { body: body, onProgress: onProgress, timeout: 60000 },
        body.action === 'create' || body.action === 'adjust' ? 3 : 0);
    },
    moves: function (productId) { return request('moves', { query: { productId: productId } }); },
    /* finalise carries its finalisation id, void and payment are idempotent
       by nature — all three are safe to send again */
    bill: function (body) { return withRetry('bill', { body: body }, 3); },
    getBill: function (id) { return request('bill', { query: { id: id } }); },
    bills: function (query) { return request('bills', { query: query }); },
    newId: newId,
    prepareImage: prepareImage,
    retryable: retryable
  };
})(window);

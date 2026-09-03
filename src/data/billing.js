/* ============================================================================
   Mobile Parts Finder · billing.js — the browser half of the payment flow
   ----------------------------------------------------------------------------
   Talks to /api/*, opens Razorpay Checkout, and reports progress. What it
   deliberately does NOT do is decide anything.

   THE RULE THIS FILE EXISTS TO ENFORCE

     A subscription becomes active because the SERVER said so, never because
     Checkout's success callback fired. That callback runs in the page, and
     anything running in the page can be run by hand from the console. So the
     handler does not unlock anything — it posts the payment to
     /api/verify-payment and waits. The signature is checked there, against a
     secret this file has never seen, and access follows from that answer alone.

   WHY THE STATUS IS RE-FETCHED AFTERWARDS

     Even the verify response is not treated as the final word on access.
     `status()` re-reads /api/subscription, so what the UI shows is always the
     server's current record — including the case where the webhook activated
     the subscription first and the browser's own verify call arrived second.

   PAYMENT CANNOT ONLY SUCCEED

     Checkout has three exits and all three are handled: success, an explicit
     failure event, and the user dismissing the modal. That last one used to be
     the bug in every integration — the promise simply never settles and the
     button spins forever — so `ondismiss` resolves with a cancelled state.
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var CHECKOUT_SDK = 'https://checkout.razorpay.com/v1/checkout.js';
  var checkoutLoading = null;

  function loadCheckout() {
    if (global.Razorpay) return Promise.resolve();
    if (checkoutLoading) return checkoutLoading;
    checkoutLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = CHECKOUT_SDK;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('checkout-unavailable')); };
      document.head.appendChild(s);
    }).catch(function (e) { checkoutLoading = null; throw e; });
    return checkoutLoading;
  }

  /* Every authenticated call goes through here so the token is always fresh
     and a 401 always means the same thing. */
  function apiFetch(path, options) {
    options = options || {};
    return SM.fb.idToken().then(function (token) {
      if (!token) throw new Error('signin-required');
      return fetch(path, {
        method: options.method || 'GET',
        headers: Object.assign({
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json'
        }, options.headers || {}),
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('http ' + res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  SM.billing = {
    /** Public pricing. No auth — a signed-out visitor must see the price. */
    plans: function () {
      return fetch('/api/plans').then(function (r) { return r.json(); });
    },

    /** The server's record of this account's access. The only source of truth. */
    status: function () {
      return apiFetch('/api/subscription');
    },

    cancel: function () {
      return apiFetch('/api/cancel-subscription', { method: 'POST' });
    },

    /**
     * Runs the whole purchase.
     *
     * @param {string} planId
     * @param {(stage:string, detail?:object) => void} [onStage]
     *        creating-order | opening-checkout | verifying |
     *        active | failed | cancelled
     * @returns {Promise<{state:string, [key:string]:any}>}
     *          Resolves for a cancellation too — a dismissed modal is an
     *          outcome, not an exception.
     */
    subscribe: function (planId, onStage) {
      var stage = onStage || function () {};

      return SM.fb.idToken().then(function (token) {
        if (!token) throw new Error('signin-required');

        stage('creating-order');
        return Promise.all([
          apiFetch('/api/create-order', { method: 'POST', body: { planId: planId } }),
          loadCheckout()
        ]);
      }).then(function (results) {
        var order = results[0];

        return new Promise(function (resolve, reject) {
          var settled = false;
          var finish = function (v) { if (!settled) { settled = true; resolve(v); } };

          var rzp = new global.Razorpay({
            key: order.keyId,              /* public key id, never the secret */
            amount: order.amount,
            currency: order.currency,
            order_id: order.orderId,
            name: 'Mobile Parts Finder',
            description: order.planName + ' subscription',
            prefill: order.prefill || {},
            theme: { color: '#0E7A6C' },

            /* Success here means Checkout finished — NOT that access is
               granted. That is decided by the server, below. */
            handler: function (response) {
              stage('verifying');
              apiFetch('/api/verify-payment', {
                method: 'POST',
                body: {
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature
                }
              }).then(function (verified) {
                stage('active', verified);
                finish({ state: 'active', ...verified });
              }).catch(function (err) {
                /* The money may well have left the account — the webhook will
                   reconcile it — so this says "could not confirm", not
                   "payment failed". */
                stage('failed', { reason: err.message, recoverable: true });
                finish({
                  state: 'verification-failed',
                  reason: err.message,
                  paymentId: response.razorpay_payment_id
                });
              });
            },

            modal: {
              /* Without this the promise never settles when the user closes
                 the sheet, and the button spins for ever. */
              ondismiss: function () {
                stage('cancelled');
                finish({ state: 'cancelled' });
              }
            }
          });

          rzp.on('payment.failed', function (resp) {
            var d = (resp && resp.error) || {};
            stage('failed', { reason: d.description, code: d.code });
            finish({ state: 'failed', reason: d.description || 'payment failed', code: d.code || null });
          });

          stage('opening-checkout');
          rzp.open();
        });
      });
    }
  };
})(window);

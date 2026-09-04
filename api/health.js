/* ============================================================================
   GET /api/health
   ----------------------------------------------------------------------------
   Says whether this deployment is configured, without saying what any value is.

   It exists because "Payment service is not configured yet" was, until now, a
   guess made in the browser from an HTTP 500 — and a 500 is equally consistent
   with a genuine crash. There was no way, from outside, to tell an unset
   environment variable from a bug. This route answers that question directly:

     curl https://www.mobilepartsfinder.com/api/health

   WHAT IT DISCLOSES, AND WHY THAT IS SAFE
     Booleans, plus the names of environment variables that are unset. Those
     names are already published in .env.example and docs/RAZORPAY.md; knowing
     that RAZORPAY_KEY_SECRET is unset does not help anyone obtain it, and it
     turns a dead Subscribe button into a five-minute fix.

     No value is ever returned. Not truncated, not hashed, not hinted at. The
     one derived detail is the Razorpay key MODE (test or live), read from the
     public key id's prefix — the same id that is sent to every browser to open
     Checkout.

   Never cached: the whole point is to reflect the environment as it is now,
   including thirty seconds after someone sets a variable and redeploys.
   ========================================================================== */
'use strict';

const { report } = require('./_lib/config');
const { json, fail, requireMethod } = require('./_lib/http');

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const cfg = report();

    /* 200 either way. This route reporting "not configured" is it working
       correctly, and a non-200 would make a monitor treat a truthful answer as
       an outage. `ok` in the body is the field to alert on. */
    return json(res, 200, {
      service: 'mobile-parts-finder',
      time: new Date().toISOString(),
      ...cfg
    });
  } catch (err) {
    return fail(res, err, 'health');
  }
};

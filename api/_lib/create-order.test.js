/* Proves create-order turns a Razorpay refusal into a named 502 rather than an
   opaque 500, and that no credential rides along with it. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

function run({ rzpError, env }) {
  const api = path.join(__dirname, '..');
  Object.keys(require.cache).filter(k => k.startsWith(api)).forEach(k => delete require.cache[k]);

  const saved = { ...process.env };
  Object.assign(process.env, env);

  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'razorpay') {
      return function Razorpay() {
        return { orders: { create: async () => { throw rzpError; } } };
      };
    }
    if (req.endsWith('_lib/store')) {
      return {
        recordPendingOrder: async () => {},
        readProfile: async () => ({
          mobileShopName: 'Ozo Mobiles', proprietorName: 'Jeevanandham Sarthar',
          mobileNumber: '9894301600', country: 'India'
        }),
        prefillFrom: () => ({ complete: true, missing: [], prefill: {} })
      };
    }
    if (req.endsWith('_lib/http')) {
      const real = origLoad.call(this, req, parent, isMain);
      return Object.assign({}, real, {
        requireUser: async () => ({ uid: 'uid123', email: 'shop@example.com', name: 'Shop' })
      });
    }
    return origLoad.call(this, req, parent, isMain);
  };

  const handler = require(path.join(api, 'create-order.js'));
  Module._load = origLoad;

  return new Promise(resolve => {
    const res = {
      statusCode: 0, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { Object.keys(process.env).forEach(k => { if (!(k in saved)) delete process.env[k]; });
               Object.assign(process.env, saved);
               resolve({ status: this.statusCode, body: JSON.parse(b) }); }
    };
    handler({ method: 'POST', headers: { authorization: 'Bearer x' }, body: { planId: 'monthly' } }, res);
  });
}

const ENV = {
  RAZORPAY_KEY_ID: 'rzp_live_ABCDEF123456',
  RAZORPAY_KEY_SECRET: 'the-real-secret-value-never-echo-me',
  FIREBASE_SERVICE_ACCOUNT: '{"project_id":"x"}',
  FIREBASE_PROJECT_ID: 'p', FIREBASE_API_KEY: 'k', FIREBASE_APP_ID: 'a'
};

test('a Razorpay refusal is a named 502 carrying its own description', async () => {
  const r = await run({
    env: ENV,
    rzpError: {
      statusCode: 401,
      error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed', reason: 'input_validation_failed' }
    }
  });
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'razorpay-refused');
  assert.equal(r.body.detail, 'Authentication failed');
  assert.equal(r.body.code, 'BAD_REQUEST_ERROR');
  assert.equal(r.body.gatewayStatus, 401);
  assert.equal(r.body.mode, 'live');
});

test('an unactivated live account reports what Razorpay actually said', async () => {
  const r = await run({
    env: ENV,
    rzpError: {
      statusCode: 400,
      error: { code: 'BAD_REQUEST_ERROR',
               description: 'Your account is not activated for live payments. Complete KYC to continue.' }
    }
  });
  assert.equal(r.status, 502);
  assert.match(r.body.detail, /not activated for live payments/);
});

test('the key secret never appears in the refusal response', async () => {
  const r = await run({
    env: ENV,
    rzpError: { statusCode: 401, error: { code: 'X', description: 'nope' } }
  });
  const serialised = JSON.stringify(r.body);
  assert.ok(!serialised.includes(ENV.RAZORPAY_KEY_SECRET), 'response leaked the key secret');
  assert.ok(!serialised.includes(ENV.RAZORPAY_KEY_ID), 'response echoed the key id needlessly');
});

test('an error with no Razorpay shape still becomes a 502, not a crash', async () => {
  const r = await run({ env: ENV, rzpError: new Error('socket hang up') });
  assert.equal(r.status, 502);
  assert.equal(r.body.detail, 'socket hang up');
  assert.equal(r.body.code, null);
});

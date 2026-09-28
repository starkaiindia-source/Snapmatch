/* ============================================================================
   api/_lib/config.test.js
   ----------------------------------------------------------------------------
   The configuration report decides what a shop owner is told when Subscribe
   does nothing, so its two jobs are tested here:

     · it must be RIGHT about what is missing — a false "configured" sends
       someone debugging Razorpay when the variable was never set
     · it must never leak a value. The whole point of reporting configuration
       publicly is that presence is safe to publish and content is not, and a
       test is the only thing that keeps that true as fields are added.
   ========================================================================== */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('./config');

/* Each test gets the environment it asks for and nothing else, so one test
   cannot pass because another left a variable behind. */
function withEnv(vars, fn) {
  const saved = { ...process.env };
  const managed = [
    'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
    'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_B64',
    'FIREBASE_PROJECT_ID', 'FIREBASE_API_KEY', 'FIREBASE_APP_ID'
  ];
  managed.forEach(k => { delete process.env[k]; });
  /* Assigning undefined into process.env stores the STRING "undefined", which
     is very much set — so an unset variable has to be an omission, not a value. */
  Object.keys(vars).forEach(k => {
    if (vars[k] !== undefined) process.env[k] = vars[k];
  });
  try { return fn(); }
  finally {
    managed.forEach(k => { delete process.env[k]; });
    Object.assign(process.env, saved);
  }
}

/* The service account names the SAME project as FIREBASE_PROJECT_ID. It used
   to say "x", which is a mismatch — a deployment where sign-in works and every
   authenticated request 401s. Now that report() catches that, the fixture for
   "fully configured" has to actually be configured. */
const FULL = {
  RAZORPAY_KEY_ID: 'rzp_test_abc123',
  RAZORPAY_KEY_SECRET: 'super-secret-value',
  RAZORPAY_WEBHOOK_SECRET: 'another-secret',
  FIREBASE_SERVICE_ACCOUNT: '{"project_id":"mobilepartsfinder","private_key":"-----BEGIN-----"}',
  FIREBASE_PROJECT_ID: 'mobilepartsfinder',
  FIREBASE_API_KEY: 'AIzaSyExample',
  FIREBASE_APP_ID: '1:1:web:1'
};

test('a fully configured deployment reports ok with nothing missing', () => {
  withEnv(FULL, () => {
    const r = config.report();
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.payments.configured, true);
    assert.equal(r.payments.webhook, true);
  });
});

test('a missing Razorpay secret is named, and payments are not ok', () => {
  withEnv({ ...FULL, RAZORPAY_KEY_SECRET: undefined }, () => {
    const r = config.report();
    assert.equal(r.ok, false);
    assert.equal(r.payments.configured, false);
    assert.ok(r.missing.includes('RAZORPAY_KEY_SECRET'));
    /* The rest is fine and must not be reported as broken too — one real cause
       beats six. */
    assert.ok(!r.missing.includes('FIREBASE_API_KEY'));
  });
});

test('an empty string counts as unset, not as configured', () => {
  withEnv({ ...FULL, RAZORPAY_KEY_ID: '   ' }, () => {
    const r = config.report();
    assert.equal(r.payments.configured, false);
    assert.ok(r.missing.includes('RAZORPAY_KEY_ID'));
  });
});

test('a missing webhook secret warns but still allows payments', () => {
  withEnv({ ...FULL, RAZORPAY_WEBHOOK_SECRET: undefined }, () => {
    const r = config.report();
    assert.equal(r.payments.configured, true);
    assert.equal(r.payments.webhook, false);
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 1);
  });
});

test('the base64 service account is accepted in place of the raw one', () => {
  withEnv({ ...FULL, FIREBASE_SERVICE_ACCOUNT: undefined, FIREBASE_SERVICE_ACCOUNT_B64: 'eyJhIjoxfQ==' }, () => {
    assert.equal(config.adminConfigured(), true);
    assert.ok(!config.report().missing.includes('FIREBASE_SERVICE_ACCOUNT'));
  });
});

test('test and live keys are told apart by their public prefix', () => {
  withEnv({ ...FULL, RAZORPAY_KEY_ID: 'rzp_test_x' }, () => assert.equal(config.razorpayMode(), 'test'));
  withEnv({ ...FULL, RAZORPAY_KEY_ID: 'rzp_live_x' }, () => assert.equal(config.razorpayMode(), 'live'));
  withEnv({ ...FULL, RAZORPAY_KEY_ID: 'something_else' }, () => assert.equal(config.razorpayMode(), 'unknown'));
  withEnv({ ...FULL, RAZORPAY_KEY_ID: undefined }, () => assert.equal(config.razorpayMode(), null));
});

/* ------------------------------------------------ the half-finished migration

   Changing the Firebase project means changing TWO variables, and the failure
   from changing only one is the most misleading in the whole system: Google
   sign-in succeeds, the user is genuinely authenticated, and then every single
   authenticated request is refused because the server is verifying tokens
   against a project that did not mint them. */
test('a service account from a different project than the browser is a hard failure', () => {
  withEnv({
    ...FULL,
    FIREBASE_SERVICE_ACCOUNT: '{"project_id":"mobilepartsfinder-old","private_key":"-----BEGIN-----"}'
  }, () => {
    const r = config.report();
    assert.equal(r.ok, false, 'a project mismatch must not report ok');
    assert.equal(r.firebaseProject.match, false);
    assert.equal(r.firebaseProject.web, 'mobilepartsfinder');
    assert.equal(r.firebaseProject.admin, 'mobilepartsfinder-old');
    /* Nothing is MISSING — that is exactly why this needed its own check. */
    assert.deepEqual(r.missing, []);
    assert.ok(r.warnings.some(w => w.includes('mobilepartsfinder-old')),
              'the warning must name both projects');
  });
});

test('matching projects report ok and say so', () => {
  withEnv(FULL, () => {
    const r = config.report();
    assert.equal(r.firebaseProject.match, true);
    assert.equal(r.ok, true);
  });
});

test('an unknown project on either side is not reported as a mismatch', () => {
  /* A base64 service account this test cannot parse into a project id, and an
     unparseable one. Unknown is not wrong, and claiming a mismatch would send
     someone to "fix" a variable that is correct. */
  withEnv({ ...FULL, FIREBASE_SERVICE_ACCOUNT: 'not json at all' }, () => {
    const r = config.report();
    assert.equal(r.firebaseProject.match, null);
    assert.equal(r.ok, true, 'an unreadable key is a different fault, reported elsewhere');
  });
  withEnv({ ...FULL, FIREBASE_PROJECT_ID: undefined }, () => {
    assert.equal(config.report().firebaseProject.match, null);
  });
});

test('the base64 service account is read for its project id too', () => {
  const b64 = Buffer.from('{"project_id":"mobilepartsfinder"}').toString('base64');
  withEnv({ ...FULL, FIREBASE_SERVICE_ACCOUNT: undefined, FIREBASE_SERVICE_ACCOUNT_B64: b64 }, () => {
    assert.equal(config.serviceAccountProjectId(), 'mobilepartsfinder');
    assert.equal(config.report().firebaseProject.match, true);
  });
});

test('NO SECRET VALUE APPEARS ANYWHERE IN THE REPORT', () => {
  withEnv(FULL, () => {
    const serialised = JSON.stringify(config.report());
    /* Every value that must never be published, checked against the whole
       response rather than field by field — a new field that leaks one fails
       here without anybody remembering to add a case. */
    [
      FULL.RAZORPAY_KEY_SECRET,
      FULL.RAZORPAY_WEBHOOK_SECRET,
      FULL.FIREBASE_SERVICE_ACCOUNT,
      FULL.FIREBASE_API_KEY,
      FULL.RAZORPAY_KEY_ID          /* public, but there is no reason to echo it */
    ].forEach(secret => {
      assert.ok(!serialised.includes(secret), `report leaked ${secret.slice(0, 8)}…`);
    });
    /* The private key in particular, checked on its own: firebaseProject reads
       INTO the service account, so the one field that must never come back out
       gets an assertion of its own rather than relying on the whole-blob match
       above. */
    assert.ok(!serialised.includes('BEGIN'), 'report leaked part of the private key');
    /* The mode is derived from the prefix and IS published — deliberately. */
    assert.equal(config.report().payments.mode, 'test');
  });
});

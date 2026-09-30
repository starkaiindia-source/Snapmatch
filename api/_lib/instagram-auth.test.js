/* ============================================================================
   api/_lib/instagram-auth.test.js
   ----------------------------------------------------------------------------
   Authentication and authorization for /api/admin/instagram, through the
   real dispatcher (api/admin.js) and the real gate (api/_lib/admin-auth.js).
   Only the token verifier and Firestore are stand-ins.

   Written from the attacker's side: the question is what someone must do to
   start an import, approve a fitment or read the queue — and the answer must
   stay "be the owner, signed in with Google".
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

delete process.env.OWNER_UID;
process.env.INSTAGRAM_GRAPH_ACCESS_TOKEN = 'test-only-graph-token-not-real';
process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID = '17841400000000000';
process.env.AI_GATEWAY_URL = 'https://ai.example.internal';
process.env.AI_GATEWAY_TOKEN = 'gateway-secret-token-value';
process.env.GOOGLE_VISION_API_KEY = 'test-only-vision-key-not-real';

const { createFakeFirestore } = require('./testing/fake-firestore');
const fake = createFakeFirestore();

/* Stand-ins installed BEFORE the admin modules load, because they capture
   these functions at require time. */
const firebase = require('./firebase');
const TOKENS = {
  'owner-token': { uid: 'ownerUid000001', email: 'Stark.ai.India@gmail.com', email_verified: true },
  'owner-unverified': { uid: 'lookalikeUid01', email: 'stark.ai.india@gmail.com', email_verified: false },
  'shop-token': { uid: 'shopUid0000001', email: 'shop@example.com', email_verified: true },
  'shop-claims-admin': { uid: 'shopUid0000002', email: 'shop2@example.com', email_verified: true, role: 'super_admin' }
};
firebase.auth = () => ({
  verifyIdToken: async token => {
    if (token === 'expired') { const e = new Error('expired'); e.code = 'auth/id-token-expired'; throw e; }
    if (!TOKENS[token]) { const e = new Error('bad'); e.code = 'auth/argument-error'; throw e; }
    return TOKENS[token];
  }
});
firebase.db = () => fake.db;
require('../_services/instagram/firestore').use(fake.provider);

const handler = require('../admin');
const { ROLES, PERMISSIONS, can } = require('../_schema/roles');

function call({ method = 'GET', token, query = {}, body }) {
  return new Promise(resolve => {
    const res = {
      statusCode: 200, headers: {},
      status(code) { this.statusCode = code; return this; },
      setHeader(k, v) { this.headers[k] = v; return this; },
      end(payload) { resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null, raw: payload || '' }); }
    };
    const req = {
      method, url: '/api/admin/instagram',
      query: Object.assign({ section: 'instagram' }, query),
      headers: token ? { authorization: 'Bearer ' + token } : {},
      body
    };
    Promise.resolve(handler(req, res)).catch(err => resolve({ status: 'threw', err }));
  });
}

/* ------------------------------------------------------ 18. authentication */

test('no token, a bad token or an expired token gets 401 and changes nothing', async () => {
  const before = fake.snapshotAll();
  for (const token of [undefined, 'not-a-real-token', 'expired']) {
    const r = await call({ token });
    assert.equal(r.status, 401, `GET with ${token}`);
    const w = await call({ method: 'POST', token, body: { action: 'analyze', profileUrl: 'https://www.instagram.com/x_y/' } });
    assert.equal(w.status, 401, `POST with ${token}`);
  }
  assert.equal(fake.snapshotAll(), before);
  const expired = await call({ token: 'expired' });
  assert.equal(expired.body.error, 'token expired');
});

/* ------------------------------------------------------- 19. authorization */

test('a signed-in customer cannot read the queue, start an import or approve anything', async () => {
  const before = fake.snapshotAll();
  for (const token of ['shop-token', 'shop-claims-admin', 'owner-unverified']) {
    assert.equal((await call({ token })).status, 403, `${token} read`);
    for (const action of ['analyze', 'tick', 'approve', 'approve_all_valid', 'reject', 'select_model', 'ignore_source']) {
      const r = await call({ method: 'POST', token, body: { action, profileUrl: 'https://www.instagram.com/x_y/', candidateId: 'abc', jobId: 'abc', modelId: 'samsung-galaxy-a15', sourceKey: 'ig_x' } });
      assert.equal(r.status, 403, `${token} ${action}`);
      assert.equal(r.body.error.indexOf('not authorised'), 0, 'the same refusal whatever the reason');
    }
  }
  assert.equal(fake.snapshotAll(), before, 'a refused request writes nothing, not even an audit row');
});

test('the owner is allowed, and every write is audited with who did it', async () => {
  const overview = await call({ token: 'owner-token' });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.integration.graph.configured, true);

  const started = await call({ method: 'POST', token: 'owner-token', body: { action: 'analyze', profileUrl: 'https://www.instagram.com/mobile_parts_hub/', maxItems: 5 } });
  assert.equal(started.status, 200);
  assert.equal(started.body.job.createdBy, 'ownerUid000001');
  await new Promise(r => setTimeout(r, 10));
  const log = fake.all('adminAuditLog');
  const entry = log.find(e => e.action === 'instagram.import_started');
  assert.ok(entry, 'the import is in the audit log');
  assert.equal(entry.actorUid, 'ownerUid000001');
  assert.equal(entry.detail.sourceUrl, 'https://www.instagram.com/mobile_parts_hub/');
});

test('no credential ever reaches the browser: not in overview, not in a job, not in an error', async () => {
  const secrets = [process.env.INSTAGRAM_GRAPH_ACCESS_TOKEN, process.env.AI_GATEWAY_TOKEN, process.env.GOOGLE_VISION_API_KEY];
  const responses = [
    await call({ token: 'owner-token' }),
    await call({ token: 'owner-token', query: { view: 'jobs' } }),
    await call({ token: 'owner-token', query: { view: 'sources' } }),
    await call({ method: 'POST', token: 'owner-token', body: { action: 'analyze', profileUrl: 'https://evil.example/x' } })
  ];
  responses.forEach(r => secrets.forEach(s => assert.equal(r.raw.indexOf(s), -1, 'a secret leaked into a response')));
  assert.equal(responses[3].status, 400);
});

test('bad input is refused before it reaches a service', async () => {
  const unknown = await call({ method: 'POST', token: 'owner-token', body: { action: 'drop_database' } });
  assert.equal(unknown.status, 400);
  const badModel = await call({ method: 'POST', token: 'owner-token', body: { action: 'select_model', candidateId: '../../etc', modelId: 'x' } });
  assert.equal(badModel.status, 400);
});

test('the permission table: approval is its own permission, and support/analyst hold none of it', () => {
  const ig = [PERMISSIONS.INSTAGRAM_READ, PERMISSIONS.INSTAGRAM_IMPORT, PERMISSIONS.COMPAT_REVIEW, PERMISSIONS.COMPAT_APPROVE];
  ig.forEach(p => {
    assert.equal(can(ROLES.SUPER_ADMIN, p), true, p);
    assert.equal(can(ROLES.ADMIN, p), true, p);
    assert.equal(can(ROLES.SUPPORT, p), false, p);
    assert.equal(can(ROLES.ANALYST, p), false, p);
    assert.equal(can(ROLES.USER, p), false, p);
  });
  assert.notEqual(PERMISSIONS.COMPAT_APPROVE, PERMISSIONS.COMPAT_REVIEW);
});

test('no Instagram request parameter collides with the dispatcher\'s own `section` parameter', async () => {
  /* vercel.json rewrites /api/admin/<x> to /api/admin.js?section=<x>. A page
     parameter also called `section` would be merged into it and route the
     request to another admin section. The review queue's is `queue`. */
  const src = fs.readFileSync(path.join(__dirname, '..', '_admin', 'instagram.js'), 'utf8');
  assert.equal(/\bq\.section\b/.test(src), false);
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'admin', 'pages', 'compat-review.js'), 'utf8');
  assert.equal(/view: 'review', section:/.test(page), false);
  const r = await call({ token: 'owner-token', query: { view: 'review', queue: 'review' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.section, 'review');
});

test('the admin UI never talks to Instagram, Google Vision or the AI gateway directly', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'admin');
  const files = [path.join(dir, 'admin-api.js')].concat(fs.readdirSync(path.join(dir, 'pages')).map(f => path.join(dir, 'pages', f)));
  files.forEach(f => {
    const src = fs.readFileSync(f, 'utf8');
    assert.equal(/graph\.facebook\.com|vision\.googleapis\.com|access_token|AI_GATEWAY_TOKEN\s*=/.test(src), false, path.basename(f));
  });
});

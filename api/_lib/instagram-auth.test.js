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
process.env.ANTHROPIC_API_KEY = 'test-only-anthropic-key-not-real';
process.env.GEMINI_API_KEY = 'test-only-gemini-key-not-real';

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
    for (const action of ['analyze', 'tick', 'approve', 'approve_all_valid', 'reject', 'select_model', 'ignore_source',
      'add_evidence', 'verify_providers', 'approve_proposal', 'proposal_select_model', 'proposal_member_decision', 'proposal_add_model',
      'proposal_set_master', 'proposal_set_target', 'proposal_refresh']) {
      const r = await call({ method: 'POST', token, body: { action, profileUrl: 'https://www.instagram.com/x_y/', candidateId: 'abc', jobId: 'abc',
        modelId: 'samsung-galaxy-a15', sourceKey: 'ig_x', contentKey: 'igm_1', memberKey: 'm:samsung-galaxy-a15', text: 'Vivo Y20 Combo' } });
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
  const secrets = [process.env.INSTAGRAM_GRAPH_ACCESS_TOKEN, process.env.AI_GATEWAY_TOKEN, process.env.GOOGLE_VISION_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.GEMINI_API_KEY];
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

  /* the group-proposal and evidence actions */
  const post = body => call({ method: 'POST', token: 'owner-token', body });
  assert.equal((await post({ action: 'proposal_member_decision', candidateId: 'abc', memberKey: 'm:../../groups/sg-0001', decision: 'exclude' })).status, 400, 'a member key is never a path');
  assert.equal((await post({ action: 'proposal_select_model', candidateId: 'abc', memberKey: 't:vivo y21' })).status, 400, 'a model id is required');
  assert.equal((await post({ action: 'proposal_member_decision', candidateId: 'abc', memberKey: 'm:vivo-y20', decision: 'delete_group' })).status, 400, 'only the listed decisions');
  assert.equal((await post({ action: 'approve_proposal', candidateId: 'no-such-proposal' })).status, 404);
  const notAnImage = await post({ action: 'add_evidence', contentKey: 'igm_1', images: [{ data: Buffer.from('<script>alert(1)</script>').toString('base64') }] });
  assert.equal(notAnImage.status, 400, 'an attachment must BE an image, whatever it is called');
  assert.match(notAnImage.body.error, /JPEG, PNG or WebP/);
  assert.equal((await post({ action: 'add_evidence', contentKey: 'igm_1', images: [{ data: '%%%not base64%%%' }] })).status, 400);
  assert.equal((await post({ action: 'add_evidence', contentKey: 'igm_missing', text: 'Vivo Y20 Combo' })).status, 404, 'evidence attaches to a post that exists');
  assert.equal((await call({ token: 'owner-token', query: { view: 'evidence_preview', id: '../../../etc/passwd' } })).status, 400);
  assert.equal((await call({ token: 'owner-token', query: { view: 'group', groupId: 'cd-9999' } })).status, 404);
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

test('Extraction Results opens on "relevant": an ignored post is listed only when asked for', async () => {
  fake.seed('instagramExtractions/igm_a__v1', { extractionId: 'igm_a__v1', contentKey: 'igm_a', relevance: 'RELEVANT_COMPATIBILITY', filters: ['all', 'relevant'], extractedAt: 3 });
  fake.seed('instagramExtractions/igm_b__v1', { extractionId: 'igm_b__v1', contentKey: 'igm_b', relevance: 'IRRELEVANT_REPAIR', filters: ['all', 'ignored'], extractedAt: 2 });
  fake.seed('instagramExtractions/igm_c__v1', { extractionId: 'igm_c__v1', contentKey: 'igm_c', relevance: 'RELEVANT_COMPATIBILITY', filters: [], supersededBy: 'igm_c__v2', extractedAt: 1 });
  const ids = async filter => (await call({ token: 'owner-token', query: Object.assign({ view: 'extractions' }, filter ? { filter } : {}) })).body.extractions.map(x => x.extractionId);
  assert.deepEqual(await ids(), ['igm_a__v1'], 'the default tab is Relevant');
  assert.deepEqual(await ids('ignored'), ['igm_b__v1']);
  assert.deepEqual(await ids('all'), ['igm_a__v1', 'igm_b__v1'], 'a replaced version is in no tab');
  assert.deepEqual(await ids('drop table'), ['igm_a__v1'], 'an unknown filter is the default, not an error');
  const overview = await call({ token: 'owner-token' });
  assert.deepEqual(overview.body.extractionFilters.map(f => f.label),
    ['Relevant', 'All', 'Existing Group Updates', 'New Groups', 'Needs Review', 'Conflicts', 'Ignored', 'Errors']);
  assert.equal(overview.body.integration.vision.configured, true);
  assert.equal(overview.body.integration.vision.provider, 'gemini', 'Gemini is the primary media reader');
  assert.equal(overview.body.integration.validator.provider, 'anthropic', 'and Claude the second opinion');
  assert.equal(overview.body.integration.video.native, true);

  /* before the tab index is deployed Firestore refuses the query; the page
     still answers, from the recent extractions, and says so */
  const collection = fake.db.collection;
  fake.db.collection = name => {
    const col = collection(name);
    if (name !== 'instagramExtractions') return col;
    return Object.assign({}, col, { where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => {
      const e = new Error('9 FAILED_PRECONDITION: The query requires an index.'); e.code = 9; throw e;
    } }) }) }) });
  };
  try {
    const r = await call({ token: 'owner-token', query: { view: 'extractions', filter: 'ignored' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.indexMissing, true);
    assert.deepEqual(r.body.extractions.map(x => x.extractionId), ['igm_b__v1']);
  } finally {
    fake.db.collection = collection;
  }
});

test('the admin UI never talks to Instagram, Google Vision, Anthropic or the AI gateway directly', () => {
  const dir = path.join(__dirname, '..', '..', 'src', 'admin');
  const files = [path.join(dir, 'admin-api.js')].concat(fs.readdirSync(path.join(dir, 'pages')).map(f => path.join(dir, 'pages', f)));
  files.forEach(f => {
    const src = fs.readFileSync(f, 'utf8');
    assert.equal(/graph\.facebook\.com|vision\.googleapis\.com|api\.anthropic\.com|x-api-key|access_token|AI_GATEWAY_TOKEN\s*=/.test(src), false, path.basename(f));
  });
});

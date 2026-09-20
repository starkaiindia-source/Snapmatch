/* ============================================================================
   api/_lib/paywall-surface.test.js
   ----------------------------------------------------------------------------
   THE PAYWALL IS ONLY AS GOOD AS ITS WEAKEST SURFACE, and for a long time the
   weakest one was not an endpoint at all — it was a static file.

   assets/dataset.json shipped `modelGroups`, the map of device -> the groups
   that fit it. Inverting that map yields, for every one of the 3,384 groups,
   the complete list of devices in it: 12,345 fitments, the thing the
   subscription is sold for, one unauthenticated GET away and parsed by the app
   itself on every page load. Every server-side check in this directory was
   being enforced over the top of a file that had already given the answer
   away.

   So this file tests two things that are not the same thing:

     1. the ROUTE withholds the member list from a free account
     2. the BUNDLE does not contain it, and cannot be made to yield it

   (2) has no API to call, so it is asserted against the built artefact. It
   will fail the moment someone puts the edge list back, which is the point:
   the check that was missing is the reason the hole existed.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* ---------------------------------------------------------------- the stub
   Same shape as search-quota.test.js: a real read-modify-write, installed in
   the module cache before the service under test requires firebase. */

const store = new Map();

function docRef(collection, id) {
  const key = collection + '/' + id;
  return {
    __key: key,
    get: async () => ({ exists: store.has(key), data: () => store.get(key) })
  };
}

const fakeDb = () => ({
  collection: name => ({ doc: id => docRef(name, id) }),
  runTransaction: async fn => fn({ get: ref => ref.get(), set: () => {} })
});

const firebasePath = require.resolve('./firebase');
require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: {
    db: fakeDb,
    auth: () => { throw new Error('auth is not stubbed'); },
    app: () => { throw new Error('app is not stubbed'); },
    admin: { firestore: { FieldValue: { increment: n => n, serverTimestamp: () => 0 } } }
  }
};

const entitlements = require(path.join(__dirname, '..', '_services', 'entitlement-service'));
const { datastoreDown } = require('./http');

test.beforeEach(() => store.clear());

/* ============================================================ 1. THE ROUTE */

/* The importer writes this map to `modelGroups`, as { id, byCategory }.
   entitlement-service used to read a `deviceGroups` collection and treat the
   document's own keys as category ids — a collection the importer has never
   written, in a shape it has never produced — so every ?modelId= request
   answered 404 for every device in the catalogue. It went unnoticed only
   because nothing called the route; the browser read the public bundle
   instead. Routing the browser through it makes this load-bearing. */
/* Synthetic ids on purpose. entitlement-service checks the LOCAL
   api/_data/parts.json before Firestore, so seeding a real device id here
   would silently test the real catalogue instead of the stub. */
function seedDevice(modelId, byCategory) {
  store.set('modelGroups/' + modelId, { id: modelId, byCategory });
}

/* A fresh id per test. entitlement-service caches group details per warm
   instance — correctly, a member list is constant between deployments — and
   the cache is module state that store.clear() cannot reach, so reusing an id
   across tests would assert against the previous test's group. */
let nextId = 0;
const freshGroup = prefix => 'zz-' + prefix + '-' + (++nextId);

function seedGroup(groupId, memberCount) {
  store.set('groupDetails/' + groupId, {
    partCode: 'MPF-XX-' + groupId,
    drawingName: 'Master ' + groupId,
    memberCount,
    memberIds: Array.from({ length: memberCount }, (_, i) => groupId + '-m' + i),
    memberNames: Array.from({ length: memberCount }, (_, i) => 'Device ' + groupId + ' ' + i)
  });
}

test('a device lookup reads the collection the importer actually writes', async () => {
  const sg = freshGroup('sg'), bt = freshGroup('bt');
  seedDevice('zz-device-a', { 'screen-guards': [sg], battery: [bt] });
  seedGroup(sg, 12);
  seedGroup(bt, 4);

  const paid = await entitlements.deviceGroupsForUser('zz-device-a', 'paid');
  assert.ok(paid, 'modelGroups/{id}.byCategory must resolve');
  assert.deepEqual(paid.categories.map(c => c.categoryId).sort(),
                   ['battery', 'screen-guards']);
});

test('a free account gets the groups but none of their devices', async () => {
  const sg = freshGroup('sg');
  seedDevice('zz-device-b', { 'screen-guards': [sg] });
  seedGroup(sg, 60);

  const free = await entitlements.deviceGroupsForUser('zz-device-b', 'free');
  const group = free.categories[0].groups[0];

  /* The group is named — that is the advertisement, and it is what makes the
     three free searches worth running. */
  assert.equal(group.groupId, sg);
  assert.equal(group.memberCount, 60);
  assert.equal(group.partCode, 'MPF-XX-' + sg);

  /* The 60 devices are not. */
  assert.equal(group.members.length, 0);
  assert.equal(group.requiresPlan, true);
  assert.equal(group.lockedCount, 60);
});

test('NOT ONE DEVICE NAME IS IN A FREE DEVICE-LOOKUP RESPONSE', async () => {
  /* The property the whole split exists for, asserted on the payload rather
     than on a flag inside it. Hiding rows in the browser would satisfy every
     other test here and fail this one. */
  const sg = freshGroup('sg'), bt = freshGroup('bt');
  seedDevice('zz-device-c', { 'screen-guards': [sg], battery: [bt] });
  seedGroup(sg, 60);
  seedGroup(bt, 30);

  const free = await entitlements.deviceGroupsForUser('zz-device-c', 'free');
  const serialised = JSON.stringify(free);

  for (let i = 0; i < 60; i++) {
    assert.equal(serialised.includes('Device ' + sg + ' ' + i), false,
                 `member ${i} of ${sg} leaked into the free payload`);
    assert.equal(serialised.includes(sg + '-m' + i), false,
                 `member id ${i} of ${sg} leaked into the free payload`);
  }
});

test('a subscriber gets every device of every group that fits the phone', async () => {
  const sg = freshGroup('sg');
  seedDevice('zz-device-d', { 'screen-guards': [sg] });
  seedGroup(sg, 60);

  const paid = await entitlements.deviceGroupsForUser('zz-device-d', 'paid');
  const group = paid.categories[0].groups[0];
  assert.equal(group.members.length, 60);
  assert.equal(group.requiresPlan, false);
  assert.equal(group.lockedCount, 0);
});

test('a device nobody has imported is null, not an empty parts list', async () => {
  /* Different sentences on screen: "we do not have this phone" and "this
     phone has no parts" must not be the same answer. */
  assert.equal(await entitlements.deviceGroupsForUser('no-such-phone', 'paid'), null);
});

/* ======================================== 1b. THE ASSISTANT, AT THE SAME TIER

   /api/chat was the easiest way round the paywall on the site: no sign-in,
   one POST, and `facts` came back holding the fitment list. It answers at the
   caller's tier now, and these assert it on the real catalogue rather than on
   a stub, because the local api/_data/parts.json is exactly what the service
   reads. */

const chatbot = require(path.join(__dirname, '..', '_services', 'chatbot-service'));
const searchSvc = require(path.join(__dirname, '..', '_services', 'search-service'));

/* The service needs the local parts file to have anything to withhold. In a
   deployed function it is absent and the answers are empty either way, which
   is why the gate has to be tested here rather than in production. */
const HAS_LOCAL_PARTS = Object.keys(searchSvc.loadIndex().groups).length > 0;

test('the assistant gives a free caller no member names for a model', { skip: !HAS_LOCAL_PARTS }, async () => {
  const free = await chatbot.respond({ message: 'Realme 5', now: Date.now(), tier: 'free' });
  const groups = (free.facts.categories || []).flatMap(c => c.groups || []);
  assert.ok(groups.length > 0, 'Realme 5 should have groups to withhold');
  groups.forEach(g => {
    assert.equal(g.members.length, 0, `${g.groupId} leaked members to a free caller`);
    assert.equal(g.requiresPlan, true);
    assert.ok(g.memberCount > 0, 'the size is still reported');
  });
  assert.equal(JSON.stringify(free).includes('Realme 5i'), false,
    'a co-member name reached a free caller');
});

test('the assistant gives a subscriber the whole list', { skip: !HAS_LOCAL_PARTS }, async () => {
  const paid = await chatbot.respond({ message: 'Realme 5', now: Date.now(), tier: 'paid' });
  const groups = (paid.facts.categories || []).flatMap(c => c.groups || []);
  assert.ok(groups.some(g => g.members.length > 0), 'a subscriber should get members');
});

test('a part code asked of the assistant is gated too', { skip: !HAS_LOCAL_PARTS }, async () => {
  /* The most precise question there is, and it used to return every member
     of the group uncapped — groupDetail applies no cap at all. */
  const free = await chatbot.respond({ message: 'MPF-SG-0167', now: Date.now(), tier: 'free' });
  assert.equal(free.facts.group.members.length, 0);
  assert.equal(free.facts.group.requiresPlan, true);
  assert.ok(free.facts.group.memberCount > 100, 'the size is still reported');

  const paid = await chatbot.respond({ message: 'MPF-SG-0167', now: Date.now(), tier: 'paid' });
  assert.equal(paid.facts.group.members.length, paid.facts.group.memberCount);
});

test('no tier passed means the FREE answer, never the paid one', { skip: !HAS_LOCAL_PARTS }, async () => {
  /* Fails closed. A future call site that forgets the argument must not
     become the next hole. */
  const r = await chatbot.respond({ message: 'MPF-SG-0167', now: Date.now() });
  assert.equal(r.facts.group.members.length, 0);
  assert.equal(r.facts.group.requiresPlan, true);
});

/* =========================================================== 2. THE BUNDLE */

const bundle = require('../../assets/dataset.json');

test('the public bundle carries no device -> group id map', () => {
  assert.equal('modelGroups' in bundle, false,
    'modelGroups is the fitment list transposed; it must not ship');
  assert.ok(bundle.modelCats, 'the per-category COUNTS should ship in its place');
});

test('every value in modelCats is a count, never a list', () => {
  Object.keys(bundle.modelCats).forEach(modelId => {
    const byCat = bundle.modelCats[modelId];
    Object.keys(byCat).forEach(cat => {
      const v = byCat[cat];
      assert.equal(typeof v, 'number',
        `${modelId}/${cat} must be a count, got ${JSON.stringify(v)}`);
      assert.ok(v > 0);
    });
  });
});

test('no group row in the bundle carries a member list', () => {
  /* `cnt` — the size — is deliberately public. `mem` is not, and neither is
     anything else array-shaped that could hold device ids. */
  assert.equal(bundle.groupCols.includes('mem'), false);
  bundle.groups.forEach(row => {
    row.forEach((cell, i) => {
      assert.equal(Array.isArray(cell), false,
        `group column ${bundle.groupCols[i]} must not be a list`);
    });
  });
});

test('THE FITMENT LIST CANNOT BE RECONSTRUCTED FROM THE PUBLIC BUNDLE', () => {
  /* The exact attack that worked against the deployed file: walk every
     public structure, collect anything that looks like a group id sitting in
     a list, and invert it. It recovered all 3,384 groups, including the 325
     members of sg-0167. It must now recover nothing. */
  const groupIds = new Set(bundle.groups.map(r => r[bundle.groupCols.indexOf('id')]));
  const recovered = Object.create(null);

  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { Object.keys(node).forEach(k => walk(node[k])); return; }
    if (typeof node === 'string' && groupIds.has(node)) {
      recovered[node] = (recovered[node] || 0) + 1;
    }
  }(bundle.modelCats));

  assert.deepEqual(Object.keys(recovered), [],
    'a group id appearing under a device in the public bundle is the paywall walked around');
});

/* ================================================ 3. AN OUTAGE IS AN OUTAGE */

test('Firestore refusing the project is a 503, not an opaque 500', () => {
  /* The live failure: billing disabled on the Google Cloud project, so every
     Firestore call — browser and Admin SDK alike — came back
     `7 PERMISSION_DENIED: This API method requires billing to be enabled`.
     Reported as a bare 500, the browser said "check the connection", which is
     false in every word and had shops re-typing their details into a form
     that could not save them. */
  const billingOff = Object.assign(new Error('7 PERMISSION_DENIED: billing'), { code: 7 });
  assert.equal(datastoreDown(billingOff), true);

  [4, 5, 8, 9, 13, 14, 16].forEach(code => {
    assert.equal(datastoreDown(Object.assign(new Error('x'), { code })), true,
      `grpc ${code} means the datastore is not answering`);
  });
});

test('an ordinary bug is still an opaque 500', () => {
  /* Only a NUMERIC gRPC status counts. A TypeError with no code, or a Firebase
     Auth error whose code is a string, must keep falling through to the 500 it
     deserves rather than being excused as an outage. */
  assert.equal(datastoreDown(new TypeError('x is not a function')), false);
  assert.equal(datastoreDown(Object.assign(new Error('x'), { code: 'auth/invalid-token' })), false);
  assert.equal(datastoreDown(Object.assign(new Error('x'), { code: 3 })), false);
  assert.equal(datastoreDown(null), false);
  assert.equal(datastoreDown(undefined), false);
});

/* ============================================================================
   api/_lib/compat-management.test.js
   ----------------------------------------------------------------------------
   Compatibility Management — Mobile Parts Finder's own.

     · what an administrator may do to a group by hand: add and remove a
       model, change the master, merge two groups, create one, delete one
     · the rule every one of them holds: one category + one model = one group
     · nothing here creates or deletes a MODEL — only the relationship
     · categories: created, renamed, deleted — and only an empty run-time one
       can go
     · every change is in the ledger, and the catalogue build replays it
     · the public lookup follows a merged group, and serves the site's
       categories only
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeFirestore } = require('./testing/fake-firestore');
let currentFake = null;
require('./firebase').db = () => currentFake.db;

const fsx = require('../_services/instagram/firestore');
const management = require('../_services/compat/management');
const categoryService = require('../_services/compat/category-service');
const taxonomy = require('../_services/taxonomy-service');
const C = require('../_schema/collections');
const { applyApprovedOverlay, findDuplicateAssignments } = require('../../scripts/build-dataset');

const ADMIN = { uid: 'ownerUid000001', email: 'stark.ai.india@gmail.com', role: 'super_admin' };
let clockT = Date.UTC(2026, 9, 2, 6, 0);
const clock = () => (clockT += 5);

const id = name => {
  const m = taxonomy.matchModel(name);
  assert.equal(m.status, 'matched', `fixture model "${name}" must be in the catalogue`);
  return m.modelId;
};
const nameOf = modelId => taxonomy.modelById(modelId).modelName;
const ids = names => names.map(id).sort();

function seedGroup(fake, groupId, categoryId, masterName, memberNames) {
  const list = memberNames.map(id);
  const master = id(masterName);
  fake.seed('groups/' + groupId, { groupNo: groupId.toUpperCase(), serialNo: 'MPF-SN-000001', categoryId, partCode: 'MPF-' + groupId.toUpperCase(),
    masterModelId: master, masterModelName: nameOf(master), memberCount: list.length });
  fake.seed('groupDetails/' + groupId, { groupNo: groupId.toUpperCase(), categoryId, partCode: 'MPF-' + groupId.toUpperCase(), drawingName: nameOf(master),
    memberIds: list, memberNames: list.map(nameOf), memberCount: list.length });
  list.forEach(m => {
    const cur = fake.read('modelGroups/' + m) || { id: m, byCategory: {} };
    cur.byCategory[categoryId] = (cur.byCategory[categoryId] || []).concat(groupId);
    fake.seed('modelGroups/' + m, cur);
  });
}

function world() {
  const fake = createFakeFirestore();
  fsx.use(fake.provider);
  currentFake = fake;
  taxonomy.registerCategories([]);
  fake.seed('catalog/meta', { version: 1 });
  seedGroup(fake, 'bf-0010', 'button-flex', 'Realme 5', ['Realme 5', 'Realme 5s', 'Realme 5i', 'Realme C3']);
  seedGroup(fake, 'bf-0020', 'button-flex', 'Realme C11', ['Realme C11', 'Realme C12', 'Realme C15']);
  seedGroup(fake, 'cd-0679', 'combo-display', 'Realme 5', ['Realme 5', 'Realme 5s']);
  return fake;
}

const members = (fake, groupId) => fake.read(C.GROUP_DETAILS + '/' + groupId).memberIds.slice().sort();
const groupsOf = (fake, name, cat) => (fake.read(C.MODEL_GROUPS + '/' + id(name)) || { byCategory: {} }).byCategory[cat] || [];
function assertOneGroupPerCategory(fake) {
  fake.paths('modelGroups/').forEach(path => {
    const doc = fake.read(path);
    Object.keys(doc.byCategory || {}).forEach(cat => assert.ok(doc.byCategory[cat].length <= 1, `${doc.id} is in ${doc.byCategory[cat].join(' and ')} for ${cat}`));
  });
}
/* every member list, the index and the count agree with each other */
function assertConsistent(fake) {
  fake.paths('groupDetails/').forEach(path => {
    const gid = path.split('/')[1];
    const gd = fake.read(path), g = fake.read('groups/' + gid);
    if (gd.mergedInto) return;
    assert.equal(gd.memberIds.length, gd.memberCount, gid + ' count');
    assert.equal(g.memberCount, gd.memberCount, gid + ' groups/groupDetails count');
    assert.equal(gd.memberNames.length, gd.memberIds.length, gid + ' names');
    assert.ok(gd.memberIds.indexOf(g.masterModelId) > -1, gid + ' holds its own master');
    gd.memberIds.forEach(m => assert.deepEqual((fake.read('modelGroups/' + m).byCategory[gd.categoryId] || []), [gid], `${m} points at ${gid}`));
  });
  assertOneGroupPerCategory(fake);
}
const ledger = fake => fake.all(C.APPROVED_COMPATIBILITIES).slice().sort((a, b) => a.approvedAt - b.approvedAt);

/* The public lookup as PRODUCTION runs it: the paid fitment file is git-ignored
   and never deployed, so the lookup reads Firestore. A developer machine may
   have the file; these tests must not depend on whether it does. */
async function asInProduction(fn) {
  const search = require('../_services/search-service');
  const real = { groupDetail: search.groupDetail, compatibilityFor: search.compatibilityFor };
  search.groupDetail = () => null;
  search.compatibilityFor = () => null;
  try { return await fn(require('../_services/entitlement-service')); }
  finally { Object.assign(search, real); }
}

/* ============================================================ add / remove */

test('add a model: only a catalogue model, only if it has no group in that category', async () => {
  const fake = world();
  const out = await management.addModel({ groupId: 'bf-0010', modelId: id('Realme C25'), admin: ADMIN, now: clock() });
  assert.equal(out.newMemberCount, 5);
  assert.deepEqual(members(fake, 'bf-0010'), ids(['Realme 5', 'Realme 5s', 'Realme 5i', 'Realme C3', 'Realme C25']));
  assert.deepEqual(groupsOf(fake, 'Realme C25', 'button-flex'), ['bf-0010']);
  assert.equal(fake.read('groups/bf-0010').lastChange.source, 'admin');

  await assert.rejects(() => management.addModel({ groupId: 'bf-0010', modelId: 'not-a-model-id', admin: ADMIN, now: clock() }), e => e.code === 'unknown-model');
  await assert.rejects(() => management.addModel({ groupId: 'bf-0010', modelId: id('Realme C25'), admin: ADMIN, now: clock() }), e => e.code === 'already-member');
  /* Realme C11 is in bf-0020: a second button-flex group for it is refused, and nothing is written */
  const before = JSON.stringify(fake.read('groupDetails/bf-0010'));
  await assert.rejects(() => management.addModel({ groupId: 'bf-0010', modelId: id('Realme C11'), admin: ADMIN, now: clock() }),
    e => e.code === 'category-conflict' && /BLOCKED — MODEL ALREADY ASSIGNED/.test(e.message) && e.blocked[0].existingGroupId === 'bf-0020');
  assert.equal(JSON.stringify(fake.read('groupDetails/bf-0010')), before);
  /* the same model in ANOTHER category is a different question */
  await management.addModel({ groupId: 'cd-0679', modelId: id('Realme C11'), admin: ADMIN, now: clock() });
  assert.deepEqual(fake.read('modelGroups/' + id('Realme C11')).byCategory, { 'button-flex': ['bf-0020'], 'combo-display': ['cd-0679'] });
  await assert.rejects(() => management.addModel({ groupId: 'bf-9999', modelId: id('Realme C25'), admin: ADMIN, now: clock() }), e => e.code === 'no-such-group');
  assertConsistent(fake);
});

test('remove a model: the relationship goes, the model stays in the catalogue and can be grouped again', async () => {
  const fake = world();
  const out = await management.removeModel({ groupId: 'bf-0010', modelId: id('Realme C3'), admin: ADMIN, now: clock() });
  assert.equal(out.newMemberCount, 3);
  assert.deepEqual(members(fake, 'bf-0010'), ids(['Realme 5', 'Realme 5s', 'Realme 5i']));
  assert.deepEqual(groupsOf(fake, 'Realme C3', 'button-flex'), []);
  assert.ok(taxonomy.modelById(id('Realme C3')), 'still a model');
  /* free again: it can join the other group */
  await management.addModel({ groupId: 'bf-0020', modelId: id('Realme C3'), admin: ADMIN, now: clock() });
  assert.deepEqual(groupsOf(fake, 'Realme C3', 'button-flex'), ['bf-0020']);

  await assert.rejects(() => management.removeModel({ groupId: 'bf-0010', modelId: id('Realme 5'), admin: ADMIN, now: clock() }), e => e.code === 'is-master');
  await assert.rejects(() => management.removeModel({ groupId: 'bf-0010', modelId: id('Realme C15'), admin: ADMIN, now: clock() }), e => e.code === 'not-a-member');
  assertConsistent(fake);
});

test('change the master: one of the group\'s own models, and it leads the list', async () => {
  const fake = world();
  const out = await management.setMaster({ groupId: 'bf-0010', modelId: id('Realme 5s'), admin: ADMIN, now: clock() });
  assert.equal(out.previousMasterId, id('Realme 5'));
  assert.equal(fake.read('groups/bf-0010').masterModelId, id('Realme 5s'));
  assert.equal(fake.read('groupDetails/bf-0010').memberIds[0], id('Realme 5s'));
  assert.equal(fake.read('groupDetails/bf-0010').drawingName, nameOf(id('Realme 5s')));
  assert.deepEqual(members(fake, 'bf-0010'), ids(['Realme 5', 'Realme 5s', 'Realme 5i', 'Realme C3']), 'nobody left, nobody joined');
  await assert.rejects(() => management.setMaster({ groupId: 'bf-0010', modelId: id('Realme C11'), admin: ADMIN, now: clock() }), e => e.code === 'not-a-member');
  await assert.rejects(() => management.setMaster({ groupId: 'bf-0010', modelId: id('Realme 5s'), admin: ADMIN, now: clock() }), e => e.code === 'already-master');
  /* the old master can now be removed */
  await management.removeModel({ groupId: 'bf-0010', modelId: id('Realme 5'), admin: ADMIN, now: clock() });
  assertConsistent(fake);
});

/* =============================================================== merge etc. */

test('merge two groups: one group, the survivor\'s master, and the old group id still finds the part', async () => {
  const fake = world();
  const out = await management.mergeGroups({ intoGroupId: 'bf-0010', fromGroupId: 'bf-0020', admin: ADMIN, now: clock() });
  assert.equal(out.newMemberCount, 7);
  assert.deepEqual(members(fake, 'bf-0010'), ids(['Realme 5', 'Realme 5s', 'Realme 5i', 'Realme C3', 'Realme C11', 'Realme C12', 'Realme C15']));
  assert.equal(fake.read('groups/bf-0010').masterModelId, id('Realme 5'));
  ['Realme C11', 'Realme C12', 'Realme C15'].forEach(n => assert.deepEqual(groupsOf(fake, n, 'button-flex'), ['bf-0010']));
  assert.equal(fake.read('groups/bf-0020').mergedInto, 'bf-0010');
  assert.equal(fake.read('groupDetails/bf-0020').mergedInto, 'bf-0010');
  assertConsistent(fake);

  /* a merged-away group is not a group to edit, and not one to merge again */
  await assert.rejects(() => management.addModel({ groupId: 'bf-0020', modelId: id('Realme C25'), admin: ADMIN, now: clock() }), e => e.code === 'merged');
  await assert.rejects(() => management.mergeGroups({ intoGroupId: 'bf-0010', fromGroupId: 'bf-0020', admin: ADMIN, now: clock() }), e => e.code === 'merged');
  await assert.rejects(() => management.mergeGroups({ intoGroupId: 'bf-0010', fromGroupId: 'bf-0010', admin: ADMIN, now: clock() }), e => e.code === 'same-group');
  await assert.rejects(() => management.mergeGroups({ intoGroupId: 'bf-0010', fromGroupId: 'cd-0679', admin: ADMIN, now: clock() }), e => e.code === 'category-mismatch');

  /* the public lookup: an old link to the merged group is answered with the group it became */
  const [viaOld, direct] = await asInProduction(e => Promise.all([e.groupForUser('bf-0020', 'paid'), e.groupForUser('bf-0010', 'paid')]));
  assert.ok(viaOld && direct);
  assert.equal(viaOld.partCode, 'MPF-BF-0010');
  assert.equal(viaOld.memberCount, 7);
});

test('create a group and delete a group: numbered from the issued range; deleting frees the models and deletes none', async () => {
  const fake = world();
  const out = await management.createGroup({ categoryId: 'button-flex', masterModelId: id('Oppo A16'),
    memberIds: [id('Oppo A16s'), id('Oppo A54')], admin: ADMIN, now: clock() });
  assert.equal(out.groupNo, 'BF-9001');
  assert.equal(fake.read('groupDetails/bf-9001').memberIds[0], id('Oppo A16'));
  assert.equal(fake.read('catalog/issued')['button-flex'], 9001);
  const second = await management.createGroup({ categoryId: 'button-flex', masterModelId: id('Vivo Y18'), memberIds: [id('Vivo Y28s')], admin: ADMIN, now: clock() });
  assert.equal(second.groupNo, 'BF-9002', 'the next number, never a reused one');

  await assert.rejects(() => management.createGroup({ categoryId: 'button-flex', masterModelId: id('Oppo A53s'), memberIds: [id('Realme C11')], admin: ADMIN, now: clock() }),
    e => e.code === 'category-conflict', 'a model that has a group cannot be put in a new one');
  assert.ok(!fake.read('groups/bf-9003'), 'and nothing was created');
  await assert.rejects(() => management.createGroup({ categoryId: 'no-such-category', masterModelId: id('Oppo A53s'), memberIds: [], admin: ADMIN, now: clock() }), e => e.code === 'unknown-category');

  const gone = await management.deleteGroup({ groupId: 'bf-9001', admin: ADMIN, now: clock() });
  assert.equal(gone.memberCount, 3);
  assert.ok(!fake.read('groups/bf-9001') && !fake.read('groupDetails/bf-9001'));
  ['Oppo A16', 'Oppo A16s', 'Oppo A54'].forEach(n => {
    assert.deepEqual(groupsOf(fake, n, 'button-flex'), []);
    assert.ok(taxonomy.modelById(id(n)), n + ' is still in All Brands & Models');
  });
  /* a deleted number is not issued again */
  const third = await management.createGroup({ categoryId: 'button-flex', masterModelId: id('Oppo A16'), memberIds: [id('Oppo A16s')], admin: ADMIN, now: clock() });
  assert.equal(third.groupNo, 'BF-9003');
  assertConsistent(fake);
});

/* ================================================================ categories */

test('categories: created, renamed and deleted in the compatibility data — the site\'s own are code', async () => {
  const fake = world();
  const cat = await categoryService.create({ name: 'Camera Glass', admin: ADMIN, now: clock() });
  assert.deepEqual([cat.id, cat.code, cat.origin], ['camera-glass', 'CG', 'admin']);
  assert.equal(taxonomy.isKnownCategory('camera-glass'), true);
  assert.equal(taxonomy.resolveCategory('camera glass compatible models').categoryId, 'camera-glass', 'and the matcher knows it by name');

  /* a prefix nobody else has: Back Glass cannot be BG if... Battery is BT, Back Cover BC, so BG is free; Button Guard is not */
  const back = await categoryService.create({ name: 'Back Glass', admin: ADMIN, now: clock() });
  assert.equal(back.code, 'BG');
  const guard = await categoryService.create({ name: 'Button Guard', admin: ADMIN, now: clock() });
  assert.notEqual(guard.code, 'BG');
  assert.ok(/^[A-Z][A-Z0-9]{1,2}$/.test(guard.code));
  const codes = (await categoryService.list()).map(c => c.code).filter(Boolean);
  assert.equal(new Set(codes).size, codes.length, 'every prefix is unique');

  await assert.rejects(() => categoryService.create({ name: 'camera glass', admin: ADMIN, now: clock() }), e => e.code === 'exists');
  await assert.rejects(() => categoryService.create({ name: 'Battery', admin: ADMIN, now: clock() }), e => e.code === 'exists', 'a site category');
  await assert.rejects(() => categoryService.create({ name: 'Display Combo', admin: ADMIN, now: clock() }), e => e.code === 'exists', 'another name for one that exists');
  await assert.rejects(() => categoryService.create({ name: ' ', admin: ADMIN, now: clock() }), e => e.code === 'bad-name');

  /* a group in it, numbered with its prefix */
  const g = await management.createGroup({ categoryId: 'camera-glass', masterModelId: id('Realme 5'), memberIds: [id('Realme 5s')], admin: ADMIN, now: clock() });
  assert.equal(g.groupNo, 'CG-9001');
  assert.deepEqual(fake.read('modelGroups/' + id('Realme 5')).byCategory['camera-glass'], ['cg-9001']);

  const renamed = await categoryService.rename({ categoryId: 'camera-glass', name: 'Camera Lens Glass', admin: ADMIN, now: clock() });
  assert.equal(renamed.previousName, 'Camera Glass');
  await assert.rejects(() => categoryService.rename({ categoryId: 'battery', name: 'Batteries', admin: ADMIN, now: clock() }), e => e.code === 'site-category');
  await assert.rejects(() => categoryService.remove({ categoryId: 'battery', admin: ADMIN, now: clock() }), e => e.code === 'site-category');
  await assert.rejects(() => categoryService.remove({ categoryId: 'camera-glass', admin: ADMIN, now: clock() }), e => e.code === 'not-empty', 'its groups are never deleted with it');
  await management.deleteGroup({ groupId: 'cg-9001', admin: ADMIN, now: clock() });
  await categoryService.remove({ categoryId: 'camera-glass', admin: ADMIN, now: clock() });
  assert.equal(taxonomy.isKnownCategory('camera-glass'), false);
  /* its prefix is not handed to a different category later */
  const again = await categoryService.create({ name: 'Charging Gasket', admin: ADMIN, now: clock() });
  assert.notEqual(again.code, 'CG');

  /* the public lookup serves the site's categories only */
  await management.createGroup({ categoryId: 'back-glass', masterModelId: id('Realme 5'), memberIds: [id('Realme 5s')], admin: ADMIN, now: clock() });
  const pub = await asInProduction(e => e.deviceGroupsForUser(id('Realme 5'), 'paid'));
  assert.deepEqual(pub.categories.map(c => c.categoryId).sort(), ['button-flex', 'combo-display'], 'a run-time category is not shown to a shop');
});

/* ================================================================= the build */

test('the catalogue build replays every change over the baseline, in order — and a run-time category stays out of the public files', async () => {
  const fake = world();
  /* the baseline: the groups as the exports had them */
  const baseline = () => fake0.paths('groupDetails/').map(p => {
    const gd = fake0.read(p), g = fake0.read(p.replace('groupDetails/', 'groups/'));
    return { id: p.split('/')[1], categoryId: gd.categoryId, partCode: gd.partCode, masterModelId: g.masterModelId, masterModelName: g.masterModelName,
             memberIds: gd.memberIds.slice(), memberNames: gd.memberNames.slice(), memberCount: gd.memberCount };
  });
  const fake0 = fake;
  const groups = baseline();
  const modelGroups = new Map();
  groups.forEach(g => g.memberIds.forEach(m => { const row = modelGroups.get(m) || {}; (row[g.categoryId] = row[g.categoryId] || []).push(g.id); modelGroups.set(m, row); }));

  /* a day of Compatibility Management */
  await management.addModel({ groupId: 'bf-0010', modelId: id('Realme C25'), admin: ADMIN, now: clock() });
  await management.removeModel({ groupId: 'bf-0010', modelId: id('Realme C3'), admin: ADMIN, now: clock() });
  await management.setMaster({ groupId: 'bf-0010', modelId: id('Realme 5s'), admin: ADMIN, now: clock() });
  await management.mergeGroups({ intoGroupId: 'bf-0010', fromGroupId: 'bf-0020', admin: ADMIN, now: clock() });
  await management.addModel({ groupId: 'bf-0010', modelId: id('Realme C25s'), admin: ADMIN, now: clock() });
  await management.createGroup({ categoryId: 'button-flex', masterModelId: id('Oppo A16'), memberIds: [id('Oppo A16s')], admin: ADMIN, now: clock() });
  await management.deleteGroup({ groupId: 'cd-0679', admin: ADMIN, now: clock() });
  await categoryService.create({ name: 'Camera Glass', admin: ADMIN, now: clock() });
  await management.createGroup({ categoryId: 'camera-glass', masterModelId: id('Realme 5'), memberIds: [id('Realme 5s')], admin: ADMIN, now: clock() });
  assertConsistent(fake);

  const models = new Map();
  taxonomy.taxonomy().entries.forEach(e => models.set(e.id, { name: nameOf(e.id), brandId: taxonomy.modelById(e.id).brandId, tokens: [] }));
  const site = Array.from(taxonomy.taxonomy().categories.values()).filter(c => !c.dynamic);
  const overlay = applyApprovedOverlay({ entries: ledger(fake) }, groups, models, modelGroups, site);
  assert.deepEqual(overlay.unapplied, [], 'nothing refused');
  assert.deepEqual([overlay.applied, overlay.removed, overlay.mastersChanged, overlay.merged, overlay.createdGroups, overlay.deletedGroups], [2, 1, 1, 1, 2, 1]);

  /* the build's groups are exactly the live groups */
  const built = new Map(groups.map(g => [g.id, g]));
  ['bf-0010', 'bf-9001'].forEach(gid => {
    assert.deepEqual(built.get(gid).memberIds.slice().sort(), members(fake, gid), gid);
    assert.equal(built.get(gid).masterModelId, fake.read('groups/' + gid).masterModelId, gid + ' master');
    assert.equal(built.get(gid).memberIds[0], built.get(gid).masterModelId, gid + ': the master leads');
  });
  assert.equal(built.has('bf-0020'), false, 'merged away');
  assert.equal(built.has('cd-0679'), false, 'deleted');
  assert.deepEqual(findDuplicateAssignments(modelGroups), []);

  /* the run-time category's group is in its own file, not in the public ones */
  assert.equal(groups.some(g => g.categoryId === 'camera-glass'), false);
  assert.deepEqual(overlay.runtimeGroups.map(g => [g.id, g.categoryName, g.partCode]), [['cg-9001', 'Camera Glass', 'MPF-CG-9001']]);
  assert.equal([...modelGroups.values()].some(row => row['camera-glass']), false);
  assert.deepEqual(overlay.runtimeModelGroups.get(id('Realme 5')), { 'camera-glass': ['cg-9001'] });

  /* replaying the same ledger over the result changes nothing in the site's
     groups (the run-time group is rebuilt each time: it lives outside them) */
  const snapshot = JSON.stringify(groups);
  const again = applyApprovedOverlay({ entries: ledger(fake) }, groups, models, modelGroups, site);
  assert.equal(again.applied + again.removed + again.mastersChanged + again.merged + again.deletedGroups, 0);
  assert.equal(again.createdGroups, 1);
  assert.equal(again.runtimeGroups[0].id, 'cg-9001');
  assert.equal(JSON.stringify(groups), snapshot);
  assert.deepEqual(again.unapplied, []);
});

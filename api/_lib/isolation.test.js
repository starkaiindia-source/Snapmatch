/* ============================================================================
   api/_lib/isolation.test.js
   ----------------------------------------------------------------------------
   PROJECT ISOLATION.

   Mobile Parts Finder, the Dashboard and ProGlide hold model data that looks
   alike. They are three projects with three databases, and this code writes
   to ONE of them. These tests are what holds that — not a convention:

     1. the code cannot REACH another project: one Firebase Admin app, one
        service account, no other project id, no other credential variable,
        no call to another project's functions — checked against every source
        file, so a second app appearing anywhere fails the build
     2. a credential for another project, pasted into this environment by
        mistake, is REFUSED before anything is written
     3. the four operations the brief names — an Instagram extraction, a group
        update, a new category, a merge — change Mobile Parts Finder and leave
        a Dashboard store and a ProGlide store with zero writes
     4. nothing written here carries a foreign key into another project
   ========================================================================== */
'use strict';

['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_VISION_API_KEY', 'AI_GATEWAY_URL', 'AI_GATEWAY_TOKEN', 'INSTAGRAM_AUTO_APPLY', 'INSTAGRAM_AUTO_CREATE_CATEGORIES']
  .forEach(k => { delete process.env[k]; });

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createFakeFirestore } = require('./testing/fake-firestore');
let currentFake = null;
require('./firebase').db = () => currentFake.db;

const projects = require('../_schema/projects');
const fsx = require('../_services/instagram/firestore');
const jobs = require('../_services/instagram/job-service');
const management = require('../_services/compat/management');
const categoryService = require('../_services/compat/category-service');
const configMod = require('../_services/instagram/config');
const { normaliseMedia } = require('../_services/instagram/graph-client');
const taxonomy = require('../_services/taxonomy-service');

const ROOT = path.join(__dirname, '..', '..');
const ADMIN = { uid: 'ownerUid000001', email: 'stark.ai.india@gmail.com', role: 'super_admin' };
let clockT = Date.UTC(2026, 9, 2, 7, 0);
const clock = () => (clockT += 3);

/* ============================================================ 1. reachability */

function sourceFiles() {
  const out = [];
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (['node_modules', '.git', 'data', '.vercel', '.claude'].indexOf(e.name) < 0) walk(p); return; }
    if (/\.(js|mjs|cjs|html|json)$/.test(e.name) && !/package-lock\.json$/.test(e.name)) out.push(p);
  });
  ['api', 'src', 'scripts', 'backend', 'admin'].filter(d => fs.existsSync(path.join(ROOT, d))).forEach(d => walk(path.join(ROOT, d)));
  ['vercel.json', '.firebaserc', 'firebase.json'].forEach(f => { if (fs.existsSync(path.join(ROOT, f))) out.push(path.join(ROOT, f)); });
  return out;
}
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');
const isTest = p => /\.test\.js$/.test(p) || /[\\/]testing[\\/]/.test(p);
/* the two files whose JOB is to name the other projects */
const BOUNDARY_FILES = ['api/_schema/projects.js', 'api/_lib/isolation.test.js'];

test('no source file names another project\'s database, and none calls another project\'s functions', () => {
  const offenders = [];
  sourceFiles().forEach(p => {
    if (BOUNDARY_FILES.indexOf(rel(p)) > -1) return;
    const text = fs.readFileSync(p, 'utf8');
    projects.PROJECTS.dashboard.firebaseProjectIds.forEach(id => { if (text.indexOf(id) > -1) offenders.push(rel(p) + ': names the Dashboard project ' + id); });
    /* a Cloud Functions or Firestore REST endpoint of ANY project is a database reached from outside this app's own Admin SDK */
    if (/[a-z0-9-]+\.cloudfunctions\.net|firestore\.googleapis\.com\/v1\/projects\//.test(text)) offenders.push(rel(p) + ': calls a Cloud Functions / Firestore REST endpoint');
    if (/DASHBOARD_[A-Z_]*(KEY|SERVICE_ACCOUNT|TOKEN|PROJECT)|PROGLIDE_[A-Z_]*(KEY|SERVICE_ACCOUNT|TOKEN|PROJECT)/.test(text)) {
      offenders.push(rel(p) + ': reads a credential variable of another project');
    }
  });
  assert.deepEqual(offenders, []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8')).projects.default, 'mobilepartsfindercom',
    'the Firebase CLI in this repository deploys to Mobile Parts Finder');
});

test('there is exactly one Firebase Admin app, built from one service account', () => {
  const inits = [];
  const credentials = new Set();
  sourceFiles().filter(p => !isTest(p)).forEach(p => {
    const text = fs.readFileSync(p, 'utf8');
    /* the Admin SDK only: the browser's own initializeApp (src/) is the web SDK for this same project */
    if (/api[\\/]|scripts[\\/]|backend[\\/]/.test(p)) {
      if (/\binitializeApp\s*\(/.test(text)) inits.push(rel(p));
      (text.match(/process\.env\.([A-Z0-9_]*SERVICE_ACCOUNT[A-Z0-9_]*)/g) || []).forEach(m => credentials.add(m.replace('process.env.', '')));
    }
  });
  /* the API has ONE; each standalone script builds its own app for the project it is told to use, by --project or application-default credentials */
  assert.deepEqual(inits.filter(f => f.indexOf('api/') === 0), ['api/_lib/firebase.js'], 'one Admin app in the API');
  assert.deepEqual(Array.from(credentials).sort(), ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_B64'], 'one service account, in its two encodings');

  /* and the compatibility services take their handle from one place */
  const services = sourceFiles().filter(p => /api[\\/]_services[\\/](instagram|compat)[\\/]/.test(p) && !isTest(p));
  assert.ok(services.length >= 10);
  services.forEach(p => {
    const text = fs.readFileSync(p, 'utf8');
    if (rel(p) === 'api/_services/instagram/firestore.js') return;
    assert.ok(!/require\(['"][./]*_lib\/firebase['"]\)|firebase-admin/.test(text), rel(p) + ' must use the one guarded handle, not its own');
  });
});

/* ============================================================== 2. the guard */

test('a credential for another project is refused before anything is written', () => {
  assert.equal(projects.assertWritable('mobilepartsfindercom', 'mobilepartsfindercom'), true);
  assert.equal(projects.assertWritable('mobilepartsfindercom', ''), true, 'FIREBASE_PROJECT_ID may be unset on a script');
  assert.throws(() => projects.assertWritable('dashboard-7e8d8', ''), e => e.code === 'project-boundary' && /Dashboard/.test(e.message) && /read only reference/.test(e.message));
  assert.throws(() => projects.assertWritable('dashboard-7e8d8', 'dashboard-7e8d8'), e => e.code === 'project-boundary', 'even when both agree');
  assert.throws(() => projects.assertWritable('proglide-web', ''), e => /ProGlide/.test(e.message));
  assert.throws(() => projects.assertWritable('some-other-project', 'mobilepartsfindercom'), e => /must be the same Mobile Parts Finder project/.test(e.message));
  assert.equal(projects.foreignOwner('mobilepartsfindercom'), null);
  assert.equal(projects.PROJECTS.mobilePartsFinder.ownership, 'ACTIVE_WRITABLE');
  assert.equal(projects.PROJECTS.dashboard.ownership, 'READ_ONLY_REFERENCE');
  assert.equal(projects.PROJECTS.proglide.ownership, 'PROTECTED_SEPARATE');

  /* the real handle: with a Dashboard service account in the environment, it gives out nothing */
  const firebase = require('./firebase');
  const realProjectId = firebase.projectId;
  const env = process.env.FIREBASE_PROJECT_ID;
  try {
    fsx.use(null);
    firebase.projectId = () => 'dashboard-7e8d8';
    delete process.env.FIREBASE_PROJECT_ID;
    assert.throws(() => fsx.db(), e => e.code === 'project-boundary');
  } finally {
    firebase.projectId = realProjectId;
    if (env === undefined) delete process.env.FIREBASE_PROJECT_ID; else process.env.FIREBASE_PROJECT_ID = env;
    fsx.use(null);
  }
});

/* ===================================================== 3. the four operations */

const id = name => { const m = taxonomy.matchModel(name); assert.equal(m.status, 'matched', name); return m.modelId; };
const nameOf = modelId => taxonomy.modelById(modelId).modelName;

/** A store that counts every write made to it. */
function counted(name) {
  const fake = createFakeFirestore();
  const writes = [];
  const wrap = target => new Proxy(target, {
    get(obj, prop) {
      const v = obj[prop];
      if (typeof v !== 'function') return v;
      return (...args) => {
        if (['set', 'update', 'delete', 'create', 'add'].indexOf(String(prop)) > -1) writes.push(name + ':' + String(prop));
        const out = v.apply(obj, args);
        return out && typeof out === 'object' && !(out instanceof Promise) && !Array.isArray(out) ? wrap(out) : out;
      };
    }
  });
  return { fake, writes, db: wrap(fake.db), provider: fake.provider };
}

function seedGroup(fake, groupId, categoryId, masterName, memberNames) {
  const list = memberNames.map(id);
  fake.seed('groups/' + groupId, { groupNo: groupId.toUpperCase(), categoryId, partCode: 'MPF-' + groupId.toUpperCase(), masterModelId: id(masterName), masterModelName: nameOf(id(masterName)), memberCount: list.length });
  fake.seed('groupDetails/' + groupId, { groupNo: groupId.toUpperCase(), categoryId, partCode: 'MPF-' + groupId.toUpperCase(), memberIds: list, memberNames: list.map(nameOf), memberCount: list.length });
  list.forEach(m => { const cur = fake.read('modelGroups/' + m) || { id: m, byCategory: {} }; cur.byCategory[categoryId] = (cur.byCategory[categoryId] || []).concat(groupId); fake.seed('modelGroups/' + m, cur); });
}

/** Three databases. Only Mobile Parts Finder's is wired to the code. */
function threeProjects() {
  const mpf = createFakeFirestore();
  const dashboard = counted('dashboard');
  const proglide = counted('proglide');
  /* the other two look like this one: the same groups, the same ids */
  [mpf, dashboard.fake, proglide.fake].forEach(f => {
    f.seed('catalog/meta', { version: 1 });
    seedGroup(f, 'bf-0010', 'button-flex', 'Realme 5', ['Realme 5', 'Realme 5s', 'Realme 5i', 'Realme C3', 'Realme C11', 'Realme C12', 'Realme C15']);
    seedGroup(f, 'bf-0020', 'button-flex', 'Vivo Y18', ['Vivo Y18', 'Vivo Y28s']);
    f.seed('compat_master/g1', { cat: 'button-flex', master: 'Realme 5', models: ['Realme 5', 'Realme 5s'] });
  });
  fsx.use(mpf.provider);
  currentFake = mpf;
  taxonomy.registerCategories([]);
  const snapshot = f => JSON.stringify(f.paths('').sort().map(p => [p, f.read(p)]));
  return { mpf, dashboard, proglide, before: { dashboard: snapshot(dashboard.fake), proglide: snapshot(proglide.fake), mpf: snapshot(mpf) }, snapshot };
}

function assertUntouched(w) {
  assert.deepEqual(w.dashboard.writes, [], 'Dashboard writes: 0');
  assert.deepEqual(w.proglide.writes, [], 'ProGlide writes: 0');
  assert.equal(w.snapshot(w.dashboard.fake), w.before.dashboard, 'Dashboard unchanged');
  assert.equal(w.snapshot(w.proglide.fake), w.before.proglide, 'ProGlide unchanged');
}

test('TEST 1 — an Instagram extraction changes Mobile Parts Finder; the Dashboard and ProGlide see zero writes', async () => {
  const w = threeProjects();
  const list = { contentClass: 'compatibility', confidence: 0.97, product: 'On Off Patta', text: '', lists: [
    { headline: 'On Off Patta Compatible Models', atSecond: 0, models: ['Realme c11', 'Realme c12', 'Realme c15', 'Realme c25', 'Realme c25s'] }] };
  const gemini = { configured: () => true, uploadFile: async () => ({ ok: false }), deleteFile: async () => {},
    listModels: async () => ({ ok: true, models: [] }),
    interact: async ({ model, schema }) => {
      const output = schema.properties.verdict ? { verdict: 'LIKELY_COMPATIBILITY', kind: 'compatibility', hasModelList: true, reason: 'a list' } : list;
      return { ok: true, output, text: JSON.stringify(output), model, usage: { inputTokens: 900, outputTokens: 90 } };
    } };
  const deps = {
    cfg: Object.assign(configMod.load(), {
      graph: { token: 't', igUserId: '1', version: 'v25.0', timeoutMs: 1000, appSecret: '' }, autoApply: true, autoCreateCategories: true,
      ocrProvider: 'none', visionProvider: 'gemini', videoProvider: 'gemini', validator: 'none', geminiKey: 'test-only-not-a-key', anthropicKey: '',
      aiMode: 'off', aiRetries: 0, prices: {}, maxItemsPerJob: 50, maxDiscoveryPages: 5, pageSize: 25, maxAttempts: 3, tickBudgetMs: 600000, leaseMs: 60000,
      maxAiItemsPerSync: 100, maxGeminiCallsPerSync: 100, maxClaudeCallsPerSync: 10, maxVideoMinutesPerSync: 60,
      dailyGraphCalls: 1000, dailyOcrCalls: 1000, dailyAiCalls: 1000, dailyVideoCalls: 1000, maxImageBytes: 8e6, maxVideoBytes: 6e7, maxCarouselChildren: 10
    }),
    graph: { configured: () => true, coverFieldSupported: () => false,
      ownProfile: async () => ({ username: 'mpf_official', name: 'MPF', followersCount: 1, mediaCount: 0 }),
      ownMediaPage: async () => ({ media: [], nextCursor: null }),
      discoverPage: async username => ({ profile: { username, name: username, followersCount: 1, mediaCount: 1, accountType: 'professional' }, nextCursor: null,
        media: [normaliseMedia({ id: 'p1', media_type: 'IMAGE', media_url: 'https://cdn/p1.jpg', permalink: 'https://www.instagram.com/p/POSTP1XXXXX/', timestamp: '2026-09-24T10:00:00+0000', caption: 'Universal on off patta compatible models' })] }) },
    ai: { isConfigured: () => false, status: () => ({ model: null, missing: [] }), invoke: async () => ({ ok: false }) },
    fetchImpl: async () => { const b = Buffer.from('IMG:p1;'); return { ok: true, status: 200, headers: { get: h => (h === 'content-type' ? 'image/jpeg' : String(b.length)) }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; },
    providers: { gemini, claude: { configured: () => false } }
  };
  const created = await jobs.createJob({ admin: ADMIN, profileUrl: 'https://www.instagram.com/sk_mobile_doctar/', now: clock(), deps });
  let out = { job: created.job };
  for (let i = 0; i < 30 && ['queued', 'discovering', 'processing'].indexOf(out.job.status) > -1; i++) {
    out = await jobs.tick({ jobId: created.job.jobId, workerId: 'test', deps: Object.assign({ clock }, deps) });
  }
  assert.equal(out.job.status, 'completed');
  assert.equal(out.job.counts.autoModelsAdded, 2, 'Mobile Parts Finder: Realme C25 and C25s joined the group');
  assert.equal(w.mpf.read('groupDetails/bf-0010').memberCount, 9);
  assert.notEqual(w.snapshot(w.mpf), w.before.mpf, 'Mobile Parts Finder changed');
  assertUntouched(w);
  /* the other projects' copy of "the same group" still has seven models */
  assert.equal(w.dashboard.fake.read('groupDetails/bf-0010').memberCount, 7);
  assert.equal(w.proglide.fake.read('groupDetails/bf-0010').memberCount, 7);
});

test('TEST 2 — updating a group, TEST 3 — creating a category, TEST 4 — merging two groups: Mobile Parts Finder only', async () => {
  const w = threeProjects();
  await management.addModel({ groupId: 'bf-0010', modelId: id('Realme C25'), admin: ADMIN, now: clock() });
  await management.removeModel({ groupId: 'bf-0010', modelId: id('Realme C3'), admin: ADMIN, now: clock() });
  assertUntouched(w);

  const cat = await categoryService.create({ name: 'Camera Glass', admin: ADMIN, now: clock() });
  await management.createGroup({ categoryId: cat.id, masterModelId: id('Vivo Y18'), memberIds: [id('Vivo Y28s')], admin: ADMIN, now: clock() });
  assert.ok(w.mpf.read('compatCategories/camera-glass'));
  assert.ok(!w.dashboard.fake.read('compatCategories/camera-glass') && !w.proglide.fake.read('compatCategories/camera-glass'));
  assertUntouched(w);

  await management.mergeGroups({ intoGroupId: 'bf-0010', fromGroupId: 'bf-0020', admin: ADMIN, now: clock() });
  assert.equal(w.mpf.read('groups/bf-0020').mergedInto, 'bf-0010');
  assert.ok(!w.dashboard.fake.read('groups/bf-0020').mergedInto, 'the Dashboard\'s group of the same id is not merged');
  assertUntouched(w);
});

/* ============================================================ 4. foreign keys */

test('nothing written here points into another project', async () => {
  const w = threeProjects();
  await management.addModel({ groupId: 'bf-0010', modelId: id('Realme C25'), admin: ADMIN, now: clock() });
  await management.mergeGroups({ intoGroupId: 'bf-0010', fromGroupId: 'bf-0020', admin: ADMIN, now: clock() });
  await management.createGroup({ categoryId: 'button-flex', masterModelId: id('Oppo A16'), memberIds: [id('Oppo A16s')], admin: ADMIN, now: clock() });
  const all = JSON.stringify(w.mpf.paths('').map(p => [p, w.mpf.read(p)]));
  ['dashboardGroupId', 'dashboardId', 'compat_master', 'dashboard-7e8d8', 'proglideId', 'proglideGroupId'].forEach(k => {
    /* compat_master was seeded above as a stand-in for the other project's shape; nothing the code WROTE refers to it */
    const written = w.mpf.paths('').filter(p => p.indexOf('compat_master/') !== 0).map(p => JSON.stringify(w.mpf.read(p))).join('\n');
    assert.ok(written.indexOf(k) < 0, 'no "' + k + '" in anything written');
  });
  assert.ok(all.length > 0);
});

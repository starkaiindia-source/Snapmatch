/* ============================================================================
   Mobile Parts Finder · scripts/instagram-ai-smoke.js
   ----------------------------------------------------------------------------
   The REAL AI pipeline on media you have on disk — a screenshot of a post, or
   a reel you are entitled to hold — so the provider integration can be tested
   without waiting for an import.

     node scripts/instagram-ai-smoke.js --image "C:\path\shot.jpg" [--image …]
                                        [--video "C:\path\reel.mp4"]
                                        [--caption "Universal combo …"]

   WHAT IS REAL AND WHAT IS NOT

     real      every AI call: Gemini screening, Gemini image / video reading,
               Claude validation — with the keys in your environment. The cheap
               filter, the extractor, the catalogue matcher and the group
               planner are the production code.
     stand-in  Instagram (the files you pass ARE the post) and Firestore (an
               in-memory copy of data/build, so the list is compared with the
               real groups and NOTHING is written anywhere).

   If a key is missing or rejected the report says NOT VERIFIED and the exit
   code is 2. It never prints a result it did not get from the provider.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const all = name => argv.reduce((out, a, i) => (a === '--' + name && argv[i + 1] ? out.concat(argv[i + 1]) : out), []);
const images = all('image');
const videos = all('video');
const caption = all('caption')[0] || '';

if (!images.length && !videos.length) {
  console.error('\n  Give at least one --image or --video file.\n');
  process.exit(1);
}
images.concat(videos).forEach(f => { if (!fs.existsSync(f)) { console.error('\n  no such file: ' + f + '\n'); process.exit(1); } });

const { createFakeFirestore } = require('../api/_lib/testing/fake-firestore');
const fsx = require('../api/_services/instagram/firestore');
const jobs = require('../api/_services/instagram/job-service');
const configMod = require('../api/_services/instagram/config');
const { normaliseMedia } = require('../api/_services/instagram/graph-client');
const { verifyProviders } = require('../api/_services/instagram/provider-check');
const C = require('../api/_schema/collections');

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic',
               '.mp4': 'video/mp4', '.mov': 'video/mov', '.webm': 'video/webm' };
const usd = micro => '$' + ((Number(micro) || 0) / 1e6).toFixed(4);

/* the local files stand in for Instagram's CDN; every other URL is the real network */
const realFetch = globalThis.fetch;
const fileUrl = f => 'https://local.invalid/' + encodeURIComponent(path.resolve(f));
const fetchImpl = async (url, init) => {
  if (String(url).indexOf('https://local.invalid/') !== 0) return realFetch(url, init);
  const file = decodeURIComponent(String(url).slice('https://local.invalid/'.length));
  const bytes = fs.readFileSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return { ok: true, status: 200, headers: { get: h => (h === 'content-type' ? type : String(bytes.length)) },
           arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};

function seedProduction(fake) {
  const read = f => fs.readFileSync(path.join(__dirname, '..', 'data', 'build', f), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  fake.seed('catalog/meta', { version: 'data/build' });
  read('groups.ndjson').forEach(g => {
    fake.seed('groups/' + g.id, { groupNo: g.groupNo, partCode: g.partCode, categoryId: g.categoryId,
      masterModelId: g.masterModelId, masterModelName: g.masterModelName, memberCount: g.memberCount });
    fake.seed('groupDetails/' + g.id, { groupNo: g.groupNo, partCode: g.partCode, categoryId: g.categoryId,
      memberIds: g.memberIds, memberNames: g.memberNames, memberCount: g.memberCount });
  });
  read('modelGroups.ndjson').forEach(m => fake.seed('modelGroups/' + m.id, m));
}

(async () => {
  const check = await verifyProviders();
  console.log('\n  Instagram AI pipeline — real provider smoke test');
  console.log('  ' + '-'.repeat(66));
  ['gemini', 'claude'].forEach(n => {
    const p = check.providers[n];
    console.log(`  ${n.padEnd(8)} ${p.status}${p.code ? ' [' + p.code + ']' : ''} — ${p.detail}`);
  });
  if (check.providers.gemini.status !== 'VERIFIED') {
    console.log('\n  NOT VERIFIED. Gemini could not be called, so nothing below this line was attempted.');
    console.log('  Put a working key in GEMINI_API_KEY (https://aistudio.google.com/apikey) and run this again.\n');
    process.exit(2);
  }

  const fake = createFakeFirestore();
  fsx.use(fake.provider);
  seedProduction(fake);

  const cfg = Object.assign(configMod.load(), {
    graph: { token: 'local-files', igUserId: 'local', version: 'v25.0', timeoutMs: 1000, appSecret: '' },
    tickBudgetMs: 10 * 60 * 1000
  });
  const raw = [];
  if (videos.length) {
    videos.forEach((f, i) => raw.push({ id: 'smokevideo' + i, media_type: 'VIDEO', media_product_type: 'REELS', media_url: fileUrl(f),
      permalink: 'https://www.instagram.com/reel/SMOKEV' + i + 'AA/', caption }));
  }
  if (images.length === 1) {
    raw.push({ id: 'smokeimage0', media_type: 'IMAGE', media_url: fileUrl(images[0]), permalink: 'https://www.instagram.com/p/SMOKEI0AA/', caption });
  } else if (images.length > 1) {
    raw.push({ id: 'smokecarousel', media_type: 'CAROUSEL_ALBUM', permalink: 'https://www.instagram.com/p/SMOKEC0AA/', caption,
      children: { data: images.map((f, i) => ({ id: 'smokeimage' + i, media_type: 'IMAGE', media_url: fileUrl(f) })) } });
  }
  const graph = {
    configured: () => true,
    ownProfile: async () => ({ username: 'local_owner', name: 'local', followersCount: 0, mediaCount: 0 }),
    ownMediaPage: async () => ({ media: [], nextCursor: null }),
    discoverPage: async username => ({ profile: { username, name: 'local files', followersCount: null, mediaCount: raw.length, accountType: 'professional' },
      media: raw.map(normaliseMedia), nextCursor: null }),
    coverFieldSupported: () => false
  };
  const admin = { uid: 'localSmokeTest01', email: null, role: 'super_admin' };
  const deps = { cfg, graph, fetchImpl };
  const created = await jobs.createJob({ admin, profileUrl: 'https://www.instagram.com/local_files/', now: Date.now(), deps });
  let job = created.job;
  for (let i = 0; i < 40 && ['queued', 'discovering', 'processing'].indexOf(job.status) > -1; i++) {
    job = (await jobs.tick({ jobId: job.jobId, workerId: 'smoke', deps })).job;
  }

  const u = job.usage || {};
  const c = job.counts || {};
  console.log('\n  Job ' + job.status + (job.statusReason ? ' — ' + job.statusReason : ''));
  console.log('  Funnel   : ' + c.postsFound + ' collected · ' + (c.cheapRejected || 0) + ' rejected by the cheap filter · ' +
    (c.screened || 0) + ' screened (' + (c.screenRejected || 0) + ' stopped there) · ' + (c.deepAnalysed || 0) + ' deep analysis · ' +
    (c.validated || 0) + ' validated by Claude');
  console.log('  Gemini   : ' + (u.geminiCalls || 0) + ' calls (' + (u.screenCalls || 0) + ' screening), ' +
    (u.geminiInputTokens || 0) + ' in / ' + (u.geminiOutputTokens || 0) + ' out tokens — ' + cfg.geminiModel + ' / ' + cfg.geminiScreenModel);
  console.log('  Claude   : ' + (u.claudeCalls || 0) + ' calls, ' + (u.claudeInputTokens || 0) + ' in / ' + (u.claudeOutputTokens || 0) + ' out tokens' +
    (cfg.validator === 'anthropic' ? ' — ' + cfg.claudeModel : ' — no validator configured'));
  console.log('  Video    : ' + (u.videoSeconds || 0) + ' s read' + ((c.videoUnavailable || 0) ? ', ' + c.videoUnavailable + ' unavailable' : ''));
  console.log('  Cache    : ' + (u.cacheHits || 0) + ' hits');
  console.log('  Cost     : ' + usd(u.costMicroUsd) + ' estimated' + ((u.costUnknownCalls || 0) ? ' + ' + u.costUnknownCalls + ' call(s) at an unknown price' : ''));

  fake.all(C.INSTAGRAM_EXTRACTIONS).forEach(x => {
    console.log('\n  ' + x.contentType + ' → ' + x.relevance + ' [' + x.pipeline.state + ']');
    console.log('    ' + x.relevanceReason);
    (x.mediaItems || []).forEach(m => console.log('    media ' + m.mediaId + ': ' + m.ocrStatus + (m.readBy ? ' by ' + m.readBy : '') +
      (m.screen ? ' · screen ' + m.screen.verdict : '') + (m.vision ? ' · ' + (m.vision.contentClass || m.vision.status) +
      (m.vision.confidence != null ? ' ' + Math.round(m.vision.confidence * 100) + '%' : '') : '') + (m.reason ? ' · ' + m.reason : '')));
  });
  fake.all(C.COMPATIBILITY_CANDIDATES).filter(p => p.kind === 'group_proposal').forEach(p => {
    const n = p.counts;
    console.log('\n  LIST  ' + (p.productName || '(no product title)') + ' · ' + (p.categoryId || 'category unclear'));
    console.log('    action      : ' + p.proposedAction + (p.target.groupId ? ' → ' + p.target.groupNo + ' (master ' + p.target.masterModelName + ')' : ''));
    console.log('    models      : ' + n.extracted + ' read · ' + n.matched + ' matched · ' + n.existing + ' already in the group · ' + n.add +
      ' to add · ' + n.conflict + ' conflict · ' + n.needsReview + ' need review · ' + n.unmatched + ' unmatched');
    console.log('    confidence  : ' + p.confidence.band + (p.validation ? ' · second opinion: ' + p.validation.status : ''));
    p.members.forEach(m => console.log('      ' + String(m.state).padEnd(13) + (m.match && m.match.modelName ? m.match.modelName : '—').padEnd(30) +
      ' “' + m.text + '”  ' + m.matchStatus + (m.currentGroupId ? '  in ' + m.currentGroupId : '') +
      (m.suggestion && m.suggestion.modelName ? '  (validator suggests ' + m.suggestion.modelName + ')' : '')));
  });
  console.log('\n  Nothing was written to Firebase. This was a read-only comparison with data/build.\n');
})().catch(err => { console.error('\n  smoke test failed:', err && err.stack || err, '\n'); process.exit(1); });

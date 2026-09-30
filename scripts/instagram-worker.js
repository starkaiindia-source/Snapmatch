/* ============================================================================
   Mobile Parts Finder · scripts/instagram-worker.js
   ----------------------------------------------------------------------------
   Drives Instagram import jobs without a browser.

   The admin page advances a job while it is open. For a large page, or to
   process overnight, run this anywhere the service account is available —
   it calls exactly the same job service, takes the same lease (so it never
   races an open admin tab), and stops where the page would stop: at the end,
   at a rate limit, at a daily cap, or at "unable to collect".

     node scripts/instagram-worker.js --job <jobId>
     node scripts/instagram-worker.js --all              every queued/running job
     node scripts/instagram-worker.js --all --max-minutes 30

   Credentials: FIREBASE_SERVICE_ACCOUNT (or _B64), and the INSTAGRAM_* / AI_*
   variables, from the environment or from .env.local — the same names the
   Vercel functions read. Nothing is printed that contains a credential.
   ========================================================================== */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

loadEnvLocal();

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : def; };
const has = name => argv.indexOf('--' + name) > -1;

const JOB = flag('job', null);
const ALL = has('all');
const MAX_MINUTES = Math.max(1, Number(flag('max-minutes', 60)) || 60);
const WORKER = 'worker:' + os.hostname();

if (!JOB && !ALL) {
  console.error('\n  Usage: node scripts/instagram-worker.js --job <jobId> | --all [--max-minutes N]\n');
  process.exit(1);
}

const jobs = require('../api/_services/instagram/job-service');
const fsx = require('../api/_services/instagram/firestore');
const C = require('../api/_schema/collections');

const RUNNING = ['queued', 'discovering', 'processing'];
const deadline = Date.now() + MAX_MINUTES * 60 * 1000;

async function drive(jobId) {
  let busyRounds = 0;
  while (Date.now() < deadline) {
    const r = await jobs.tick({ jobId, workerId: WORKER });
    if (!r.job) { console.log(`  ${jobId}: ${r.error || 'not found'}`); return; }
    const c = r.job.counts || {};
    console.log(`  ${jobId} @${r.job.username}: ${r.job.status}  ${(c.processed || 0) + (c.failed || 0)}/${c.postsFound || 0} posts · ` +
      `${c.relationships || 0} relationships · ${c.pendingReview || 0} to review` + (r.busy ? '  (another worker holds the lease)' : ''));
    if (r.busy) {
      if (++busyRounds > 20) { console.log('  giving up: the job stayed leased by another worker'); return; }
      await new Promise(res => setTimeout(res, 5000));
      continue;
    }
    busyRounds = 0;
    if (RUNNING.indexOf(r.job.status) < 0) {
      if (r.job.statusReason) console.log('  ' + r.job.statusReason);
      return;
    }
  }
  console.log(`  ${jobId}: stopped at the ${MAX_MINUTES}-minute limit; it resumes from here next time.`);
}

async function main() {
  console.log('\n  Mobile Parts Finder — Instagram import worker (' + WORKER + ')');
  if (JOB) return drive(JOB);
  const snap = await fsx.db().collection(C.INSTAGRAM_IMPORT_JOBS).where('status', 'in', RUNNING).limit(20).get();
  if (snap.empty) { console.log('  no queued or running jobs'); return; }
  for (const d of snap.docs) {
    if (Date.now() >= deadline) break;
    await drive(d.id);
  }
}

/* The same tiny .env.local reader as scripts/dev-server.js. Existing
   environment variables win. */
function loadEnvLocal() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) return;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  });
}

main().then(() => process.exit(0), err => { console.error('\n  worker failed:', err && err.message, '\n'); process.exit(1); });

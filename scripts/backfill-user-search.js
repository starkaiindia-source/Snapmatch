/* ============================================================================
   scripts/backfill-user-search.js
   ----------------------------------------------------------------------------
   Adds the lower-cased search mirrors to user profiles written before they
   existed, so the admin table can find every account by name from day one.

   ----------------------------------------------------------------------------
   WHY THIS IS A BACKFILL AND NOT A MIGRATION

   It does not change a single value a user entered. It reads the profile,
   recomputes five derived fields from what is already there, and writes them
   back only if they differ. Run it twice and the second run writes nothing.
   Run it against a partially-migrated collection and it finishes the job.

   Nothing is deleted, nothing is renamed, no field a shop typed is touched.
   That is the difference that makes it safe to run against live production
   data — the worst outcome of a bug here is a search index that is wrong, and
   re-running fixes it.

   ----------------------------------------------------------------------------
   IT IS NOT REQUIRED FOR CORRECTNESS

   Until a record is backfilled it is still found by uid and by email, because
   both of those have exact paths that do not use a mirror. The backfill adds
   search by shop name, proprietor name and phone number. So this can be run at
   any time, including never, and the admin area works either way — it simply
   finds fewer things by name.

     node scripts/backfill-user-search.js            report what would change
     node scripts/backfill-user-search.js --write    make the changes
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

(function loadEnvLocal() {
  const file = path.join(ROOT, '.env.local');
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach(line => {
    if (/^\s*#/.test(line)) return;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) return;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  });
}());

const { db } = require(path.join(ROOT, 'api/_lib/firebase'));
const { searchFieldsFor } = require(path.join(ROOT, 'api/_schema/user-profile'));
const { USERS } = require(path.join(ROOT, 'api/_schema/collections'));

/* Firestore caps a batch at 500 writes. 400 leaves room and keeps each commit
   comfortably inside the request deadline. */
const BATCH_SIZE = 400;

async function main() {
  const write = process.argv.includes('--write');

  if (!process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
    console.error('\n  FIREBASE_SERVICE_ACCOUNT is not set. Put it in .env.local first.\n');
    process.exit(1);
  }

  console.log('\n  ' + (write ? 'Backfilling' : 'Dry run — nothing will be written') + '\n');

  let scanned = 0;
  let changed = 0;
  let cursor = null;

  /* Paged by document id rather than read in one go: a collection read in one
     query holds every profile in memory at once, and the point of this script
     is that it keeps working as the user base grows. */
  for (;;) {
    let q = db().collection(USERS).orderBy('__name__').limit(BATCH_SIZE);
    if (cursor) q = q.startAfter(cursor);

    const snap = await q.get();
    if (snap.empty) break;

    const batch = db().batch();
    let pending = 0;

    snap.docs.forEach(doc => {
      scanned++;
      const profile = doc.data();
      const wanted = searchFieldsFor(profile);
      const differs = Object.keys(wanted).some(k => profile[k] !== wanted[k]);
      if (!differs) return;

      changed++;
      pending++;
      if (write) batch.set(doc.ref, wanted, { merge: true });
      else {
        const name = wanted.mobileShopNameLower || wanted.displayNameLower || doc.id;
        console.log('    would update ' + doc.id + '  ' + name);
      }
    });

    if (write && pending) await batch.commit();
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < BATCH_SIZE) break;
  }

  console.log('\n  scanned ' + scanned + ' profiles, ' +
              (write ? 'updated ' : 'would update ') + changed + '\n');
  if (!write && changed) console.log('  Re-run with --write to apply.\n');
}

main().then(
  () => process.exit(0),
  err => {
    console.error('\n  Failed:', (err && err.message) || err, '\n');
    process.exit(1);
  }
);

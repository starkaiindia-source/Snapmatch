/* ============================================================================
   Mobile Parts Finder · scripts/upload-category-assets.js
   ----------------------------------------------------------------------------
   Uploads the official category logos to Firebase Storage and writes the
   resulting URLs into src/data/category-assets.js, which is the one place the
   app resolves a category picture from.

   YOU run this — it needs credentials for your own Firebase project, and they
   stay on your machine.

       set GOOGLE_APPLICATION_CREDENTIALS=C:\\path\\to\\serviceAccount.json
       node scripts/upload-category-assets.js --project mobilepartsfinder

   Flags
     --project <id>   Firebase project id                      (required)
     --bucket <name>  storage bucket        (default <project>.firebasestorage.app)
     --dry            report what would be uploaded, change nothing

   WHAT GOES UP

     category-assets/<category-id>/master.png    the file you supplied, untouched
     category-assets/<category-id>/logo-256.png  the web copy the site serves

     The master is uploaded so the bucket is the system of record: the original
     is recoverable without going back to a Downloads folder. The web copy is
     what a browser fetches.

   THESE OBJECTS ARE PUBLIC, DELIBERATELY

     They are product photographs on a public marketing site. Serving them
     through signed URLs would mean a token in the HTML that expires, on a page
     that is pre-rendered and cached — the icons would simply stop appearing one
     day. storage.rules grants read on this prefix and nothing else.

   IDEMPOTENT. Re-running overwrites the same object paths and rewrites the same
   mapping file. Nothing is duplicated and nothing is versioned into oblivion.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets', 'categories');
const MAPPING = path.join(ROOT, 'src', 'data', 'category-assets.js');

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
const has = n => argv.indexOf('--' + n) > -1;

const PROJECT = flag('project');
const DRY = has('dry');
const BUCKET = flag('bucket', PROJECT ? `${PROJECT}.firebasestorage.app` : null);

if (!PROJECT) {
  console.error('\n  --project is required, e.g.\n' +
    '    node scripts/upload-category-assets.js --project mobilepartsfinder\n');
  process.exit(1);
}

const manifestPath = path.join(ASSETS, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('\n  assets/categories/manifest.json not found. Build the web copies first:\n' +
    '    python scripts/build-category-assets.py --src "C:/path/to/logos"\n');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const CATEGORY_IDS = Object.keys(manifest.categories);

/* Where a master lives once it has been uploaded once — the build script records
   only its original filename, so the master is looked for beside the web copy
   or in the folder the build read from. */
const MASTER_DIRS = [
  path.join(ASSETS, 'master'),
  flag('src', 'C:/Users/stark/Downloads')
];

function findMaster(catId) {
  const entry = manifest.categories[catId];
  for (const dir of MASTER_DIRS) {
    for (const name of [catId + '.png', entry.master]) {
      if (!name) continue;
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/* The public download URL for an object. Firebase's own form, so it works
   through the same CDN the console shows and needs no token when the rules
   allow public read. */
function publicUrl(bucket, objectPath) {
  return 'https://firebasestorage.googleapis.com/v0/b/' + bucket +
         '/o/' + encodeURIComponent(objectPath) + '?alt=media';
}

async function main() {
  const rows = [];

  if (!DRY) {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: PROJECT,
        storageBucket: BUCKET
      });
    }
    const bucket = admin.storage().bucket(BUCKET);
    let warnedAcl = false;

    for (const catId of CATEGORY_IDS) {
      const entry = manifest.categories[catId];
      const webFile = path.join(ROOT, entry.file);
      const master = findMaster(catId);

      const uploads = [
        { local: webFile, remote: `category-assets/${catId}/logo-256.png` }
      ];
      if (master) uploads.push({ local: master, remote: `category-assets/${catId}/master.png` });

      for (const u of uploads) {
        await bucket.upload(u.local, {
          destination: u.remote,
          metadata: {
            contentType: 'image/png',
            /* A year, immutable: these change by being replaced at a new path or
               by a deliberate re-upload, not on their own. */
            cacheControl: 'public, max-age=31536000, immutable'
          }
        });
        /* Per-object ACLs are refused when the bucket has uniform bucket-level
           access turned on, which is the modern default. That is not a failure:
           storage.rules grants read on this prefix, and the Firebase download
           endpoint honours those rules. Try the ACL, carry on without it. */
        try {
          await bucket.file(u.remote).makePublic();
        } catch (aclErr) {
          if (!warnedAcl) {
            console.warn('  note: per-object ACLs unavailable (' +
              ((aclErr && aclErr.message) || 'uniform bucket-level access') +
              ') — relying on storage.rules for read access');
            warnedAcl = true;
          }
        }
      }

      rows.push({
        id: catId,
        label: entry.label,
        remote: `category-assets/${catId}/logo-256.png`,
        url: publicUrl(BUCKET, `category-assets/${catId}/logo-256.png`),
        local: '/' + entry.file,
        masterUploaded: !!master
      });
    }
  } else {
    for (const catId of CATEGORY_IDS) {
      const entry = manifest.categories[catId];
      rows.push({
        id: catId,
        label: entry.label,
        remote: `category-assets/${catId}/logo-256.png`,
        url: publicUrl(BUCKET, `category-assets/${catId}/logo-256.png`),
        local: '/' + entry.file,
        masterUploaded: !!findMaster(catId)
      });
    }
  }

  /* ---- write the mapping the app reads ----
     `focus` is where the PART sits inside its canvas, measured by
     scripts/build-category-focus.py and carried in the manifest. It is
     re-emitted here rather than dropped, because rewriting this file without
     it would silently return every category tile to fitting the white canvas
     instead of the part — the exact bug that script exists to fix. */
  const body = rows.map(r => {
    const f = (manifest.categories[r.id] || {}).focus;
    return `    '${r.id}': {\n` +
      `      label: ${JSON.stringify(r.label)},\n` +
      `      storage: ${JSON.stringify(r.url)},\n` +
      `      bundled: ${JSON.stringify(r.local)}` +
      (f ? `,\n      focus: { iw: ${f.iw}, il: ${f.il}, it: ${f.it} }\n` : '\n') +
      `    }`;
  }).join(',\n');

  const file = `/* ============================================================================
   Mobile Parts Finder · category-assets.js — the official category logos
   ----------------------------------------------------------------------------
   GENERATED. Do not edit by hand.

       python scripts/build-category-assets.py --src "<folder of masters>"
       node scripts/upload-category-assets.js --project ${PROJECT}

   ONE MAPPING, EVERY SURFACE

     Category logos are resolved here and nowhere else. Registering them into
     SM.art means every existing call site — the finder rail, the category
     tiles, group cards, group sheets, category headers, search results — shows
     the same official picture for the same category, because they all already
     go through SM.art.category(). No component picks its own icon.

   ALIASES

     The same category is spelled several ways across the source data and the
     SEO pages: "screen-guards", "screen guard", "tempered glass". They all
     resolve to one asset, so a naming variation can never produce a different
     logo for the same part.

   TWO URLS PER CATEGORY, AND WHY

     storage  Firebase Storage — the system of record, and what the site loads.
     bundled  the identical file deployed with the site.

     The bundled copy is the fallback, and it is the SAME OFFICIAL LOGO, not a
     generic stand-in. If Storage is slow, blocked or misconfigured the category
     still shows its own picture rather than a drawn icon that means something
     else.

   Generated ${new Date().toISOString()}
   ========================================================================== */
(function (global) {
  'use strict';
  var SM = (global.SM = global.SM || {});

  var ASSETS = {
${body}
  };

  /* Spellings that mean the same category. The app's own ids are the keys of
     ASSETS above; these are the variants that appear in source data, URLs and
     copy. Normalised the same way on both sides, so case and punctuation do not
     matter. */
  var ALIASES = {
    'screen-guards': ['screen', 'screens', 'screen guard', 'screen guards', 'screenguard',
                      'tempered glass', 'temperedglass', 'glass', 'universal tempered glass',
                      'sg'],
    'back-cover':    ['back cover', 'backcover', 'cover', 'universal back cover', 'bc'],
    'combo-display': ['combo display', 'combodisplay', 'combo/display', 'display', 'combo',
                      'folder', 'lcd', 'cd'],
    'middle-frame':  ['middle frame', 'middleframe', 'frame', 'mid frame', 'mf'],
    'cc-board':      ['cc board', 'ccboard', 'charging board', 'charging connector board',
                      'connector board', 'cc'],
    'battery':       ['battery', 'batteries', 'bt']
  };

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  var LOOKUP = Object.create(null);
  Object.keys(ASSETS).forEach(function (id) {
    LOOKUP[norm(id)] = id;
    LOOKUP[norm(ASSETS[id].label)] = id;
    (ALIASES[id] || []).forEach(function (a) { LOOKUP[norm(a)] = id; });
  });

  SM.categoryAssets = {
    /** Canonical category id for any spelling, or null. */
    resolve: function (nameOrId) {
      return LOOKUP[norm(nameOrId)] || null;
    },

    /** { storage, bundled, label } for a category, or null when there is none. */
    get: function (nameOrId) {
      var id = this.resolve(nameOrId);
      return id ? ASSETS[id] : null;
    },

    /** Every category that has an official logo. */
    ids: function () { return Object.keys(ASSETS); },

    /**
     * Registers every logo with SM.art, which is what the whole UI already
     * calls. One call, and every surface is correct at once.
     */
    install: function () {
      if (!SM.art || !SM.art.registerCategory) return false;
      Object.keys(ASSETS).forEach(function (id) {
        SM.art.registerCategory(id, ASSETS[id].storage, ASSETS[id].bundled);
      });
      return true;
    }
  };
})(window);
`;

  if (!DRY) fs.writeFileSync(MAPPING, file);

  console.log('\n  Mobile Parts Finder — category logos ->  Firebase Storage' +
              (DRY ? '   (DRY RUN, nothing uploaded)' : ''));
  console.log('  ' + '-'.repeat(74));
  console.log('  project  ' + PROJECT);
  console.log('  bucket   ' + BUCKET);
  console.log('  ' + '-'.repeat(74));
  rows.forEach(r => {
    console.log('  %s  %s', r.id.padEnd(15), r.remote + (r.masterUploaded ? '  + master.png' : ''));
  });
  console.log('  ' + '-'.repeat(74));
  console.log('  ' + rows.length + ' categories');
  console.log(DRY ? '  dry run — src/data/category-assets.js not written\n'
                  : '  wrote src/data/category-assets.js\n');
  if (!DRY) {
    console.log('  Deploy the storage rules so these are readable:');
    console.log('    npx firebase-tools deploy --only storage\n');
  }
}

main().catch(err => {
  console.error('\n  upload failed:', (err && err.message) || err);
  if (err && /credential|authenticate|permission/i.test(String(err.message))) {
    console.error('\n  Point GOOGLE_APPLICATION_CREDENTIALS at your service-account key:');
    console.error('    set GOOGLE_APPLICATION_CREDENTIALS=C:\\path\\to\\serviceAccount.json\n');
  }
  process.exit(1);
});

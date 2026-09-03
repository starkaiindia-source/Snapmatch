/* ============================================================================
   Mobile Parts Finder · backend/schema.js
   ----------------------------------------------------------------------------
   THE single source of truth for the Firestore layout. The importer, the
   ingestion adapters, the rules generator and the client all read collection
   names and field lists from here, so a field cannot drift between them.

   ----------------------------------------------------------------------------
   WHY THE DATA IS SHAPED THIS WAY

   The product answers one question: "which parts fit this phone?". That is a
   many-to-many relation — one part fits many models, one model takes many
   parts — and it is resolved through compatibility GROUPS, not through direct
   part->model edges. A group is "every device that takes this exact part in
   this category". So:

       device  --(member of)-->  group  --(is)-->  one part in one category

   Compatibility is keyed on CANONICAL DEVICE IDs, never on raw text. Sources
   spell the same handset differently ("Redmi Note 13 Pro+ 5G", "REDMI NOTE 13
   PRO PLUS"), so every raw name resolves through /aliases to one canonical id
   before it can join a group.

   ----------------------------------------------------------------------------
   READ COST IS THE DESIGN CONSTRAINT

   Firestore bills per document read, so the layout is chosen to make the hot
   path cheap:

     - Model search never touches Firestore. It runs against a static bundle
       (assets/search-index.json) served from the CDN: 0 reads, no latency.
     - A device's parts answer is ONE read of /deviceGroups/{id}, which holds
       the group ids per category inline.
     - Rendering those groups is one read each, or a single getAll() batch.
     - Specs, colours and prices are subcollections, so browsing the catalogue
       never pays for spec sheets nobody opened.

   Denormalisation is used only where it removes a read on that hot path;
   everything else stays normalised so updates have one writer.

   ----------------------------------------------------------------------------
   THE PAYWALL LIVES IN THE LAYOUT

   Firestore rules cannot protect individual FIELDS, only documents. So the
   fields a subscription pays for are stored in their own collections:

       /groups/{id}        public preview  — category, master device, count
       /groupDetails/{id}  PAID            — part number, full member list
       /deviceGroups/{id}  PAID            — device -> matching group ids

   A signed-out visitor can browse and see that an answer exists; only an
   active subscriber can read the answer. See firestore.rules.
   ========================================================================== */
'use strict';

/* ------------------------------------------------------------------ version
   Bumped when a stored document shape changes. Every written document carries
   it, so a later migration can find records still on an older shape. */
const SCHEMA_VERSION = 1;

/* ---------------------------------------------------------------- confidence
   How far a record can be trusted. Only `verified` data is shown without a
   caveat in the UI; `unverified` means it came from a source we could not
   confirm, `stale` means past its refresh window. */
const CONFIDENCE = ['verified', 'unverified', 'stale', 'conflict'];

/* -------------------------------------------------------------------- device
   Lifecycle status, mirroring how the trade actually talks about stock. */
const DEVICE_STATUS = ['rumoured', 'announced', 'available', 'discontinued'];

/* ============================================================================
   COLLECTIONS
   Each entry documents the path, who may read it, and the fields stored.
   `key` is the document id and is always deterministic — never auto-generated —
   so every import is idempotent and re-running one cannot duplicate a record.
   ========================================================================== */
const COLLECTIONS = {

  /* -------------------------------------------------------------- catalogue */
  catalog: {
    path: 'catalog',
    key: 'fixed: "meta"',
    access: 'public read',
    doc: 'Dataset version and counts. One document, read once at boot.',
    fields: ['version', 'generatedAt', 'importedAt', 'counts', 'categories', 'schemaVersion']
  },

  brands: {
    path: 'brands',
    key: 'brand slug — "apple", "samsung"',
    access: 'public read',
    fields: [
      'id', 'name', 'nameLower', 'aliases',
      'logoUrl', 'logoSource',          /* null until a licensed asset exists */
      'deviceCount', 'groupCount',
      'updatedAt', 'schemaVersion'
    ]
  },

  /* The canonical device master. One document per real-world handset. */
  devices: {
    path: 'devices',
    key: 'canonical device id — "apple-iphone-17-pro-max"',
    access: 'public read',
    doc: 'Identity and the few facts every screen needs. Heavy data lives in ' +
         'subcollections so a catalogue listing stays cheap to read.',
    fields: [
      'id', 'brandId', 'brand', 'name', 'nameLower', 'slug',
      'aliases',                        /* alternate spellings seen in sources */
      'searchPrefixes',                 /* for prefix queries when not using the bundle */
      'tokens',
      'deviceType',                     /* phone | tablet | watch | other      */
      'announcedAt', 'releasedAt', 'releaseYear', 'status',
      'image', 'images',
      'sourceRefs',                     /* { gsmarena: url, apple: url, ... }   */
      'confidence', 'lastVerifiedAt', 'updatedAt', 'schemaVersion'
    ]
  },

  /* Full spec sheet. Subcollection because most reads never need it. */
  deviceSpecs: {
    path: 'devices/{deviceId}/specs',
    key: 'fixed: "current"',
    access: 'public read',
    fields: [
      'network', 'os', 'chipset', 'cpu', 'gpu',
      'ramVariantsGb', 'storageVariantsGb',
      'display',                        /* {sizeInch,type,resolution,ratio,ppi,protection,heightMm,widthMm,screenCm2,bodyRatio} */
      'cameraRear', 'cameraFront',
      'battery',                        /* {capacityMah,type,charging{...}}     */
      'body',                           /* {heightMm,widthMm,depthMm,weightG,materials} */
      'connectivity', 'sensors', 'other',
      'sources', 'confidence', 'lastVerifiedAt', 'updatedAt', 'schemaVersion'
    ]
  },

  /* Official colour variants. Separate documents so region-specific and
     special-edition colours can be added without rewriting the device. */
  colorVariants: {
    path: 'devices/{deviceId}/colorVariants',
    key: 'colour slug — "cosmic-orange"',
    access: 'public read',
    fields: [
      'id', 'name', 'marketingName', 'hexApprox',
      'region',                         /* null = global                        */
      'isSpecialEdition', 'imageUrl',
      'sourceId', 'sourceUrl', 'confidence', 'lastVerifiedAt', 'schemaVersion'
    ]
  },

  /* One document per (source, region, storage variant). Never overwritten by a
     different source — that is why sourceId is part of the key. */
  priceOffers: {
    path: 'devices/{deviceId}/priceOffers',
    key: '{sourceId}__{region}__{variant} — "apple-in__IN__256gb"',
    access: 'public read',
    fields: [
      'sourceId', 'sourceName', 'region', 'currency',
      'variant',                        /* "256gb" or null for a single SKU     */
      'kind',                           /* launch | official | retailer         */
      'amount', 'mrp', 'discountPct',
      'availability',                   /* in_stock | out_of_stock | preorder | unknown */
      'url', 'checkedAt', 'confidence', 'schemaVersion'
    ]
  },

  /* Append-only time series. Never updated in place — a price change writes a
     new document, so history survives. */
  priceHistory: {
    path: 'devices/{deviceId}/priceHistory',
    key: '{sourceId}__{region}__{variant}__{ISO date} — one row per source per day',
    access: 'public read',
    fields: ['sourceId', 'region', 'currency', 'variant', 'amount', 'checkedAt', 'schemaVersion']
  },

  /* Rollup so a product page shows a price range without reading every offer. */
  priceSummary: {
    path: 'devices/{deviceId}/pricing',
    key: 'fixed: "summary"',
    access: 'public read',
    fields: [
      'launch',                         /* {amount,currency,region,variant,sourceUrl,announcedAt} */
      'officialCurrent',                /* {amount,currency,region,url}         */
      'byRetailer',                     /* { "amazon-in": {...}, ... }          */
      'lowest', 'highest',
      'currency', 'region',
      'lastCheckedAt', 'schemaVersion'
    ]
  },

  /* -------------------------------------------------- canonical identity layer
     The bridge between messy source text and canonical ids. A raw name is
     slugged, looked up here in ONE read, and resolved to a device. */
  aliases: {
    path: 'aliases',
    key: 'normalised alias slug — "redmi-note-13-pro-plus-5g"',
    access: 'public read',
    fields: ['alias', 'canonicalId', 'brandId', 'sourceId', 'confidence', 'createdAt', 'schemaVersion']
  },

  /* ------------------------------------------------------------ compatibility
     The existing real dataset. Names kept stable so the current importer and
     the built NDJSON keep working. */
  partCategories: {
    path: 'partCategories',
    key: 'category slug — "combo-display"',
    access: 'public read',
    fields: ['id', 'name', 'short', 'code', 'order', 'groupCount', 'schemaVersion']
  },

  groups: {
    path: 'groups',
    key: 'group id — "cd-0185"',
    access: 'public read — PREVIEW ONLY',
    doc: 'Deliberately excludes partNo and memberIds: those are the paid answer.',
    fields: [
      'groupNo', 'serialNo', 'categoryId', 'categoryName',
      'masterModelId', 'masterModelName', 'masterBrandId',
      'memberCount', 'searchTokens', 'schemaVersion'
    ]
  },

  groupDetails: {
    path: 'groupDetails',
    key: 'same id as /groups',
    access: 'PAID — active subscription required',
    fields: ['groupNo', 'categoryId', 'partNo', 'drawingName', 'memberIds', 'memberNames', 'memberCount', 'schemaVersion']
  },

  deviceGroups: {
    path: 'deviceGroups',
    key: 'canonical device id',
    access: 'PAID — active subscription required',
    doc: 'The hot path. ONE read returns every matching group id per category.',
    fields: ['id', 'byCategory', 'totalGroups', 'schemaVersion']
  },

  /* ------------------------------------------------------------- operations */
  sources: {
    path: 'sources',
    key: 'source slug — "apple-compare-in"',
    access: 'admin read/write only',
    doc: 'Registry of every data source, including its access verdict. The ' +
         'ingestion runner refuses to fetch a source whose allowed flag is false.',
    fields: [
      'id', 'name', 'baseUrl', 'kind',  /* specs | colors | price | discovery   */
      'allowed', 'accessMethod',        /* robots | api | licensed-feed | manual */
      'robotsCheckedAt', 'robotsVerdict', 'licenceUrl', 'attributionRequired',
      'requiresCredentials', 'credentialEnvVar', 'configured',
      'rateLimitPerMin', 'notes', 'updatedAt', 'schemaVersion'
    ]
  },

  importRuns: {
    path: 'importRuns',
    key: 'ISO timestamp + mode — "2026-09-03T12-00-00Z__apple-poc"',
    access: 'admin read/write only',
    doc: 'Audit trail. Every write to the catalogue is attributable to a run.',
    fields: [
      'runId', 'startedAt', 'finishedAt', 'mode', 'dryRun',
      'sourceIds', 'targets',
      'counts',                         /* {created,updated,unchanged,skipped,failed} */
      'reads', 'writes',                /* measured, for cost tracking          */
      'errors', 'notes', 'schemaVersion'
    ]
  },

  updateJobs: {
    path: 'updateJobs',
    key: 'job slug — "price-refresh-daily"',
    access: 'admin read/write only',
    doc: 'Scheduled work. Different fields move at different speeds, so each ' +
         'job has its own cadence — a chipset never changes, a price changes daily.',
    fields: [
      'id', 'type',                     /* discovery | specRefresh | priceRefresh | availabilityRefresh */
      'cadence',                        /* cron expression                      */
      'enabled', 'targetFilter', 'batchSize',
      'lastRunAt', 'lastRunStatus', 'nextRunAt', 'consecutiveFailures',
      'updatedAt', 'schemaVersion'
    ]
  },

  /* ------------------------------------------------------------------ users */
  users: {
    path: 'users',
    key: 'Firebase Auth uid',
    access: 'owner only; subscription fields server-written',
    fields: ['uid', 'email', 'shopName', 'proprietor', 'country', 'mobile', 'address', 'photoUrl', 'location', 'createdAt', 'updatedAt']
  },

  billing: {
    path: 'users/{uid}/billing',
    key: 'fixed: "subscription"',
    access: 'owner read, SERVER WRITE ONLY',
    fields: ['plan', 'status', 'startedAt', 'expiresAt', 'provider', 'providerRef', 'updatedAt']
  }
};

/* ============================================================================
   Canonical identity helpers — the one place a name becomes an id.
   Every adapter must go through these, so a device gets the same id no matter
   which source found it first.
   ========================================================================== */

/* Slug rules learned from the real dataset:
     "+"  must survive as "plus", or "Honor 30 Pro+" collides with "Honor 30 Pro"
     "&"  becomes "and"
   Those two produced 107 silent collisions across 4,933 models before they
   were handled. */
function slug(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* A canonical device id is brand-scoped so two brands may reuse a model name.
   `name` may or may not already start with the brand; both forms give the same
   id, which matters because sources disagree about that. */
function canonicalDeviceId(brand, name) {
  const b = slug(brand);
  let n = slug(name);
  if (b && n.startsWith(b + '-')) n = n.slice(b.length + 1);
  return b && n ? b + '-' + n : (b || n);
}

/* Alias key for the /aliases lookup. Deliberately more aggressive than the
   device slug: it drops the marketing noise sources add and normalises the
   variants that mean the same handset, so "REDMI Note 13 Pro Plus 5G (2024)"
   and "Redmi Note 13 Pro+ 5G" land on the same key. */
function aliasKey(brand, name) {
  let n = String(name == null ? '' : name).toLowerCase();
  n = n.replace(/\((?:[^)]*\b(?:19|20)\d{2}[^)]*)\)/g, ' ');   /* trailing year */
  n = n.replace(/\b(dual|single)\s*sim\b/g, ' ');
  n = n.replace(/\b(global|india|indian|international|china|cn|eu|us)\s+(version|variant|model)\b/g, ' ');
  n = n.replace(/\b\d+\s*gb\b/g, ' ');                          /* storage tags */
  n = n.replace(/\+/g, ' plus ');
  return canonicalDeviceId(brand, n);
}

/* Prefix set for "starts with" queries when a search must run in Firestore
   rather than against the static bundle. Capped so a long name cannot blow up
   the index entry count. */
function searchPrefixes(name, max = 24) {
  const base = slug(name).replace(/-/g, '');
  const out = [];
  for (let i = 2; i <= Math.min(base.length, max); i++) out.push(base.slice(0, i));
  return out;
}

function tokens(name) {
  return Array.from(new Set(slug(name).split('-').filter(t => t.length > 1)));
}

module.exports = {
  SCHEMA_VERSION, CONFIDENCE, DEVICE_STATUS, COLLECTIONS,
  slug, canonicalDeviceId, aliasKey, searchPrefixes, tokens
};

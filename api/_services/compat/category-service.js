/* ============================================================================
   Mobile Parts Finder · api/_services/compat/category-service.js
   ----------------------------------------------------------------------------
   The part categories of Mobile Parts Finder's own compatibility data.

   TWO KINDS, ONE LIST

     site categories      declared in the catalogue build (scripts/build-dataset.js):
                          a part-code prefix, a picture, generated pages. They
                          are code; they cannot be renamed or deleted from here.
     run-time categories  created in the compatibility data itself — by
                          Instagram Intelligence when a post is about a part
                          there is no category for ("camera glass"), or by an
                          administrator. Stored in compatCategories.

   A run-time category is complete in the compatibility data at once: groups
   can be created in it, the one-group-per-model rule holds in it, and the
   admin panel shows it. It is NOT shown on the public site until it is added
   to the build's register — the public lookup serves site categories only
   (entitlement-service) — because a category a shop can browse needs its
   picture and its pages, and those are not data.

   Everything here reads and writes THIS project only.
   ========================================================================== */
'use strict';

const C = require('../../_schema/collections');
const fsx = require('../instagram/firestore');
const taxonomy = require('../taxonomy-service');

class CategoryError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CategoryError';
    this.status = status;
    this.code = code;
  }
}

const col = () => fsx.db().collection(C.COMPAT_CATEGORIES);
const CACHE_MS = 30000;
let loadedAt = 0;
let loadedFor = null;

function slug(name) {
  return String(name || '').toLowerCase().replace(/\+/g, ' plus ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/** A part-code prefix nobody else has: the initials, then other letters of the name. */
function codeFor(name, taken) {
  const words = cleanName(name).toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(' ').filter(Boolean);
  const letters = words.join('');
  const tries = [];
  if (words.length > 1) tries.push(words[0][0] + words[1][0]);
  for (let i = 1; i < letters.length; i++) tries.push(letters[0] + letters[i]);
  if (words.length > 2) tries.push(words[0][0] + words[1][0] + words[2][0]);
  for (let i = 2; i < letters.length; i++) tries.push(letters.slice(0, 2) + letters[i]);
  const ok = tries.find(t => /^[A-Z][A-Z0-9]{1,2}$/.test(t) && !taken.has(t));
  if (!ok) throw new CategoryError(409, 'no-code', `No free part-code prefix could be derived from "${name}".`);
  return ok;
}

/**
 * Reads the run-time categories and registers them with this instance's
 * matcher. One small read, cached for half a minute.
 * @returns {Promise<object[]>} the run-time categories
 */
async function load({ force = false } = {}) {
  const db = fsx.db();
  if (!force && loadedFor === db && Date.now() - loadedAt < CACHE_MS) return dynamicList();
  const snap = await col().limit(200).get();
  const rows = snap.docs.map(d => d.data()).filter(c => c && c.id && c.name && c.status !== 'deleted');
  taxonomy.registerCategories(rows);
  loadedAt = Date.now();
  loadedFor = db;
  return dynamicList();
}

function dynamicList() {
  return Array.from(taxonomy.taxonomy().categories.values()).filter(c => c.dynamic);
}

/** Every category, site and run-time, as the admin panel lists them. */
async function list() {
  await load();
  return Array.from(taxonomy.taxonomy().categories.values()).map(c => ({
    id: c.id, name: c.name, code: c.code || null, groupCount: Number(c.groupCount) || 0,
    kind: c.dynamic ? 'run_time' : 'site', onPublicSite: !c.dynamic, comingSoon: !!c.comingSoon
  }));
}

async function createDoc({ id, name, terms, origin, admin, now, sourceTerm }) {
  await load({ force: true });
  const db = fsx.db();
  const ref = col().doc(id);
  /* every prefix in use — and a prefix a deleted category once used is not
     handed to a different one: its group numbers may still be on a shelf */
  const taken = new Set(Array.from(taxonomy.taxonomy().categories.values()).map(c => c.code).filter(Boolean));
  (await col().limit(200).get()).docs.forEach(d => { if (d.id !== id && d.data().code) taken.add(d.data().code); });
  const out = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.data().status !== 'deleted') return { created: false, category: snap.data() };
    const category = {
      id, name, code: codeFor(name, taken), terms: Array.from(new Set((terms || []).map(t => String(t).toLowerCase().trim()).filter(Boolean))).slice(0, 12),
      status: 'active', origin, sourceTerm: sourceTerm || null, onPublicSite: false, groupCount: 0,
      createdBy: admin.uid, createdAt: now, updatedAt: now
    };
    tx.set(ref, category);
    return { created: true, category };
  });
  await load({ force: true });
  return out;
}

/**
 * The category a post's product belongs in, created if this is the first time
 * it is seen. Only for the part types the matcher lists as creatable — a word
 * nobody listed never becomes a category.
 *
 * @returns {Promise<{created:boolean, category:object}|null>} null when the term is not creatable
 */
async function ensureForTerm(term, { admin, now }) {
  const spec = taxonomy.creatableCategoryFor(term);
  if (!spec) return null;
  await load();
  const have = taxonomy.categoryById(spec.id);
  if (have) return { created: false, category: have };
  return createDoc({ id: spec.id, name: spec.name, terms: spec.terms, origin: 'instagram-intelligence', admin, now, sourceTerm: term });
}

/** An administrator creates a category by name. */
async function create({ name, admin, now }) {
  const clean = cleanName(name);
  const id = slug(clean);
  if (clean.length < 2 || !id) throw new CategoryError(400, 'bad-name', 'A category needs a name.');
  await load({ force: true });
  const clash = Array.from(taxonomy.taxonomy().categories.values())
    .find(c => c.id === id || String(c.name).toLowerCase() === clean.toLowerCase());
  if (clash) throw new CategoryError(409, 'exists', `"${clash.name}" already exists.`);
  /* a name the matcher already maps to a category is that category */
  const mapped = taxonomy.resolveCategory(clean);
  if (mapped.categoryId) throw new CategoryError(409, 'exists', `"${clean}" is already matched to ${taxonomy.categoryById(mapped.categoryId).name}.`);
  const out = await createDoc({ id, name: clean, terms: [clean], origin: 'admin', admin, now });
  return out.category;
}

async function rename({ categoryId, name, admin, now }) {
  const clean = cleanName(name);
  if (clean.length < 2) throw new CategoryError(400, 'bad-name', 'A category needs a name.');
  await load({ force: true });
  const cur = taxonomy.categoryById(categoryId);
  if (!cur) throw new CategoryError(404, 'not-found', 'No such category.');
  if (!cur.dynamic) throw new CategoryError(409, 'site-category', `${cur.name} is one of the site's categories: its name is part of the catalogue build and the public pages, and is changed there.`);
  const clash = Array.from(taxonomy.taxonomy().categories.values()).find(c => c.id !== categoryId && String(c.name).toLowerCase() === clean.toLowerCase());
  if (clash) throw new CategoryError(409, 'exists', `"${clash.name}" already exists.`);
  await col().doc(categoryId).set({ name: clean, updatedAt: now, renamedBy: admin.uid }, { merge: true });
  await load({ force: true });
  return { id: categoryId, previousName: cur.name, name: clean };
}

/** Only an empty run-time category can be removed. Its groups are never deleted with it. */
async function remove({ categoryId, admin, now }) {
  await load({ force: true });
  const cur = taxonomy.categoryById(categoryId);
  if (!cur) throw new CategoryError(404, 'not-found', 'No such category.');
  if (!cur.dynamic) throw new CategoryError(409, 'site-category', `${cur.name} is one of the site's categories and cannot be deleted from here.`);
  const used = await fsx.db().collection(C.GROUPS).where('categoryId', '==', categoryId).limit(1).get();
  if (!used.empty) throw new CategoryError(409, 'not-empty', `${cur.name} still has compatibility groups. Delete or move them first; nothing was changed.`);
  await col().doc(categoryId).set({ status: 'deleted', deletedBy: admin.uid, deletedAt: now, updatedAt: now }, { merge: true });
  await load({ force: true });
  return { id: categoryId, name: cur.name };
}

module.exports = { CategoryError, load, list, ensureForTerm, create, rename, remove, _internal: { codeFor, slug } };

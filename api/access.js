/* ============================================================================
   GET  /api/access               what may this account do right now
   POST /api/access               spend one of the five lifetime free searches
   GET  /api/device-parts         a group's members, cut to the tier
   GET  /api/device-parts?previews=  the free home-feed preview of some groups
   ----------------------------------------------------------------------------
   The enforcement point for the free/paid split. Everything the paywall
   withholds is withheld HERE, on the way out, before the response exists.

   ----------------------------------------------------------------------------
   WHY THESE THREE SHARE A FUNCTION

   Vercel's Hobby plan allows 12 Serverless Functions per deployment. Three
   public GETs were folded into api/public.js to free the slot this occupies,
   and these three endpoints are one concern anyway: they all answer "what is
   this person entitled to".

   ----------------------------------------------------------------------------
   IDENTITY IS OPTIONAL, AND VERIFIED WHEN PRESENT

   A signed-out visitor gets the free view of a group — the same slice a signed
   -in free account gets — because the free tier is what the public site
   already shows and refusing it would only push them to a competitor's site to
   find out what fits.

   What a signed-out visitor CANNOT do is spend a search credit, because there
   is no account to spend it against. Metering a device rather than an account
   would be a limit that clearing cookies resets, which is not a limit.

   ----------------------------------------------------------------------------
   THE TIER COMES FROM FIRESTORE, NEVER FROM THE REQUEST

   There is no field a caller can set to be treated as paid. The uid comes from
   a verified ID token, the subscription state is read from users/{uid} by the
   server, and the member list is sliced before it is serialised. A free
   account asking for a 268-member group receives ten names and the number 258
   — the other 258 names are not in the payload, so there is nothing in the
   network tab, no JavaScript variable and no DOM node to recover them from.
   ========================================================================== */
'use strict';

const { ok, bad, json, fail, unavailable, notAllowed, body } = require('./_lib/http');
const { auth } = require('./_lib/firebase');
const { adminConfigured } = require('./_lib/config');
const entitlements = require('./_services/entitlement-service');
const search = require('./_services/search-service');
const { TIERS } = require('./_schema/entitlement');
const v = require('./_lib/validate');

module.exports = async function handler(req, res) {
  try {
    const section = sectionFrom(req);

    if (section === 'device-parts') return await deviceParts(req, res);
    if (section !== 'access') return json(res, 404, { error: 'no such endpoint' });

    if (req.method === 'GET') return await currentAccess(req, res);
    if (req.method === 'POST') return await spendSearch(req, res);
    return notAllowed(res);
  } catch (err) {
    return fail(res, err, 'access');
  }
};

function sectionFrom(req) {
  const fromQuery = req.query && req.query.section;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const path = String(req.url || '').split('?')[0].replace(/\/+$/, '');
  const match = /\/api\/([A-Za-z0-9_-]+)$/.exec(path);
  return match ? match[1] : '';
}

/**
 * Who is asking.
 *
 * THREE ANSWERS, AND THE THIRD ONE MATTERS.
 *
 *   { uid: null }          no Authorization header: a signed-out visitor, who
 *                          is entitled to the free view
 *   { uid: '...' }         a token Firebase verified
 *   { rejected: '...' }    a token was SENT and could not be verified
 *
 * The third used to be folded into the first. A subscriber whose token had
 * expired between the browser's cache and this function, or whose device
 * clock was out, was answered as an anonymous visitor: HTTP 200, `paid:
 * false`, and a paywall drawn over a plan they had paid for — with nothing in
 * the response to say the server had simply failed to recognise them.
 *
 * "I could not tell who you are" is not "you have not paid". It is a 401, the
 * browser mints a new token and asks again, and nobody is told to buy a
 * subscription they already have.
 *
 * checkRevoked is off: this route grants no money and moves nothing. The worst
 * a just-revoked token achieves is spending its own search credit.
 */
async function resolveUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!match) return { uid: null };
  try {
    const decoded = await auth().verifyIdToken(match[1], false);
    return { uid: decoded.uid };
  } catch (err) {
    /* A configuration fault throws from inside this same try. Reporting THAT
       as a bad token would have every signed-in shop refreshing a token that
       was never the problem; it is re-thrown and answered as the 500/503 it
       is. Only a genuine token failure becomes a 401. */
    if (!err || !String(err.code || '').startsWith('auth/')) throw err;
    if (err.code !== 'auth/id-token-expired') {
      console.warn('[access:auth]', err.code, err.message);
    }
    return { rejected: err.code === 'auth/id-token-expired' ? 'token expired' : 'invalid token' };
  }
}

/** The 401 for a token that was sent and could not be verified. */
function tokenRejected(res, who) {
  return json(res, 401, { error: who.rejected, retry: 'refresh-token' });
}

/* ------------------------------------------------------------- GET /access */

async function currentAccess(req, res) {
  if (!adminConfigured()) {
    return unavailable(res, 'access-unconfigured', { missing: ['FIREBASE_SERVICE_ACCOUNT'] });
  }
  const who = await resolveUser(req);
  if (who.rejected) return tokenRejected(res, who);
  const access = await entitlements.readAccess(who.uid, Date.now());
  return ok(res, access);
}

/* ------------------------------------------------------------ POST /access

   Called when a free user actually RUNS a search — picks a model, presses
   enter on a real result — and never while they are typing.

   That distinction is the client's to make and it makes it in one place: the
   credit is spent in pickModel(), not in the keystroke handler that fetches
   suggestions. Autocomplete is free, and typing "samsung galaxy m21" costs
   nothing.

   The body names the model: { modelId }. It is what makes a repeat free — the
   same model a second time, after a reload, a retry or a double tap, is the
   same search, and entitlement-service charges it once. A model id the
   catalogue does not know is refused rather than charged: a typo in a crafted
   request must not spend the account's allowance, and an unknown id can never
   return a result anyway. A body with no model id at all (a browser from
   before this change) is charged as a new search every time, which is the
   cautious direction. */

async function spendSearch(req, res) {
  if (!adminConfigured()) {
    return unavailable(res, 'access-unconfigured', { missing: ['FIREBASE_SERVICE_ACCOUNT'] });
  }

  const who = await resolveUser(req);
  if (who.rejected) return tokenRejected(res, who);
  const uid = who.uid;
  if (!uid) {
    /* 401 rather than a silent allow. A search that cannot be metered must not
       be waved through — that is the bypass this whole route exists to close. */
    return json(res, 401, {
      error: 'sign-in required',
      access: await entitlements.readAccess(null, Date.now())
    });
  }

  const requested = body(req).modelId;
  let modelId = null;
  if (requested !== undefined && requested !== null && requested !== '') {
    modelId = v.docId(requested, 80);
    if (!modelId || !search.loadIndex().byId.has(modelId)) return bad(res, 'unknown modelId');
  }

  const { allowed, charged, access } = await entitlements.consumeSearch(uid, Date.now(), modelId);

  if (!allowed) {
    /* 429, and the current state alongside it so the client can render the
       upgrade prompt from one response rather than asking again. */
    return json(res, 429, { error: 'free-search-limit', access });
  }
  return ok(res, { allowed: true, charged, access });
}

/* ------------------------------------------------- GET /api/device-parts

   The paid half of the catalogue. Two shapes:

     ?groupId=sg-0001   one compatibility group
     ?modelId=realme-5  every group that fits one device

   Both come back cut to the caller's tier.

   And one free one:

     ?previews=sg-0001,bc-0627,…   up to PREVIEW_MAX groups' previews

   The home feed's model names. Identity is not asked for and not used: the
   preview is the same for everyone, so the answer may be cached at the edge
   for a few minutes and most feed loads never reach Firestore at all. */
const PREVIEW_MAX = 48;

async function deviceParts(req, res) {
  if (req.method !== 'GET') return notAllowed(res);
  if (!adminConfigured()) {
    return unavailable(res, 'access-unconfigured', { missing: ['FIREBASE_SERVICE_ACCOUNT'] });
  }

  const query = req.query || {};
  if (query.previews !== undefined) return groupPreviews(query.previews, res);

  const groupId = v.docId(query.groupId, 60);
  const modelId = v.docId(query.modelId, 80);
  if (!groupId && !modelId) return bad(res, 'groupId or modelId is required');

  const now = Date.now();
  const who = await resolveUser(req);
  /* Refused, not downgraded. Answering a subscriber's unverifiable token with
     the free slice would send them `requiresPlan: true` for a group they have
     paid to open. */
  if (who.rejected) return tokenRejected(res, who);
  const access = await entitlements.readAccess(who.uid, now);
  const tier = access.paid ? TIERS.PAID : TIERS.FREE;

  if (groupId) {
    const group = await entitlements.groupForUser(groupId, tier);
    if (!group) return json(res, 404, { error: 'no such group' });
    return ok(res, { group, access });
  }

  const device = await entitlements.deviceGroupsForUser(modelId, tier);
  if (!device) return json(res, 404, { error: 'no such model' });
  return ok(res, { device, access });
}

/* -------------------------------------------- GET /api/device-parts?previews */

async function groupPreviews(raw, res) {
  const ids = String(raw || '').split(',')
    .map(id => v.docId(id.trim(), 60))
    .filter(Boolean);
  const unique = Array.from(new Set(ids));
  if (!unique.length) return bad(res, 'previews needs at least one group id');
  if (unique.length > PREVIEW_MAX) return bad(res, 'at most ' + PREVIEW_MAX + ' groups per request');

  const previews = await entitlements.groupPreviews(unique);
  /* public: the same bytes for every caller. s-maxage lets Vercel's edge
     answer repeat feed loads; a group edited in Compatibility Management
     shows its new preview within ten minutes. */
  return json(res, 200, { previews }, 'public, max-age=60, s-maxage=600, stale-while-revalidate=600');
}

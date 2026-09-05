/* ============================================================================
   GET  /api/access               what may this account do right now
   POST /api/access               spend one free search
   GET  /api/device-parts         a group's members, cut to the tier
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

const { ok, bad, json, fail, unavailable, notAllowed } = require('./_lib/http');
const { auth } = require('./_lib/firebase');
const { adminConfigured } = require('./_lib/config');
const entitlements = require('./_services/entitlement-service');
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
 * The uid behind a request, or null.
 *
 * checkRevoked is off: this route grants no money and moves nothing. The worst
 * a just-revoked token achieves is spending its own search credit.
 */
async function resolveUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!match) return null;
  try {
    const decoded = await auth().verifyIdToken(match[1], false);
    return decoded.uid;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- GET /access */

async function currentAccess(req, res) {
  if (!adminConfigured()) {
    return unavailable(res, 'access-unconfigured', { missing: ['FIREBASE_SERVICE_ACCOUNT'] });
  }
  const uid = await resolveUser(req);
  const access = await entitlements.readAccess(uid, Date.now());
  return ok(res, access);
}

/* ------------------------------------------------------------ POST /access

   Called when a free user actually RUNS a search — picks a model, presses
   enter on a real result — and never while they are typing.

   That distinction is the client's to make and it makes it in one place: the
   credit is spent in pickModel(), not in the keystroke handler that fetches
   suggestions. Autocomplete is free, and typing "samsung galaxy m21" costs
   nothing. This route simply meters what it is told, once per call. */

async function spendSearch(req, res) {
  if (!adminConfigured()) {
    return unavailable(res, 'access-unconfigured', { missing: ['FIREBASE_SERVICE_ACCOUNT'] });
  }

  const uid = await resolveUser(req);
  if (!uid) {
    /* 401 rather than a silent allow. A search that cannot be metered must not
       be waved through — that is the bypass this whole route exists to close. */
    return json(res, 401, {
      error: 'sign-in required',
      access: await entitlements.readAccess(null, Date.now())
    });
  }

  const { allowed, access } = await entitlements.consumeSearch(uid, Date.now());

  if (!allowed) {
    /* 429, and the current state alongside it so the client can render the
       upgrade prompt from one response rather than asking again. */
    return json(res, 429, { error: 'daily-search-limit', access });
  }
  return ok(res, { allowed: true, access });
}

/* ------------------------------------------------- GET /api/device-parts

   The paid half of the catalogue. Two shapes:

     ?groupId=sg-0001   one compatibility group
     ?modelId=realme-5  every group that fits one device

   Both come back cut to the caller's tier. */

async function deviceParts(req, res) {
  if (req.method !== 'GET') return notAllowed(res);
  if (!adminConfigured()) {
    return unavailable(res, 'access-unconfigured', { missing: ['FIREBASE_SERVICE_ACCOUNT'] });
  }

  const query = req.query || {};
  const groupId = v.docId(query.groupId, 60);
  const modelId = v.docId(query.modelId, 80);
  if (!groupId && !modelId) return bad(res, 'groupId or modelId is required');

  const now = Date.now();
  const uid = await resolveUser(req);
  const access = await entitlements.readAccess(uid, now);
  const tier = access.paid ? TIERS.PAID : TIERS.FREE;

  if (groupId) {
    const group = entitlements.groupForUser(groupId, tier);
    if (!group) return json(res, 404, { error: 'no such group' });
    return ok(res, { group, access });
  }

  const device = entitlements.deviceGroupsForUser(modelId, tier);
  if (!device) return json(res, 404, { error: 'no such model' });
  return ok(res, { device, access });
}

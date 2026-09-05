/* ============================================================================
   Mobile Parts Finder · api/_lib/admin-auth.js
   ----------------------------------------------------------------------------
   The gate on every admin route. Nothing reaches admin data without passing
   through requireAdmin() or requirePermission() here.

   ----------------------------------------------------------------------------
   WHAT AN ADMIN IS, AND WHERE THAT IS DECIDED

   Not a URL. Not a flag in localStorage. Not a value the browser sends. An
   admin is:

     · the OWNER — the Google account named by OWNER_EMAIL in _schema/roles.js,
       recognised by the verified `email` claim on their Firebase ID token; or
     · only while OWNER_ONLY is false, an account with a role in
       adminUsers/{uid} that the owner granted

   and the check happens on the server, on every single request.

   OWNER_ONLY IS TRUE, so today the owner is the ONLY identity with access. A
   registry document grants nothing, a custom claim grants nothing, and there
   is no path by which an account gives itself either.

   The frontend's part in this is to render what the server sent it. It cannot
   grant itself anything, because the admin collections are `allow read: if
   false` in firestore.rules — a browser holding a valid ID token for a normal
   user cannot read one document of admin data even with the SDK open in the
   console. The only door is /api/admin/*, and this file is the lock on it.

   ----------------------------------------------------------------------------
   WHY THE OWNER CHECK IS AN EMAIL, AND WHY THAT IS SOUND

   `decoded.email` is a claim on a token Firebase has just verified against
   Google's signing keys. It is what GOOGLE asserts this person's address is —
   not a string the client chose. There is no request field, header, query
   parameter or storage key a caller can set to influence it.

   `email_verified` is required alongside it. Google sign-in always sets it, so
   it costs the owner nothing; what it stops is an account created through some
   future password or custom provider asserting the owner's address without
   ever proving control of the mailbox.

   The owner check needs NO Firestore document. That is deliberate: the owner
   cannot be locked out of their own backend by a missing record, a failed
   write, or a revocation gone wrong.

   ----------------------------------------------------------------------------
   THE REGISTRY PATH (dormant while OWNER_ONLY is true)

     1. The custom claim on the ID token. Free — it arrives with the request —
        and it rejects unauthorised calls without touching Firestore.

     2. adminUsers/{uid}. The authority, read on every request that got past
        (1), which makes a revocation take effect immediately rather than when
        the token expires an hour later.

   A REGISTRY DOCUMENT WITH `disabled: true`, OR NO DOCUMENT AT ALL, IS NOT AN
   ADMIN — whatever the token claims.

   ----------------------------------------------------------------------------
   NO CREDENTIALS ANYWHERE

   There is no admin password and no shared secret. OWNER_EMAIL is an address,
   not a credential: knowing it grants nothing, because access requires a
   Google sign-in AS that account, verified by Firebase, on every request. The
   frontend has never held a credential and cannot start.
   ========================================================================== */
'use strict';

const { db, auth } = require('./firebase');
const { forbidden, unauthorised } = require('./http');
const { ADMIN_USERS } = require('../_schema/collections');
const {
  ROLES, OWNER_ONLY, isOwnerEmail,
  normaliseRole, isStaff, can, permissionsFor
} = require('../_schema/roles');

/** The custom-claim key. One name, used by the granter and by the check. */
const ROLE_CLAIM = 'role';

/**
 * Resolves the caller and their role.
 *
 * Returns null and sends the reply when the caller is not staff, so a route
 * body is `const admin = await requireAdmin(req, res); if (!admin) return;`
 * and cannot accidentally continue.
 *
 * @returns {Promise<null|{uid:string,email:string|null,role:string,permissions:string[],name:string|null}>}
 */
async function requireAdmin(req, res) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!match) { unauthorised(res); return null; }

  let decoded;
  try {
    /* checkRevoked: an admin whose sessions were revoked after a compromise
       must not keep working from a token that has not expired yet. */
    decoded = await auth().verifyIdToken(match[1], true);
  } catch (err) {
    /* A configuration failure throws from inside this same try, and reporting
       THAT as "invalid token" sends whoever reads the log hunting a token
       problem when the real fault is an unset service account. Re-thrown so
       the route answers 500 with the real cause. */
    if (!err || !String(err.code || '').startsWith('auth/')) throw err;
    unauthorised(res, err.code === 'auth/id-token-expired' ? 'token expired' : 'invalid token');
    return null;
  }

  /* ---- check 0: is this the owner? ----------------------------------------

     The owner's authority comes from their Google identity and nothing else.
     `decoded.email` is a claim on a token Firebase has just cryptographically
     verified — it is what GOOGLE says this person's address is, not what the
     browser claims. There is no request field a caller can set to reach this
     branch.

     `email_verified` is required as well. With Google sign-in it is always
     true, so this costs the owner nothing; what it prevents is an account
     created through some future password or custom provider asserting the
     owner's address without ever proving control of the mailbox.

     Checked FIRST, and it needs no registry document. That is deliberate: the
     owner can never be locked out of their own backend by a missing record, a
     failed write, or a revocation gone wrong. */
  if (isOwnerEmail(decoded.email) && decoded.email_verified === true) {
    return {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name || null,
      role: ROLES.SUPER_ADMIN,
      permissions: permissionsFor(ROLES.SUPER_ADMIN),
      isOwner: true,
      /* The owner's access does not depend on a claim, so a claim that has not
         caught up is not stale in any way that matters. */
      claimStale: false
    };
  }

  /* ---- owner-only mode ends here -----------------------------------------

     While OWNER_ONLY is true the owner is the ONLY identity with admin access.
     The registry is not consulted, so a document in adminUsers grants nothing
     and a stale custom claim on somebody's token grants nothing either.

     The refusal is identical to every other refusal below — same status, same
     body — so nobody can tell from the outside whether they were rejected for
     not being the owner, for not being in the registry, or for being disabled.
     A different message per reason is an oracle for enumerating who the
     administrators are. */
  if (OWNER_ONLY) {
    logDenied(decoded.uid, 'not the owner account (owner-only mode)');
    forbidden(res, 'not authorised');
    return null;
  }

  /* ---- check 1: the claim. Cheap, and it ends most unauthorised calls. ---- */
  const claimedRole = normaliseRole(decoded[ROLE_CLAIM]);
  if (!isStaff(claimedRole)) {
    /* Deliberately the same 403 and the same body a disabled admin gets. A
       different message here would let anyone with an account enumerate who
       the administrators are by watching which response they get. */
    logDenied(decoded.uid, 'no staff claim');
    forbidden(res, 'not authorised');
    return null;
  }

  /* ---- check 2: the registry. The authority, and where revocation bites. -- */
  const snap = await db().collection(ADMIN_USERS).doc(decoded.uid).get();
  if (!snap.exists) {
    logDenied(decoded.uid, 'claim present but no registry record');
    forbidden(res, 'not authorised');
    return null;
  }

  const record = snap.data() || {};
  if (record.disabled === true) {
    logDenied(decoded.uid, 'registry record disabled');
    forbidden(res, 'not authorised');
    return null;
  }

  const role = normaliseRole(record.role);
  if (!isStaff(role)) {
    logDenied(decoded.uid, 'registry role is not staff');
    forbidden(res, 'not authorised');
    return null;
  }

  return {
    uid: decoded.uid,
    email: decoded.email || record.email || null,
    name: decoded.name || record.displayName || null,
    role,
    permissions: permissionsFor(role),
    isOwner: false,
    /* True when the token's claim and the registry disagree — the admin should
       refresh their token. Reported rather than fixed silently so a stale
       claim is visible instead of mysterious. */
    claimStale: claimedRole !== role
  };
}

/**
 * requireAdmin, plus one permission.
 *
 * @param {string} permission from _schema/roles PERMISSIONS
 */
async function requirePermission(req, res, permission) {
  const admin = await requireAdmin(req, res);
  if (!admin) return null;
  if (!can(admin.role, permission)) {
    console.warn('[admin:auth] denied', { uid: admin.uid, role: admin.role, permission });
    forbidden(res, 'not authorised for this action');
    return null;
  }
  return admin;
}

/* Denials are logged with the uid and never with the token. Someone probing
   the admin API should leave a trail; the trail should not contain a
   credential. */
function logDenied(uid, reason) {
  console.warn('[admin:auth] denied', { uid: uid || null, reason });
}

/**
 * Writes a role.
 *
 * Both halves, in an order chosen so a crash between them fails SAFE:
 *
 *   granting  — registry first, then the claim. A crash leaves a registry
 *               record whose token has no claim: the person cannot get in
 *               until their claim is set, which is a broken grant, not a
 *               security hole.
 *   revoking  — claim first, then the registry. A crash leaves a registry
 *               record with no claim: again, locked out rather than let in.
 *
 * Either way the failure mode is "an admin cannot log in", which someone will
 * report in a minute, rather than "someone can log in who should not", which
 * nobody reports at all.
 *
 * @param {object} args
 * @param {string} args.uid          the account being changed
 * @param {string} args.role         from ROLE_LIST
 * @param {string} args.grantedBy    the acting admin's uid
 * @param {number} args.now
 * @param {object|null} [args.identity]  email / displayName for the registry row
 */
async function setRole({ uid, role, grantedBy, now, identity }) {
  const nextRole = normaliseRole(role);
  const ref = db().collection(ADMIN_USERS).doc(uid);
  const revoking = !isStaff(nextRole);

  const claimPayload = revoking ? { [ROLE_CLAIM]: null } : { [ROLE_CLAIM]: nextRole };

  /* Merge rather than set: a custom-claims object is replaced wholesale by
     setCustomUserClaims, so anything else living there would be wiped. Read
     what is there, change one key, write it back. */
  const existing = await auth().getUser(uid);
  const claims = Object.assign({}, existing.customClaims || {});
  if (revoking) delete claims[ROLE_CLAIM];
  else claims[ROLE_CLAIM] = nextRole;

  if (revoking) {
    await auth().setCustomUserClaims(uid, claims);
    await ref.set({
      uid,
      role: nextRole,
      disabled: true,
      revokedAt: now,
      revokedBy: grantedBy,
      updatedAt: now
    }, { merge: true });
  } else {
    await ref.set({
      uid,
      role: nextRole,
      disabled: false,
      email: (identity && identity.email) || existing.email || null,
      displayName: (identity && identity.displayName) || existing.displayName || null,
      grantedBy,
      grantedAt: now,
      updatedAt: now,
      revokedAt: null,
      revokedBy: null
    }, { merge: true });
    await auth().setCustomUserClaims(uid, claims);
  }

  /* The claim is baked into tokens that are already out there. Revoking
     refresh tokens forces the browser to obtain a new ID token, which is the
     only way a role change takes effect immediately rather than within the
     hour. The registry check above covers the gap either way. */
  await auth().revokeRefreshTokens(uid);

  return { uid, role: nextRole, disabled: revoking };
}

/** Everyone with a registry record, whether enabled or not. */
async function listAdmins() {
  const snap = await db().collection(ADMIN_USERS).get();
  return snap.docs.map(d => {
    const r = d.data() || {};
    return {
      uid: d.id,
      role: normaliseRole(r.role),
      disabled: r.disabled === true,
      email: r.email || null,
      displayName: r.displayName || null,
      grantedBy: r.grantedBy || null,
      grantedAt: r.grantedAt ?? null,
      revokedAt: r.revokedAt ?? null,
      updatedAt: r.updatedAt ?? null
    };
  });
}

/** The role for a uid, without any HTTP involvement. Used by scripts. */
async function roleFor(uid) {
  const snap = await db().collection(ADMIN_USERS).doc(uid).get();
  if (!snap.exists) return 'user';
  const r = snap.data() || {};
  if (r.disabled === true) return 'user';
  return normaliseRole(r.role);
}

module.exports = { ROLE_CLAIM, requireAdmin, requirePermission, setRole, listAdmins, roleFor };

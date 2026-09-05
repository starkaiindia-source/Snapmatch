/* ============================================================================
   GET  /api/admin/admins     who has access
   POST /api/admin/admins     grant or revoke a role
   ----------------------------------------------------------------------------
   Role management. super_admin only for writes, and it holds two rules that
   exist to stop an account locking everyone out.

   ----------------------------------------------------------------------------
   RULE 1: YOU CANNOT CHANGE YOUR OWN ROLE

   Not even to a higher one — there is no higher one — and especially not to a
   lower one. A super_admin who demotes themselves by mistake has locked the
   business out of its own backend, recoverable only from the command line with
   the service-account key. The refusal costs nothing: another super_admin can
   do it, and if there is only one, that is what rule 2 is about.

   ----------------------------------------------------------------------------
   RULE 2: THE LAST SUPER_ADMIN CANNOT BE REMOVED

   Checked against the registry at the moment of the write. Without it, two
   admins revoking each other simultaneously ends with nobody, and the only way
   back is scripts/grant-admin.js on a machine with the key.

   ----------------------------------------------------------------------------
   GRANTING BY EMAIL, NOT BY UID

   Nobody knows anyone's Firebase uid. The route resolves an email through
   Firebase Authentication — which means the person must already have signed in
   at least once, and that is correct: an admin role is granted to an account
   that exists, not to an address that might one day become one.
   ========================================================================== */
'use strict';

const { requirePermission, setRole, listAdmins } = require('../_lib/admin-auth');
const { PERMISSIONS, ROLE_LIST, ROLES, OWNER_EMAIL, OWNER_ONLY, isStaff, isOwnerEmail } =
  require('../_schema/roles');
const { ok, bad, json, fail, notAllowed } = require('../_lib/http');
const { auth } = require('../_lib/firebase');
const audit = require('../_services/audit-service');
const v = require('../_lib/validate');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await list(req, res);
    if (req.method === 'POST') return await change(req, res);
    return notAllowed(res);
  } catch (err) {
    return fail(res, err, 'admin-admins');
  }
};

async function list(req, res) {
  const admin = await requirePermission(req, res, PERMISSIONS.ADMINS_READ);
  if (!admin) return;

  const admins = await listAdmins();
  return ok(res, {
    admins: admins.sort((a, b) => (b.grantedAt || 0) - (a.grantedAt || 0)),
    roles: ROLE_LIST,
    /* The owner has no registry row — their access comes from their Google
       identity — so without this the Settings page would show an empty list to
       the very person reading it, which reads as "nobody has access". */
    owner: { email: OWNER_EMAIL, role: ROLES.SUPER_ADMIN },
    ownerOnly: OWNER_ONLY,
    serverTime: Date.now()
  });
}

async function change(req, res) {
  const admin = await requirePermission(req, res, PERMISSIONS.ADMINS_WRITE);
  if (!admin) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const role = v.oneOf(body.role, ROLE_LIST, null);
  if (!role) return bad(res, 'role must be one of: ' + ROLE_LIST.join(', '));

  /* While the backend is owner-only, a granted role would be written and then
     ignored by every request — requireAdmin does not consult the registry at
     all. Handing someone a role that does nothing is worse than refusing:
     they would be told they have access, find they do not, and there would be
     a document implying otherwise for the next person reading the database.

     Revocation stays available, so a role granted before the switch can still
     be cleaned up. */
  if (OWNER_ONLY && isStaff(role)) {
    return json(res, 409, {
      error: 'owner-only mode',
      detail: 'This backend is restricted to the owner account. Set OWNER_ONLY to ' +
              'false in api/_schema/roles.js to enable staff roles.'
    });
  }

  /* Resolve the target. Either an email (the usual way) or an explicit uid. */
  let targetUid = v.uid(body.uid);
  let targetRecord = null;

  if (!targetUid) {
    const email = v.email(body.email);
    if (!email) return bad(res, 'an email address or uid is required');
    try {
      targetRecord = await auth().getUserByEmail(email);
      targetUid = targetRecord.uid;
    } catch (err) {
      if (err && err.code === 'auth/user-not-found') {
        return json(res, 404, {
          error: 'no account with that email',
          /* The actionable half. Nobody can be made an admin before they have
             an account, and this says how to get one. */
          detail: 'Ask them to sign in to the site with Google once, then try again.'
        });
      }
      throw err;
    }
  } else {
    /* Resolved HERE rather than further down, because the owner check below
       reads targetRecord.email. Leaving it until after that check would mean a
       request naming the owner by uid instead of email had a null record to
       compare against and walked straight past the guard. */
    targetRecord = await auth().getUser(targetUid).catch(() => null);
    if (!targetRecord) return json(res, 404, { error: 'no such account' });
  }

  if (targetUid === admin.uid) {
    return json(res, 409, {
      error: 'you cannot change your own role',
      detail: 'Ask another super_admin, or use scripts/grant-admin.js on a machine ' +
              'that holds the service-account key.'
    });
  }

  /* The owner's access comes from their Google identity, not from a registry
     row, so writing one for them would achieve nothing while implying they had
     been demoted. Refuse plainly rather than accepting a write that lies.

     Resolved from Firebase Authentication rather than from the request, so
     naming the owner by uid instead of email does not slip past. */
  if (isOwnerEmail(targetRecord && targetRecord.email)) {
    return json(res, 409, {
      error: 'the owner account cannot be changed here',
      detail: `${OWNER_EMAIL} owns this backend. Its access comes from the Google ` +
              'account itself and is set in api/_schema/roles.js, not in this list.'
    });
  }

  /* Rule 2, checked against the registry as it stands right now.
     Only moves AWAY from super_admin can reduce the count, so promoting
     someone to super_admin skips this entirely. */
  if (role !== ROLES.SUPER_ADMIN) {
    const admins = await listAdmins();
    const supers = admins.filter(a => a.role === ROLES.SUPER_ADMIN && !a.disabled);
    const removingASuper = supers.some(a => a.uid === targetUid);
    if (removingASuper && supers.length <= 1) {
      return json(res, 409, {
        error: 'this is the last super_admin',
        detail: 'Grant super_admin to another account first.'
      });
    }
  }

  const now = Date.now();
  const result = await setRole({
    uid: targetUid,
    role,
    grantedBy: admin.uid,
    now,
    identity: { email: targetRecord.email, displayName: targetRecord.displayName }
  });

  audit.record({
    actorUid: admin.uid,
    actorRole: admin.role,
    action: isStaff(role) ? audit.ACTIONS.ADMIN_GRANTED : audit.ACTIONS.ADMIN_REVOKED,
    targetType: 'admin',
    targetId: targetUid,
    detail: { role, email: targetRecord.email || null },
    now
  });

  return ok(res, {
    ...result,
    email: targetRecord.email || null,
    /* setRole revokes refresh tokens, so the affected person is signed out of
       the admin area on their next request rather than within the hour. */
    note: 'The account must sign in again for the new role to appear on its token.'
  });
}

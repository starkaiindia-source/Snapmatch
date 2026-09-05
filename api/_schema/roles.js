/* ============================================================================
   Mobile Parts Finder · api/_schema/roles.js
   ----------------------------------------------------------------------------
   Who may do what. One table, no exceptions elsewhere.

   ----------------------------------------------------------------------------
   ROLES

     super_admin   everything, including granting and revoking other admins
     admin         all business data and all approval actions; no role changes
     support       read users and subscriptions; may not see revenue totals
     analyst       read aggregate analytics; no individual user records
     user          the default, and the only role a customer ever has

   `user` exists in the list deliberately. Every account has a role, and the
   absence of one means `user` — not "unknown", not "check somewhere else".

   ----------------------------------------------------------------------------
   PERMISSIONS, NOT ROLE CHECKS

   Routes ask `can(role, 'users.read')`, never `role === 'admin'`. The
   difference matters the first time a fifth role is added: with permission
   names, that is one row in this table; with role comparisons scattered
   through twenty routes, it is twenty edits and one you will miss.

   ----------------------------------------------------------------------------
   WHERE THE ROLE ACTUALLY LIVES

   Two places, deliberately, and the routes check BOTH:

     1. a Firebase Auth custom claim on the ID token — fast, no read, and it is
        what makes an unauthorised request cost nothing
     2. adminUsers/{uid} in Firestore — the registry, and the authority

   The claim alone is not enough: a token stays valid for up to an hour after
   the claim is removed, so revoking an admin would not take effect until it
   expired. The registry alone is not enough either: it would put a Firestore
   read in front of every request including the ones from people who are not
   admins at all. So the claim gates cheaply and the registry decides, and a
   revocation takes effect on the next request.

   NOTHING ABOUT THIS LIVES IN THE FRONTEND. The admin UI asks the server what
   it is allowed to see; it never decides for itself, and hiding a button is
   not a security control.
   ========================================================================== */
'use strict';

/* ----------------------------------------------------------------- owner

   THE OWNER ACCOUNT

   One Google account owns this business and its backend. It is named here, in
   ONE place, server side, and it is the only identity that grants admin access
   while OWNER_ONLY is true.

   Why an email rather than a uid: a uid is unreadable, unmemorable, and cannot
   be checked by whoever is reading this file to confirm it is right. The email
   is verified by Google on every sign-in and arrives on the ID token as a
   signed claim — so comparing against it is comparing against something Google
   asserted, not something a browser sent.

   The comparison is normalised (trimmed, lower-cased) because Google returns
   the address in whatever case the account was created with, and
   "Stark.ai.India@gmail.com" and "stark.ai.india@gmail.com" are the same
   mailbox. The stored constant keeps its readable form; only the comparison is
   folded.

   It is NOT a secret and NOT a credential. Knowing the owner's email address
   grants nothing: access requires a Google sign-in as that account, verified
   by Firebase, on every single request. */
const OWNER_EMAIL = 'Stark.ai.India@gmail.com';

/**
 * OWNER-ONLY MODE
 *
 * true  — the owner account is the ONLY identity with admin access. The
 *         adminUsers registry is not consulted for access at all, so a record
 *         in it grants nothing. This is the current, deliberate state.
 *
 * false — the registry is consulted as well, which is how support and analyst
 *         accounts would be added later. Only the owner can ever create one
 *         (granting needs admins.write, which only super_admin holds, and the
 *         owner is the only super_admin), so even then nobody can self-assign.
 *
 * One flag, one place, and the routes read it rather than deciding for
 * themselves — a second copy of this decision is how one route stays open
 * after the other is closed.
 */
const OWNER_ONLY = true;

/** Trimmed and lower-cased. Anything that is not a string becomes ''. */
function normaliseEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Is this the owner's address?
 *
 * Callers must only ever pass an email that came from a VERIFIED ID token.
 * An address from a request body, a query string or a client-side variable
 * proves nothing — anyone can type the owner's email into a JSON payload.
 */
function isOwnerEmail(email) {
  const candidate = normaliseEmail(email);
  return candidate !== '' && candidate === normaliseEmail(OWNER_EMAIL);
}

const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  SUPPORT: 'support',
  ANALYST: 'analyst',
  USER: 'user'
};

const ROLE_LIST = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPPORT, ROLES.ANALYST, ROLES.USER];

/** Roles that may open the admin area at all. */
const STAFF_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN, ROLES.SUPPORT, ROLES.ANALYST];

/**
 * Every permission the backend recognises.
 *
 * Named after what they let you do, not after the page they appear on: a page
 * can be redesigned, but "may read an individual user's record" is a stable
 * fact about the system.
 */
const PERMISSIONS = {
  /* users */
  USERS_READ: 'users.read',                 /* list and open individual users */
  USERS_READ_CONTACT: 'users.read_contact', /* phone number and address — PII */
  USERS_WRITE: 'users.write',               /* change account status */

  /* money */
  BILLING_READ: 'billing.read',             /* subscriptions and payment history */
  REVENUE_READ: 'revenue.read',             /* totals, ARPU, revenue charts */

  /* product */
  ANALYTICS_READ: 'analytics.read',
  MISSING_MODELS_READ: 'missing_models.read',
  MISSING_MODELS_WRITE: 'missing_models.write',   /* move through the workflow */
  MISSING_MODELS_PUBLISH: 'missing_models.publish', /* the one that changes the catalogue */

  /* AI */
  AI_READ: 'ai.read',
  AI_RUN: 'ai.run',                         /* ask the gateway for a draft */
  AI_APPROVE: 'ai.approve',                 /* accept a draft into production */

  /* operations */
  AUDIT_READ: 'audit.read',
  ADMINS_READ: 'admins.read',
  ADMINS_WRITE: 'admins.write'              /* grant and revoke roles */
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

/**
 * The table.
 *
 * `support` sees who a customer is and what they bought so they can answer a
 * question about it, and does not see revenue totals — those are a business
 * figure rather than a support tool.
 *
 * `analyst` is the mirror image: aggregate numbers including revenue, and no
 * individual user records at all. That split is what lets an analytics
 * contractor be given access without being given the customer list.
 */
const ROLE_PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: ALL_PERMISSIONS,

  [ROLES.ADMIN]: [
    PERMISSIONS.USERS_READ, PERMISSIONS.USERS_READ_CONTACT, PERMISSIONS.USERS_WRITE,
    PERMISSIONS.BILLING_READ, PERMISSIONS.REVENUE_READ,
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.MISSING_MODELS_READ, PERMISSIONS.MISSING_MODELS_WRITE,
    PERMISSIONS.MISSING_MODELS_PUBLISH,
    PERMISSIONS.AI_READ, PERMISSIONS.AI_RUN, PERMISSIONS.AI_APPROVE,
    PERMISSIONS.AUDIT_READ, PERMISSIONS.ADMINS_READ
  ],

  [ROLES.SUPPORT]: [
    PERMISSIONS.USERS_READ, PERMISSIONS.USERS_READ_CONTACT,
    PERMISSIONS.BILLING_READ,
    PERMISSIONS.MISSING_MODELS_READ
  ],

  [ROLES.ANALYST]: [
    PERMISSIONS.ANALYTICS_READ,
    PERMISSIONS.REVENUE_READ,
    PERMISSIONS.MISSING_MODELS_READ
  ],

  [ROLES.USER]: []
};

/** Unknown or absent is `user`, never a staff role. Fails closed. */
function normaliseRole(role) {
  return ROLE_LIST.indexOf(role) > -1 ? role : ROLES.USER;
}

/** @returns {boolean} */
function can(role, permission) {
  const list = ROLE_PERMISSIONS[normaliseRole(role)];
  return Array.isArray(list) && list.indexOf(permission) > -1;
}

/** @returns {boolean} may this role open the admin area at all? */
function isStaff(role) {
  return STAFF_ROLES.indexOf(normaliseRole(role)) > -1;
}

/**
 * What the admin UI is told about itself.
 *
 * Sent to the browser so it can hide what this person cannot use — a
 * convenience, not a control. Every route re-checks the same permission
 * server-side, so a hand-edited response buys nothing but a page full of
 * buttons that return 403.
 */
function permissionsFor(role) {
  return (ROLE_PERMISSIONS[normaliseRole(role)] || []).slice();
}

module.exports = {
  OWNER_EMAIL, OWNER_ONLY, normaliseEmail, isOwnerEmail,
  ROLES, ROLE_LIST, STAFF_ROLES,
  PERMISSIONS, ALL_PERMISSIONS, ROLE_PERMISSIONS,
  normaliseRole, can, isStaff, permissionsFor
};

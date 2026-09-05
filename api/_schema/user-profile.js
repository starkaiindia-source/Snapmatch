/* ============================================================================
   Mobile Parts Finder · api/_schema/user-profile.js
   ----------------------------------------------------------------------------
   The single definition of what a user IS, and what state they are in.

   ----------------------------------------------------------------------------
   TWO SOURCES, ONE RECORD, NO THIRD COPY

   Firebase Authentication owns          users/{uid} owns
     uid                                   mobileShopName
     the sign-in provider                  proprietorName
     the authenticated email               mobileNumber, mobileNumberE164
     emailVerified                         country, countryCode
     creation / last-sign-in times         address
     disabled                              profilePhotoURL
                                           the server-written subscription mirror

   Nothing else stores a user profile. The admin area reads exactly these two
   and joins them by uid; it does not keep an "admin users" table of its own,
   because a second copy is a copy that goes stale.

   ----------------------------------------------------------------------------
   PROFILE COMPLETION — WHAT IS ACTUALLY MANDATORY

   Three business facts, and only three:

     1. mobile number, with the country it belongs to
     2. mobile shop name
     3. proprietor name

   `country` is not a fourth requirement. It is the country-selection half of
   requirement 1 — a bare "9876543210" is not a number anyone can dial, and
   Razorpay Checkout cannot prefill it without the dial code. It is required
   for that reason and no other.

   ADDRESS IS OPTIONAL, permanently. City, district and state are useful for
   business analytics and worthless as a gate. A returning shop with a complete
   profile and a blank address is a COMPLETE profile, and any code that treats
   it as a new user is wrong.

   ----------------------------------------------------------------------------
   THE STATE MODEL

   Three axes that cannot contradict each other, because they answer different
   questions and are derived from different fields:

     accountState        where this user is in onboarding
       profile_incomplete   signed in, missing one of the three business facts
       profile_complete     has all three
       (not being signed in means having no record here at all, so
        `authenticated` is the precondition of both rather than a third value)

     subscriptionState   what they are paying for, from the server mirror
       subscription_inactive   never paid, lapsed, or cancelled and run out
       subscription_active     inside a paid period, by the server clock

     accountStatus       an operator's decision, not a derived value
       active | disabled | suspended

   Deliberately separate fields rather than one enum. One enum forces a choice
   between "profile_complete" and "subscription_active" for a user who is both,
   and whichever you pick, some screen shows the wrong thing.
   ========================================================================== */
'use strict';

/**
 * The three business facts, in the field names the database uses.
 * `country` rides with the number — see the header.
 *
 * Kept identical to REQUIRED_PROFILE in api/_lib/store.js, which is what the
 * payment flow checks. Two lists that drift apart is how a profile passes
 * sign-up and then fails at checkout.
 */
const REQUIRED_PROFILE_FIELDS = ['mobileNumber', 'country', 'mobileShopName', 'proprietorName'];

/** Fields a user may write about themselves. Nothing about money is here. */
const WRITABLE_PROFILE_FIELDS = [
  'mobileShopName', 'proprietorName', 'mobileNumber', 'mobileNumberE164',
  'country', 'countryCode', 'address', 'profilePhotoURL', 'profilePhotoPath'
];

/** True when a value is actually present rather than blank or whitespace. */
function present(v) {
  return v != null && String(v).trim() !== '';
}

/** Which of the three business facts are still missing. */
function missingProfileFields(profile) {
  return REQUIRED_PROFILE_FIELDS.filter(k => !present(profile && profile[k]));
}

/** @returns {boolean} all three business facts present. */
function isProfileComplete(profile) {
  return missingProfileFields(profile).length === 0;
}

/** @returns {'profile_incomplete'|'profile_complete'} */
function deriveAccountState(profile) {
  return isProfileComplete(profile) ? 'profile_complete' : 'profile_incomplete';
}

/**
 * What the subscription mirror says, checked against the SERVER clock.
 *
 * Both field names are read because both are written: activeSubscriptionStatus
 * is what the billing code has always used and subscriptionStatus is what the
 * app reads. Reading one and not the other is how a live subscription reads as
 * absent.
 *
 * @returns {'subscription_active'|'subscription_inactive'}
 */
function deriveSubscriptionState(profile, now) {
  if (!profile) return 'subscription_inactive';
  const status = profile.activeSubscriptionStatus || profile.subscriptionStatus || 'none';
  const expiresAt = Number(profile.subscriptionExpiresAt);
  const running = Number.isFinite(expiresAt) && expiresAt > now;

  /* A cancelled subscription still has access until the paid period runs out —
     the shop paid for those days and must not lose them at the moment they
     press Cancel. */
  if ((status === 'active' || status === 'cancelling' || status === 'cancelled') && running) {
    return 'subscription_active';
  }
  return 'subscription_inactive';
}

/**
 * The finer-grained plan status the admin table shows, for the cases where
 * "inactive" is not specific enough to act on.
 *
 * @returns {'none'|'active'|'expired'|'cancelling'|'cancelled'|'pending'}
 */
function derivePlanStatus(profile, now) {
  if (!profile) return 'none';
  const status = profile.activeSubscriptionStatus || profile.subscriptionStatus || 'none';
  if (!status || status === 'none') return 'none';

  const expiresAt = Number(profile.subscriptionExpiresAt);
  const running = Number.isFinite(expiresAt) && expiresAt > now;

  if (status === 'pending') return 'pending';
  if (status === 'cancelled' || status === 'cancelling') return running ? 'cancelling' : 'cancelled';
  if (status === 'active') return running ? 'active' : 'expired';
  return status;
}

/**
 * When this account was last seen.
 *
 * Derived from the newest timestamp we actually hold rather than from a
 * separate "isActive" flag nothing maintains — a boolean nobody updates is a
 * boolean that lies within a week.
 */
function lastSeenAt(profile, authRecord) {
  const candidates = [
    profile && profile.lastActiveAt,
    profile && profile.lastLoginAt,
    authRecord && authRecord.lastRefreshAt,
    authRecord && authRecord.lastSignInAt,
    profile && profile.updatedAt
  ]
    /* null BEFORE Number(), not after. Number(null) is 0, which is finite, so
       filtering afterwards turns an absent timestamp into epoch zero — a user
       last seen on 1 January 1970, sorted to the top of "longest inactive" and
       displayed as "56 yr ago". Firestore stores explicit nulls on these
       fields, so this is the ordinary case rather than an edge one. */
    .filter(v => v !== null && v !== undefined && v !== '')
    .map(Number)
    .filter(Number.isFinite);

  return candidates.length ? Math.max.apply(null, candidates) : null;
}

/* ------------------------------------------------------------ search mirrors

   Lower-cased copies of the fields an admin searches, plus a digits-only copy
   of the phone number.

   Firestore has no case-insensitive comparison and no LIKE, so a search for
   "sri balaji" can only find "Sri Balaji Mobiles" if the lower-cased form is
   stored. These are the fields that make that possible.

   They are DERIVED and never authoritative. Nothing reads them for display,
   nothing edits them by hand, and recomputing them from the real fields is
   always correct — which is what makes the backfill script safe to re-run.

   Pure, and in the schema layer rather than in a service, because both the
   write path (api/_lib/store.js) and the read path (user-directory-service)
   need the identical definition. Two copies would drift, and a drifted mirror
   is a user who cannot be found by name. */
function searchFieldsFor(profile) {
  const p = profile || {};
  const lower = value => {
    const s = present(value) ? String(value).trim().slice(0, 200).toLowerCase() : '';
    return s || null;
  };
  const digitsOnly = value => {
    const d = present(value) ? String(value).replace(/\D/g, '').slice(0, 20) : '';
    return d || null;
  };

  return {
    emailLower: lower(p.email),
    mobileShopNameLower: lower(p.mobileShopName || p.shopName),
    proprietorNameLower: lower(p.proprietorName || p.proprietor),
    displayNameLower: lower(p.displayName || p.googleDisplayName),
    mobileDigits: digitsOnly(p.mobileNumberE164 || p.mobileNumber || p.mobile)
  };
}

/**
 * The one shape the admin API returns for a user, everywhere.
 *
 * ABSENT IS ABSENT. A field with no value comes back null, never as an empty
 * string dressed up as data and never as a plausible-looking placeholder. The
 * admin UI renders null as an em dash, which is the honest answer to "we have
 * not asked this shop for their city yet".
 *
 * @param {object} args
 * @param {string} args.uid
 * @param {object|null} args.profile     the users/{uid} document
 * @param {object|null} args.authRecord  flattened Firebase Auth UserRecord
 * @param {object|null} args.billing     rollup from the payments collection
 * @param {number} args.now              server time
 */
function toAdminUserView({ uid, profile, authRecord, billing, now }) {
  const p = profile || {};
  const a = authRecord || {};
  const b = billing || {};
  const addr = p.address && typeof p.address === 'object' ? p.address : {};

  const value = v => (present(v) ? String(v) : null);
  const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

  return {
    uid,

    /* ---- identity: Firebase Authentication is the source ---- */
    email: value(a.email) || value(p.email),
    emailVerified: typeof a.emailVerified === 'boolean'
      ? a.emailVerified
      : (typeof p.emailVerified === 'boolean' ? p.emailVerified : null),
    displayName: value(p.displayName) || value(a.displayName) || value(p.googleDisplayName),
    photoURL: value(p.profilePhotoURL) || value(p.googlePhotoURL) || value(a.photoURL),
    authProvider: value(a.providerId) || value(p.authProvider) || 'google',
    disabled: typeof a.disabled === 'boolean' ? a.disabled : null,

    /* ---- shop profile: users/{uid} is the source ----
       The older field names are read as a fallback so a document written by an
       earlier release still displays, exactly as the client normaliser does. */
    mobileShopName: value(p.mobileShopName) || value(p.shopName),
    proprietorName: value(p.proprietorName) || value(p.proprietor),
    mobileNumber: value(p.mobileNumber) || value(p.mobile),
    mobileNumberE164: value(p.mobileNumberE164),
    country: value(p.country) || value(p.countryName),
    countryCode: value(p.countryCode),
    address: {
      flat: value(addr.flat),
      area: value(addr.area),
      city: value(addr.city),
      district: value(addr.district),
      state: value(addr.state),
      country: value(addr.country) || value(p.country)
    },

    /* ---- derived state ---- */
    accountState: deriveAccountState(p),
    profileComplete: isProfileComplete(p),
    missingProfileFields: missingProfileFields(p),
    accountStatus: value(p.accountStatus) || (a.disabled ? 'disabled' : 'active'),
    subscriptionState: deriveSubscriptionState(p, now),

    /* ---- timestamps ---- */
    createdAt: num(p.createdAt) != null ? num(p.createdAt) : num(a.createdAt),
    lastLoginAt: num(p.lastLoginAt) != null ? num(p.lastLoginAt) : num(a.lastSignInAt),
    lastActiveAt: lastSeenAt(p, a),
    updatedAt: num(p.updatedAt),

    /* ---- subscription mirror: server-written, read-only everywhere else ---- */
    subscription: {
      planId: value(p.currentPlanId) || value(p.subscriptionPlan),
      status: derivePlanStatus(p, now),
      startedAt: num(p.subscriptionStartedAt),
      expiresAt: num(p.subscriptionExpiresAt),
      subscriptionId: value(p.currentSubscriptionId),
      lastVerifiedAt: num(p.lastVerifiedAt)
    },

    /* ---- billing rollup: computed from payments, never stored on the user ---- */
    billing: {
      totalPaidPaise: num(b.totalPaidPaise) || 0,
      successfulPayments: num(b.successfulPayments) || 0,
      failedPayments: num(b.failedPayments) || 0,
      lastPaymentAt: num(b.lastPaymentAt),
      lastPaymentId: value(b.lastPaymentId),
      currency: value(b.currency) || 'INR'
    }
  };
}

module.exports = {
  REQUIRED_PROFILE_FIELDS,
  WRITABLE_PROFILE_FIELDS,
  present,
  missingProfileFields,
  isProfileComplete,
  deriveAccountState,
  deriveSubscriptionState,
  derivePlanStatus,
  lastSeenAt,
  searchFieldsFor,
  toAdminUserView
};

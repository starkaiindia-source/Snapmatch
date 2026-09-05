/* ============================================================================
   api/_lib/user-state.test.js
   ----------------------------------------------------------------------------
   Profile completion and the derived account states.

   The rule these exist to protect: a shop that has already given us its three
   business details must never be treated as a new user. Every regression in
   that direction shows up as "the site asked me to sign up again", which is
   the single worst thing this backend could do to a paying customer.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_PROFILE_FIELDS, isProfileComplete, missingProfileFields,
  deriveAccountState, deriveSubscriptionState, derivePlanStatus,
  lastSeenAt, searchFieldsFor, toAdminUserView
} = require('../_schema/user-profile');

const { REQUIRED_PROFILE } = require('./store');

const COMPLETE = {
  mobileShopName: 'Sri Balaji Mobiles',
  proprietorName: 'R. Kumar',
  mobileNumber: '9876543210',
  country: 'India'
};

test('the required fields match what the payment flow checks', () => {
  /* Two lists that drift apart is how a profile passes sign-up and then fails
     at checkout, which is exactly the bug this assertion prevents. */
  assert.deepEqual([...REQUIRED_PROFILE_FIELDS].sort(), [...REQUIRED_PROFILE].sort());
});

test('all three business details present is a complete profile', () => {
  assert.equal(isProfileComplete(COMPLETE), true);
  assert.deepEqual(missingProfileFields(COMPLETE), []);
  assert.equal(deriveAccountState(COMPLETE), 'profile_complete');
});

test('an empty address does not make a complete profile incomplete', () => {
  /* Address is optional, permanently. A returning shop with a complete
     profile and no address is COMPLETE, and any code that treats it as a new
     user is wrong. */
  assert.equal(isProfileComplete({ ...COMPLETE, address: {} }), true);
  assert.equal(isProfileComplete({ ...COMPLETE, address: null }), true);
  assert.equal(isProfileComplete({ ...COMPLETE, address: { city: '', state: '' } }), true);
  assert.equal(deriveAccountState({ ...COMPLETE, address: {} }), 'profile_complete');
});

test('each missing business detail is named, not just counted', () => {
  assert.deepEqual(missingProfileFields({ ...COMPLETE, mobileNumber: '' }), ['mobileNumber']);
  assert.deepEqual(missingProfileFields({ ...COMPLETE, proprietorName: '   ' }), ['proprietorName']);
  assert.deepEqual(missingProfileFields({}).sort(), [...REQUIRED_PROFILE_FIELDS].sort());
});

test('whitespace is not a value', () => {
  assert.equal(isProfileComplete({ ...COMPLETE, mobileShopName: '   ' }), false);
  assert.equal(isProfileComplete({ ...COMPLETE, country: null }), false);
});

/* ------------------------------------------------------------- subscription */

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 5, 1);

test('access is decided by the date, not by the stored flag alone', () => {
  const lapsed = {
    activeSubscriptionStatus: 'active',
    subscriptionExpiresAt: NOW - HOUR
  };
  /* The flag still says active because nothing has rewritten it yet. The date
     has passed, so access has not. */
  assert.equal(deriveSubscriptionState(lapsed, NOW), 'subscription_inactive');
  assert.equal(derivePlanStatus(lapsed, NOW), 'expired');
});

test('a running subscription is active', () => {
  const live = { activeSubscriptionStatus: 'active', subscriptionExpiresAt: NOW + 30 * 24 * HOUR };
  assert.equal(deriveSubscriptionState(live, NOW), 'subscription_active');
  assert.equal(derivePlanStatus(live, NOW), 'active');
});

test('cancelling keeps the days already paid for', () => {
  const cancelled = { activeSubscriptionStatus: 'cancelled', subscriptionExpiresAt: NOW + 5 * 24 * HOUR };
  assert.equal(deriveSubscriptionState(cancelled, NOW), 'subscription_active');
  assert.equal(derivePlanStatus(cancelled, NOW), 'cancelling');

  const runOut = { activeSubscriptionStatus: 'cancelled', subscriptionExpiresAt: NOW - HOUR };
  assert.equal(deriveSubscriptionState(runOut, NOW), 'subscription_inactive');
  assert.equal(derivePlanStatus(runOut, NOW), 'cancelled');
});

test('an account that never paid is none, not expired', () => {
  assert.equal(derivePlanStatus({}, NOW), 'none');
  assert.equal(derivePlanStatus({ activeSubscriptionStatus: 'none' }, NOW), 'none');
  assert.equal(deriveSubscriptionState({}, NOW), 'subscription_inactive');
});

test('both stored field names are read', () => {
  /* subscriptionStatus is what the app writes and activeSubscriptionStatus is
     what the billing code writes. Reading one and not the other is how a live
     subscription reads as absent. */
  const onlyNewName = { subscriptionStatus: 'active', subscriptionExpiresAt: NOW + HOUR };
  assert.equal(deriveSubscriptionState(onlyNewName, NOW), 'subscription_active');

  const onlyOldName = { activeSubscriptionStatus: 'active', subscriptionExpiresAt: NOW + HOUR };
  assert.equal(deriveSubscriptionState(onlyOldName, NOW), 'subscription_active');
});

test('the two state axes never contradict each other', () => {
  /* A user can be profile_complete AND subscription_inactive, or
     profile_incomplete AND subscription_active — someone who paid before the
     profile rules changed. Separate fields, so neither has to lose. */
  const paidButIncomplete = {
    mobileShopName: 'A Shop',
    activeSubscriptionStatus: 'active',
    subscriptionExpiresAt: NOW + HOUR
  };
  assert.equal(deriveAccountState(paidButIncomplete), 'profile_incomplete');
  assert.equal(deriveSubscriptionState(paidButIncomplete, NOW), 'subscription_active');
});

/* ----------------------------------------------------------- last seen */

test('last seen takes the newest timestamp available', () => {
  assert.equal(lastSeenAt({ lastLoginAt: 100, updatedAt: 300 }, { lastSignInAt: 200 }), 300);
  assert.equal(lastSeenAt({}, { lastRefreshAt: 500 }), 500);
  assert.equal(lastSeenAt({}, {}), null);
  assert.equal(lastSeenAt(null, null), null);
});

test('an explicitly null timestamp is absent, not 1970', () => {
  /* Number(null) is 0, which is finite. Filtering after the conversion rather
     than before turns a stored null into epoch zero — a user "last seen 56
     years ago", sorted to the top of the longest-inactive list. Firestore
     writes explicit nulls on these fields, so this is the ordinary case. */
  assert.equal(lastSeenAt({ lastActiveAt: null, lastLoginAt: null, updatedAt: null }, null), null);
  assert.equal(lastSeenAt({ lastActiveAt: null, lastLoginAt: 900 }, null), 900);
  assert.equal(lastSeenAt({ lastLoginAt: '' }, { lastSignInAt: null }), null);
});

/* -------------------------------------------------------- search mirrors */

test('search mirrors are lower-cased and digits-only', () => {
  const mirrors = searchFieldsFor({
    email: 'Shop@Example.COM',
    mobileShopName: 'Sri Balaji Mobiles',
    proprietorName: 'R. Kumar',
    mobileNumberE164: '+91 98765 43210'
  });
  assert.equal(mirrors.emailLower, 'shop@example.com');
  assert.equal(mirrors.mobileShopNameLower, 'sri balaji mobiles');
  assert.equal(mirrors.proprietorNameLower, 'r. kumar');
  assert.equal(mirrors.mobileDigits, '919876543210');
});

test('an absent field mirrors to null, never to an empty string', () => {
  /* An empty string is a value Firestore will index and match. null is
     absence, and the difference matters when a query asks for everyone whose
     shop name starts with "". */
  const mirrors = searchFieldsFor({});
  Object.values(mirrors).forEach(v => assert.equal(v, null));
});

test('mirrors are recomputed identically every time, so a backfill is safe to re-run', () => {
  const profile = { email: 'A@B.com', mobileShopName: 'Shop', mobileNumber: '99999 88888' };
  assert.deepEqual(searchFieldsFor(profile), searchFieldsFor({ ...profile, ...searchFieldsFor(profile) }));
});

/* ------------------------------------------------------------ admin view */

test('a field with no value is null, never an invented placeholder', () => {
  const view = toAdminUserView({ uid: 'abc123def456', profile: {}, authRecord: null,
                                 billing: null, now: NOW });
  assert.equal(view.mobileShopName, null);
  assert.equal(view.proprietorName, null);
  assert.equal(view.mobileNumber, null);
  assert.equal(view.address.city, null);
  assert.equal(view.createdAt, null);
  assert.equal(view.subscription.planId, null);
  /* Money is the exception: no payments is genuinely zero, not unknown. */
  assert.equal(view.billing.totalPaidPaise, 0);
  assert.equal(view.billing.successfulPayments, 0);
});

test('older field names still display', () => {
  /* Documents written by an earlier release used shopName/proprietor/mobile.
     Nothing rewrites them, so the read path has to know both. */
  const view = toAdminUserView({
    uid: 'abc123def456',
    profile: { shopName: 'Old Shop', proprietor: 'Old Name', mobile: '9000000000' },
    authRecord: null, billing: null, now: NOW
  });
  assert.equal(view.mobileShopName, 'Old Shop');
  assert.equal(view.proprietorName, 'Old Name');
  assert.equal(view.mobileNumber, '9000000000');
});

test('Firebase Authentication wins for identity, the profile wins for the shop', () => {
  const view = toAdminUserView({
    uid: 'abc123def456',
    profile: { email: 'stale@old.com', mobileShopName: 'The Shop' },
    authRecord: { email: 'real@current.com', emailVerified: true, disabled: false },
    billing: null,
    now: NOW
  });
  assert.equal(view.email, 'real@current.com');
  assert.equal(view.mobileShopName, 'The Shop');
});

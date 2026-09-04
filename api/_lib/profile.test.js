/* ============================================================================
   api/_lib/profile.test.js
   ----------------------------------------------------------------------------
   /api/profile-sync accepts a body from the browser and merges part of it into
   users/{uid}. sanitiseProfile is the entire boundary between "shop details a
   user may set" and "facts about money the server owns", so it is tested for
   what it REFUSES at least as hard as for what it keeps.

   The important case is not a malformed field. It is a well-formed request that
   asks for a free subscription.
   ========================================================================== */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sanitiseProfile, profileIsComplete, WRITABLE_PROFILE, REQUIRED_PROFILE } =
  require('./store');

test('shop details a user may set are kept, and trimmed', () => {
  const out = sanitiseProfile({
    mobileShopName: '  Ozo Mobiles  ',
    proprietorName: 'Jeevanandham Sarthar',
    mobileNumber: ' 9894301600 ',
    mobileNumberE164: '+919894301600',
    country: 'India',
    countryCode: 'IN'
  });
  assert.equal(out.mobileShopName, 'Ozo Mobiles');
  assert.equal(out.mobileNumber, '9894301600');
  assert.equal(out.countryCode, 'IN');
});

test('a subscription cannot be granted through the profile endpoint', () => {
  const out = sanitiseProfile({
    mobileShopName: 'Ozo Mobiles',
    /* Everything a browser would try if it wanted a free plan. */
    subscriptionStatus: 'active',
    activeSubscriptionStatus: 'active',
    subscriptionPlan: 'yearly',
    currentPlanId: 'yearly',
    subscriptionExpiresAt: Date.now() + 31536000000,
    subscriptionStartedAt: Date.now(),
    accountStatus: 'premium',
    role: 'admin',
    uid: 'someone-elses-uid'
  });
  assert.deepEqual(Object.keys(out), ['mobileShopName']);
  /* Spelled out, because a regression here is a revenue bug, not a style one. */
  ['subscriptionStatus', 'activeSubscriptionStatus', 'subscriptionPlan', 'currentPlanId',
   'subscriptionExpiresAt', 'subscriptionStartedAt', 'accountStatus', 'role', 'uid']
    .forEach(k => assert.equal(out[k], undefined, `${k} must not be writable by a client`));
});

test('the writable list holds nothing about a subscription', () => {
  WRITABLE_PROFILE.forEach(k => {
    assert.ok(!/subscription|plan|status|role/i.test(k),
      `${k} looks server-owned but is in WRITABLE_PROFILE`);
  });
});

test('an empty value is an absent field, not an instruction to blank one', () => {
  /* Merging '' over a stored number is how a shop loses the phone number it
     entered on another device. */
  const out = sanitiseProfile({ mobileNumber: '', proprietorName: '   ', mobileShopName: 'Ozo' });
  assert.equal('mobileNumber' in out, false);
  assert.equal('proprietorName' in out, false);
  assert.equal(out.mobileShopName, 'Ozo');
});

test('null and non-strings are dropped rather than stored', () => {
  const out = sanitiseProfile({
    mobileShopName: null, proprietorName: 42, mobileNumber: { a: 1 }, countryCode: ['IN']
  });
  assert.deepEqual(out, {});
});

test('an oversized value is capped, not rejected outright', () => {
  const out = sanitiseProfile({ mobileShopName: 'x'.repeat(5000) });
  assert.equal(out.mobileShopName.length, 200);
});

test('the address keeps its known parts and drops anything else', () => {
  const out = sanitiseProfile({
    address: { flat: ' 12A ', city: 'Chennai', state: 'Tamil Nadu', evil: 'drop me', role: 'admin' }
  });
  assert.deepEqual(out.address, { flat: '12A', city: 'Chennai', state: 'Tamil Nadu' });
});

test('an all-empty address is not written as an empty object', () => {
  assert.equal('address' in sanitiseProfile({ address: { flat: '', city: '  ' } }), false);
});

test('a blank form cannot wipe a stored profile', () => {
  /* The payment path used to open the edit sheet without seeding it, so every
     field arrived empty. Merging that would have deleted a good profile. */
  const blankForm = {
    mobileShopName: '', proprietorName: '', mobileNumber: '', mobileNumberE164: '',
    country: '', countryCode: '',
    address: { flat: '', area: '', city: '', district: '', state: '', country: '' }
  };
  assert.deepEqual(sanitiseProfile(blankForm), {},
    'a blank form must produce no writes at all');
});

test('an address of nothing but a country is not an address', () => {
  /* Registration built the address unconditionally and always put the country
     in it, so every account that skipped the optional section got one. */
  const out = sanitiseProfile({
    mobileShopName: 'Xy mobile',
    address: { flat: '', area: '', city: '', district: '', state: '', country: 'India' }
  });
  assert.equal(out.mobileShopName, 'Xy mobile');
  assert.equal('address' in out, true, 'a country IS one of the recognised parts');
  assert.deepEqual(out.address, { country: 'India' });
});

test('a non-object body is handled rather than thrown on', () => {
  [null, undefined, 'hello', 7, []].forEach(v => {
    assert.deepEqual(sanitiseProfile(v), {});
  });
});

test('completeness needs every field a payment depends on', () => {
  const full = {
    mobileShopName: 'Ozo Mobiles', proprietorName: 'Jeevanandham Sarthar',
    mobileNumber: '9894301600', country: 'India'
  };
  assert.equal(profileIsComplete(full), true);

  REQUIRED_PROFILE.forEach(k => {
    assert.equal(profileIsComplete({ ...full, [k]: '' }), false, `${k} blank must not be complete`);
    assert.equal(profileIsComplete({ ...full, [k]: undefined }), false, `${k} absent must not be complete`);
  });
  assert.equal(profileIsComplete(null), false);
  /* Whitespace is not a phone number. */
  assert.equal(profileIsComplete({ ...full, mobileNumber: '   ' }), false);
});

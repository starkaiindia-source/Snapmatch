/* ============================================================================
   api/_lib/roles.test.js
   ----------------------------------------------------------------------------
   The permission table.

   These tests are about the SHAPE of authorisation, not about any one role's
   list. A role that gains a permission is a decision; a role that gains one
   because `can()` silently treats an unknown value as staff is a security bug,
   and that is what most of these check.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLES, ROLE_LIST, STAFF_ROLES, PERMISSIONS, ALL_PERMISSIONS,
  normaliseRole, can, isStaff, permissionsFor
} = require('../_schema/roles');

test('an unknown role is a user, never staff', () => {
  ['', null, undefined, 'administrator', 'ADMIN', 'root', 'superadmin', 0, {}]
    .forEach(value => {
      assert.equal(normaliseRole(value), ROLES.USER, `${JSON.stringify(value)} must normalise to user`);
      assert.equal(isStaff(value), false, `${JSON.stringify(value)} must not be staff`);
    });
});

test('a plain user has no permissions at all', () => {
  assert.deepEqual(permissionsFor(ROLES.USER), []);
  ALL_PERMISSIONS.forEach(p => {
    assert.equal(can(ROLES.USER, p), false, `user must not hold ${p}`);
  });
});

test('an unknown role holds no permissions', () => {
  ALL_PERMISSIONS.forEach(p => {
    assert.equal(can('made-up-role', p), false);
    assert.equal(can(undefined, p), false);
  });
});

test('super_admin holds every permission, and is the only role that does', () => {
  ALL_PERMISSIONS.forEach(p => assert.equal(can(ROLES.SUPER_ADMIN, p), true, `super_admin needs ${p}`));

  ROLE_LIST.filter(r => r !== ROLES.SUPER_ADMIN).forEach(role => {
    const held = permissionsFor(role);
    assert.notEqual(held.length, ALL_PERMISSIONS.length,
      `${role} must not hold everything — only super_admin may`);
  });
});

test('only super_admin may change roles', () => {
  ROLE_LIST.forEach(role => {
    assert.equal(
      can(role, PERMISSIONS.ADMINS_WRITE),
      role === ROLES.SUPER_ADMIN,
      `admins.write for ${role}`
    );
  });
});

test('support sees customers but not revenue', () => {
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.USERS_READ), true);
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.USERS_READ_CONTACT), true);
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.BILLING_READ), true);
  /* The whole point of the support role: answer a customer's question without
     being handed the business's revenue figures. */
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.REVENUE_READ), false);
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.USERS_WRITE), false);
});

test('analyst sees totals but never an individual customer', () => {
  assert.equal(can(ROLES.ANALYST, PERMISSIONS.ANALYTICS_READ), true);
  assert.equal(can(ROLES.ANALYST, PERMISSIONS.REVENUE_READ), true);
  /* The mirror image of support, and what makes it safe to give an outside
     analyst access without giving them the customer list. */
  assert.equal(can(ROLES.ANALYST, PERMISSIONS.USERS_READ), false);
  assert.equal(can(ROLES.ANALYST, PERMISSIONS.USERS_READ_CONTACT), false);
});

test('publishing to the catalogue is narrower than editing the queue', () => {
  /* Triaging a review queue and changing what every shop sees on the site are
     different acts. They must not share a permission just because they share
     a page. */
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.MISSING_MODELS_READ), true);
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.MISSING_MODELS_WRITE), false);
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.MISSING_MODELS_PUBLISH), false);
  assert.equal(can(ROLES.ANALYST, PERMISSIONS.MISSING_MODELS_PUBLISH), false);
});

test('every staff role can open the admin area and `user` cannot', () => {
  STAFF_ROLES.forEach(role => assert.equal(isStaff(role), true, `${role} should be staff`));
  assert.equal(isStaff(ROLES.USER), false);
  assert.equal(STAFF_ROLES.includes(ROLES.USER), false);
});

test('permissionsFor hands back a copy, not the table itself', () => {
  /* A caller that mutated the returned array would be editing the permission
     table for every subsequent request in that warm instance. */
  const list = permissionsFor(ROLES.SUPPORT);
  list.push(PERMISSIONS.REVENUE_READ);
  assert.equal(can(ROLES.SUPPORT, PERMISSIONS.REVENUE_READ), false);
});

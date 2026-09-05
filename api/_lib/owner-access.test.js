/* ============================================================================
   api/_lib/owner-access.test.js
   ----------------------------------------------------------------------------
   Owner-only admin access.

   Written from the attacker's side throughout. The question each test asks is
   not "does the owner get in" — that is one line — but "what does somebody
   have to do to get in who should not", and the answer has to stay "sign in as
   the owner's Google account".
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OWNER_EMAIL, OWNER_ONLY, normaliseEmail, isOwnerEmail,
  ROLES, permissionsFor, ALL_PERMISSIONS, can
} = require('../_schema/roles');

const ROOT = path.join(__dirname, '..', '..');

test('the owner address is the one the business actually uses', () => {
  assert.equal(normaliseEmail(OWNER_EMAIL), 'stark.ai.india@gmail.com');
});

test('case and surrounding whitespace do not matter', () => {
  /* Google returns the address in whatever case the account was created with,
     so a case-sensitive compare would lock the owner out of their own backend
     on a day nothing had changed. */
  [
    'Stark.ai.India@gmail.com',
    'stark.ai.india@gmail.com',
    'STARK.AI.INDIA@GMAIL.COM',
    '  Stark.ai.India@gmail.com  ',
    '\tstark.ai.india@gmail.com\n'
  ].forEach(variant => {
    assert.equal(isOwnerEmail(variant), true, `${JSON.stringify(variant)} should be the owner`);
  });
});

test('a lookalike address is not the owner', () => {
  [
    'stark.ai.india@gmail.com.evil.com',   /* suffix */
    'evil.com/stark.ai.india@gmail.com',   /* prefix */
    'notstark.ai.india@gmail.com',
    'stark.ai.india+admin@gmail.com',      /* plus-addressing is a different string */
    'stark.ai.india@googlemail.com',       /* Google's other domain — still not this */
    'starkaiindia@gmail.com',              /* dots removed: Gmail routes it, we do not */
    'stark.ai.india@gmail.co',
    'stark.ai.india@gmail.com ',           /* handled — but assert the trimmed compare */
    ''
  ].forEach(candidate => {
    const expected = normaliseEmail(candidate) === normaliseEmail(OWNER_EMAIL);
    assert.equal(isOwnerEmail(candidate), expected,
      `${JSON.stringify(candidate)} was judged wrongly`);
  });

  /* Spelled out, because the plus-address and dot-stripped cases are the two
     somebody would actually try. Gmail delivers all three to one mailbox; this
     system treats only the configured string as the owner. */
  assert.equal(isOwnerEmail('stark.ai.india+admin@gmail.com'), false);
  assert.equal(isOwnerEmail('starkaiindia@gmail.com'), false);
});

test('a non-string is never the owner', () => {
  [null, undefined, 0, 1, true, {}, [], { toString: () => OWNER_EMAIL }]
    .forEach(value => {
      assert.equal(isOwnerEmail(value), false,
        `${JSON.stringify(value)} must not be the owner`);
    });
});

test('an empty or blank email is never the owner', () => {
  /* The case that matters: an anonymous or provider-less account arrives with
     no email claim, and a careless compare of '' to '' would let it through. */
  ['', '   ', '\n', '\t'].forEach(blank => {
    assert.equal(isOwnerEmail(blank), false);
  });
  assert.equal(normaliseEmail(undefined), '');
  assert.equal(isOwnerEmail(normaliseEmail(undefined)), false);
});

test('the owner holds every permission', () => {
  /* The owner is resolved to super_admin in requireAdmin, so this is the
     permission set they actually get. */
  const held = permissionsFor(ROLES.SUPER_ADMIN);
  ALL_PERMISSIONS.forEach(p => {
    assert.equal(can(ROLES.SUPER_ADMIN, p), true, `owner needs ${p}`);
    assert.ok(held.includes(p));
  });
});

test('owner-only mode is on', () => {
  /* If this ever fails, someone turned staff roles back on. That is a real
     decision with real consequences — the registry starts granting access
     again — and it should not happen by accident. */
  assert.equal(OWNER_ONLY, true);
});

/* ------------------------------------------------------- the two copies

   The owner address is written in two files: the server's authority, and the
   browser's copy used to decide whether to draw the Admin Panel link.

   Duplicated on purpose — the alternative is publishing the owner's email to
   every visitor through /api/firebase-config. But a duplicate that drifts is a
   link that stops appearing for the owner, or appears for nobody, with no
   error anywhere. So it is asserted. */

test('the browser copy of the owner address matches the server', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/data/firebase.js'), 'utf8');
  const match = /OWNER_EMAIL:\s*'([^']+)'/.exec(source);

  assert.ok(match, 'src/data/firebase.js no longer declares OWNER_EMAIL');
  assert.equal(normaliseEmail(match[1]), normaliseEmail(OWNER_EMAIL),
    `src/data/firebase.js says ${match[1]}, api/_schema/roles.js says ${OWNER_EMAIL}`);
});

test('the browser check requires a verified email, exactly as the server does', () => {
  /* Not about the client being trustworthy — it is not, and nothing depends on
     it. It is about the two checks agreeing, so the link never appears for
     somebody the panel will then refuse. */
  const source = fs.readFileSync(path.join(ROOT, 'src/data/firebase.js'), 'utf8');
  const fn = /isOwner:\s*function[\s\S]*?\n    \},/.exec(source);
  assert.ok(fn, 'src/data/firebase.js no longer declares isOwner()');
  assert.match(fn[0], /emailVerified/, 'the browser check dropped the emailVerified guard');
  assert.match(fn[0], /toLowerCase\(\)/, 'the browser check is no longer case-insensitive');
});

/* ------------------------------------------------------------ the gate

   requireAdmin needs Firebase Admin, so it cannot run here without a service
   account. What CAN be asserted is the shape of the source: that the owner
   branch reads the verified token and nothing else, and that owner-only mode
   closes the registry path. */

const gateSource = fs.readFileSync(path.join(ROOT, 'api/_lib/admin-auth.js'), 'utf8');

test('the owner is recognised from the verified token, never from the request', () => {
  assert.match(gateSource, /isOwnerEmail\(decoded\.email\)/,
    'the owner check must read decoded.email from the verified ID token');
  assert.match(gateSource, /decoded\.email_verified === true/,
    'the owner check must require a verified email');

  /* The failure this guards against: someone "helpfully" letting the caller
     supply an email to check against. */
  assert.doesNotMatch(gateSource, /isOwnerEmail\(\s*(req|body|payload|query|headers)/,
    'the owner check must never read an email from the request');
});

test('owner-only mode returns before the registry is consulted', () => {
  const ownerBranch = gateSource.indexOf('isOwnerEmail(decoded.email)');
  const ownerOnlyGate = gateSource.indexOf('if (OWNER_ONLY)');
  const registryRead = gateSource.indexOf('collection(ADMIN_USERS)');

  assert.ok(ownerBranch > -1 && ownerOnlyGate > -1 && registryRead > -1);
  assert.ok(ownerBranch < ownerOnlyGate,
    'the owner must be recognised before owner-only mode refuses everyone else');
  assert.ok(ownerOnlyGate < registryRead,
    'owner-only mode must refuse before the registry is read, or a registry ' +
    'record would still grant access');
});

test('every refusal in the identity gate is worded identically', () => {
  /* A different message per reason would be an oracle: probe the endpoint,
     read the wording, learn who the administrators are. "not the owner",
     "no registry record" and "disabled" must be indistinguishable.

     Scoped to requireAdmin. requirePermission's "not authorised for this
     action" is a DIFFERENT layer and correctly says something different — it
     is only ever reached by a caller who already passed the identity gate, so
     it tells an outsider nothing. */
  const start = gateSource.indexOf('async function requireAdmin');
  const end = gateSource.indexOf('async function requirePermission');
  assert.ok(start > -1 && end > start, 'could not isolate requireAdmin');

  const body = gateSource.slice(start, end);
  const refusals = body.match(/forbidden\(res,\s*'([^']+)'\)/g) || [];
  assert.ok(refusals.length >= 4, `expected several refusal paths, found ${refusals.length}`);

  const wordings = new Set(refusals.map(r => /'([^']+)'/.exec(r)[1]));
  assert.equal(wordings.size, 1,
    `identity-gate refusals differ in wording: ${[...wordings].join(' / ')}`);
});

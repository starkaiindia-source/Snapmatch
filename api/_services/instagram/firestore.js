/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/firestore.js
   ----------------------------------------------------------------------------
   The one Firestore handle the Instagram services use.

   Production: the Admin SDK instance from api/_lib/firebase.js — the same
   one every other service uses, so there is one credential and one app.
   Tests: an in-memory stand-in installed with use(), so the approval
   transaction, the resume logic and the production-protection rules are
   exercised for real without a network or a service account.
   ========================================================================== */
'use strict';

let provider = null;

function real() {
  const firebase = require('../../_lib/firebase');
  return { db: () => firebase.db(), FieldValue: firebase.admin.firestore.FieldValue };
}

function current() {
  if (!provider) provider = real();
  return provider;
}

module.exports = {
  db: () => current().db(),
  FieldValue: () => current().FieldValue,
  /** Tests only. Pass null to go back to the Admin SDK. */
  use(p) { provider = p; }
};

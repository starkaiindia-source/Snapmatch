/* ============================================================================
   Mobile Parts Finder · api/_services/instagram/firestore.js
   ----------------------------------------------------------------------------
   The one Firestore handle the Instagram and compatibility services use.

   It is also where the PROJECT BOUNDARY is held (api/_schema/projects.js):
   before the handle is given out, the project the service account belongs to
   is checked. A credential for the Dashboard or for ProGlide — pasted into
   the wrong environment — is refused here, before anything is written.

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
  const projects = require('../../_schema/projects');
  let checked = false;
  return {
    db: () => {
      if (!checked) {
        projects.assertWritable(firebase.projectId(), process.env.FIREBASE_PROJECT_ID);
        checked = true;
      }
      return firebase.db();
    },
    FieldValue: firebase.admin.firestore.FieldValue
  };
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

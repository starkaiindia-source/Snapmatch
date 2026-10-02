/* ============================================================================
   Mobile Parts Finder · api/_schema/projects.js
   ----------------------------------------------------------------------------
   WHOSE DATA IS WHOSE.

   Three projects hold mobile-model data that looks alike. They are not one
   database, and this file is where that is written down for the code rather
   than left to somebody's memory:

     MOBILE PARTS FINDER   this repository, this Firebase project. The ONLY
                           project this code writes to. Its compatibility
                           groups, categories and model references are its own
                           master data — nothing else is consulted to change
                           them, and nothing else is changed when they change.

     DASHBOARD             a separate application with its own Firebase project
                           and its own Compatibility Management. Its exports
                           seeded this catalogue once. It is HISTORICAL
                           REFERENCE: never written, never called at run time,
                           and no credential for it belongs in this project.

     PROGLIDE              a separate project. Nothing here reads or writes it.

   ----------------------------------------------------------------------------
   HOW THE BOUNDARY IS HELD

   · There is exactly one Firebase Admin app in this codebase
     (api/_lib/firebase.js), built from one service account
     (FIREBASE_SERVICE_ACCOUNT). No module initialises a second one, and
     api/_lib/isolation.test.js fails the build if one appears.
   · Every compatibility write goes through the handle in
     api/_services/instagram/firestore.js, which calls assertWritable() on the
     project that credential belongs to: a service account for another project
     — pasted into the wrong environment by mistake — is refused before a
     single document is written.
   · A group, a category or a ledger entry here carries no id of another
     project's record. Identity across a catalogue build is by the DEVICE a
     change was anchored on, never by a foreign key.
   ========================================================================== */
'use strict';

const OWNERSHIP = Object.freeze({
  ACTIVE_WRITABLE: 'ACTIVE_WRITABLE',
  READ_ONLY_REFERENCE: 'READ_ONLY_REFERENCE',
  PROTECTED_SEPARATE: 'PROTECTED_SEPARATE'
});

const PROJECTS = Object.freeze({
  mobilePartsFinder: Object.freeze({
    name: 'Mobile Parts Finder', ownership: OWNERSHIP.ACTIVE_WRITABLE,
    /* the id is configuration, not a constant here: it is whatever
       FIREBASE_PROJECT_ID names, and the service account must agree with it */
    firebaseProjectIdEnv: 'FIREBASE_PROJECT_ID'
  }),
  dashboard: Object.freeze({
    name: 'Dashboard', ownership: OWNERSHIP.READ_ONLY_REFERENCE,
    firebaseProjectIds: Object.freeze(['dashboard-7e8d8'])
  }),
  proglide: Object.freeze({
    name: 'ProGlide', ownership: OWNERSHIP.PROTECTED_SEPARATE,
    /* matched by name: any Firebase project of that product is off limits */
    firebaseProjectIdPattern: /proglide/i
  })
});

class ProjectBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectBoundaryError';
    this.code = 'project-boundary';
  }
}

/** Which of the other projects a Firebase project id belongs to, or null. */
function foreignOwner(projectId) {
  const id = String(projectId || '').trim();
  if (!id) return null;
  if (PROJECTS.dashboard.firebaseProjectIds.indexOf(id) > -1) return PROJECTS.dashboard;
  if (PROJECTS.proglide.firebaseProjectIdPattern.test(id)) return PROJECTS.proglide;
  return null;
}

/**
 * May this code WRITE to the Firebase project it holds a credential for?
 *
 * @param {string|null} credentialProjectId   the service account's project_id
 * @param {string|null} [configuredProjectId] FIREBASE_PROJECT_ID, when set
 * @throws {ProjectBoundaryError}
 */
function assertWritable(credentialProjectId, configuredProjectId) {
  const id = String(credentialProjectId || '').trim();
  const owner = foreignOwner(id);
  if (owner) {
    throw new ProjectBoundaryError(
      `Refusing to write: the service account belongs to the ${owner.name} project (${id}), which is ` +
      `${owner.ownership.replace(/_/g, ' ').toLowerCase()}. Mobile Parts Finder writes only to its own project.`);
  }
  const want = String(configuredProjectId || '').trim();
  if (id && want && id !== want) {
    throw new ProjectBoundaryError(
      `Refusing to write: FIREBASE_PROJECT_ID is "${want}" but the service account belongs to "${id}". ` +
      'The two must be the same Mobile Parts Finder project.');
  }
  return true;
}

module.exports = { OWNERSHIP, PROJECTS, ProjectBoundaryError, foreignOwner, assertWritable };

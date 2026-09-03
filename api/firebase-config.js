/* ============================================================================
   GET /api/firebase-config
   ----------------------------------------------------------------------------
   Serves the Firebase Web SDK configuration from environment variables.

   WHY AN ENDPOINT AND NOT A BUILD-TIME VARIABLE
     This site ships as plain files with no build step — that is what lets
     Vercel serve it statically and keeps GitHub -> Vercel a single push with
     nothing to compile. There is therefore no bundler to substitute a
     VITE_/NEXT_PUBLIC_ variable into client code. Reading the values here and
     handing them to the browser keeps the configuration in one place (the
     Vercel environment), so rotating a value needs no code change and no
     commit.

   THIS CONFIG IS NOT A SECRET
     Worth being plain about, because the naming suggests otherwise: every
     value below is shipped to every visitor's browser by design. It has to be
     — the SDK cannot reach the project without it. `apiKey` is a project
     identifier, not a credential; it authorises nothing on its own.

     What actually protects the data is Firestore Security Rules and the
     authorised-domain list. Serving these from the environment is operational
     hygiene: one place to change, nothing to edit in source. It is not
     secrecy, and treating it as secrecy would be a false sense of safety.

     The dangerous credential is the service-account key used by the billing
     functions. That one never leaves the server and never appears in any
     response — including this one.

   Cached at the edge: the config changes about never, and a fetch on every
   page load for four constants is waste.
   ========================================================================== */
'use strict';

const { json, fail, requireMethod } = require('./_lib/http');

/* projectId is the one value that can be derived rather than configured: the
   auth domain and the default bucket are both built from it, so a mismatch
   between them is impossible by construction. */
function readConfig() {
  const projectId = process.env.FIREBASE_PROJECT_ID || '';
  if (!projectId) return null;

  const cfg = {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
    projectId,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || ''
  };
  if (process.env.FIREBASE_MEASUREMENT_ID) {
    cfg.measurementId = process.env.FIREBASE_MEASUREMENT_ID;
  }
  return cfg;
}

module.exports = async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  try {
    const config = readConfig();

    /* An unconfigured deployment says so, by name, rather than returning a
       half-filled object the SDK would fail on with a vaguer error. */
    if (!config || !config.apiKey || !config.appId) {
      return json(res, 200, {
        configured: false,
        missing: [
          !process.env.FIREBASE_PROJECT_ID && 'FIREBASE_PROJECT_ID',
          !process.env.FIREBASE_API_KEY && 'FIREBASE_API_KEY',
          !process.env.FIREBASE_APP_ID && 'FIREBASE_APP_ID'
        ].filter(Boolean)
      });
    }

    return json(res, 200, { configured: true, config },
      'public, max-age=300, s-maxage=3600');
  } catch (err) {
    return fail(res, err, 'firebase-config');
  }
};
